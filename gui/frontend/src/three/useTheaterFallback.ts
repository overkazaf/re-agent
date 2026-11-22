// Theater fallback chain & visibility-aware adaptive performance guard:
// - `useTheaterFallback`: checks hard prerequisites (`no-webgl`, `prefers-reduced-motion`)
//   and invokes the fallback callback immediately. NEVER force-kicks users out of 3D mode
//   for `low-fps` — real sustained foreground GPU struggle is handled gracefully by
//   stepping down rendering quality via `useTheaterPerfGuard`.
// - `useTheaterPerfGuard`: tracks foreground rAF while ignoring background tabs, blurred
//   windows, and >250ms resume/GC gaps. Only after 2 consecutive 4s foreground windows
//   below 22fps does it auto-engage ECO rendering tier, while persisting user choice
//   (`auto` | `eco` | `hd`) in localStorage (`0xaf-3d-quality`).
import { useCallback, useEffect, useRef, useState } from 'react'

/** 真实可用的 WebGL 上下文（webgl2 优先，退化 webgl）。 */
export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface TheaterFallbackReason {
  kind: 'no-webgl' | 'reduced-motion' | 'low-fps'
}

export type TheaterQualityPreference = 'auto' | 'eco' | 'hd'
export type TheaterQualityTier = 'eco' | 'hd'

export const THEATER_QUALITY_STORAGE_KEY = '0xaf-3d-quality'
export const FPS_ECO_THRESHOLD = 22
export const FPS_WINDOW_MS = 4_000
export const FPS_CONSECUTIVE_WINDOWS = 2
export const MAX_VALID_FRAME_DELTA_MS = 250

export interface FpsWindowState {
  windowStart: number | null
  lastFrameAt: number | null
  frames: number
  consecutiveLowWindows: number
  autoEco: boolean
  lastFps: number | null
}

export interface FpsSampleInput {
  now: number
  hidden: boolean
  blurred: boolean
}

export interface FpsGuardConfig {
  fpsThreshold?: number
  windowMs?: number
  consecutiveWindows?: number
  maxFrameDeltaMs?: number
}

export interface FpsWindowEvaluation {
  state: FpsWindowState
  /** True on the exact transition where sustained low foreground FPS engages eco mode. */
  triggeredEco: boolean
  /** True when the sampling window was reset due to hidden tab, blur, or resume/GC gap. */
  windowReset: boolean
  /** Measured FPS when a full foreground window completed on this sample; otherwise null. */
  completedWindowFps: number | null
}

/** Immediate hard-prerequisite check (WebGL availability + reduced-motion preference). */
export function detectInitialFallback(): TheaterFallbackReason | null {
  if (!hasWebGL()) return { kind: 'no-webgl' }
  if (prefersReducedMotion()) return { kind: 'reduced-motion' }
  return null
}

/** Creates a clean initial FPS monitor state. */
export function createInitialFpsWindowState(): FpsWindowState {
  return {
    windowStart: null,
    lastFrameAt: null,
    frames: 0,
    consecutiveLowWindows: 0,
    autoEco: false,
    lastFps: null,
  }
}

/** Resets the active sampling window and streak while preserving autoEco / lastFps. */
export function resetFpsSamplingWindow(state: FpsWindowState): FpsWindowState {
  return {
    ...state,
    windowStart: null,
    lastFrameAt: null,
    frames: 0,
    consecutiveLowWindows: 0,
  }
}

/**
 * Returns true if a frame delta must be ignored (and trigger a sampling window reset):
 * - tab is hidden (`document.hidden === true`)
 * - window is blurred / unfocused
 * - delta is non-finite, non-positive, or exceeds `maxDeltaMs` (default 250ms:
 *   tab switch, sleep wake, macOS Space switch, or GC pause).
 */
export function shouldIgnoreFrameDelta(
  dtMs: number,
  hidden: boolean,
  blurred: boolean,
  maxDeltaMs: number = MAX_VALID_FRAME_DELTA_MS,
): boolean {
  if (hidden || blurred) return true
  if (!Number.isFinite(dtMs) || dtMs <= 0) return true
  return dtMs > maxDeltaMs
}

/**
 * Pure foreground FPS window evaluator.
 * Advances one rAF sample and returns the next state plus whether ECO mode was newly engaged.
 * Only sustained foreground FPS below `fpsThreshold` (default 22fps) across `consecutiveWindows`
 * (default 2) consecutive `windowMs` (default 4000ms) windows engages `autoEco`.
 */
