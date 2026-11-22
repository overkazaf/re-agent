// Versioned localStorage workbench cache: preferences & layout state,
// compact investigation memory snapshots (capped to 8 sessions, scope-isolated
// between real desktop and demo sandbox), and 15-minute TTL greeting cache.

import type { LoopEvent, TickDTO } from './types'

export const WORKBENCH_CACHE_KEY = '0xaf:workbench-cache:v1'
export const WORKBENCH_CACHE_VERSION = 1 as const
export const MAX_MEMORY_SESSIONS = 8
export const MAX_RECENT_WORKSPACES = 8
export const MAX_GREETING_CACHE_ENTRIES = 4
export const GREETING_CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

export type CacheScope = 'desktop' | 'demo'
export type CachedActiveView = 'classic' | '3d' | 'shell'
export type CachedCenterView = 'dashboard' | 'graph' | 'terrain'
export type CachedGraphMode = 'pipeline' | 'dag' | 'writeup'
export type TimeOfDayBucket = 'morning' | 'afternoon' | 'evening' | 'late_night'

export type GreetingActionKind =
  | 'resume_session'
  | 'send_prompt'
  | 'fill_prompt'
  | 'run_command'
  | 'open_re_picker'
  | 'new_session'

export type GreetingSource = 'llm' | 'cached' | 'local-cache' | 'local-model'

export interface CachedHypothesisBrief {
  id: string
  claim: string
  status: string
}

export interface CachedSessionMemory {
  sessionId: string
  workspace: string
  targetFile?: string
  objective?: string
  rePhase?: string
  openHypotheses: CachedHypothesisBrief[]
  pendingCount: number
  unverifiedCount: number
  lastPrompt?: string
  updatedAt: number
  scope: CacheScope
}

export interface GreetingSessionMemory {
  sessionId: string
  workspace: string
  targetFile?: string
  objective?: string
  rePhase?: string
  openHypotheses?: CachedHypothesisBrief[]
  pendingCount?: number
  unverifiedCount?: number
  lastPrompt?: string
  updatedAt?: number
}

export interface GreetingRequest {
  timeOfDay?: TimeOfDayBucket
  localHour?: number
  activeSession?: string
  activeWorkspace?: string
  preferredModel?: string
  recentSessions?: GreetingSessionMemory[]
  forceRefresh?: boolean
}

export interface GreetingSuggestion {
  id: string
  label: string
  reason: string
  actionKind: GreetingActionKind
  payload: string
}

export interface GreetingResponse {
  salutation: string
  summary: string
  suggestions: GreetingSuggestion[]
  model: string
  provider: string
  source: GreetingSource
  generatedAt: number
  fallbackNote?: string
}

export interface CachedPaneLayout {
  sidebarWidth?: number
  sideWidth?: number
  transcriptHeight?: number
  sidebarCollapsed?: boolean
  sideCollapsed?: boolean
  dashboardCollapsed?: boolean
  transcriptCollapsed?: boolean
}

export interface WorkbenchPrefs {
  activeView: CachedActiveView
  centerView: CachedCenterView
  graphMode: CachedGraphMode
  paneLayout?: CachedPaneLayout
  lastWorkspace: string
  recentWorkspaces: string[]
  lastActiveSessionId: string
  configuredModel: string
  configuredProvider: string
}

export interface CachedGreetingEntry {
  key: string
  cachedAt: number
  expiresAt: number
  response: GreetingResponse
}

export interface WorkbenchCacheV1 {
  version: typeof WORKBENCH_CACHE_VERSION
  updatedAt: number
  prefs: WorkbenchPrefs
  sessions: CachedSessionMemory[]
  greetingCache: Record<string, CachedGreetingEntry>
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export interface SessionRuntimeLike {
  info: {
    id: string
    workspace: string
    workflow?: string
    planner?: string
    executor?: string
  }
  latestTick: TickDTO | null
  loopBuffer: LoopEvent[]
}

export interface TimeOfDayInfo {
  bucket: TimeOfDayBucket
  hour: number
  dateKey: string
  salutation: string
}

const DEFAULT_PREFS: WorkbenchPrefs = {
  activeView: '3d',
  centerView: 'dashboard',
  graphMode: 'pipeline',
  lastWorkspace: '',
  recentWorkspaces: [],
  lastActiveSessionId: '',
  configuredModel: '',
  configuredProvider: '',
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch {
    // Private mode / restricted iframe / SSR
  }
  return null
}

export function createEmptyWorkbenchCache(now = Date.now()): WorkbenchCacheV1 {
  return {
    version: WORKBENCH_CACHE_VERSION,
    updatedAt: now,
    prefs: { ...DEFAULT_PREFS, recentWorkspaces: [] },
    sessions: [],
    greetingCache: {},
  }
}

export function truncateText(text: string | undefined | null, maxLen: number): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxLen) return flat
  if (maxLen <= 1) return flat.slice(0, maxLen)
  return `${flat.slice(0, maxLen - 1)}…`
}

