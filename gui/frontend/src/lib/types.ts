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
  history?: LoopEvent[]
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
  concerns?: string[]
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
  researcher?: string
  auditor?: string
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

// ---------- evidence ledger & hypothesis stack ----------

// Canonical hypothesis lifecycle states. In the re-agent model (§6 Defense ③),
// "weakened" is represented by contradicting evidence + halved confidence, and
// "frozen" / rollback cascades map to "reevaluate".
export type HypothesisStatus = 'active' | 'revised' | 'rejected' | 'reevaluate'

export interface HypothesisExperiment {
  id: string
  title: string
  command: string
  expected?: string
  status: 'planned' | 'passed' | 'falsified' | 'error'
  evidenceId?: string
  actual?: string
  ranAt?: number
}

export interface Hypothesis {
  id: string
  claim: string
  scope?: string
  confidence: number
  supporting?: string[]
  contradicting?: string[]
  falsifiers?: string[]
  nextTest?: string
  dependsOn?: string[]
  derived?: string[]
  status: HypothesisStatus
  note?: string
  experiments?: HypothesisExperiment[]
  createdAt: number
  updatedAt: number
}

export interface VerificationStats {
  build: boolean
  passed: number
  total: number
  id?: string
  status?: 'candidate' | 'verified'
  boundaryPassed?: number
  differentialCases?: number
  uncoveredPaths?: string[]
}

export type AuditVerdict = 'accepted' | 'rejected' | 'needs_more_evidence'

export interface AuditCheckDTO {
  id: string
  label: string
  pass: boolean
  detail?: string
}

export interface EvidenceRecord {
  id: string
  source: string
  kind?: string
  view?: string
  excerpt: string
  summary?: string
  isError?: boolean
  toolCallId?: string
  artifact?: string
  sha256?: string
  supports?: string[]
  contradicts?: string[]
  untrustedInput?: boolean
  bytes: number
  verification?: VerificationStats | null
  createdAt: number
}

export interface GoalCriterionDTO {
  label: string
  pass: boolean
  detail?: string
}

export interface GoalSummaryDTO {
  primary: string
  intent?: string
  targetFile?: string
  targetSha256?: string
  targetArch?: string
  targetFormat?: string
  targetVersion?: string
  targetScope?: string
  deliverables?: string[]
  stopConditions?: string[]
  accepted: boolean
  constraints?: Record<string, string>
  criteria: GoalCriterionDTO[]
}

export interface SandboxActionDTO {
  at: number
  tool: string
  capability?: string
  subject: string
  sha256: string
  decision: 'granted' | 'denied' | 'unmanaged'
  origin?: string
  hypothesisId?: string
}

export interface SandboxDTO {
  active: boolean
  granted: string[]
  device?: string
  grantedCount: number
  deniedCount: number
  recentActions: SandboxActionDTO[]
}

export interface FindingDTO {
  rule: string
  hypothesisId: string
  evidenceId?: string
  action?: string
  applied: boolean
  message: string
}

export interface LedgerDTO {
  hypotheses: Hypothesis[]
  evidence: EvidenceRecord[]
  path?: string
  auditorProvider?: string
  goal?: GoalSummaryDTO | null
  sandbox?: SandboxDTO | null
  findings?: FindingDTO[]
  auditVerdict?: AuditVerdict
  auditChecks?: AuditCheckDTO[]
}

export interface TickDTO {
  flow: FlowDTO
  hud: HudDTO
  re: ReDTO | null
  plan: PlanSnapshot | null
  ledger?: LedgerDTO | null
}

// ---------- hypothesis, experiment, verification & review workbench ----------

export interface HypothesisMutationDTO {
  action: 'create' | 'revise' | 'reject' | 'support' | 'challenge' | 'meta' | 'add_experiment'
  id?: string
  claim?: string
  scope?: string
  falsifiers?: string[]
  nextTest?: string
  confidence?: number
  evidenceIds?: string[]
  dependsOn?: string[]
  note?: string
  expTitle?: string
  expCommand?: string
  expExpected?: string
}

export interface RunExperimentDTO {
  hypothesisId: string
  experimentId?: string
  title?: string
  command?: string
  expected?: string
}

export interface VerificationCaseDTO {
  name: string
  command: string
  input?: string
  expected: string
}

export interface VerificationRequestDTO {
  artifact: string
  buildCommand?: string
  cases: VerificationCaseDTO[]
  hypothesisId?: string
}

export interface ReviewRequestDTO {
  mode: 'arbitrate' | 'operator_audit' | 'model_audit'
  summary?: string
  hypothesisId?: string
  verdict?: 'support' | 'challenge' | 'reject' | ''
  citedEvidence?: string[]
}

export interface ReviewResultDTO {
  auditRecord?: EvidenceRecord | null
  findings: FindingDTO[]
}

// ---------- loop events (transcript stream) ----------
export type LoopEventType =
  | 'user' | 'turn' | 'wire' | 'compaction' | 'progress' | 'plan' | 'reply' | 'tool_start' | 'tool_end'

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
  auditProvider?: string
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
  auditProvider?: string
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

// ---------- binary forensic terrain (Route B) ----------
export interface WorkspaceFileDTO {
  path: string
  size: number
  format: string
  isBinary: boolean
}

export interface TerrainSectionDTO {
  name: string
  segment?: string
  offset: number
  size: number
  vaddr?: string
  flags: string
  entropy: number
  rwx?: boolean
  isConstructor?: boolean
}

export interface TerrainBucketDTO {
  offset: number
  size: number
  entropy: number
  printable: number
  hexPreview: string
  asciiPreview: string
}

export interface TerrainCarveDTO {
  offset: number
  kind: string
  signature: string
}

export interface TerrainAntiDTO {
  category: string
  confidence: string
  description: string
  detail: string
  offset: number
  bypass?: string
}

export interface TerrainDiffDTO {
  offset: number
  length: number
  bytesA: string
  bytesB: string
  classification?: string[]
}

export interface BinaryTerrainDTO {
  path: string
  comparePath?: string
  format: string
  arch?: string
  size: number
  sampled: number
  sha256: string
  overallEntropy: number
  maxEntropy: number
  entryPoint?: string
  mitigations?: Record<string, string>
  sections: TerrainSectionDTO[]
  entropy: TerrainBucketDTO[]
  carves: TerrainCarveDTO[]
  anti: TerrainAntiDTO[]
  diffs: TerrainDiffDTO[]
}
