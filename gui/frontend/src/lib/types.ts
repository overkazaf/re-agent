// FROZEN CONTRACT — mirror of gui/dto.go and docs/plans/2026-11-03-gui-implementation.md §0.
// The freeze served the parallel workstream build; that build is complete and
// amendments now go through normal review: keep this file mirroring gui/dto.go.

// ---------- lifecycle ----------
export type LifecycleState = 'idle' | 'running' | 'awaiting_approval' | 'closed'

export interface StartOptions {
  workspace: string
  role: string
  workflow: string
  mock: boolean
}

export interface SessionInfo {
  id: string
  workspace: string
  role: string
  workflow: string
  planner: string
  executor: string
  lifecycle: LifecycleState
}

export interface SessionSummaryDTO {
  id: string
  hash: string
  updatedAt: string
  messages: number
  workspace: string
  firstPrompt: string
}

export interface NoticeDTO {
  level: 'info' | 'error'
  text: string
}

export interface CommandResultDTO {
  ok: boolean
  notices: NoticeDTO[]
}

// ---------- approval ----------
export type ApprovalDecision = 'allow' | 'allow-always' | 'deny' | 'deny-always'

export interface ApprovalDTO {
  requestID: string
  toolName: string
  risk: 'read' | 'write' | 'network' | 'exec'
  summary: string
  argsPreview: string
}

// ---------- tokens ----------
export interface TokenUsage {
  input: number
  output: number
  thinking: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

// ---------- flow ----------
export type FlowStage =
  | 'idle' | 'send' | 'wait' | 'think' | 'calls' | 'tool' | 'write' | 'done' | 'error'

export interface ToolRunSnapshot {
  id: number
  name: string
  argsText: string
  preview: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  finishedAt: number
  ms: number
  ok: boolean
}

export interface PlanBadge {
  done: number
  total: number
  source: string
}

export interface FlowDTO {
  stage: FlowStage
  turn: number
  provider: string
  model: string
  endpoint: string
  messages: number
  sentTokens: number
  usage: TokenUsage
  pendingCalls: number
  activeTool: string
  toolStartedAt: number
  toolMs: number
  toolsOk: number
  toolsFailed: number
  toolRuns: ToolRunSnapshot[]
  replyChars: number
  compactedDrop: number
  compactedElide: number
  hasCompacted: boolean
  plan: PlanBadge | null
  planKind: '' | 'open' | 'write' | 'step'
  error: string
  frame: number
  packets: number[][]
  since: number
}

// ---------- hud ----------
export interface HudRoute {
  planner: string
  executor: string
  active: string
}

export interface PlanStep {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  id: string
  startedAt: number
  completedAt: number
}

export interface PlanSnapshot {
  steps: PlanStep[]
  source: string
  note: string
  updatedAt: number
}

export interface HudDTO {
  phase: string
  frame: string
  elapsedMs: number
  stats: TokenUsage
  spark: number[]
  route: HudRoute | null
  queueCount: number
  planDisplay: 'auto' | 'collapsed' | 'expanded'
  thinkDisplay: 'auto' | 'collapsed' | 'expanded'
}

export interface ReDTO {
  sampleType: string
  phase: string
  phaseIndex: number
  phaseCount: number
  hypotheses: number
  evidence: number
}

// ---------- RE picker (mirrors workflow.SampleTypes via App.RESampleTypes) ----------

export interface RESamplePrompt {
  short: string
  full: string
}

export interface RESampleType {
  key: string
  label: string
  desc: string
  prompts: RESamplePrompt[]
}

export interface TickDTO {
  flow: FlowDTO
  hud: HudDTO
  re: ReDTO | null
  plan: PlanSnapshot | null
}

// ---------- loop events (transcript stream) ----------
export type LoopEventType =
  | 'turn' | 'wire' | 'compaction' | 'progress' | 'plan' | 'reply' | 'tool_start' | 'tool_end'

export interface ProviderProgress {
  kind: string // status | thinking | text | tool | usage | plan
  text: string
  tool: string
  status: string
  usage: TokenUsage | null
  plan: PlanStep[] | null
  planNote: string
}

export interface LoopEvent {
  type: LoopEventType
  turn: number
  provider: string
  phase: string // send | recv (wire events)
  model: string
  endpoint: string
  messages: number
  tokens: number
  tools: number
  ms: number
  ok: boolean
  toolCalls: number
  textChars: number
  error: string
  tokensBefore: number
  tokensAfter: number
  droppedMessages: number
  elidedToolResults: number
  progress: ProviderProgress | null
  snapshot: PlanSnapshot | null
  text: string
  usage: TokenUsage | null
  reason: string
  name: string
  args: Record<string, unknown> | null
  preview: string
}

/** kind=loop payloads arrive 50ms-batched: data is LoopEvent[] */
export type LoopBatch = LoopEvent[]

// ---------- settings dialog ----------
export interface ProviderInfoDTO {
  name: string
  model: string
  type: string
}

export interface SettingsDTO {
  role: string
  provider: string // agent override, '' = auto routing
  plannerProvider: string
  executorProvider: string
  researcherProvider: string
  providerNames: string[]
  providers: ProviderInfoDTO[]
  maxTurns: number
  compactionStrategy: string
  mcpServerCount: number
}

/** Empty/zero fields mean "leave unchanged" (mirrors gui.SettingsPatch). */
export interface SettingsPatch {
  plannerProvider: string
  executorProvider: string
  researcherProvider: string
  maxTurns: number
}

// ---------- shells (PTY terminal panel) ----------
export interface ShellInfo {
  id: string
  cwd: string
  pid: number
}

/** gui:shell payload — data rides base64 (PTY bytes are not guaranteed UTF-8). */
export interface ShellEnvelope {
  shellId: string
  kind: 'data' | 'exit'
  b64: string
  code: number
}

// ---------- gui event envelope ----------
export type GuiEventKind = 'loop' | 'tick' | 'approval' | 'notice' | 'lifecycle'

export interface GuiEvent {
  sessionId: string
  kind: GuiEventKind
  ts: number
  data: TickDTO | LoopBatch | ApprovalDTO | NoticeDTO | { state: LifecycleState }
}