export function workspaceBaseName(path: string | undefined | null): string {
  if (!path) return 'workspace'
  const cleaned = path.trim().replace(/[/\\]+$/, '')
  if (!cleaned) return 'workspace'
  const parts = cleaned.split(/[/\\]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : cleaned
}

function sanitizeHypothesisBrief(raw: unknown): CachedHypothesisBrief | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const claim = typeof r.claim === 'string' ? truncateText(r.claim, 96) : ''
  const status = typeof r.status === 'string' ? r.status.trim() : 'active'
  if (!id || !claim) return null
  return { id, claim, status }
}

function sanitizeSessionMemory(raw: unknown): CachedSessionMemory | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId.trim() : ''
  const workspace = typeof r.workspace === 'string' ? r.workspace.trim() : ''
  if (!sessionId || !workspace) return null
  const scope: CacheScope = r.scope === 'demo' ? 'demo' : 'desktop'
  const hyps = Array.isArray(r.openHypotheses)
    ? r.openHypotheses.map(sanitizeHypothesisBrief).filter((h): h is CachedHypothesisBrief => h !== null).slice(0, 5)
    : []
  return {
    sessionId,
    workspace,
    targetFile: typeof r.targetFile === 'string' && r.targetFile.trim() ? truncateText(r.targetFile, 80) : undefined,
    objective: typeof r.objective === 'string' && r.objective.trim() ? truncateText(r.objective, 140) : undefined,
    rePhase: typeof r.rePhase === 'string' && r.rePhase.trim() ? r.rePhase.trim() : undefined,
    openHypotheses: hyps,
    pendingCount: Math.max(0, Number(r.pendingCount) || 0),
    unverifiedCount: Math.max(0, Number(r.unverifiedCount) || 0),
    lastPrompt: typeof r.lastPrompt === 'string' && r.lastPrompt.trim() ? truncateText(r.lastPrompt, 120) : undefined,
    updatedAt: Number(r.updatedAt) || 0,
    scope,
  }
}

function sanitizePrefs(raw: unknown): WorkbenchPrefs {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_PREFS, recentWorkspaces: [] }
  }
  const r = raw as Record<string, unknown>
  const activeView: CachedActiveView =
    r.activeView === 'classic' || r.activeView === '3d' || r.activeView === 'shell' ? r.activeView : '3d'
  const centerView: CachedCenterView =
    r.centerView === 'dashboard' || r.centerView === 'graph' || r.centerView === 'terrain'
      ? r.centerView
      : 'dashboard'
  const graphMode: CachedGraphMode =
    r.graphMode === 'pipeline' || r.graphMode === 'dag' || r.graphMode === 'writeup' ? r.graphMode : 'pipeline'
  const recentWorkspaces = Array.isArray(r.recentWorkspaces)
    ? r.recentWorkspaces
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .slice(0, MAX_RECENT_WORKSPACES)
    : []
  let paneLayout: CachedPaneLayout | undefined
  if (r.paneLayout && typeof r.paneLayout === 'object') {
    const p = r.paneLayout as Record<string, unknown>
    paneLayout = {
      sidebarWidth: typeof p.sidebarWidth === 'number' ? p.sidebarWidth : undefined,
      sideWidth: typeof p.sideWidth === 'number' ? p.sideWidth : undefined,
      transcriptHeight: typeof p.transcriptHeight === 'number' ? p.transcriptHeight : undefined,
      sidebarCollapsed: typeof p.sidebarCollapsed === 'boolean' ? p.sidebarCollapsed : undefined,
      sideCollapsed: typeof p.sideCollapsed === 'boolean' ? p.sideCollapsed : undefined,
      dashboardCollapsed: typeof p.dashboardCollapsed === 'boolean' ? p.dashboardCollapsed : undefined,
      transcriptCollapsed: typeof p.transcriptCollapsed === 'boolean' ? p.transcriptCollapsed : undefined,
    }
  }
  return {
    activeView,
    centerView,
    graphMode,
    paneLayout,
    lastWorkspace: typeof r.lastWorkspace === 'string' ? r.lastWorkspace : '',
    recentWorkspaces,
    lastActiveSessionId: typeof r.lastActiveSessionId === 'string' ? r.lastActiveSessionId : '',
    configuredModel: typeof r.configuredModel === 'string' ? r.configuredModel : '',
    configuredProvider: typeof r.configuredProvider === 'string' ? r.configuredProvider : '',
  }
}