export function evaluateFpsWindow(
  prev: FpsWindowState,
  sample: FpsSampleInput,
  config?: FpsGuardConfig,
): FpsWindowEvaluation {
  const fpsThreshold = config?.fpsThreshold ?? FPS_ECO_THRESHOLD
  const windowMs = config?.windowMs ?? FPS_WINDOW_MS
  const consecutiveWindows = config?.consecutiveWindows ?? FPS_CONSECUTIVE_WINDOWS
  const maxFrameDeltaMs = config?.maxFrameDeltaMs ?? MAX_VALID_FRAME_DELTA_MS

  if (sample.hidden || sample.blurred || !Number.isFinite(sample.now)) {
    return {
      state: resetFpsSamplingWindow(prev),
      triggeredEco: false,
      windowReset: true,
      completedWindowFps: null,
    }
  }

  if (prev.windowStart === null || prev.lastFrameAt === null) {
    return {
      state: {
        ...prev,
        windowStart: sample.now,
        lastFrameAt: sample.now,
        frames: 0,
      },
      triggeredEco: false,
      windowReset: false,
      completedWindowFps: null,
    }
  }

  const dt = sample.now - prev.lastFrameAt
  if (shouldIgnoreFrameDelta(dt, sample.hidden, sample.blurred, maxFrameDeltaMs)) {
    const restartFromNow = dt > maxFrameDeltaMs
    return {
      state: {
        ...prev,
        windowStart: restartFromNow ? sample.now : null,
        lastFrameAt: restartFromNow ? sample.now : null,
        frames: 0,
        consecutiveLowWindows: 0,
      },
      triggeredEco: false,
      windowReset: true,
      completedWindowFps: null,
    }
  }

  const frames = prev.frames + 1
  const elapsed = sample.now - prev.windowStart
  if (elapsed < windowMs) {
    return {
      state: {
        ...prev,
        lastFrameAt: sample.now,
        frames,
      },
      triggeredEco: false,
      windowReset: false,
      completedWindowFps: null,
    }
  }

  const fps = (frames * 1000) / elapsed
  if (fps < fpsThreshold) {
    const nextConsecutive = prev.consecutiveLowWindows + 1
    const triggeredEco = !prev.autoEco && nextConsecutive >= consecutiveWindows
    return {
      state: {
        windowStart: sample.now,
        lastFrameAt: sample.now,
        frames: 0,
        consecutiveLowWindows: nextConsecutive,
        autoEco: prev.autoEco || triggeredEco,
        lastFps: fps,
      },
      triggeredEco,
      windowReset: false,
      completedWindowFps: fps,
    }
  }

  return {
    state: {
      windowStart: sample.now,
      lastFrameAt: sample.now,
      frames: 0,
      consecutiveLowWindows: 0,
      autoEco: prev.autoEco,
      lastFps: fps,
    },
    triggeredEco: false,
    windowReset: false,
    completedWindowFps: fps,
  }
}

export function loadQualityPreference(
  storage?: Pick<Storage, 'getItem'> | null,
): TheaterQualityPreference {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    const raw = store?.getItem(THEATER_QUALITY_STORAGE_KEY)
    if (raw === 'eco' || raw === 'hd' || raw === 'auto') return raw
  } catch {
    // Ignore restricted/private storage environments.
  }
  return 'auto'
}

export function saveQualityPreference(
  pref: TheaterQualityPreference,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    store?.setItem(THEATER_QUALITY_STORAGE_KEY, pref)
  } catch {
    // Ignore restricted/private storage environments.
  }
}

export function resolveEffectiveTier(
  preference: TheaterQualityPreference,
  autoEngaged: boolean,
): TheaterQualityTier {
  if (preference === 'eco') return 'eco'
  if (preference === 'hd') return 'hd'
  return autoEngaged ? 'eco' : 'hd'
}

/**
 * 挂载在 theater 模式下：
 * - 立即检查 WebGL / reduced-motion，不满足直接回调切回经典视图
 * - 不再因低帧率强退 3D（真实低帧率由 `useTheaterPerfGuard` 自动降档为节能画质）
 */
export function useTheaterFallback(onFallback: (reason: TheaterFallbackReason) => void): void {
  const cbRef = useRef(onFallback)
  cbRef.current = onFallback

  useEffect(() => {
    const reason = detectInitialFallback()
    if (reason) {
      cbRef.current(reason)
    }
  }, [])
}

