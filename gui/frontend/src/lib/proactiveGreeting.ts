// Proactive startup greeting orchestrator:
// 1. Serves cached greeting instantaneously when (scope + model + memoryFingerprint + timeBucket)
//    hits within the 15-minute TTL.
// 2. Immediately surfaces an optimistic local-memory greeting on cache miss so the UI never stalls.
// 3. Refreshes in the background via the user's configured LLM (Wails GreetWithModel) or
//    browser demo synthesis, caching the result cleanly for subsequent startups.

import { api } from './api'
import {
  buildGreetingCacheKey,
  computeMemoryFingerprint,
  getCachedGreeting,
  getRecentSessionMemories,
  getTimeOfDayInfo,
  GREETING_CACHE_TTL_MS,
  setCachedGreeting,
  synthesizeFallbackGreeting,
  type CacheScope,
  type GreetingActionKind,
  type GreetingRequest,
  type GreetingResponse,
  type GreetingSessionMemory,
  type GreetingSource,
  type StorageLike,
} from './localCache'

export interface LoadProactiveGreetingOptions {
  scope: CacheScope
  configuredModel: string
  configuredProvider?: string
  activeSessionId?: string | null
  activeWorkspace?: string | null
  /** Optional override for recent session memories (defaults to reading from localCache). */
  recentSessions?: GreetingSessionMemory[]
  forceRefresh?: boolean
  now?: Date
  ttlMs?: number
  storage?: StorageLike | null
  /** Injectable backend fetcher for unit tests (defaults to api.greetWithModel). */
  fetcher?: (req: GreetingRequest) => Promise<GreetingResponse>
  /** Fires immediately if a cached or optimistic greeting is ready before async LLM completion. */
  onInstant?: (resp: GreetingResponse) => void
}

export interface ProactiveGreetingResult {
  response: GreetingResponse
  fromCache: boolean
  cacheKey: string
}

export const synthesizeLocalGreeting = synthesizeFallbackGreeting

export function greetingActionGlyph(kind: GreetingActionKind): string {
  switch (kind) {
    case 'resume_session':
      return '↻'
    case 'run_command':
      return '▶'
    case 'open_re_picker':
      return '◈'
    case 'new_session':
      return '＋'
    case 'send_prompt':
      return '⚡'
    case 'fill_prompt':
    default:
      return '›'
  }
}

export function formatGreetingSourceChip(resp: GreetingResponse): {
  label: string
  hint: string
} {
  const modelLabel = (resp.model || resp.provider || '').trim()
  const modelPrefix = modelLabel ? `${modelLabel} · ` : ''
  const stamp = resp.generatedAt ? formatShortTime(resp.generatedAt) : ''
  const timeSuffix = stamp ? `（更新于 ${stamp}）` : ''

  switch (resp.source) {
    case 'llm':
      return {
        label: `${modelPrefix}LLM 实时建议`,
        hint: `由当前配置的 ${modelLabel || 'LLM'} 基于本地会话记忆生成${timeSuffix}`,
      }
    case 'cached':
      return {
        label: `${modelPrefix}已从本地缓存同步`,
        hint: `命中 15 分钟本地缓存，零延迟展示${timeSuffix}；点击 ↻ 可强制重新请求模型`,
      }
    case 'local-model':
      return {
        label: `${modelPrefix}沙盒上下文推演`,
        hint: `当前处于浏览器演示环境，已结合模型配置与本地会话缓存生成建议${timeSuffix}`,
      }
    case 'local-cache':
    default:
      return {
        label: modelLabel ? `${modelLabel} · 本地记忆回退` : '本地记忆缓存',
        hint: resp.fallbackNote
          ? `未调用远程模型（${resp.fallbackNote}），已基于本地缓存记忆生成建议${timeSuffix}`
          : `离线/本地缓存模式，已基于近期会话记忆生成建议${timeSuffix}`,
      }
  }
}