function sanitizeGreetingCache(raw: unknown): Record<string, CachedGreetingEntry> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, CachedGreetingEntry> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue
    const e = val as Record<string, unknown>
    const resp = e.response as GreetingResponse | undefined
    if (
      !resp ||
      typeof resp !== 'object' ||
      typeof resp.salutation !== 'string' ||
      typeof resp.summary !== 'string' ||
      !Array.isArray(resp.suggestions)
    ) {
      continue
    }
    out[key] = {
      key,
      cachedAt: Number(e.cachedAt) || 0,
      expiresAt: Number(e.expiresAt) || 0,
      response: resp,
    }
  }
  return out
}

export function loadWorkbenchCache(storage: StorageLike | null = defaultStorage()): WorkbenchCacheV1 {
  if (!storage) return createEmptyWorkbenchCache()
  try {
    const raw = storage.getItem(WORKBENCH_CACHE_KEY)
    if (!raw) return createEmptyWorkbenchCache()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || parsed.version !== WORKBENCH_CACHE_VERSION) {
      return createEmptyWorkbenchCache()
    }
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .map(sanitizeSessionMemory)
          .filter((s): s is CachedSessionMemory => s !== null)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_MEMORY_SESSIONS)
      : []
    return {
      version: WORKBENCH_CACHE_VERSION,
      updatedAt: Number(parsed.updatedAt) || Date.now(),
      prefs: sanitizePrefs(parsed.prefs),
      sessions,
      greetingCache: sanitizeGreetingCache(parsed.greetingCache),
    }
  } catch {
    return createEmptyWorkbenchCache()
  }
}

export function saveWorkbenchCache(
  cache: WorkbenchCacheV1,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false
  const payload: WorkbenchCacheV1 = {
    ...cache,
    version: WORKBENCH_CACHE_VERSION,
    updatedAt: Date.now(),
    sessions: cache.sessions.slice(0, MAX_MEMORY_SESSIONS),
  }
  try {
    storage.setItem(WORKBENCH_CACHE_KEY, JSON.stringify(payload))
    return true
  } catch {
    // Quota exceeded or private mode — retry once after shedding greeting cache
    try {
      storage.setItem(
        WORKBENCH_CACHE_KEY,
        JSON.stringify({ ...payload, greetingCache: {} }),
      )
      return true
    } catch {
      return false
    }
  }
}

export function updateWorkbenchPrefs(
  patch: Partial<WorkbenchPrefs>,
  storage: StorageLike | null = defaultStorage(),
): WorkbenchPrefs {
  const cache = loadWorkbenchCache(storage)
  const nextPrefs: WorkbenchPrefs = {
    ...cache.prefs,
    ...patch,
    recentWorkspaces: patch.recentWorkspaces
      ? patch.recentWorkspaces.filter((w) => w.trim().length > 0).slice(0, MAX_RECENT_WORKSPACES)
      : cache.prefs.recentWorkspaces,
  }
  saveWorkbenchCache({ ...cache, prefs: nextPrefs }, storage)
  return nextPrefs
}

export function recordRecentWorkspace(
  workspace: string,
  storage: StorageLike | null = defaultStorage(),
): string[] {
  const dir = workspace.trim()
  if (!dir) return loadWorkbenchCache(storage).prefs.recentWorkspaces
  const cache = loadWorkbenchCache(storage)
  const deduped = [dir, ...cache.prefs.recentWorkspaces.filter((w) => w !== dir)].slice(
    0,
    MAX_RECENT_WORKSPACES,
  )
  const nextPrefs: WorkbenchPrefs = {
    ...cache.prefs,
    lastWorkspace: dir,
    recentWorkspaces: deduped,
  }
  saveWorkbenchCache({ ...cache, prefs: nextPrefs }, storage)
  return deduped
}

/** Extract a compact, safe investigation snapshot from a live SessionRuntime.
 *  Deliberately excludes assistant reply prose to keep storage tiny and avoid
 *  cross-session text bleed. */
