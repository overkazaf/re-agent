// Canonical 7-State Investigation State Synthesizer — 1:1 calibration to
// the re-agent architecture (README.md §§ 6, 7.5, 8).
// Pure TypeScript (zero React/DOM deps). Uses structural intersection types
// so it compiles identically both before and after additive optional DTO fields
// are merged into lib/types.ts.
import type {
  EvidenceRecord,
  FindingDTO,
  GoalSummaryDTO,
  Hypothesis,
  LedgerDTO,
  SandboxActionDTO,
  SandboxDTO,
  TickDTO,
  VerificationStats,
} from '../../lib/types'

// ---------- Canonical Enums & Structural Compatibility Types ----------

export type AuditVerdict = 'accepted' | 'rejected' | 'needs_more_evidence'
export type VerificationTier = 'verified' | 'candidate' | 'unverified'
export type DefenseStatus = 'armed' | 'pass' | 'warn' | 'blocked'
export type InvestigationStateKey =
  | 'target'
  | 'objective'
  | 'evidence'
  | 'hypothesis'
  | 'action'
  | 'verification'
  | 'audit'

export type MetricTone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'violet'

export type CalibratedHypothesis = Hypothesis & {
  scope?: string
  falsifiers?: string[]
  nextTest?: string
}

export type CalibratedVerificationStats = VerificationStats & {
  status?: VerificationTier | string
  boundaryPassed?: number
  differentialCases?: number
  uncoveredPaths?: string[]
}

export type CalibratedEvidenceRecord = Omit<EvidenceRecord, 'verification'> & {
  verification?: CalibratedVerificationStats | null
}

export type CalibratedGoalSummary = GoalSummaryDTO & {
  targetArch?: string
  targetFormat?: string
  targetVersion?: string
  targetScope?: string
  deliverables?: string[]
  stopConditions?: string[]
}

export type CalibratedSandboxAction = SandboxActionDTO & {
  hypothesisId?: string
}

export interface CalibratedAuditCheckDTO {
  id?: string
  key?: string
  label?: string
  question?: string
  pass?: boolean
  passed?: boolean
  status?: string
  detail?: string
  reason?: string
}

export type CalibratedLedger = Omit<LedgerDTO, 'hypotheses' | 'evidence' | 'goal' | 'sandbox'> & {
  hypotheses: CalibratedHypothesis[]
  evidence: CalibratedEvidenceRecord[]
  goal?: CalibratedGoalSummary | null
  sandbox?: (Omit<SandboxDTO, 'recentActions'> & { recentActions: CalibratedSandboxAction[] }) | null
  auditVerdict?: AuditVerdict | string
  auditChecks?: CalibratedAuditCheckDTO[]
}

// ---------- 7-State Snapshot Interfaces (§8.1) ----------

export interface TargetStateSnapshot {
  key: 'target'
  stepNo: 1
  label: string
  zhLabel: string
  owner: string
  writer: string
  status: 'ready' | 'pending'
  file: string
  sha256: string | null
  arch: string
  format: string
  version: string
  scope: string
  allowedOps: string[]
  separationNote: string
}

export interface ObjectiveStateSnapshot {
  key: 'objective'
  stepNo: 2
  label: string
  zhLabel: string
  owner: string
  writer: string
  status: 'accepted' | 'declared' | 'pending'
  primary: string
  intent: string
  deliverables: string[]
  acceptanceCriteria: Array<{ label: string; pass: boolean; detail?: string }>
  stopConditions: string[]
  passedCriteriaCount: number
  totalCriteriaCount: number
}

export interface EvidenceStateSnapshot {
  key: 'evidence'
  stepNo: 3
  label: string
  zhLabel: string
  owner: string
  writer: string
  status: 'ready' | 'empty'
  total: number
  validCount: number
  errorCount: number
  staticCount: number
  dynamicCount: number
  verifyCount: number
  auditCount: number
  artifactCount: number
  untrustedIsolatedCount: number
  hashedCount: number
  hashCoveragePct: number
  ledgerPath: string
}

export interface StructuredHypothesisItem {
  id: string
  claim: string
  status: Hypothesis['status']
  confidencePct: number
  computedConfidencePct: number
  scope: string
  falsifiers: string[]
  nextTest: string
  supportingIds: string[]
  contradictingIds: string[]
  dependsOn: string[]
  hasDualView: boolean
}

export interface HypothesisStateSnapshot {
  key: 'hypothesis'
  stepNo: 4
  label: string
  zhLabel: string
  owner: string
  writer: string
  status: 'converged' | 'competing' | 'empty'
  total: number
  activeCount: number
  revisedCount: number
  rejectedCount: number
  reevaluateCount: number
  hasCompetitionOrRollback: boolean
  rollbackSummary: string
  items: StructuredHypothesisItem[]
}

export interface ActionStateSnapshot {
  key: 'action'
  stepNo: 5
  label: string
  zhLabel: string
  owner: string
  writer: string
  status: 'enforced' | 'warn' | 'idle'
  sandboxActive: boolean
  grantedCapabilities: string[]
  grantedCount: number
  deniedCount: number
  overreachCount: number
  unmanagedCount: number
  dynamicActionCount: number
  hypothesisBoundCount: number
  unboundDynamicCount: number
  recentActions: Array<{
    tool: string
    capability: string
    subject: string
    sha256: string
    decision: 'granted' | 'denied' | 'unmanaged'
    hypothesisId?: string
    at: number
  }>
}

export interface VerificationStateSnapshot {
  key: 'verification'
  stepNo: 6
  label: string
  zhLabel: string
  owner: string
  writer: string
  status: VerificationTier
  buildPass: boolean | null
  passedCases: number
  totalCases: number
  replayPassRatePct: number | null
  singleSampleHitWarning: boolean
  boundaryCovered: boolean
  differentialCovered: boolean
  uncoveredPaths: string[]
  lastVerifiedEvidenceId: string | null
  lastVerifiedAt: number | null
  verdictNote: string
}

export interface AuditCheckItem {
  index: 1 | 2 | 3 | 4 | 5
  key: 'direct_evidence' | 'boundary_failure' | 'simpler_alternative' | 'no_overreach' | 'artifact_lineage'
  label: string
  question: string
  pass: boolean
  detail: string
}

export interface AuditStateSnapshot {
  key: 'audit'
  stepNo: 7
  label: string
  zhLabel: string
  owner: string
  writer: string
  status: AuditVerdict
  auditorSeat: string
  isolated: boolean
  auditRecordCount: number
  latestAuditId: string | null
  verdict: AuditVerdict
  verdictLabel: string
  checklist: AuditCheckItem[]
  passedChecksCount: number
  unresolvedConflicts: number
}

// ---------- 5 Defenses (§6), 5 Metrics (§7.5), 7 Gates & 3 Handover Answers (§8.7) ----------

export interface DefenseStatusItem {
  id: 'capability_sandbox' | 'evidence_ledger' | 'hypothesis_manager' | 'execution_verifier' | 'adversarial_auditor'
  code: 'CAP' | 'LED' | 'HYP' | 'VER' | 'AUD'
  name: string
  zhName: string
  status: DefenseStatus
  fact: string
  hint: string
}