export interface TheaterPerfGuardState {
  /** Effective rendering quality tier right now ('eco' | 'hd'). */
  tier: TheaterQualityTier
  /** Convenience boolean: true when rendering in ECO tier. */
  eco: boolean
  /** Persisted user preference ('auto' | 'eco' | 'hd'). */
  preference: TheaterQualityPreference
  /** True when preference is 'auto' and sustained low foreground FPS auto-engaged ECO. */
  autoEngaged: boolean
  /** True when document.hidden === true (used to pause WebGL frameloop). */
  tabHidden: boolean
  /** Latest completed foreground window FPS measurement, or null if not yet sampled. */
  fps: number | null
  /** Explicitly set and persist quality preference ('auto' | 'eco' | 'hd'). */
  setPreference: (pref: TheaterQualityPreference) => void
  /** Toggle between ECO and HD and persist the explicit user choice. */
  toggleQuality: () => void
}

/**
 * Visibility-aware adaptive 3D performance monitor.
 * - Tracks `document.visibilityState` so Canvas can pause (`frameloop="never"`) in background tabs.
 * - Ignores hidden tabs, blurred windows, and >250ms resume/GC spikes.
 * - Auto-engages ECO tier only after 2 consecutive 4s foreground windows < 22fps (never kicks out of 3D).
 * - Persists user preference (`auto` | `eco` | `hd`) under `localStorage['0xaf-3d-quality']`.
 */
export function useTheaterPerfGuard(): TheaterPerfGuardState {
  const [preference, setPreferenceState] = useState<TheaterQualityPreference>(() =>
    loadQualityPreference(),
  )
  const [autoEngaged, setAutoEngaged] = useState(false)
  const [tabHidden, setTabHidden] = useState<boolean>(() =>
    typeof document !== 'undefined' ? Boolean(document.hidden) : false,
  )
  const [fps, setFps] = useState<number | null>(null)

  const windowStateRef = useRef<FpsWindowState>(createInitialFpsWindowState())
  const blurredRef = useRef<boolean>(
    typeof document !== 'undefined' && typeof document.hasFocus === 'function'
      ? !document.hasFocus()
      : false,
  )

  const tier = resolveEffectiveTier(preference, autoEngaged)
  const eco = tier === 'eco'

  const setPreference = useCallback((next: TheaterQualityPreference) => {
    saveQualityPreference(next)
    setPreferenceState(next)
    if (next !== 'auto') {
      setAutoEngaged(false)
    } else {
      windowStateRef.current = createInitialFpsWindowState()
      setAutoEngaged(false)
    }
  }, [])

  const toggleQuality = useCallback(() => {
    const next: TheaterQualityPreference = eco ? 'hd' : 'eco'
    saveQualityPreference(next)
    setPreferenceState(next)
    setAutoEngaged(false)
  }, [eco])

  // Track visibility & window focus so background/occluded windows never poison FPS sampling.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const onVisibilityChange = () => {
      setTabHidden(Boolean(document.hidden))
      windowStateRef.current = resetFpsSamplingWindow(windowStateRef.current)
    }
    const onBlur = () => {
      blurredRef.current = true
      windowStateRef.current = resetFpsSamplingWindow(windowStateRef.current)
    }
    const onFocus = () => {
      blurredRef.current = false
      windowStateRef.current = resetFpsSamplingWindow(windowStateRef.current)
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // Run lightweight foreground FPS sampling only while in 'auto' mode and not yet stepped down.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (preference !== 'auto' || autoEngaged || tabHidden) return

    windowStateRef.current = resetFpsSamplingWindow(windowStateRef.current)
    let rafId = 0

    const tick = (now: number) => {
      const res = evaluateFpsWindow(windowStateRef.current, {
        now,
        hidden: Boolean(document.hidden),
        blurred: blurredRef.current,
      })
      windowStateRef.current = res.state
      if (res.completedWindowFps !== null) {
        setFps(res.completedWindowFps)
      }
      if (res.triggeredEco) {
        setAutoEngaged(true)
        return
      }
      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [preference, autoEngaged, tabHidden])

  return {
    tier,
    eco,
    preference,
    autoEngaged,
    tabHidden,
    fps,
    setPreference,
    toggleQuality,
  }
}