export function buildSessionMemorySnapshot(
  runtime: SessionRuntimeLike,
  scope: CacheScope,
  now = Date.now(),
): CachedSessionMemory {
  const tick = runtime.latestTick
  const ledger = tick?.ledger
  const goal = ledger?.goal

  const openHypotheses: CachedHypothesisBrief[] = (ledger?.hypotheses ?? [])
    .filter((h) => h.status !== 'rejected')
    .slice(0, 5)
    .map((h) => ({
      id: h.id,
      claim: truncateText(h.claim, 96),
      status: h.status,
    }))

  // Unverified count: active/reevaluate hypotheses that lack verification evidence
  const verifiedEvidenceIds = new Set(
    (ledger?.evidence ?? [])
      .filter((ev) => ev.kind === 'verification_result' || Boolean(ev.verification))
      .map((ev) => ev.id),
  )
  let unverifiedCount = 0
  for (const h of ledger?.hypotheses ?? []) {
    if (h.status === 'rejected') continue
    const hasVerifiedSupport = (h.supporting ?? []).some((id) => verifiedEvidenceIds.has(id))
    const hasPassedExp = (h.experiments ?? []).some((exp) => exp.status === 'passed')
    if (h.status === 'reevaluate' || (!hasVerifiedSupport && !hasPassedExp)) {
      unverifiedCount += 1
    }
  }

  const pendingCount = (tick?.plan?.steps ?? []).filter((s) => s.status !== 'completed').length

  let lastPrompt = ''
  for (let i = runtime.loopBuffer.length - 1; i >= 0; i -= 1) {
    const ev = runtime.loopBuffer[i]
    if (ev.type === 'user' && ev.text && ev.text.trim()) {
      lastPrompt = truncateText(ev.text, 120)
      break
    }
  }

  return {
    sessionId: runtime.info.id,
    workspace: runtime.info.workspace,
    targetFile: goal?.targetFile ? truncateText(goal.targetFile, 80) : undefined,
    objective: goal?.primary ? truncateText(goal.primary, 140) : undefined,
    rePhase: tick?.re?.phase || (runtime.info.workflow && runtime.info.workflow !== 'off' ? runtime.info.workflow : undefined),
    openHypotheses,
    pendingCount,
    unverifiedCount,
    lastPrompt: lastPrompt || undefined,
    updatedAt: now,
    scope,
  }
}

export function recordSessionMemory(
  snapshot: CachedSessionMemory,
  storage: StorageLike | null = defaultStorage(),
): CachedSessionMemory[] {
  const sanitized = sanitizeSessionMemory(snapshot)
  if (!sanitized) return loadWorkbenchCache(storage).sessions

  const cache = loadWorkbenchCache(storage)
  const filtered = cache.sessions.filter(
    (s) => !(s.sessionId === sanitized.sessionId && s.scope === sanitized.scope),
  )
  // Keep up to MAX_MEMORY_SESSIONS overall, preserving newest per entry
  const nextSessions = [sanitized, ...filtered]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_MEMORY_SESSIONS)

  saveWorkbenchCache({ ...cache, sessions: nextSessions }, storage)
  return nextSessions
}

export function getRecentSessionMemories(
  scope: CacheScope,
  storage: StorageLike | null = defaultStorage(),
): CachedSessionMemory[] {
  const cache = loadWorkbenchCache(storage)
  return cache.sessions
    .filter((s) => s.scope === scope)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_MEMORY_SESSIONS)
}

export function getTimeOfDayInfo(now: Date = new Date()): TimeOfDayInfo {
  const hour = now.getHours()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const dateKey = `${yyyy}-${mm}-${dd}`
  if (hour >= 5 && hour < 12) {
    return { bucket: 'morning', hour, dateKey, salutation: '早上好' }
  }
  if (hour >= 12 && hour < 18) {
    return { bucket: 'afternoon', hour, dateKey, salutation: '下午好' }
  }
  if (hour >= 18 && hour < 23) {
    return { bucket: 'evening', hour, dateKey, salutation: '晚上好' }
  }
  return { bucket: 'late_night', hour, dateKey, salutation: '夜深了' }
}

