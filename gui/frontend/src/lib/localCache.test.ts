import { describe, expect, it } from 'vitest'
import {
  buildGreetingCacheKey,
  buildSessionMemorySnapshot,
  computeMemoryFingerprint,
  getCachedGreeting,
  getRecentSessionMemories,
  getTimeOfDayInfo,
  GREETING_CACHE_TTL_MS,
  loadWorkbenchCache,
  MAX_MEMORY_SESSIONS,
  recordRecentWorkspace,
  recordSessionMemory,
  setCachedGreeting,
  updateWorkbenchPrefs,
  WORKBENCH_CACHE_KEY,
  type GreetingResponse,
  type StorageLike,
} from './localCache'

function makeMemoryStorage(throwOnSet = false): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (throwOnSet) throw new Error('QuotaExceededError')
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
  }
}

describe('localCache — versioned workbench persistence', () => {
  it('persists and restores preferences, pane layout, and deduplicated recent workspaces', () => {
    const storage = makeMemoryStorage()

    updateWorkbenchPrefs(
      {
        activeView: 'classic',
        centerView: 'graph',
        graphMode: 'dag',
        configuredModel: 'codex-sol',
        configuredProvider: 'codex-sol',
        lastActiveSessionId: 'gui-3',
        paneLayout: { sidebarWidth: 260, sideCollapsed: true },
      },
      storage,
    )
    recordRecentWorkspace('/lab/alpha', storage)
    recordRecentWorkspace('/lab/beta', storage)
    recordRecentWorkspace('/lab/alpha', storage)

    const loaded = loadWorkbenchCache(storage)
    expect(loaded.version).toBe(1)
    expect(loaded.prefs.activeView).toBe('classic')
    expect(loaded.prefs.centerView).toBe('graph')
    expect(loaded.prefs.graphMode).toBe('dag')
    expect(loaded.prefs.configuredModel).toBe('codex-sol')
    expect(loaded.prefs.lastActiveSessionId).toBe('gui-3')
    expect(loaded.prefs.paneLayout?.sidebarWidth).toBe(260)
    expect(loaded.prefs.paneLayout?.sideCollapsed).toBe(true)
    expect(loaded.prefs.lastWorkspace).toBe('/lab/alpha')
    expect(loaded.prefs.recentWorkspaces).toEqual(['/lab/alpha', '/lab/beta'])
  })

  it('handles corrupted JSON, unknown schema versions, and storage quota errors safely', () => {
    const corrupted = makeMemoryStorage()
    corrupted.store.set(WORKBENCH_CACHE_KEY, '{not-valid-json')
    expect(loadWorkbenchCache(corrupted).sessions).toEqual([])

    corrupted.store.set(WORKBENCH_CACHE_KEY, JSON.stringify({ version: 999, sessions: [] }))
    expect(loadWorkbenchCache(corrupted).version).toBe(1)

    const blocked = makeMemoryStorage(true)
    expect(() => updateWorkbenchPrefs({ activeView: 'classic' }, blocked)).not.toThrow()
    expect(() => recordRecentWorkspace('/lab/x', blocked)).not.toThrow()
  })

  it('caps investigation memory snapshots to MAX_MEMORY_SESSIONS and isolates desktop vs demo scope', () => {
    const storage = makeMemoryStorage()
    for (let i = 1; i <= MAX_MEMORY_SESSIONS + 4; i += 1) {
      recordSessionMemory(
        {
          sessionId: `desk-${i}`,
          workspace: `/lab/project-${i}`,
          rePhase: 'dynamic',
          openHypotheses: [{ id: 'H-001', claim: 'key schedule at 0x4010', status: 'active' }],
          pendingCount: 1,
          unverifiedCount: 1,
          updatedAt: 1000 + i,
          scope: 'desktop',
        },
        storage,
      )
    }
    recordSessionMemory(
      {
        sessionId: 'demo-1',
        workspace: '/demo/reverse-lab',
        rePhase: 'verify',
        openHypotheses: [],
        pendingCount: 0,
        unverifiedCount: 0,
        updatedAt: 99999,
        scope: 'demo',
      },
      storage,
    )

    const all = loadWorkbenchCache(storage).sessions
    expect(all.length).toBeLessThanOrEqual(MAX_MEMORY_SESSIONS)

    const desktopOnly = getRecentSessionMemories('desktop', storage)
    const demoOnly = getRecentSessionMemories('demo', storage)
    expect(desktopOnly.every((s) => s.scope === 'desktop')).toBe(true)
    expect(desktopOnly.some((s) => s.workspace.includes('/demo/'))).toBe(false)
    expect(demoOnly).toHaveLength(1)
    expect(demoOnly[0].sessionId).toBe('demo-1')
  })

  it('extracts compact session snapshots without leaking assistant replies', () => {
    const snap = buildSessionMemorySnapshot(
      {
        info: { id: 's-1', workspace: '/lab/carrier', workflow: 'reverse', planner: 'codex-sol' },
        latestTick: {
          flow: {} as never,
          hud: {} as never,
          re: { sampleType: 'firmware', phase: 'verify', phaseIndex: 6, phaseCount: 9, hypotheses: 2, evidence: 4 },
          plan: {
            source: 'agent',
            note: '',
            updatedAt: 1,
            steps: [
              { id: '1', text: 'carve', status: 'completed', startedAt: 1, completedAt: 2 },
              { id: '2', text: 'audit', status: 'pending', startedAt: 0, completedAt: 0 },
            ],
          },
          ledger: {
            goal: {
              primary: '提取二阶段载荷并核验校验算法',
              targetFile: 'carrier.bin',
              accepted: true,
              criteria: [],
            },
            hypotheses: [
              {
                id: 'H-001',
                claim: 'XOR 密钥在偏移 0x40',
                confidence: 0.85,
                status: 'active',
                createdAt: 1,
                updatedAt: 2,
              },
              {
                id: 'H-002',
                claim: '已证伪假设',
                confidence: 0.1,
                status: 'rejected',
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            evidence: [],
          },
        },
        loopBuffer: [
          { type: 'user', text: '分析 carrier.bin 头部校验' } as never,
          { type: 'reply', text: 'Smoke complete — SECRET REPLY TEXT' } as never,
        ],
      },
      'desktop',
      5000,
    )

    expect(snap.targetFile).toBe('carrier.bin')
    expect(snap.rePhase).toBe('verify')
    expect(snap.openHypotheses).toHaveLength(1)
    expect(snap.openHypotheses[0].id).toBe('H-001')
    expect(snap.pendingCount).toBe(1)
    expect(snap.unverifiedCount).toBe(1)
    expect(snap.lastPrompt).toBe('分析 carrier.bin 头部校验')
    expect(JSON.stringify(snap)).not.toContain('Smoke complete')
  })

  it('caches greetings with 15-minute TTL and distinct fingerprint keys', () => {
    const storage = makeMemoryStorage()
    const now = Date.parse('2026-11-22T20:00:00Z')
    const fp1 = computeMemoryFingerprint([{ sessionId: 's-1', workspace: '/lab/a', rePhase: 'triage' }])
    const fp2 = computeMemoryFingerprint([{ sessionId: 's-1', workspace: '/lab/a', rePhase: 'verify' }])
    expect(fp1).not.toBe(fp2)

    const key = buildGreetingCacheKey('desktop', 'codex-sol', fp1, '2026-11-22:evening')
    const greeting: GreetingResponse = {
      salutation: '晚上好',
      summary: '上次停在 triage 阶段。',
      suggestions: [],
      model: 'codex-sol',
      provider: 'codex-sol',
      source: 'llm',
      generatedAt: now,
    }

    setCachedGreeting(key, greeting, now, GREETING_CACHE_TTL_MS, storage)
    expect(getCachedGreeting(key, now + 5 * 60 * 1000, storage)?.summary).toBe('上次停在 triage 阶段。')
    expect(getCachedGreeting(key, now + GREETING_CACHE_TTL_MS + 1, storage)).toBeNull()
  })

  it('maps local hours to Chinese time-of-day buckets', () => {
    expect(getTimeOfDayInfo(new Date(2026, 10, 22, 8, 30)).salutation).toBe('早上好')
    expect(getTimeOfDayInfo(new Date(2026, 10, 22, 14, 0)).salutation).toBe('下午好')
    expect(getTimeOfDayInfo(new Date(2026, 10, 22, 20, 0)).salutation).toBe('晚上好')
    expect(getTimeOfDayInfo(new Date(2026, 10, 22, 1, 15)).salutation).toBe('夜深了')
  })
})