function formatShortTime(tsMs: number): string {
  try {
    const d = new Date(tsMs)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  } catch {
    return ''
  }
}

export async function loadProactiveGreeting(
  opts: LoadProactiveGreetingOptions,
): Promise<ProactiveGreetingResult> {
  const nowDate = opts.now ?? new Date()
  const nowMs = nowDate.getTime()
  const tod = getTimeOfDayInfo(nowDate)
  const ttlMs = opts.ttlMs ?? GREETING_CACHE_TTL_MS
  const activeSession = (opts.activeSessionId ?? '').trim()
  const activeWorkspace = (opts.activeWorkspace ?? '').trim()
  const preferredModel = (opts.configuredModel || opts.configuredProvider || '').trim()

  const recentSessions: GreetingSessionMemory[] =
    opts.recentSessions ??
    getRecentSessionMemories(opts.scope, opts.storage).map((s) => ({
      sessionId: s.sessionId,
      workspace: s.workspace,
      targetFile: s.targetFile,
      objective: s.objective,
      rePhase: s.rePhase,
      openHypotheses: s.openHypotheses,
      pendingCount: s.pendingCount,
      unverifiedCount: s.unverifiedCount,
      lastPrompt: s.lastPrompt,
      updatedAt: s.updatedAt,
    }))

  const fingerprint = computeMemoryFingerprint(recentSessions, activeSession)
  const timeBucketKey = `${tod.dateKey}:${tod.bucket}`
  const cacheKey = buildGreetingCacheKey(opts.scope, preferredModel, fingerprint, timeBucketKey)

  // Step 1: Instant cache hit (unless user explicitly requested a force refresh)
  if (!opts.forceRefresh) {
    const cached = getCachedGreeting(cacheKey, nowMs, opts.storage)
    if (cached) {
      const hit: GreetingResponse = {
        ...cached,
        source: 'cached',
      }
      opts.onInstant?.(hit)
      return { response: hit, fromCache: true, cacheKey }
    }
  }

  const req: GreetingRequest = {
    timeOfDay: tod.bucket,
    localHour: tod.hour,
    activeSession: activeSession || undefined,
    activeWorkspace: activeWorkspace || undefined,
    preferredModel: preferredModel || undefined,
    recentSessions: recentSessions.slice(0, 4),
    forceRefresh: Boolean(opts.forceRefresh),
  }

  // Step 2: Surface instant local synthesis while waiting on the configured LLM
  const optimistic = synthesizeFallbackGreeting(req, 'local-cache', nowMs)
  opts.onInstant?.(optimistic)

  // Step 3: Fetch fresh greeting from configured LLM (or browser demo bridge)
  const fetcher = opts.fetcher ?? api.greetWithModel
  try {
    const fresh = await fetcher(req)
    const normalized: GreetingResponse = {
      salutation: fresh.salutation?.trim() || optimistic.salutation,
      summary: fresh.summary?.trim() || optimistic.summary,
      suggestions:
        Array.isArray(fresh.suggestions) && fresh.suggestions.length > 0
          ? fresh.suggestions.slice(0, 3)
          : optimistic.suggestions,
      model: fresh.model?.trim() || preferredModel || optimistic.model,
      provider: fresh.provider?.trim() || opts.configuredProvider || optimistic.provider,
      source: normalizeSource(fresh.source),
      generatedAt: fresh.generatedAt || nowMs,
      fallbackNote: fresh.fallbackNote,
    }
    setCachedGreeting(cacheKey, normalized, nowMs, ttlMs, opts.storage)
    return { response: normalized, fromCache: false, cacheKey }
  } catch {
    setCachedGreeting(cacheKey, optimistic, nowMs, ttlMs, opts.storage)
    return { response: optimistic, fromCache: false, cacheKey }
  }
}

function normalizeSource(src: string | undefined): GreetingSource {
  if (src === 'llm' || src === 'cached' || src === 'local-model' || src === 'local-cache') {
    return src
  }
  return 'local-cache'
}