/** Deterministic compact hash over session memories + active target. */
export function computeMemoryFingerprint(
  sessions: readonly GreetingSessionMemory[],
  activeSessionId = '',
): string {
  const canonical = JSON.stringify({
    a: activeSessionId,
    s: sessions.slice(0, 4).map((s) => ({
      id: s.sessionId,
      w: s.workspace,
      t: s.targetFile ?? '',
      p: s.rePhase ?? '',
      o: s.objective ?? '',
      l: s.lastPrompt ?? '',
      pc: s.pendingCount ?? 0,
      uc: s.unverifiedCount ?? 0,
      h: (s.openHypotheses ?? []).slice(0, 3).map((h) => `${h.id}:${h.status}`),
    })),
  })
  let hash = 2166136261
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function buildGreetingCacheKey(
  scope: CacheScope,
  configuredModel: string,
  memoryFingerprint: string,
  timeBucket: string,
): string {
  const modelKey = configuredModel.trim().toLowerCase() || 'default'
  return `${scope}|${modelKey}|${memoryFingerprint}|${timeBucket}`
}

export function getCachedGreeting(
  key: string,
  now = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): GreetingResponse | null {
  const cache = loadWorkbenchCache(storage)
  const entry = cache.greetingCache[key]
  if (!entry) return null
  if (entry.expiresAt <= now) return null
  return entry.response
}

export function setCachedGreeting(
  key: string,
  response: GreetingResponse,
  now = Date.now(),
  ttlMs = GREETING_CACHE_TTL_MS,
  storage: StorageLike | null = defaultStorage(),
): void {
  const cache = loadWorkbenchCache(storage)
  const nextMap: Record<string, CachedGreetingEntry> = {}

  // Drop expired entries and keep at most MAX_GREETING_CACHE_ENTRIES - 1 old entries
  const validOld = Object.values(cache.greetingCache)
    .filter((entry) => entry.key !== key && entry.expiresAt > now)
    .sort((a, b) => b.cachedAt - a.cachedAt)
    .slice(0, MAX_GREETING_CACHE_ENTRIES - 1)

  for (const entry of validOld) {
    nextMap[entry.key] = entry
  }
  nextMap[key] = {
    key,
    cachedAt: now,
    expiresAt: now + ttlMs,
    response,
  }
  saveWorkbenchCache({ ...cache, greetingCache: nextMap }, storage)
}

/** Pure deterministic Chinese greeting & next-step synthesizer shared by both
 *  the browser/demo bridge and offline/fallback flows. */
export function synthesizeFallbackGreeting(
  req: GreetingRequest,
  source: GreetingSource = 'local-cache',
  now = Date.now(),
): GreetingResponse {
  const hour = typeof req.localHour === 'number' ? req.localHour : new Date(now).getHours()
  const bucket: TimeOfDayBucket =
    req.timeOfDay ??
    (hour >= 5 && hour < 12
      ? 'morning'
      : hour >= 12 && hour < 18
        ? 'afternoon'
        : hour >= 18 && hour < 23
          ? 'evening'
          : 'late_night')

  const salutation =
    bucket === 'morning'
      ? '早上好'
      : bucket === 'afternoon'
        ? '下午好'
        : bucket === 'evening'
          ? '晚上好'
          : '夜深了'

  const model = (req.preferredModel || '').trim() || 'local-planner'
  const recent = req.recentSessions ?? []
  const suggestions: GreetingSuggestion[] = []
  let summary = ''

  if (recent.length === 0) {
    const ws = req.activeWorkspace ? workspaceBaseName(req.activeWorkspace) : ''
    summary = ws
      ? `工作区 ${ws} 已就绪，暂无历史假设或取证缓存。建议选择样本类型启动 9 阶段逆向主线，或直接发起静态分诊。`
      : '工作台已就绪，本地暂无历史逆向会话记录。可以新建工作区会话，或快速启动 9 阶段逆向取证。'

    if (req.activeSession) {
      suggestions.push(
        {
          id: 'open-re-picker',
          label: '新建逆向样本',
          reason: '按样本类型（ELF/APK/PE/固件）开启 9 阶段逆向取证流程',
          actionKind: 'open_re_picker',
          payload: '',
        },
        {
          id: 'quick-triage',
          label: '快速工作区盘点',
          reason: '自动检查当前工作区目标文件结构与入口特征',
          actionKind: 'fill_prompt',
          payload: '先扫描当前工作区文件结构与可疑二进制入口，给出下一步逆向分诊建议',
        },
      )
    } else {
      suggestions.push(
        {
          id: 'new-session',
          label: '新建逆向会话',
          reason: '选择一个本地工作区目录并初始化分析会话',
          actionKind: 'new_session',
          payload: '',
        },
        {
          id: 'slash-help',
          label: '查看命令速览',
          reason: '查看内置离线取证、解码与对抗审计命令',
          actionKind: 'fill_prompt',
          payload: '/help',
        },
      )
    }
  } else {
    const latest = recent[0]
    const ws = workspaceBaseName(latest.workspace)
    const target = latest.targetFile ? workspaceBaseName(latest.targetFile) : ''
    const openHyps = latest.openHypotheses ?? []
    const reevalCount = openHyps.filter((h) => h.status === 'reevaluate').length

    const clauses: string[] = []
    if (latest.rePhase) {
      clauses.push(
        target
          ? `上次在 ${ws} 分析 ${target} 停留在 ${latest.rePhase} 阶段`
          : `上次在 ${ws} 停留在 ${latest.rePhase} 阶段`,
      )
    } else if (target) {
      clauses.push(`上次在 ${ws} 分析目标 ${target}`)
    } else {
      clauses.push(`上次在工作区 ${ws} 进行逆向分析`)
    }

    if (reevalCount > 0) {
      clauses.push(`有 ${reevalCount} 条假设待重新评估`)
    } else if (openHyps.length > 0) {
      clauses.push(`当前保留 ${openHyps.length} 条活跃假设`)
    }

    if ((latest.unverifiedCount ?? 0) > 0) {
      clauses.push(`${latest.unverifiedCount} 项结论尚待动态验证`)
    } else if ((latest.pendingCount ?? 0) > 0) {
      clauses.push(`${latest.pendingCount} 个计划步骤待完成`)
    }
    summary = `${clauses.join('，')}。`

    // Suggestion 1: Resume previous session or push top hypothesis forward
    if (latest.sessionId && latest.sessionId !== req.activeSession) {
      suggestions.push({
        id: 'resume-last',
        label: '继续上次任务',
        reason: `恢复 ${ws} 的历史上下文、假设栈与取证进度`,
        actionKind: 'resume_session',
        payload: latest.sessionId,
      })
    } else if (openHyps.length > 0) {
      const top = openHyps[0]
      suggestions.push({
        id: 'advance-hyp',
        label: `推进 ${top.id} 验证`,
        reason: `围绕假设 ${top.id}（${truncateText(top.claim, 32)}）补齐动静态交叉证据`,
        actionKind: 'fill_prompt',
        payload: `基于现有证据账本继续验证假设 ${top.id}（${truncateText(top.claim, 56)}），给出最小可证伪实验`,
      })
    } else if (latest.lastPrompt) {
      suggestions.push({
        id: 'continue-prompt',
        label: '接续上次分析',
        reason: `延续上次指令：${truncateText(latest.lastPrompt, 36)}`,
        actionKind: 'fill_prompt',
        payload: `接着上次进度继续推进：${truncateText(latest.lastPrompt, 72)}`,
      })
    }

    // Suggestion 2: /audit when hypotheses/verify/audit state exists, else phase check
    const phase = (latest.rePhase || '').toLowerCase()
    if (
      req.activeSession &&
      (phase === 'verify' || phase === 'audit' || openHyps.length > 0 || (latest.unverifiedCount ?? 0) > 0)
    ) {
      suggestions.push({
        id: 'run-audit',
        label: '执行 /audit 复核',
        reason: '触发独立第三席位对抗审计，检查证据链与假设缺口',
        actionKind: 'run_command',
        payload: '/audit',
      })
    } else if (req.activeSession && phase) {
      suggestions.push({
        id: 'check-phase',
        label: '查看 /phase 进度',
        reason: `确认当前 ${latest.rePhase} 阶段准出条件与下一阶段任务`,
        actionKind: 'run_command',
        payload: '/phase',
      })
    }

    // Suggestion 3: Open RE picker or new session
    if (suggestions.length < 3) {
      if (req.activeSession) {
        suggestions.push({
          id: 'open-re-picker',
          label: '新建逆向样本',
          reason: '在当前会话启动新的样本分诊与 9 阶段工作流',
          actionKind: 'open_re_picker',
          payload: '',
        })
      } else {
        suggestions.push({
          id: 'new-session',
          label: '新建逆向会话',
          reason: '创建新的独立工作区会话',
          actionKind: 'new_session',
          payload: '',
        })
      }
    }
  }

  return {
    salutation,
    summary,
    suggestions: suggestions.slice(0, 3),
    model,
    provider: model,
    source,
    generatedAt: now,
  }
}