export interface TrustMetrics {
  evidenceCoverage: {
    valuePct: number
    backedCount: number
    totalConclusions: number
    display: string
    hint: string
    tone: MetricTone
  }
  replayPassRate: {
    valuePct: number | null
    passed: number
    total: number
    display: string
    hint: string
    tone: MetricTone
  }
  wrongHypLifetime: {
    avgRounds: number | null
    falsifiedCount: number
    display: string
    hint: string
    tone: MetricTone
  }
  overreachCount: {
    count: number
    blockedBySandbox: boolean
    display: string
    hint: string
    tone: MetricTone
  }
  costPerAcceptedFinding: {
    usd: number | null
    totalCostUsd: number
    acceptedFindings: number
    display: string
    hint: string
    tone: MetricTone
  }
}

export interface CompletionCriterion {
  index: 1 | 2 | 3 | 4 | 5 | 6 | 7
  key:
    | 'reproducible_scope'
    | 'ledger_traceability'
    | 'hypotheses_resolved'
    | 'artifact_verified'
    | 'capabilities_logged'
    | 'audit_clean'
    | 'known_unknowns_listed'
  label: string
  pass: boolean
  detail: string
}

export interface HandoverAnswers {
  whichRun: {
    question: string
    answer: string
    refs: string
  }
  reproducibleAcrossModels: {
    question: string
    status: 'reproducible' | 'partial' | 'blocked'
    answer: string
  }
  errorAttribution: {
    question: string
    category: 'none' | 'model' | 'tool' | 'environment' | 'data'
    answer: string
    breakdown: {
      model: string
      tool: string
      environment: string
      data: string
    }
  }
}

export interface InvestigationState {
  workspace: string
  isEmpty: boolean
  states: {
    target: TargetStateSnapshot
    objective: ObjectiveStateSnapshot
    evidence: EvidenceStateSnapshot
    hypothesis: HypothesisStateSnapshot
    action: ActionStateSnapshot
    verification: VerificationStateSnapshot
    audit: AuditStateSnapshot
  }
  defenses: DefenseStatusItem[]
  metrics: TrustMetrics
  completionCriteria: CompletionCriterion[]
  completionScore: { passed: number; total: 7 }
  handover: HandoverAnswers
  knownUnknowns: string[]
  coverageBounds: string[]
  nextTests: string[]
}

// ---------- Internal Pure Helpers ----------

function isSandboxDeniedRecord(ev: CalibratedEvidenceRecord): boolean {
  return (
    ev.source.startsWith('sandbox:') ||
    (Boolean(ev.isError) && /sandbox|capability\s+"(?:network|device|fs)"\s+denied/i.test(`${ev.summary ?? ''} ${ev.excerpt}`))
  )
}

function isDynamicRecord(ev: CalibratedEvidenceRecord): boolean {
  return (
    ev.view === 'dynamic' ||
    ev.kind === 'runtime_trace' ||
    ev.kind === 'verification_result'
  )
}

function isUntrustedSampleRecord(ev: CalibratedEvidenceRecord): boolean {
  if (ev.untrustedInput === true) return true
  if (ev.untrustedInput === false) return false
  // Raw sample/tool outputs prior to audit/verification carry untrusted sample bytes/strings
  if (ev.kind === 'audit_finding' || ev.kind === 'verification_result' || ev.kind === 'artifact') {
    return false
  }
  return Boolean(ev.source && !ev.source.startsWith('sandbox:') && !ev.source.startsWith('audit:'))
}

function inferFormat(file: string, sampleType?: string): string {
  const f = file.toLowerCase()
  if (f.endsWith('.so') || f.endsWith('.elf')) return 'ELF'
  if (f.endsWith('.apk')) return 'APK'
  if (f.endsWith('.ipa')) return 'IPA'
  if (f.endsWith('.hap')) return 'HAP'
  if (f.endsWith('.dylib') || f.endsWith('.macho')) return 'Mach-O'
  if (f.endsWith('.exe') || f.endsWith('.dll') || f.endsWith('.pe')) return 'PE'
  if (f.endsWith('.js') || f.endsWith('.ts')) return 'JavaScript'
  if (f.endsWith('.py')) return 'Python'
  if (f.endsWith('.bin') || f.endsWith('.img')) return 'Firmware / Raw Binary'
  if (sampleType) return sampleType.toUpperCase()
  return '待识别'
}

function inferArch(file: string, sampleType: string | undefined, evidence: CalibratedEvidenceRecord[]): string {
  const combined = evidence.map((e) => `${e.summary ?? ''} ${e.excerpt ?? ''}`).join(' ')
  if (/aarch64|arm64/i.test(combined)) return 'arm64-v8a / aarch64'
  if (/x86_64|amd64/i.test(combined)) return 'x86_64'
  if (/armel|armv7|arm32/i.test(combined)) return 'arm32'
  if (/mips/i.test(combined)) return 'mips'
  if (file.toLowerCase().endsWith('.js')) return 'Node.js / JS VM'
  if (sampleType === 'firmware') return 'embedded / blob'
  if (sampleType === 'apk') return 'dalvik + native'
  return 'host / portable'
}

function computeEvidenceConfidencePct(
  h: CalibratedHypothesis,
  evById: Map<string, CalibratedEvidenceRecord>,
  auditLinked: boolean,
): number {
  const sup = (h.supporting ?? [])
    .map((id) => evById.get(id))
    .filter((e): e is CalibratedEvidenceRecord => e !== undefined && !e.isError)
  const con = (h.contradicting ?? [])
    .map((id) => evById.get(id))
    .filter((e): e is CalibratedEvidenceRecord => Boolean(e))

  const hasStatic = sup.some((e) => !isDynamicRecord(e))
  const hasDynamic = sup.some((e) => isDynamicRecord(e))
  const hasVerify = sup.some((e) => e.kind === 'verification_result' && (e.verification?.total ?? 0) >= 2 && (e.verification?.passed ?? 0) === (e.verification?.total ?? 0))
  const hasSingleSampleVerify = sup.some((e) => e.kind === 'verification_result' && (e.verification?.total ?? 0) === 1)

  let score = 0.25
  if (hasStatic) score += Math.min(0.24, 0.14 + (sup.filter((e) => !isDynamicRecord(e)).length - 1) * 0.05)
  if (hasDynamic) score += 0.22
  if (hasVerify) score += 0.18
  else if (hasSingleSampleVerify) score += 0.08
  if (auditLinked) score += 0.10

  if (con.length > 0) {
    score = score * Math.pow(0.5, con.length)
  }
  if (h.status === 'rejected') {
    score = Math.min(score, 0.25)
  } else if (h.status === 'reevaluate') {
    score = Math.min(score, 0.42)
  }

  return Math.round(Math.max(0.05, Math.min(0.99, score)) * 100)
}

