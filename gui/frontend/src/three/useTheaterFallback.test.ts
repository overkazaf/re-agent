import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FPS_CONSECUTIVE_WINDOWS,
  FPS_ECO_THRESHOLD,
  FPS_WINDOW_MS,
  MAX_VALID_FRAME_DELTA_MS,
  THEATER_QUALITY_STORAGE_KEY,
  createInitialFpsWindowState,
  detectInitialFallback,
  evaluateFpsWindow,
  hasWebGL,
  loadQualityPreference,
  prefersReducedMotion,
  resolveEffectiveTier,
  saveQualityPreference,
  shouldIgnoreFrameDelta,
  type FpsWindowState,
} from './useTheaterFallback'

/** Helper: advances `evaluateFpsWindow` at steady `fps` for `durationMs` starting at `startMs`. */
function feedSteadyFps(
  initial: FpsWindowState,
  {
    fps,
    durationMs,
    startMs = 0,
    hidden = false,
    blurred = false,
  }: {
    fps: number
    durationMs: number
    startMs?: number
    hidden?: boolean
    blurred?: boolean
  },
): {
  state: FpsWindowState
  triggeredCount: number
  completedFps: number[]
  endMs: number
} {
  const step = 1000 / fps
  let state = initial
  let triggeredCount = 0
  const completedFps: number[] = []
  let t = startMs

  // Feed initial anchor frame if uninitialized
  if (state.windowStart === null) {
    const first = evaluateFpsWindow(state, { now: t, hidden, blurred })
    state = first.state
  }

  const targetEnd = startMs + durationMs
  while (t < targetEnd) {
    t += step
    const res = evaluateFpsWindow(state, { now: t, hidden, blurred })
    state = res.state
    if (res.triggeredEco) triggeredCount += 1
    if (res.completedWindowFps !== null) completedFps.push(res.completedWindowFps)
  }

  return { state, triggeredCount, completedFps, endMs: t }
}

describe('shouldIgnoreFrameDelta', () => {
  it('accepts normal foreground frame intervals including 30fps battery and 250ms boundary', () => {
    expect(shouldIgnoreFrameDelta(16.67, false, false)).toBe(false)
    expect(shouldIgnoreFrameDelta(33.33, false, false)).toBe(false)
    expect(shouldIgnoreFrameDelta(66.7, false, false)).toBe(false)
    expect(shouldIgnoreFrameDelta(MAX_VALID_FRAME_DELTA_MS, false, false)).toBe(false)
  })

  it('rejects hidden tabs, blurred windows, >250ms resume gaps, and invalid deltas', () => {
    expect(shouldIgnoreFrameDelta(16.67, true, false)).toBe(true)
    expect(shouldIgnoreFrameDelta(16.67, false, true)).toBe(true)
    expect(shouldIgnoreFrameDelta(16.67, true, true)).toBe(true)
    expect(shouldIgnoreFrameDelta(MAX_VALID_FRAME_DELTA_MS + 1, false, false)).toBe(true)
    expect(shouldIgnoreFrameDelta(8_500, false, false)).toBe(true)
    expect(shouldIgnoreFrameDelta(0, false, false)).toBe(true)
    expect(shouldIgnoreFrameDelta(-16, false, false)).toBe(true)
    expect(shouldIgnoreFrameDelta(Number.NaN, false, false)).toBe(true)
    expect(shouldIgnoreFrameDelta(Number.POSITIVE_INFINITY, false, false)).toBe(true)
  })
})

