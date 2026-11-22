import { describe, expect, it, vi } from 'vitest'
import {
  GREETING_CACHE_TTL_MS,
  recordSessionMemory,
  type GreetingResponse,
  type StorageLike,
} from './localCache'
import {
  formatGreetingSourceChip,
  greetingActionGlyph,
  loadProactiveGreeting,
  synthesizeLocalGreeting,
} from './proactiveGreeting'

function makeStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

describe('proactiveGreeting orchestrator', () => {
  it('fetches from configured LLM on cache miss, caches response, and serves instant cache hit on reopen', async () => {
    const storage = makeStorage()
    recordSessionMemory(
      {
        sessionId: 'sess-1',
        workspace: '/lab/carrier-fw',
        targetFile: 'carrier.bin',
        rePhase: 'verify',
        openHypotheses: [{ id: 'H-004', claim: '偏移 0x40 处存在 XOR 密钥', status: 'active' }],
        pendingCount: 1,
        unverifiedCount: 1,
        updatedAt: 1000,
        scope: 'desktop',
      },
      storage,
    )

    const llmResponse: GreetingResponse = {
      salutation: '晚上好',
      summary: 'carrier.bin 已推进到 verify 阶段，建议立刻做独立审计复核。',
      suggestions: [
        {
          id: 's1',
          label: '继续上次任务',
          reason: '恢复 carrier-fw 会话',
          actionKind: 'resume_session',
          payload: 'sess-1',
        },
        {
          id: 's2',
          label: '运行 /audit 复核',
          reason: '验证 H-004 证据链完整性',
          actionKind: 'run_command',
          payload: '/audit',
        },
      ],
      model: 'codex-sol',
      provider: 'codex-sol',
      source: 'llm',
      generatedAt: Date.parse('2026-11-22T20:00:00'),
    }

    const fetcher = vi.fn(async () => llmResponse)
    const instantCalls: GreetingResponse[] = []
    const now = new Date(2026, 10, 22, 20, 0, 0)

    // First launch: cache miss → optimistic instant greeting + LLM call
    const first = await loadProactiveGreeting({
      scope: 'desktop',
      configuredModel: 'codex-sol',
      storage,
      now,
      fetcher,
      onInstant: (r) => instantCalls.push(r),
    })

    expect(first.fromCache).toBe(false)
    expect(first.response.source).toBe('llm')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(instantCalls).toHaveLength(1)
    expect(instantCalls[0].source).toBe('local-cache')

    // Second launch within 15-min TTL: cache hit → zero LLM calls!
    const secondInstant: GreetingResponse[] = []
    const second = await loadProactiveGreeting({
      scope: 'desktop',
      configuredModel: 'codex-sol',
      storage,
      now: new Date(now.getTime() + 3 * 60 * 1000),
      fetcher,
      onInstant: (r) => secondInstant.push(r),
    })

    expect(second.fromCache).toBe(true)
    expect(second.response.source).toBe('cached')
    expect(second.response.summary).toBe(llmResponse.summary)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(secondInstant).toHaveLength(1)

    // Force refresh (user clicks ↻) bypasses cache and re-queries LLM
    const refreshed = await loadProactiveGreeting({
      scope: 'desktop',
      configuredModel: 'codex-sol',
      storage,
      now: new Date(now.getTime() + 4 * 60 * 1000),
      forceRefresh: true,
      fetcher,
    })
    expect(refreshed.fromCache).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)

    // Switching configured model invalidates cache key cleanly
    const switchedModel = await loadProactiveGreeting({
      scope: 'desktop',
      configuredModel: 'glm-5.3',
      storage,
      now: new Date(now.getTime() + 5 * 60 * 1000),
      fetcher,
    })
    expect(switchedModel.fromCache).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(3)

    // After 15-min TTL expiry past the latest refresh (+4m), cache misses cleanly
    const expired = await loadProactiveGreeting({
      scope: 'desktop',
      configuredModel: 'codex-sol',
      storage,
      now: new Date(now.getTime() + 4 * 60 * 1000 + GREETING_CACHE_TTL_MS + 10_000),
      fetcher,
    })
    expect(expired.fromCache).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('gracefully falls back to deterministic local greeting when fetcher throws', async () => {
    const storage = makeStorage()
    const failingFetcher = vi.fn(async () => {
      throw new Error('offline')
    })

    const res = await loadProactiveGreeting({
      scope: 'desktop',
      configuredModel: 'codex-sol',
      activeSessionId: 'gui-1',
      activeWorkspace: '/lab/elf-sample',
      storage,
      now: new Date(2026, 10, 22, 10, 0, 0),
      fetcher: failingFetcher,
    })

    expect(res.response.source).toBe('local-cache')
    expect(res.response.salutation).toBe('早上好')
    expect(res.response.suggestions.length).toBeGreaterThanOrEqual(2)
    expect(res.response.suggestions[0].actionKind).toBe('open_re_picker')
  })

  it('synthesizes contextual Chinese suggestions and crisp source chips', () => {
    const resp = synthesizeLocalGreeting(
      {
        localHour: 15,
        activeSession: 's-1',
        preferredModel: 'codex-sol',
        recentSessions: [
          {
            sessionId: 's-1',
            workspace: '/demo/reverse-lab',
            targetFile: 'carrier.bin',
            rePhase: 'verify',
            unverifiedCount: 1,
            openHypotheses: [{ id: 'H-003', claim: '外联域名在动态初始化时解密', status: 'reevaluate' }],
          },
        ],
      },
      'local-model',
    )

    expect(resp.salutation).toBe('下午好')
    expect(resp.summary).toContain('carrier.bin')
    expect(resp.summary).toContain('重新评估')
    expect(resp.suggestions.some((s) => s.actionKind === 'run_command' && s.payload === '/audit')).toBe(true)

    const chip = formatGreetingSourceChip(resp)
    expect(chip.label).toContain('codex-sol')
    expect(greetingActionGlyph('resume_session')).toBe('↻')
    expect(greetingActionGlyph('run_command')).toBe('▶')
    expect(greetingActionGlyph('open_re_picker')).toBe('◈')
  })
})