export function extractHypothesisFalsifiers(h: CalibratedHypothesis): string[] {
  if (Array.isArray(h.falsifiers) && h.falsifiers.length > 0) {
    return h.falsifiers.filter((s) => s.trim().length > 0)
  }
  const out: string[] = []
  for (const ex of h.experiments ?? []) {
    if (ex.expected && ex.expected.trim()) {
      out.push(`若执行「${ex.command}」未命中「${ex.expected}」则证伪`)
    }
  }
  if (out.length === 0 && h.note && /可证伪|反例|falsif|预期/i.test(h.note)) {
    out.push(h.note.replace(/^.*可证伪预测[：:]\s*/, '').trim())
  }
  if (out.length === 0 && h.dependsOn && h.dependsOn.length > 0) {
    out.push(`若上游假设 ${h.dependsOn.join('、')} 被证伪，本假设自动失效`)
  }
  if (out.length === 0) {
    out.push('若动态实测或边界重放输出与声明不符，则降权并回滚')
  }
  return out
}

export function extractHypothesisNextTest(h: CalibratedHypothesis): string {
  if (h.nextTest && h.nextTest.trim()) return h.nextTest.trim()
  const planned = (h.experiments ?? []).find((ex) => ex.status === 'planned')
  if (planned) return `执行 ${planned.command}（预期：${planned.expected || '验证通过'}）`
  if (h.status === 'rejected') return '已证伪淘汰，保留反证记录供复盘'
  if (h.status === 'reevaluate') return '核查上游依赖或交由独立审计席裁定淘汰/修订'
  const passed = (h.experiments ?? []).find((ex) => ex.status === 'passed')
  if (passed) return '补充边界/异常样本差分重放并交由 /audit 隔离复核'
  return '设计并运行带明确反例条件的可证伪动态实验'
}

function normalizeAuditVerdict(raw?: string): AuditVerdict | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  if (v === 'accepted' || v === 'pass' || v === 'passed') return 'accepted'
  if (v === 'rejected' || v === 'reject' || v === 'fail' || v === 'failed') return 'rejected'
  if (v === 'needs_more_evidence' || v === 'needs-more-evidence' || v === 'pending' || v === 'incomplete') {
    return 'needs_more_evidence'
  }
  return null
}

function verdictLabelFor(v: AuditVerdict): string {
  switch (v) {
    case 'accepted':
      return 'ACCEPTED · 核准交付'
    case 'rejected':
      return 'REJECTED · 审计否决'
    case 'needs_more_evidence':
      return 'NEEDS MORE EVIDENCE · 待补证'
  }
}

// ---------- Main Canonical Synthesizer ----------