describe('evaluateFpsWindow — foreground adaptive eco guard', () => {
  it('suppresses tab-hidden frames so long background stays never trigger eco mode', () => {
    let state = createInitialFpsWindowState()
    // 2s of healthy foreground rendering
    const pre = feedSteadyFps(state, { fps: 60, durationMs: 2_000, startMs: 1_000 })
    state = pre.state
    expect(state.autoEco).toBe(false)

    // User switches tabs for 12s (throttled ~0.5fps while hidden)
    const hiddenRes = evaluateFpsWindow(state, {
      now: pre.endMs + 12_000,
      hidden: true,
      blurred: false,
    })
    expect(hiddenRes.windowReset).toBe(true)
    expect(hiddenRes.triggeredEco).toBe(false)
    expect(hiddenRes.state.autoEco).toBe(false)
    expect(hiddenRes.state.windowStart).toBeNull()
    expect(hiddenRes.state.frames).toBe(0)

    // Returning to foreground resumes cleanly at 60fps
    const post = feedSteadyFps(hiddenRes.state, {
      fps: 60,
      durationMs: 10_000,
      startMs: pre.endMs + 12_100,
    })
    expect(post.triggeredCount).toBe(0)
    expect(post.state.autoEco).toBe(false)
  })

  it('suppresses unfocused/blurred windows (e.g. macOS Space switch or background app)', () => {
    let state = createInitialFpsWindowState()
    // 1 low foreground window first
    const w1 = feedSteadyFps(state, { fps: 15, durationMs: FPS_WINDOW_MS + 100, startMs: 0 })
    expect(w1.state.consecutiveLowWindows).toBe(1)
    expect(w1.state.autoEco).toBe(false)

    // Window blurs (user switches to another app) -> resets window and streak
    const blurredRes = evaluateFpsWindow(w1.state, {
      now: w1.endMs + 100,
      hidden: false,
      blurred: true,
    })
    expect(blurredRes.windowReset).toBe(true)
    expect(blurredRes.state.consecutiveLowWindows).toBe(0)
    expect(blurredRes.state.autoEco).toBe(false)
  })

  it('rejects >250ms resume/GC gaps by resetting the active window cleanly', () => {
    let state = createInitialFpsWindowState()
    // 3.5s at 60fps
    const run = feedSteadyFps(state, { fps: 60, durationMs: 3_500, startMs: 100 })
    state = run.state
    expect(state.frames).toBeGreaterThan(150)

    // Suddenly a 6-second sleep/wake or GC gap arrives while visible
    const wakeRes = evaluateFpsWindow(state, {
      now: run.endMs + 6_000,
      hidden: false,
      blurred: false,
    })
    expect(wakeRes.windowReset).toBe(true)
    expect(wakeRes.triggeredEco).toBe(false)
    expect(wakeRes.completedWindowFps).toBeNull()
    expect(wakeRes.state.autoEco).toBe(false)
    expect(wakeRes.state.frames).toBe(0)
    expect(wakeRes.state.windowStart).toBe(run.endMs + 6_000)

    // Next 4.2s at 30fps completes cleanly with ~30fps
    const afterWake = feedSteadyFps(wakeRes.state, {
      fps: 30,
      durationMs: 4_200,
      startMs: run.endMs + 6_000,
    })
    expect(afterWake.triggeredCount).toBe(0)
    expect(afterWake.state.autoEco).toBe(false)
    expect(afterWake.completedFps[0]).toBeGreaterThan(28)
  })

  it('remains rock-solid at macOS Low Power Mode 30fps and 29.8fps indefinitely', () => {
    for (const batteryFps of [30, 29.8, 24]) {
      const res = feedSteadyFps(createInitialFpsWindowState(), {
        fps: batteryFps,
        durationMs: 32_000,
        startMs: 0,
      })
      expect(res.triggeredCount).toBe(0)
      expect(res.state.autoEco).toBe(false)
      expect(res.state.consecutiveLowWindows).toBe(0)
      expect(res.completedFps.length).toBeGreaterThanOrEqual(7)
      for (const measured of res.completedFps) {
        expect(measured).toBeGreaterThanOrEqual(FPS_ECO_THRESHOLD)
      }
    }
  })

  it('steps down to eco mode only after 2 consecutive 4s foreground windows below 22fps', () => {
    let state = createInitialFpsWindowState()

    // Window 1 (4s at 15fps): counts as 1st low window, does NOT trigger eco yet
    const w1 = feedSteadyFps(state, { fps: 15, durationMs: FPS_WINDOW_MS + 100, startMs: 0 })
    state = w1.state
    expect(w1.completedFps).toHaveLength(1)
    expect(w1.completedFps[0]).toBeLessThan(FPS_ECO_THRESHOLD)
    expect(w1.triggeredCount).toBe(0)
    expect(state.consecutiveLowWindows).toBe(1)
    expect(state.autoEco).toBe(false)

    // Window 2 (another 4s at 15fps): hits 2 consecutive windows (8s total) -> engages eco!
    const w2 = feedSteadyFps(state, {
      fps: 15,
      durationMs: FPS_WINDOW_MS + 100,
      startMs: w1.endMs,
    })
    state = w2.state
    expect(w2.triggeredCount).toBe(1)
    expect(state.consecutiveLowWindows).toBe(FPS_CONSECUTIVE_WINDOWS)
    expect(state.autoEco).toBe(true)

    // Window 3 stays in eco without re-firing triggeredEco
    const w3 = feedSteadyFps(state, {
      fps: 15,
      durationMs: FPS_WINDOW_MS + 100,
      startMs: w2.endMs,
    })
    expect(w3.triggeredCount).toBe(0)
    expect(w3.state.autoEco).toBe(true)
  })

  it('does not trigger eco when a single slow window recovers on the next window', () => {
    let state = createInitialFpsWindowState()
    const slow1 = feedSteadyFps(state, { fps: 16, durationMs: FPS_WINDOW_MS + 100, startMs: 0 })
    expect(slow1.state.consecutiveLowWindows).toBe(1)
    expect(slow1.state.autoEco).toBe(false)

    // Next window recovers to 30fps -> streak resets to 0
    const healthy = feedSteadyFps(slow1.state, {
      fps: 30,
      durationMs: FPS_WINDOW_MS + 100,
      startMs: slow1.endMs,
    })
    expect(healthy.state.consecutiveLowWindows).toBe(0)
    expect(healthy.state.autoEco).toBe(false)

    // Another isolated slow window is only streak=1, still does not trigger
    const slow2 = feedSteadyFps(healthy.state, {
      fps: 16,
      durationMs: FPS_WINDOW_MS + 100,
      startMs: healthy.endMs,
    })
    expect(slow2.state.consecutiveLowWindows).toBe(1)
    expect(slow2.triggeredCount).toBe(0)
    expect(slow2.state.autoEco).toBe(false)
  })
})