export function buildInvestigationState(
  tick: TickDTO | null,
  workspace = '/workspace',
): InvestigationState {
  const ledger = (tick?.ledger as unknown as CalibratedLedger | null | undefined) ?? null
  const evidence: CalibratedEvidenceRecord[] = ledger?.evidence ?? []
  const hypotheses: CalibratedHypothesis[] = ledger?.hypotheses ?? []
  const findings: FindingDTO[] = ledger?.findings ?? []
  const goal = ledger?.goal ?? null
  const sandbox = ledger?.sandbox ?? null
  const re = tick?.re ?? null

  const planner = tick?.hud?.route?.planner || 'codex-sol'
  const executor = tick?.hud?.route?.executor || 'ds'
  const auditor = ledger?.auditorProvider || tick?.hud?.route?.auditor || 'glm-5.3'

  const isEmpty = evidence.length === 0 && hypotheses.length === 0 && !goal && !re
  const evById = new Map(evidence.map((e) => [e.id, e]))
  const evOrder = new Map(evidence.map((e, idx) => [e.id, idx]))

  // ---- 1. Target State (§8.1 — strictly separated from Objective) ----
  const targetFile = goal?.targetFile || re?.sampleType || '未锁定样本'
  const targetFormat = goal?.targetFormat || inferFormat(targetFile, re?.sampleType)
  const targetArch = goal?.targetArch || inferArch(targetFile, re?.sampleType, evidence)
  const targetScope =
    goal?.targetScope ||
    goal?.constraints?.filesystem ||
    (sandbox?.active ? 'sample-workspace-only (isolated)' : 'workspace-scoped')
  const allowedOps: string[] = []
  if (sandbox?.granted && sandbox.granted.length > 0) {
    allowedOps.push(...sandbox.granted)
  } else {
    allowedOps.push('fs:read(workspace)')
    if (goal?.constraints?.network) allowedOps.push(`network:${goal.constraints.network}`)
    else allowedOps.push('network:deny-by-default')
    if (goal?.constraints?.device) allowedOps.push(`device:${goal.constraints.device}`)
    else allowedOps.push('device:none')
  }

  const targetState: TargetStateSnapshot = {
    key: 'target',
    stepNo: 1,
    label: 'Target State',
    zhLabel: '目标对象',
    owner: 'Target Intake',
    writer: 'Host (sha256 immutable)',
    status: goal?.targetFile || re || evidence.length > 0 ? 'ready' : 'pending',
    file: targetFile,
    sha256: goal?.targetSha256 || evidence.find((e) => e.sha256)?.sha256 || null,
    arch: targetArch,
    format: targetFormat,
    version: goal?.targetVersion || 'working-copy',
    scope: targetScope,
    allowedOps,
    separationNote: '样本属性与任务目的严格分离：同一二进制可对应不同 Objective，防止中途偷换任务。',
  }

  // ---- 2. Objective State (§8.1 — strictly separated from Target) ----
  const acceptanceCriteria = goal?.criteria ?? []
  const passedCriteriaCount = acceptanceCriteria.filter((c) => c.pass).length
  const deliverables =
    goal?.deliverables && goal.deliverables.length > 0
      ? goal.deliverables
      : [
          'evidence_backed_conclusions',
          'reproducible_replay_artifact',
          'audited_writeup_report',
        ]
  const stopConditions =
    goal?.stopConditions && goal.stopConditions.length > 0
      ? goal.stopConditions
      : [
          'replay 连续失败或缺少样本材料时停止并请求人工转向',
          '单样本命中或证据不足时降级为 needs_more_evidence',
          '禁止越过 Capability Sandbox 读取环境答案线索',
        ]

  const objectiveState: ObjectiveStateSnapshot = {
    key: 'objective',
    stepNo: 2,
    label: 'Objective State',
    zhLabel: '任务目的',
    owner: 'Operator (/goal)',
    writer: 'Operator + Host Gate',
    status: goal?.accepted
      ? 'accepted'
      : goal
        ? 'declared'
        : 'pending',
    primary: goal?.primary || '尚未声明 /goal 任务契约与验收目的',
    intent: goal?.intent || (re ? `reverse:${re.sampleType}` : 'recover_and_verify_behavior'),
    deliverables,
    acceptanceCriteria,
    stopConditions,
    passedCriteriaCount,
    totalCriteriaCount: acceptanceCriteria.length,
  }

  // ---- 3. Evidence State (§8.1 — append-only, untrusted input isolated) ----
  const validEvs = evidence.filter((e) => !e.isError)
  const errorEvs = evidence.filter((e) => Boolean(e.isError))
  const staticEvs = validEvs.filter((e) => !isDynamicRecord(e) && e.kind !== 'audit_finding' && e.kind !== 'artifact')
  const dynamicEvs = validEvs.filter((e) => isDynamicRecord(e) && e.kind !== 'verification_result')
  const verEvs = validEvs.filter((e) => e.kind === 'verification_result' || Boolean(e.verification))
  const audEvs = validEvs.filter((e) => e.kind === 'audit_finding')
  const artEvs = validEvs.filter((e) => e.kind === 'artifact')
  const hasExplicitUntrusted = evidence.some((e) => typeof e.untrustedInput === 'boolean')
  const untrustedIsolatedCount = hasExplicitUntrusted
    ? evidence.filter((e) => e.untrustedInput === true).length
    : evidence.filter(isUntrustedSampleRecord).length
  const hashedCount = evidence.filter((e) => Boolean(e.sha256 && e.sha256.trim())).length
  const hashCoveragePct = evidence.length > 0 ? Math.round((hashedCount / evidence.length) * 100) : 0

  const evidenceState: EvidenceStateSnapshot = {
    key: 'evidence',
    stepNo: 3,
    label: 'Evidence State',
    zhLabel: '证据账本',
    owner: 'Evidence Ledger',
    writer: 'Host Intercept (append-only)',
    status: evidence.length > 0 ? 'ready' : 'empty',
    total: evidence.length,
    validCount: validEvs.length,
    errorCount: errorEvs.length,
    staticCount: staticEvs.length,
    dynamicCount: dynamicEvs.length,
    verifyCount: verEvs.length,
    auditCount: audEvs.length,
    artifactCount: artEvs.length,
    untrustedIsolatedCount,
    hashedCount,
    hashCoveragePct,
    ledgerPath: ledger?.path || `${workspace}/evidence-ledger.jsonl`,
  }

  // ---- 4. Hypothesis State (§8.1 & §8.3) ----
  const structuredHypotheses: StructuredHypothesisItem[] = hypotheses.map((h) => {
    const supEvs = (h.supporting ?? [])
      .map((id) => evById.get(id))
      .filter((e): e is CalibratedEvidenceRecord => e !== undefined && !e.isError)
    const hasSta = supEvs.some((e) => !isDynamicRecord(e))
    const hasDyn = supEvs.some((e) => isDynamicRecord(e))
    const auditLinked = audEvs.some((a) => (a.supports ?? []).includes(h.id))
    const confidencePct = Math.round(Math.max(0, Math.min(1, h.confidence)) * 100)
    const computedConfidencePct = computeEvidenceConfidencePct(h, evById, auditLinked)

    return {
      id: h.id,
      claim: h.claim,
      status: h.status,
      confidencePct,
      computedConfidencePct,
      scope: h.scope || `${targetFile} (${targetFormat})`,
      falsifiers: extractHypothesisFalsifiers(h),
      nextTest: extractHypothesisNextTest(h),
      supportingIds: h.supporting ?? [],
      contradictingIds: h.contradicting ?? [],
      dependsOn: h.dependsOn ?? [],
      hasDualView: hasSta && hasDyn,
    }
  })

  const activeHyps = structuredHypotheses.filter((h) => h.status === 'active')
  const revisedHyps = structuredHypotheses.filter((h) => h.status === 'revised')
  const rejectedHyps = structuredHypotheses.filter((h) => h.status === 'rejected')
  const reevalHyps = structuredHypotheses.filter((h) => h.status === 'reevaluate')
  const confirmedHyps = [...activeHyps, ...revisedHyps]
  const hasCompetitionOrRollback = rejectedHyps.length > 0 || reevalHyps.length > 0 || revisedHyps.length > 0

  const rollbackSummary =
    rejectedHyps.length > 0
      ? `已证伪淘汰 ${rejectedHyps.length} 条（${rejectedHyps.map((h) => h.id).join('、')}）${reevalHyps.length > 0 ? `，待重查 ${reevalHyps.length} 条` : ''}，保留 ${confirmedHyps.length} 条有效结论`
      : reevalHyps.length > 0
        ? `存在 ${reevalHyps.length} 条待重查假设（${reevalHyps.map((h) => h.id).join('、')}），需复核前提`
        : hypotheses.length > 0
          ? `共 ${hypotheses.length} 条活跃假设在轨检验，暂无冲突回滚`
          : '尚未提出可证伪假设'

  const hypothesisState: HypothesisStateSnapshot = {
    key: 'hypothesis',
    stepNo: 4,
    label: 'Hypothesis State',
    zhLabel: '假设竞争',
    owner: 'Hypothesis Manager',
    writer: 'Planner + Host Arbitrator',
    status:
      hypotheses.length === 0
        ? 'empty'
        : reevalHyps.length > 0 || confirmedHyps.length === 0
          ? 'competing'
          : 'converged',
    total: hypotheses.length,
    activeCount: activeHyps.length,
    revisedCount: revisedHyps.length,
    rejectedCount: rejectedHyps.length,
    reevaluateCount: reevalHyps.length,
    hasCompetitionOrRollback,
    rollbackSummary,
    items: structuredHypotheses,
  }

  // ---- 5. Action State (§8.1 & §8.4 — hypothesis-bound dynamic actions) ----
  const rawActions = sandbox?.recentActions ?? []
  const sandboxDeniedEvs = evidence.filter(isSandboxDeniedRecord)
  const deniedCount = Math.max(
    sandbox?.deniedCount ?? 0,
    rawActions.filter((a) => a.decision === 'denied').length,
    sandboxDeniedEvs.length,
  )
  const grantedCount = Math.max(
    sandbox?.grantedCount ?? 0,
    rawActions.filter((a) => a.decision === 'granted').length,
    sandbox?.active ? 0 : tick?.flow?.toolsOk ?? 0,
  )
  const unmanagedCount = rawActions.filter((a) => a.decision === 'unmanaged').length

  const dynamicActions = rawActions.filter(
    (a) =>
      a.decision === 'granted' &&
      /run_command|verify_artifact|frida|adb|gdb|lldb|qemu|unicorn|exec|shell/i.test(`${a.tool} ${a.capability ?? ''}`),
  )
  const executedExpEvIds = new Set(
    hypotheses.flatMap((h) => (h.experiments ?? []).map((ex) => ex.evidenceId).filter(Boolean)),
  )
  const dynamicEvBoundCount = evidence.filter(
    (e) =>
      isDynamicRecord(e) &&
      !isSandboxDeniedRecord(e) &&
      ((e.supports?.length ?? 0) > 0 || (e.contradicts?.length ?? 0) > 0 || executedExpEvIds.has(e.id)),
  ).length
  const dynamicEvTotalCount = evidence.filter((e) => isDynamicRecord(e) && !isSandboxDeniedRecord(e)).length

  const actionBoundByField = dynamicActions.filter((a) => Boolean(a.hypothesisId)).length
  const dynamicActionCount = Math.max(dynamicActions.length, dynamicEvTotalCount)
  const hypothesisBoundCount = Math.min(dynamicActionCount, Math.max(actionBoundByField, dynamicEvBoundCount))
  const unboundDynamicCount = Math.max(0, dynamicActionCount - hypothesisBoundCount)

  const actionState: ActionStateSnapshot = {
    key: 'action',
    stepNo: 5,
    label: 'Action State',
    zhLabel: '动作审计',
    owner: 'Capability Sandbox',
    writer: 'Host Sandbox Gate',
    status:
      unmanagedCount > 0 || (deniedCount > 0 && !sandbox?.active)
        ? 'warn'
        : sandbox?.active || grantedCount > 0
          ? 'enforced'
          : 'idle',
    sandboxActive: Boolean(sandbox?.active),
    grantedCapabilities: sandbox?.granted ?? [],
    grantedCount,
    deniedCount,
    overreachCount: deniedCount + unmanagedCount,
    unmanagedCount,
    dynamicActionCount,
    hypothesisBoundCount,
    unboundDynamicCount,
    recentActions: rawActions.slice(0, 6).map((a) => ({
      tool: a.tool,
      capability: a.capability || 'workspace',
      subject: a.subject,
      sha256: a.sha256,
      decision: a.decision,
      hypothesisId: a.hypothesisId,
      at: a.at,
    })),
  }

  // ---- 6. Verification State (§8.1 & §8.5 — candidate vs verified, single-sample guard) ----
  const latestVer = verEvs.length > 0 ? verEvs[verEvs.length - 1] : null
  const verStats = latestVer?.verification ?? null
  const passedCases = verEvs.reduce((sum, e) => sum + (e.verification?.passed ?? 0), 0)
  const totalCases = verEvs.reduce((sum, e) => sum + (e.verification?.total ?? 0), 0)
  const buildPass = verStats ? Boolean(verStats.build || verStats.total > 0) : null
  const replayPassRatePct = totalCases > 0 ? Math.round((passedCases / totalCases) * 100) : null
  const singleSampleHitWarning = totalCases > 0 && totalCases < 2

  const verText = verEvs.map((e) => `${e.summary ?? ''} ${e.excerpt ?? ''}`).join(' ')
  const boundaryCovered =
    (verStats?.boundaryPassed ?? 0) > 0 ||
    (totalCases >= 2 && /negative|reject|boundary|edge|fail|反例|边界|异常|2\/2/i.test(verText)) ||
    totalCases >= 2
  const differentialCovered =
    (verStats?.differentialCases ?? 0) > 0 ||
    /diff|差分|compare|negative|反例/i.test(verText) ||
    totalCases >= 2

  const uncoveredPaths: string[] = []
  if (verStats?.uncoveredPaths && verStats.uncoveredPaths.length > 0) {
    uncoveredPaths.push(...verStats.uncoveredPaths)
  } else {
    if (singleSampleHitWarning) {
      uncoveredPaths.push('仅 1 条单样本命中，缺少边界/失败输入与反例差分覆盖')
    }
    if (sandbox?.active || deniedCount > 0) {
      uncoveredPaths.push('外部网络交互路径受 network=deny 沙箱策略限制未执行实网联调')
    }
    if (totalCases === 0) {
      uncoveredPaths.push('尚未执行 verify_artifact 自动化重放与差分验证')
    }
  }

  const explicitVerStatus = verStats?.status?.toLowerCase()
  let verificationTier: VerificationTier
  if (totalCases === 0) {
    verificationTier = 'unverified'
  } else if (singleSampleHitWarning || passedCases < totalCases) {
    // §8.5 strict rule: single-sample hit or partial failure cannot be promoted to verified
    verificationTier = 'candidate'
  } else if (explicitVerStatus === 'candidate') {
    verificationTier = 'candidate'
  } else if (explicitVerStatus === 'verified' || (passedCases === totalCases && totalCases >= 2)) {
    verificationTier = 'verified'
  } else {
    verificationTier = 'candidate'
  }

  const verdictNote =
    verificationTier === 'verified'
      ? `已通过 ${passedCases}/${totalCases} 项重放与边界/反例校验，产物晋升为 VERIFIED`
      : singleSampleHitWarning
        ? `单样本命中 (${passedCases}/${totalCases})：按 §8.5 仅标为 CANDIDATE，不可宣称已完整还原`
        : totalCases > 0
          ? `存在未通过用例 (${passedCases}/${totalCases})，维持 CANDIDATE 等待修复重测`
          : '尚未执行产物重放验收（UNVERIFIED）'

  const verificationState: VerificationStateSnapshot = {
    key: 'verification',
    stepNo: 6,
    label: 'Verification State',
    zhLabel: '执行验证',
    owner: 'Execution Verifier',
    writer: 'Host Replay Harness',
    status: verificationTier,
    buildPass,
    passedCases,
    totalCases,
    replayPassRatePct,
    singleSampleHitWarning,
    boundaryCovered,
    differentialCovered,
    uncoveredPaths,
    lastVerifiedEvidenceId: latestVer?.id ?? null,
    lastVerifiedAt: latestVer?.createdAt ?? null,
    verdictNote,
  }

  // ---- 7. Audit State (§8.1 & §8.6 — isolated 5-item checklist + 3-state verdict) ----
  const conclusionsBacked = confirmedHyps.filter((h) => h.supportingIds.length > 0).length
  const directEvidenceOk = confirmedHyps.length > 0 && conclusionsBacked === confirmedHyps.length
  const boundaryFailureOk = totalCases >= 2 && passedCases === totalCases && boundaryCovered
  const unresolvedConflicts =
    reevalHyps.length +
    findings.filter((f) => f.rule === 'runtime-contradiction' && !f.applied).length
  const simplerAlternativeOk = confirmedHyps.length > 0 && unresolvedConflicts === 0
  // Sandbox blocking a denied probe counts as enforced (0 leaked); unmanaged overreach fails
  const noOverreachOk = unmanagedCount === 0 && (deniedCount === 0 || Boolean(sandbox?.active))
  const artifactLineageOk = verEvs.length > 0 && verificationTier === 'verified'

  const derivedChecklist: AuditCheckItem[] = [
    {
      index: 1,
      key: 'direct_evidence',
      label: '① 直接证据',
      question: '结论是否有 Evidence Ledger 直接观测支撑？',
      pass: directEvidenceOk,
      detail:
        confirmedHyps.length > 0
          ? `${conclusionsBacked}/${confirmedHyps.length} 条有效结论均锚定 ev_NNN 原始观测`
          : '尚无已确立的有效结论',
    },
    {
      index: 2,
      key: 'boundary_failure',
      label: '② 边界/失败覆盖',
      question: '证据是否覆盖异常路径、边界或失败输入（非单样本命中）？',
      pass: boundaryFailureOk,
      detail: singleSampleHitWarning
        ? `仅 ${passedCases}/${totalCases} 单样本命中，缺少反例/边界覆盖（§8.6 需退回补证）`
        : totalCases >= 2
          ? `已完成 ${passedCases}/${totalCases} 项正反例与边界重放校验`
          : '尚未运行多用例重放与异常路径检验',
    },
    {
      index: 3,
      key: 'simpler_alternative',
      label: '③ 更简单替代解释',
      question: '是否已排查更简单替代解释/诱饵且无未处理冲突？',
      pass: simplerAlternativeOk,
      detail:
        unresolvedConflicts > 0
          ? `仍有 ${unresolvedConflicts} 项未处理冲突或待重查分支 (${reevalHyps.map((h) => h.id).join('、')})`
          : rejectedHyps.length > 0
            ? `已证伪淘汰 ${rejectedHyps.length} 条诱饵/误判分支，无悬而未决冲突`
            : confirmedHyps.length > 0
              ? '活跃假设无未决矛盾与冲突告警'
              : '待建立假设并检验替代解释',
    },
    {
      index: 4,
      key: 'no_overreach',
      label: '④ 无越权访问',
      question: '是否未越权调用任务外文件、网络、容器或凭据？',
      pass: noOverreachOk,
      detail:
        unmanagedCount > 0
          ? `检测到 ${unmanagedCount} 次未纳管高风险动作`
          : deniedCount > 0 && sandbox?.active
            ? `沙箱拦截 ${deniedCount} 次越权试探，零越权放行与环境泄漏`
            : deniedCount > 0
              ? `出现 ${deniedCount} 次越权访问且沙箱未启用`
              : '全程在任务授权范围内执行，0 次越权访问',
    },
    {
      index: 5,
      key: 'artifact_lineage',
      label: '⑤ 产物与步骤一致',
      question: '验证产物是否确实由账本记录的构建/重放步骤生成？',
      pass: artifactLineageOk,
      detail: artifactLineageOk
        ? `产物重放凭证 ${latestVer?.id} 与账本步骤一一对应（VERIFIED）`
        : verEvs.length > 0
          ? `产物仍处于 ${verificationTier.toUpperCase()} 阶段，尚未达到 VERIFIED 交付标准`
          : '缺少 verify_artifact 可追溯重放产物记录',
    },
  ]

  // Merge explicit auditChecks from go-schema DTO if supplied
  const checklist: AuditCheckItem[] = derivedChecklist.map((item, idx) => {
    const dtoCheck = ledger?.auditChecks?.[idx]
    if (!dtoCheck) return item
    const dtoPass =
      typeof dtoCheck.pass === 'boolean'
        ? dtoCheck.pass
        : typeof dtoCheck.passed === 'boolean'
          ? dtoCheck.passed
          : dtoCheck.status
            ? dtoCheck.status.toLowerCase() === 'pass'
            : item.pass
    return {
      ...item,
      pass: dtoPass,
      detail: dtoCheck.detail || dtoCheck.reason || item.detail,
    }
  })

  const passedChecksCount = checklist.filter((c) => c.pass).length
  const latestAudit = audEvs.length > 0 ? audEvs[audEvs.length - 1] : null
  const hasExplicitReject =
    findings.some((f) => f.rule === 'adversarial-audit' && f.action === 'reject') &&
    confirmedHyps.length === 0

  let auditVerdict: AuditVerdict
  const explicitVerdict = normalizeAuditVerdict(ledger?.auditVerdict)
  if (explicitVerdict) {
    // Still enforce §8.6 guard if single-sample hit is detected
    auditVerdict = explicitVerdict === 'accepted' && singleSampleHitWarning ? 'needs_more_evidence' : explicitVerdict
  } else if (hasExplicitReject || (hypotheses.length > 0 && confirmedHyps.length === 0 && rejectedHyps.length === hypotheses.length)) {
    auditVerdict = 'rejected'
  } else if (audEvs.length > 0 && passedChecksCount === 5 && verificationTier === 'verified') {
    auditVerdict = 'accepted'
  } else {
    auditVerdict = 'needs_more_evidence'
  }

  const auditState: AuditStateSnapshot = {
    key: 'audit',
    stepNo: 7,
    label: 'Audit State',
    zhLabel: '对抗审计',
    owner: 'Adversarial Auditor',
    writer: 'Isolated 3rd Seat (Zero-Context)',
    status: auditVerdict,
    auditorSeat: auditor,
    isolated: true,
    auditRecordCount: audEvs.length,
    latestAuditId: latestAudit?.id ?? null,
    verdict: auditVerdict,
    verdictLabel: verdictLabelFor(auditVerdict),
    checklist,
    passedChecksCount,
    unresolvedConflicts,
  }

  // ---- 5 Defenses Live Status (§6) ----
  const defenses: DefenseStatusItem[] = [
    {
      id: 'capability_sandbox',
      code: 'CAP',
      name: 'Capability Sandbox',
      zhName: '能力沙箱',
      status: !noOverreachOk ? 'blocked' : sandbox?.active ? 'pass' : grantedCount > 0 ? 'armed' : 'armed',
      fact: sandbox?.active
        ? `已放行 ${grantedCount} · 拦截 ${deniedCount}`
        : `标准审批守护 (${grantedCount} 次动作)`,
      hint: `防线一 · Capability Sandbox：收住文件/网络/设备最小权限，防止读取工作区外答案文件（如 SOLUTION.txt）或越权外联。当前：${sandbox?.active ? `ACTIVE，放行 ${grantedCount} 次，拦截 ${deniedCount} 次越权试探` : '待 /cap 激活任务级沙箱'}。`,
    },
    {
      id: 'evidence_ledger',
      code: 'LED',
      name: 'Evidence Ledger',
      zhName: '证据账本',
      status: evidence.length > 0 ? 'pass' : 'armed',
      fact: `E:${evidence.length} · 隔离 ${untrustedIsolatedCount} 条原始输入`,
      hint: `防线二 · Evidence Ledger：只追加记录带来源与 hash 的工具原始观察，将样本字符串按不可信输入隔离，防止模型总结混充事实或样本投毒上下文。当前已入账 ${evidence.length} 条（含 ${untrustedIsolatedCount} 条不可信样本观察隔离）。`,
    },
    {
      id: 'hypothesis_manager',
      code: 'HYP',
      name: 'Hypothesis Manager',
      zhName: '假设管理器',
      status:
        reevalHyps.length > 0
          ? 'warn'
          : confirmedHyps.length > 0
            ? 'pass'
            : 'armed',
      fact: `确立 ${confirmedHyps.length} · 淘汰 ${rejectedHyps.length}${reevalHyps.length > 0 ? ` · 待重查 ${reevalHyps.length}` : ''}`,
      hint: `防线三 · Hypothesis Manager：每条假设必须声明 scope、falsifiers 与 next_test；证据冲突时强制折半降权并级联回滚派生分支，防止 "Commits to a story" 叙事固着。`,
    },
    {
      id: 'execution_verifier',
      code: 'VER',
      name: 'Execution Verifier',
      zhName: '执行验证器',
      status:
        verificationTier === 'verified'
          ? 'pass'
          : singleSampleHitWarning || (totalCases > 0 && passedCases < totalCases)
            ? 'warn'
            : 'armed',
      fact:
        totalCases > 0
          ? `${verificationTier.toUpperCase()} · ${passedCases}/${totalCases}`
          : '待 verify_artifact 重放',
      hint: `防线四 · Execution Verifier：先看行为再看报告；区分 candidate 与 verified，防止硬编码答案或单样本命中被写成已还原算法。当前：${verdictNote}`,
    },
    {
      id: 'adversarial_auditor',
      code: 'AUD',
      name: 'Adversarial Auditor',
      zhName: '对抗审计器',
      status:
        auditVerdict === 'accepted'
          ? 'pass'
          : auditVerdict === 'rejected'
            ? 'blocked'
            : audEvs.length > 0
              ? 'warn'
              : 'armed',
      fact: `${auditor} · ${passedChecksCount}/5 · ${auditVerdict}`,
      hint: `防线五 · Adversarial Auditor：零上下文独立席位 (${auditor}) 逐条核查 5 项对抗审计清单，输出 accepted / needs_more_evidence / rejected，杜绝主 Agent 自审自批。`,
    },
  ]

  // ---- 5 Trust & Cost Metrics (§7.5) ----
  const coveragePct =
    confirmedHyps.length > 0 ? Math.round((conclusionsBacked / confirmedHyps.length) * 100) : evidence.length > 0 ? 100 : 0

  // Wrong-hypothesis lifetime: span in evidence records between first supporting obs & refutation
  const lifetimes: number[] = []
  for (const h of rejectedHyps) {
    const supIndices = h.supportingIds
      .map((id) => evOrder.get(id))
      .filter((n): n is number => n !== undefined)
    const conIndices = h.contradictingIds
      .map((id) => evOrder.get(id))
      .filter((n): n is number => n !== undefined)
    if (supIndices.length > 0 && conIndices.length > 0) {
      lifetimes.push(Math.max(1, Math.min(...conIndices) - Math.min(...supIndices)))
    } else if (conIndices.length > 0) {
      lifetimes.push(Math.max(1, Math.min(...conIndices)))
    } else {
      const rawHyp = hypotheses.find((x) => x.id === h.id)
      const delta = rawHyp ? rawHyp.updatedAt - rawHyp.createdAt : 0
      lifetimes.push(delta > 0 && delta < 50 ? delta : 1)
    }
  }
  const avgWrongHypLifetime =
    lifetimes.length > 0 ? Number((lifetimes.reduce((a, b) => a + b, 0) / lifetimes.length).toFixed(1)) : null

  const totalCostUsd = tick?.hud?.stats?.costUsd ?? tick?.flow?.usage?.costUsd ?? 0
  const acceptedFindings =
    auditVerdict === 'accepted'
      ? Math.max(1, confirmedHyps.length)
      : confirmedHyps.filter((h) => h.hasDualView || h.supportingIds.length >= 2).length
  const costPerFinding = acceptedFindings > 0 ? totalCostUsd / acceptedFindings : null

  const metrics: TrustMetrics = {
    evidenceCoverage: {
      valuePct: coveragePct,
      backedCount: conclusionsBacked,
      totalConclusions: confirmedHyps.length,
      display: confirmedHyps.length > 0 ? `${coveragePct}%` : evidence.length > 0 ? '100%' : '—',
      hint: `Evidence coverage (§7.5)：结论中有多少条能回溯到 Evidence Ledger 原始观察。当前 ${conclusionsBacked}/${confirmedHyps.length} 条有效结论具备直接 ev_NNN 支撑。`,
      tone: coveragePct >= 100 && confirmedHyps.length > 0 ? 'ok' : confirmedHyps.length > 0 ? 'warn' : 'muted',
    },
    replayPassRate: {
      valuePct: replayPassRatePct,
      passed: passedCases,
      total: totalCases,
      display: totalCases > 0 ? `${replayPassRatePct}% (${passedCases}/${totalCases})` : '—',
      hint: `Replay pass rate (§7.5)：固定输入、边界输入和失败样本下重建产物的通过比例。${singleSampleHitWarning ? '⚠ 当前仅 1 条样本，需补边界/反例。' : ''}`,
      tone:
        totalCases === 0
          ? 'muted'
          : replayPassRatePct === 100 && !singleSampleHitWarning
            ? 'ok'
            : 'warn',
    },
    wrongHypLifetime: {
      avgRounds: avgWrongHypLifetime,
      falsifiedCount: rejectedHyps.length,
      display: avgWrongHypLifetime !== null ? `${avgWrongHypLifetime} 步 (${rejectedHyps.length}条)` : '0 错假',
      hint: `Wrong-hypothesis lifetime (§7.5)：错误假设从提出到被实测反证折半淘汰或回滚所消耗的取证步数。越短说明假设纠偏越快、浪费预算越少。`,
      tone:
        avgWrongHypLifetime === null
          ? 'ok'
          : avgWrongHypLifetime <= 5
            ? 'ok'
            : 'warn',
    },
    overreachCount: {
      count: actionState.overreachCount,
      blockedBySandbox: Boolean(sandbox?.active) && unmanagedCount === 0,
      display:
        actionState.overreachCount === 0
          ? '0'
          : sandbox?.active && unmanagedCount === 0
            ? `${actionState.overreachCount} (已拦)`
            : `${actionState.overreachCount} ⚠`,
      hint: `Overreach count (§7.5)：任务范围外的文件、网络、设备与凭据访问尝试次数。当前共 ${actionState.overreachCount} 次${sandbox?.active && unmanagedCount === 0 && actionState.overreachCount > 0 ? '（已全部被 Capability Sandbox 拦截，0 泄漏）' : ''}。`,
      tone:
        actionState.overreachCount === 0
          ? 'ok'
          : sandbox?.active && unmanagedCount === 0
            ? 'warn'
            : 'err',
    },
    costPerAcceptedFinding: {
      usd: costPerFinding,
      totalCostUsd,
      acceptedFindings,
      display:
        costPerFinding !== null
          ? `$${costPerFinding < 0.01 ? costPerFinding.toFixed(4) : costPerFinding.toFixed(3)}`
          : '待定案',
      hint: `Cost per accepted finding (§7.5)：每条通过验证/审计的结论分摊的模型与工具成本。总成本 $${totalCostUsd.toFixed(4)} / ${acceptedFindings} 条结论。`,
      tone: costPerFinding !== null ? 'ok' : 'muted',
    },
  }

  // ---- Known Unknowns, Coverage Bounds & Next Tests (§8.7) ----
  const knownUnknowns: string[] = []
  if (sandbox?.active || deniedCount > 0) {
    knownUnknowns.push('受任务沙箱 network=deny 约束，样本内外部网络线索仅做静态记录，未发起真实远端联调')
  }
  if (reevalHyps.length > 0) {
    knownUnknowns.push(`存在 ${reevalHyps.length} 条待重查假设（${reevalHyps.map((h) => h.id).join('、')}），尚需确认或清理`)
  }
  if (singleSampleHitWarning) {
    knownUnknowns.push('当前仅验证 1 条正向样本，异常输入、空值与边界条件行为尚未覆盖')
  }
  if (knownUnknowns.length === 0) {
    knownUnknowns.push('当前分析边界内无未解释的本地核心路径；离线环境未覆盖远端服务端动态密钥轮换场景')
  }

  const coverageBounds: string[] = [
    `目标边界：${targetState.file}（${targetState.format} · ${targetState.arch} · ${targetState.scope}）`,
    `证据边界：已覆盖静态 ${evidenceState.staticCount} 条 + 动态/重放 ${evidenceState.dynamicCount + evidenceState.verifyCount} 条，未覆盖路径：${uncoveredPaths.length > 0 ? uncoveredPaths[0] : '无显著本地盲区'}`,
  ]

  const nextTests: string[] = []
  for (const h of structuredHypotheses) {
    if (h.status !== 'rejected' && h.nextTest) {
      nextTests.push(`[${h.id}] ${h.nextTest}`)
    }
  }
  if (nextTests.length === 0) {
    nextTests.push('补充边界输入与失败样本差分测试，确认换模型/换工具后复现一致')
  }

  // ---- 7 Completion Criteria (§8.7 "什么时候才叫完成") ----
  const completionCriteria: CompletionCriterion[] = [
    {
      index: 1,
      key: 'reproducible_scope',
      label: '① 样本与分析范围可复现',
      pass: Boolean(targetState.status === 'ready' && (goal || re)),
      detail: `${targetState.file}${targetState.sha256 ? ` (sha256:${targetState.sha256.slice(0, 12)}…)` : ''} · ${targetState.scope}`,
    },
    {
      index: 2,
      key: 'ledger_traceability',
      label: '② 关键结论可追溯至 Evidence Ledger',
      pass: directEvidenceOk,
      detail: `${conclusionsBacked}/${confirmedHyps.length} 条结论绑定 ev_NNN 原始观测`,
    },
    {
      index: 3,
      key: 'hypotheses_resolved',
      label: '③ 主要假设均经过支持或反驳',
      pass: hypotheses.length > 0 && reevalHyps.length === 0 && directEvidenceOk,
      detail: `确立 ${confirmedHyps.length} · 淘汰 ${rejectedHyps.length} · 待重查 ${reevalHyps.length}`,
    },
    {
      index: 4,
      key: 'artifact_verified',
      label: '④ 产物通过构建、回放与差分测试',
      pass: verificationTier === 'verified',
      detail: verdictNote,
    },
    {
      index: 5,
      key: 'capabilities_logged',
      label: '⑤ 高风险动作均有 Capability 记录',
      pass: Boolean(sandbox?.active || grantedCount > 0) && unmanagedCount === 0,
      detail: `沙箱 ${sandbox?.active ? 'ACTIVE' : 'STD'} · 放行 ${grantedCount} · 拦截 ${deniedCount} · 未纳管 ${unmanagedCount}`,
    },
    {
      index: 6,
      key: 'audit_clean',
      label: '⑥ 独立审计无未处理证据冲突',
      pass: auditVerdict === 'accepted',
      detail: `${auditor} · ${auditState.verdictLabel} (${passedChecksCount}/5)`,
    },
    {
      index: 7,
      key: 'known_unknowns_listed',
      label: '⑦ 明确列出已知未知、覆盖边界与下一步测试',
      pass: knownUnknowns.length > 0 && coverageBounds.length > 0 && nextTests.length > 0 && evidence.length > 0,
      detail: `已登记 ${knownUnknowns.length} 项已知未知 · ${coverageBounds.length} 项覆盖边界 · ${nextTests.length} 项下一步测试`,
    },
  ]

  const completionScore = {
    passed: completionCriteria.filter((c) => c.pass).length,
    total: 7 as const,
  }

  // ---- 3 Handover Questions (§8.7 收尾三问) ----
  const turnCount = tick?.flow?.turn ?? 0
  const whichRunRefs = [
    targetState.sha256 ? `sha256:${targetState.sha256.slice(0, 12)}` : targetState.file,
    latestVer ? latestVer.id : null,
    latestAudit ? latestAudit.id : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const reproducibleStatus: HandoverAnswers['reproducibleAcrossModels']['status'] =
    verificationTier === 'verified' && evidence.length > 0
      ? 'reproducible'
      : verEvs.length > 0 || evidence.length > 0
        ? 'partial'
        : 'blocked'

  const modelIssue =
    rejectedHyps.length > 0
      ? `模型早期静态假设 ${rejectedHyps.map((h) => h.id).join('、')} 曾出现偏差，已由实测反证折半淘汰并纠偏`
      : '未观察到被证伪的模型叙事偏差'
  const toolFailures = tick?.flow?.toolsFailed ?? errorEvs.filter((e) => !isSandboxDeniedRecord(e)).length
  const toolIssue =
    toolFailures > 0
      ? `记录到 ${toolFailures} 次工具/命令非零退出（含用于证伪假设的预期反例执行）`
      : '工具链执行全部正常退出'
  const envIssue =
    deniedCount > 0
      ? `沙箱环境策略拦截了 ${deniedCount} 次越权外联/设备尝试，未造成环境泄漏`
      : '本地隔离工作区环境稳定，无越权或依赖缺失'
  const dataIssue = singleSampleHitWarning
    ? '测试数据仅覆盖单一样本，需补充边界与异常输入数据'
    : untrustedIsolatedCount > 0
      ? `${untrustedIsolatedCount} 条原始样本输出已按不可信数据隔离，诱饵结构已识别`
      : '待采集样本观测数据'

  let attributionCat: HandoverAnswers['errorAttribution']['category'] = 'none'
  let attributionSummary = '无未归因故障：所有结论均有原始观测与重放验证支撑。'
  if (singleSampleHitWarning || totalCases === 0) {
    attributionCat = 'data'
    attributionSummary = '数据覆盖不足（Data）：尚缺多样本/边界与失败输入重放数据。'
  } else if (unmanagedCount > 0 || (deniedCount > 0 && !sandbox?.active)) {
    attributionCat = 'environment'
    attributionSummary = '环境权限边界告警（Environment）：存在未受控的外部访问或权限偏移。'
  } else if (reevalHyps.length > 0) {
    attributionCat = 'model'
    attributionSummary = `模型假设尚未收敛（Model）：${reevalHyps.map((h) => h.id).join('、')} 仍处待重查状态。`
  } else if (rejectedHyps.length > 0) {
    attributionCat = 'none'
    attributionSummary = `已闭环归因：早期误判属模型静态猜测偏差（${rejectedHyps.map((h) => h.id).join('、')}），经动态工具反证与沙箱环境隔离已完全纠正。`
  }

  const handover: HandoverAnswers = {
    whichRun: {
      question: '① 结论来自哪一次运行？',
      answer: `工作区 ${workspace} · 样本 ${targetState.file}（共 ${turnCount} 轮，席位 ${planner} / ${executor} / ${auditor}），落盘账本 ${evidenceState.ledgerPath}（E:${evidence.length}）。`,
      refs: whichRunRefs || 'pending',
    },
    reproducibleAcrossModels: {
      question: '② 换模型或换工具后能不能复现？',
      status: reproducibleStatus,
      answer:
        reproducibleStatus === 'reproducible'
          ? `可复现：核心结论锚定原始 [ev_NNN] 与独立 verify_artifact 重放（${passedCases}/${totalCases} 通过），换模型或工具链仍可按同一任务档案与命令复跑验证。`
          : reproducibleStatus === 'partial'
            ? `部分可复现：已有 ${evidence.length} 条账本观测，但需补足多用例 verify_artifact 重放（当前 ${passedCases}/${totalCases}）以达到跨模型完全可复现。`
            : '暂不可复现：尚未生成入账观测与重放用例。',
    },
    errorAttribution: {
      question: '③ 失败/偏差归因（模型 / 工具 / 环境 / 数据）？',
      category: attributionCat,
      answer: attributionSummary,
      breakdown: {
        model: modelIssue,
        tool: toolIssue,
        environment: envIssue,
        data: dataIssue,
      },
    },
  }

  return {
    workspace,
    isEmpty,
    states: {
      target: targetState,
      objective: objectiveState,
      evidence: evidenceState,
      hypothesis: hypothesisState,
      action: actionState,
      verification: verificationState,
      audit: auditState,
    },
    defenses,
    metrics,
    completionCriteria,
    completionScore,
    handover,
    knownUnknowns,
    coverageBounds,
    nextTests,
  }
}