describe('quality preference persistence & tier resolution', () => {
  it('loads and saves auto/eco/hd preferences safely under 0xaf-3d-quality', () => {
    const store = new Map<string, string>()
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    }

    expect(loadQualityPreference(mockStorage)).toBe('auto')

    saveQualityPreference('eco', mockStorage)
    expect(store.get(THEATER_QUALITY_STORAGE_KEY)).toBe('eco')
    expect(loadQualityPreference(mockStorage)).toBe('eco')

    saveQualityPreference('hd', mockStorage)
    expect(loadQualityPreference(mockStorage)).toBe('hd')

    store.set(THEATER_QUALITY_STORAGE_KEY, 'corrupt-value')
    expect(loadQualityPreference(mockStorage)).toBe('auto')

    // Never throws on broken storage
    const brokenStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => saveQualityPreference('eco', brokenStorage)).not.toThrow()
    expect(loadQualityPreference(brokenStorage)).toBe('auto')
  })

  it('resolves effective tier respecting explicit user override over autoEngaged', () => {
    expect(resolveEffectiveTier('auto', false)).toBe('hd')
    expect(resolveEffectiveTier('auto', true)).toBe('eco')
    expect(resolveEffectiveTier('eco', false)).toBe('eco')
    expect(resolveEffectiveTier('eco', true)).toBe('eco')
    expect(resolveEffectiveTier('hd', false)).toBe('hd')
    expect(resolveEffectiveTier('hd', true)).toBe('hd')
  })
})

describe('no-webgl and prefers-reduced-motion fallback preservation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns no-webgl when canvas cannot create webgl2 or webgl context', () => {
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => null,
      }),
    })
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    })

    expect(hasWebGL()).toBe(false)
    expect(detectInitialFallback()).toEqual({ kind: 'no-webgl' })
  })

  it('returns reduced-motion when WebGL is available and user prefers reduced motion', () => {
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: (kind: string) => (kind === 'webgl2' ? {} : null),
      }),
    })
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query.includes('prefers-reduced-motion: reduce') }),
    })

    expect(hasWebGL()).toBe(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(detectInitialFallback()).toEqual({ kind: 'reduced-motion' })
  })

  it('returns null when WebGL is available and reduced-motion is off (never auto-kicks on low-fps)', () => {
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: (kind: string) => (kind === 'webgl' ? {} : null),
      }),
    })
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    })

    expect(hasWebGL()).toBe(true)
    expect(prefersReducedMotion()).toBe(false)
    expect(detectInitialFallback()).toBeNull()
  })
})
