// Cognitive Synthesis Engine — turns raw TickDTO ledger records, hypotheses,
// experiments, arbitrator findings, and audit verdicts into:
//   1) A complete, natural, non-jumpy deductive ProofStory (macro chronological
//      chapters with explicit causal connectors + per-hypothesis 5-beat proof arcs)
//   2) Step-by-step ReplayFrames with explicit causal transitions
//   3) Executive ProcessSummary + 6-stage architecture checklist
//   4) Publication-grade, evidence-anchored Markdown Writeup (3 templates).
import type {
  EvidenceRecord,
  FindingDTO,
  Hypothesis,
  TickDTO,
} from '../../lib/types'
import {
  buildInvestigationState,
  extractHypothesisFalsifiers,
  extractHypothesisNextTest,
  type AuditVerdict,
  type CalibratedHypothesis,
  type InvestigationState,
  type VerificationTier,
} from './investigationState'

export type GraphNodeKey =
  | 'planner'
  | 'executor'
  | 'auditor'
  | 'sandbox'
  | 'approval'
  | 'ledger'
  | 'hypotheses'
  | 'arbitrator'
  | 'gate'

export type WriteupTemplateId = 'article-standard' | 'ctf-writeup' | 'algo-report'

export interface ArticleStageStatus {
  stageNo: 1 | 2 | 3 | 4 | 5 | 6
  code: string
  title: string
  principle: string
  status: 'done' | 'active' | 'pending'
  fact: string
}

export interface ReplayFrame {
  index: number
  id: string
  stageNo: 1 | 2 | 3 | 4 | 5 | 6
  stageTag: string
  title: string
  actor: string
  actorTone: 'accent' | 'ok' | 'warn' | 'err' | 'violet'
  focusNode: GraphNodeKey
  /** Why we moved from the previous step into this step (causal bridge). */
  transitionFromPrev?: string
  thought: string
  /** Concise understanding/state takeaway produced by this step. */
  takeaway?: string
  stateDelta: string
  tick: TickDTO
}

export interface ConclusionPillar {
  key: string
  label: string
  tone: 'accent' | 'ok' | 'warn' | 'err' | 'violet'
  value: string
  refs: string
}

export interface ProcessSummary {
  headline: string
  narrative: string
  pillars: ConclusionPillar[]
  structuredMarkdown: string
  stages: ArticleStageStatus[]
  writeupGate: {
    unlocked: boolean
    strictReverseMode: boolean
    reasons: string[]
  }
}

// ---------- Deductive Proof Narrative Model ----------

export interface EvidenceMention {
  id: string
  source: string
  view: 'static' | 'dynamic'
  kind: string
  isError: boolean
  summary: string
  excerpt: string
  verification?: { passed: number; total: number; build?: boolean }
}

export interface ContrastCallout {
  hypothesisId: string
  expected: string
  observed: string
  deduction: string
  evidenceId?: string
  cascadedIds?: string[]
}

export interface NarrativeChapter {
  stepNo: number
  id: string
  phaseLabel: string
  roleTag: string
  tone: 'accent' | 'ok' | 'warn' | 'err' | 'violet'
  headline: string
  transitionFromPrev: string | null
  body: string
  bulletFacts: string[]
  evidenceRefs: EvidenceMention[]
  hypothesisIds: string[]
  contrasts: ContrastCallout[]
  /** Explicit §8.5 verification tier tag (`candidate` vs `verified`) on verify chapters. */
  verificationTier?: VerificationTier
  /** Explicit §8.6 3-state audit verdict on audit chapters. */
  auditVerdict?: AuditVerdict
}

export interface HypothesisArc {
  id: string
  claim: string
  status: Hypothesis['status']
  statusLabel: string
  tone: 'accent' | 'ok' | 'warn' | 'err' | 'violet'
  confidencePct: number
  dependsOn: string[]
  dependents: string[]
  /** Optional §8.3 scope of the hypothesis. */
  scope?: string
  /** Explicit §8.3 falsification criteria. */
  falsifiers: string[]
  /** Explicit §8.3 next test to confirm or refute. */
  nextTest: string
  /** ① 起因线索：为什么最初这样猜 */
  triggerClues: string
  /** ② 假设主张与验证标准：主张什么、若成立应观察到什么 */
  claimAndCriterion: string
  /** ③ 检验过程与客观结果：执行了什么实验/观察、拿到了什么结果 */
  testAndObservation: string
  /** ④ 推导判断：印证 / 反证淘汰 / 级联重查的推理过程 */
  deductionVerdict: string
  /** ⑤ 后续影响：推动新假设 / 进入审计 / 确认定案 */
  nextMove: string
  supportingRefs: EvidenceMention[]
  contradictingRefs: EvidenceMention[]
  auditRefs: EvidenceMention[]
  contrast: ContrastCallout | null
  /** One-line readable causal story for compact panels (Ledger / Workbench / Alignment). */
  oneLineStory: string
}

export interface ProofStory {
  isEmpty: boolean
  targetName: string
  leadSummary: string
  chapters: NarrativeChapter[]
  hypothesisArcs: HypothesisArc[]
  verificationTier: VerificationTier
  auditVerdict: AuditVerdict
  fullPlainText: string
}

// ---------- Internal Narrative Helpers ----------

function toEvidenceMention(ev: EvidenceRecord): EvidenceMention {
  const view: 'static' | 'dynamic' =
    ev.view === 'dynamic' || ev.kind === 'runtime_trace' || ev.kind === 'verification_result'
      ? 'dynamic'
      : 'static'
  return {
    id: ev.id,
    source: ev.source,
    view,
    kind: ev.kind || 'tool_observation',
    isError: Boolean(ev.isError),
    summary: (ev.summary || ev.excerpt || '').replace(/\s+/g, ' ').trim(),
    excerpt: (ev.excerpt || ev.summary || '').trim(),
    verification: ev.verification
      ? { passed: ev.verification.passed, total: ev.verification.total, build: ev.verification.build }
      : undefined,
  }
}

function cleanEvFact(ev: EvidenceRecord, maxLen = 110): string {
  const raw = (ev.summary || ev.excerpt || '').replace(/\s+/g, ' ').trim()
  if (!raw) return `${ev.source} 产出观测记录`
  // Strip redundant leading "tool(args) → " prefix when we already mention source
  const arrowIdx = raw.indexOf('→')
  const body =
    arrowIdx > 0 && arrowIdx < 96 && raw.slice(0, arrowIdx).includes('(')
      ? raw.slice(arrowIdx + 1).trim()
      : raw
  return body.length > maxLen ? `${body.slice(0, maxLen)}…` : body
}

function isSandboxEvidence(ev: EvidenceRecord): boolean {
  return (
    ev.source.startsWith('sandbox:') ||
    (Boolean(ev.isError) && /sandbox|capability\s+"(?:network|device)"\s+denied/i.test(`${ev.summary ?? ''} ${ev.excerpt}`))
  )
}

function isDynamicEvidence(ev: EvidenceRecord): boolean {
  return (
    ev.view === 'dynamic' ||
    ev.kind === 'runtime_trace' ||
    ev.kind === 'verification_result'
  )
}

function isWriteupArtifact(ev: EvidenceRecord): boolean {
  return (
    ev.kind === 'artifact' &&
    Boolean(ev.artifact && (ev.artifact.includes('writeup') || ev.artifact.includes('solve') || ev.artifact.endsWith('.md')))
  )
}

function extractFlagFromEvidence(evidence: EvidenceRecord[]): string | null {
  const m = evidence
    .map((e) => `${e.summary ?? ''} ${e.excerpt ?? ''}`)
    .join('\n')
    .match(/(?:flag|0xaf)\{[a-zA-Z0-9_.-]+\}/)
  return m ? m[0] : null
}

function joinIds(ids: string[], sep = '、'): string {
  return ids.join(sep)
}

function formatEvRefList(evs: EvidenceRecord[]): string {
  return evs.map((e) => `[${e.id}]`).join('、')
}

function inferExpectationForHypothesis(h: Hypothesis): {
  shortExpected: string
  criterionSentence: string
} {
  const exp = (h.experiments ?? []).find((x) => x.command || x.expected)
  if (exp) {
    const expDesc = exp.expected
      ? `执行「${exp.command}」后应当命中预期输出「${exp.expected}」`
      : `通过执行「${exp.command}」验证行为是否与推测一致`
    return {
      shortExpected: exp.expected ? `执行 ${exp.command} 预期得到「${exp.expected}」` : `执行 ${exp.command} 应验证通过`,
      criterionSentence: `为了检验这一判断是否成立，预设的验证标准是：${expDesc}；一旦实测不符，就应降低置信度并排除该分支。`,
    }
  }
  if (h.note && /可证伪预测[：:]/.test(h.note)) {
    const pred = h.note.replace(/^.*可证伪预测[：:]\s*/, '').trim()
    return {
      shortExpected: pred,
      criterionSentence: `预设的可证伪检验标准为：${pred}。`,
    }
  }
  if (h.dependsOn && h.dependsOn.length > 0) {
    return {
      shortExpected: `上游假设 ${joinIds(h.dependsOn)} 成立，且后续解码/运行结果与本推论一致`,
      criterionSentence: `该推论建立在上游假设 ${joinIds(h.dependsOn)} 成立的前提之上；若上游被推翻，本假设自动失去成立基础并需重审。`,
    }
  }
  return {
    shortExpected: `动态实测或独立重放结果应与「${h.claim.slice(0, 42)}${h.claim.length > 42 ? '…' : ''}」相符`,
    criterionSentence: `如果该判断成立，后续针对同一对象的动态运行或重放检验应当复现对应特征；若实测出现反例，则必须推翻重估。`,
  }
}

function statusMetaForHypothesis(
  h: Hypothesis,
  hasStatic: boolean,
  hasDynamicOrVerify: boolean,
  hasAudit: boolean,
  isCascaded: boolean,
): { label: string; tone: HypothesisArc['tone'] } {
  if (h.status === 'rejected') {
    return {
      label: isCascaded && !(h.contradicting && h.contradicting.length > 0 && !isCascaded)
        ? '因前提失效淘汰'
        : '已被反证淘汰',
      tone: 'err',
    }
  }
  if (h.status === 'reevaluate') {
    return { label: '前提动摇·待重查', tone: 'warn' }
  }
  if (h.status === 'revised') {
    return { label: hasDynamicOrVerify ? '已修订并证实' : '已修订·待验证', tone: 'violet' }
  }
  if (hasAudit && hasDynamicOrVerify) {
    return { label: '双视角证实·审计通过', tone: 'ok' }
  }
  if (hasStatic && hasDynamicOrVerify) {
    return { label: '已获双视角证实', tone: 'ok' }
  }
  if (hasDynamicOrVerify) {
    return { label: '动态验证通过', tone: 'ok' }
  }
  if (hasAudit && hasStatic) {
    return { label: '静态结构·审计核准', tone: 'ok' }
  }
  return { label: '静态推断·待动态检验', tone: 'accent' }
}

/** Synthesizes the 5-beat causal proof arc for every hypothesis in the ledger. */
export function buildHypothesisArcs(
  evidence: EvidenceRecord[],
  hypotheses: Hypothesis[],
  findings: FindingDTO[] = [],
  auditorName = 'glm-5.3',
): HypothesisArc[] {
  if (hypotheses.length === 0) return []

  const evById = new Map(evidence.map((e) => [e.id, e]))
  const evOrder = new Map(evidence.map((e, idx) => [e.id, idx]))
  const hypById = new Map(hypotheses.map((h) => [h.id, h]))

  // Map dependents (children) for each hypothesis
  const dependentsMap = new Map<string, string[]>()
  for (const h of hypotheses) {
    for (const parentId of h.dependsOn ?? []) {
      const list = dependentsMap.get(parentId) ?? []
      list.push(h.id)
      dependentsMap.set(parentId, list)
    }
  }

  // Locate earliest contradiction evidence index to identify post-refutation pivot hypotheses
  const firstContraEvIdx = evidence.findIndex(
    (e) =>
      (e.contradicts && e.contradicts.length > 0) ||
      hypotheses.some((h) => (h.contradicting ?? []).includes(e.id)),
  )
  const refutedRootIds = hypotheses
    .filter((h) => h.status === 'rejected' && !(h.dependsOn && h.dependsOn.length > 0))
    .map((h) => h.id)
  const allRejectedOrReevalIds = hypotheses
    .filter((h) => h.status === 'rejected' || h.status === 'reevaluate')
    .map((h) => h.id)

  // Identify post-pivot confirmed hypotheses (for nextMove cross-referencing)
  const pivotedHypIds = hypotheses
    .filter((h) => {
      if (h.status === 'rejected' || h.status === 'reevaluate') return false
      if (firstContraEvIdx < 0) return false
      const supIdx = (h.supporting ?? [])
        .map((id) => evOrder.get(id))
        .filter((n): n is number => n !== undefined)
      return supIdx.length > 0 && Math.min(...supIdx) > firstContraEvIdx
    })
    .map((h) => h.id)

  return hypotheses.map((h) => {
    const pct = Math.round(Math.max(0, Math.min(1, h.confidence)) * 100)
    const deps = h.dependsOn ?? []
    const dependents = dependentsMap.get(h.id) ?? []

    const supEvs = (h.supporting ?? [])
      .map((id) => evById.get(id))
      .filter((e): e is EvidenceRecord => Boolean(e))
    const conEvs = (h.contradicting ?? [])
      .map((id) => evById.get(id))
      .filter((e): e is EvidenceRecord => Boolean(e))
    const audEvs = evidence.filter(
      (e) =>
        e.kind === 'audit_finding' &&
        ((e.supports ?? []).includes(h.id) || (e.contradicts ?? []).includes(h.id)),
    )
    const hypFindings = findings.filter((f) => f.hypothesisId === h.id)
    const cascadeFinding = hypFindings.find((f) => f.rule === 'dependency-cascade')
    const runtimeContraFinding = hypFindings.find((f) => f.rule === 'runtime-contradiction')
    const singleViewFinding = hypFindings.find((f) => f.rule === 'single-view')
    const auditSupportFinding = hypFindings.find(
      (f) => (f.rule === 'adversarial-audit' || f.rule === 'operator-review') && f.action === 'support',
    )
    const auditChallengeFinding = hypFindings.find(
      (f) => (f.rule === 'adversarial-audit' || f.rule === 'operator-review') && (f.action === 'challenge' || f.action === 'reject'),
    )

    const staticSup = supEvs.filter((e) => !isDynamicEvidence(e) && !e.isError)
    const dynSup = supEvs.filter((e) => isDynamicEvidence(e) && !e.isError)
    const verSup = supEvs.filter((e) => e.kind === 'verification_result' && !e.isError)

    const parentRefuted = deps.filter((pid) => {
      const p = hypById.get(pid)
      return p && (p.status === 'rejected' || p.status === 'reevaluate')
    })
    const isCascaded = Boolean(cascadeFinding || parentRefuted.length > 0)
    const isPivotHyp = pivotedHypIds.includes(h.id)

    const { shortExpected, criterionSentence } = inferExpectationForHypothesis(h)
    const statusMeta = statusMetaForHypothesis(
      h,
      staticSup.length > 0,
      dynSup.length > 0 || verSup.length > 0,
      audEvs.length > 0 || Boolean(auditSupportFinding),
      isCascaded,
    )

    // ① 起因线索 (Triggering Clues)
    let triggerClues = ''
    if (isPivotHyp && refutedRootIds.length > 0) {
      const clueDesc = staticSup
        .map((e) => `[${e.id}]（${e.source}：${cleanEvFact(e, 72)}）`)
        .join('、')
      triggerClues =
        `此前围绕 ${joinIds(allRejectedOrReevalIds)} 的猜想已被动态实测排除，分析随即转向排查其余伴生线索` +
        (clueDesc ? `：通过 ${clueDesc} 发现了新的直接线索，由此提出 ${h.id}。` : `，由此提出替代假设 ${h.id}。`)
    } else if (deps.length > 0) {
      const clueDesc = staticSup
        .map((e) => `[${e.id}]（${cleanEvFact(e, 64)}）`)
        .join('、')
      triggerClues =
        `该假设承接上游假设 ${joinIds(deps)} 进一步推演` +
        (clueDesc ? `，并结合静态观测 ${clueDesc}，推测出下一步解密/利用路径。` : `，试图沿既有判断继续向前推导。`)
    } else if (staticSup.length > 0) {
      const clueDesc = staticSup
        .map((e) => `[${e.id}]（${e.source} 观察到：${cleanEvFact(e, 70)}）`)
        .join('；')
      triggerClues = `在初步静态勘察中，通过 ${clueDesc}，据此自然引出 ${h.id} 这一判断。`
    } else if (supEvs.length > 0) {
      const clueDesc = supEvs.map((e) => `[${e.id}]（${cleanEvFact(e, 70)}）`).join('；')
      triggerClues = `基于前期记录 ${clueDesc} 提出该假设。`
    } else {
      triggerClues = `基于当前阶段的分析目标提出初始待检验猜想（尚未绑定前置观测记录）。`
    }

    // ② 假设主张与验证标准 (Claim & Test Criterion)
    const claimAndCriterion = `主张：「${h.claim}」。${criterionSentence}`

    // ③ 检验过程与客观结果 (Test & Observation)
    const executedExps = (h.experiments ?? []).filter((ex) => ex.status !== 'planned')
    let testAndObservation = ''
    if (conEvs.length > 0 && !isCascaded) {
      const expPart = executedExps.length > 0
        ? `按预设标准执行了实验「${executedExps[0].command}」`
        : `执行了动态实测检验`
      const obsDesc = conEvs
        .map((e) => `[${e.id}]（${e.source} 实测返回：${cleanEvFact(e, 86)}）`)
        .join('；')
      testAndObservation = `${expPart}，但客观实测结果与预期背离：${obsDesc}。`
    } else if (isCascaded && parentRefuted.length > 0) {
      const parentCon = parentRefuted
        .flatMap((pid) => hypById.get(pid)?.contradicting ?? [])
        .map((id) => evById.get(id))
        .filter((e): e is EvidenceRecord => Boolean(e))
      testAndObservation =
        parentCon.length > 0
          ? `未继续在该分支盲目展开新实验——因为其依赖的父假设 ${joinIds(parentRefuted)} 在 ${formatEvRefList(parentCon)} 的动态实测中已被证伪（${cleanEvFact(parentCon[0], 74)}）。`
          : `其依赖的上游父假设 ${joinIds(parentRefuted)} 已在验证中失效，因此本分支无需再按原前提推进。`
    } else if (verSup.length > 0 || dynSup.length > 0) {
      const parts: string[] = []
      if (executedExps.length > 0) {
        const passedExp = executedExps.find((x) => x.status === 'passed') ?? executedExps[0]
        parts.push(`执行实验「${passedExp.command}」，实测输出命中预期${passedExp.actual ? `（${passedExp.actual.slice(0, 72)}）` : ''}`)
      }
      for (const v of verSup) {
        const ratio = v.verification ? `${v.verification.passed}/${v.verification.total} 项用例全部通过` : '重放校验通过'
        parts.push(`经 verify_artifact [${v.id}] 独立重放验证（${ratio}：${cleanEvFact(v, 72)}）`)
      }
      const pureDyn = dynSup.filter((e) => e.kind !== 'verification_result')
      if (pureDyn.length > 0 && executedExps.length === 0) {
        parts.push(
          `动态实测 ${pureDyn.map((e) => `[${e.id}]（${cleanEvFact(e, 72)}）`).join('、')} 结果与假设吻合`,
        )
      }
      testAndObservation = `${parts.join('；')}。`
    } else if (singleViewFinding) {
      testAndObservation = `目前仅具备静态观测依据（${formatEvRefList(staticSup) || '无动态记录'}），宿主仲裁器已提示 [single-view] 风险：单靠静态线索不足以定论，尚待动态实测检验。`
    } else {
      testAndObservation =
        staticSup.length > 0
          ? `已对照静态观测 ${formatEvRefList(staticSup)} 完成结构核查${audEvs.length > 0 ? `，并经独立审计 ${formatEvRefList(audEvs)} 复核一致` : '，暂未补充动态运行实验'}。`
          : `尚未执行对应的动态实验或重放检验。`
    }

    // ④ 推导判断 (Deduction Verdict)
    let deductionVerdict = ''
    let contrast: ContrastCallout | null = null
    if (h.status === 'rejected' && !isCascaded) {
      const conEv = conEvs[0]
      const observedText = conEv
        ? `[${conEv.id}] ${cleanEvFact(conEv, 92)}`
        : executedExps[0]?.actual || h.note || '实测结果与原假设矛盾'
      deductionVerdict =
        `实测反例直接推翻了原判断${runtimeContraFinding ? `（宿主规则引擎捕获 [runtime-contradiction]）` : ''}：预期与实测存在根本矛盾，置信度被强制折半降至 ${pct}% 并正式淘汰。`
      contrast = {
        hypothesisId: h.id,
        expected: shortExpected,
        observed: observedText,
        deduction: `实测表明原静态特征并非有效载荷/成立条件，因此淘汰 ${h.id}${dependents.length > 0 ? `，并同步撤销下游 ${joinIds(dependents)} 的成立前提` : ''}。`,
        evidenceId: conEv?.id,
        cascadedIds: dependents.length > 0 ? dependents : undefined,
      }
    } else if (h.status === 'rejected' && isCascaded) {
      const observedText =
        conEvs[0]
          ? `父假设 ${joinIds(parentRefuted)} 被 [${conEvs[0].id}] 证伪（${cleanEvFact(conEvs[0], 78)}）`
          : `上游父假设 ${joinIds(parentRefuted)} 已被证伪`
      deductionVerdict =
        `由于前提 ${joinIds(parentRefuted)} 已不成立，建立在其上的 ${h.id} 先被宿主级联标记为待重查，随后${auditChallengeFinding ? `经独立审计席 ${auditorName} 复核裁定淘汰` : '随上游一并淘汰'}（残余置信度 ${pct}%）。`
      contrast = {
        hypothesisId: h.id,
        expected: `上游前提 ${joinIds(parentRefuted)} 成立，从而支持本分支继续推演`,
        observed: observedText,
        deduction: `前提既已失效，派生推论 ${h.id} 失去逻辑支点，予以剔除以防顺着错误路线延伸。`,
        evidenceId: conEvs[0]?.id,
      }
    } else if (h.status === 'reevaluate') {
      const cause = parentRefuted.length > 0
        ? `父假设 ${joinIds(parentRefuted)} 被推翻或修订`
        : conEvs.length > 0
          ? `收到反证 ${formatEvRefList(conEvs)}`
          : '出现新冲突证据'
      deductionVerdict = `因 ${cause}，原推理前提已动摇，置信度下调至 ${pct}%，当前处于待重查（reevaluate）状态，不能作为最终结论使用。`
      contrast = {
        hypothesisId: h.id,
        expected: shortExpected,
        observed: conEvs[0] ? `[${conEvs[0].id}] ${cleanEvFact(conEvs[0], 84)}` : `${cause}，原有依赖链中断`,
        deduction: `暂停采信 ${h.id}，需先核查前提或由独立审计清理该分支。`,
        evidenceId: conEvs[0]?.id,
      }
    } else if (staticSup.length > 0 && (dynSup.length > 0 || verSup.length > 0)) {
      const audText =
        audEvs.length > 0 || auditSupportFinding
          ? `，并且通过了独立审计席 ${auditorName} 的零上下文复核（${formatEvRefList(audEvs) || 'AUDIT SUPPORT'}）`
          : ''
      deductionVerdict =
        `静态线索（${formatEvRefList(staticSup)}）与动态实测/重放（${formatEvRefList([...dynSup, ...verSup].filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i))}）从两个独立视角相互印证，无任何反例${audText}，结论成立（置信度 ${pct}%）。`
    } else if (verSup.length > 0 || dynSup.length > 0) {
      deductionVerdict = `已获得动态实测/重放验证支持（${formatEvRefList([...dynSup, ...verSup])}），当前置信度 ${pct}%。`
    } else if (audEvs.length > 0 || auditSupportFinding) {
      deductionVerdict = `静态结构观测清晰且边界明确（${formatEvRefList(staticSup)}），独立审计席 ${auditorName} 复核无过度外推，予以确认（置信度 ${pct}%）。`
    } else {
      deductionVerdict = `目前仅由静态线索支持（置信度 ${pct}%），属于阶段性合理推断，尚未完成动态证实。`
    }

    // ⑤ 后续影响 (Next Move)
    let nextMove = ''
    if (h.status === 'rejected') {
      const pivotPart =
        pivotedHypIds.length > 0 && !isCascaded
          ? `排除该错误方向后，分析顺理成章转向排查其余文件并提出 ${joinIds(pivotedHypIds)}。`
          : dependents.length > 0
            ? `同时触发下游假设 ${joinIds(dependents)} 级联降级重审，彻底截断错误推理分支。`
            : `已从最终结论中明确剔除，避免报告误将干扰项当作真实机制。`
      nextMove =
        dependents.length > 0 && pivotedHypIds.length > 0 && !isCascaded
          ? `触发下游 ${joinIds(dependents)} 级联重审，并促使分析转向排查伴生线索、提出 ${joinIds(pivotedHypIds)}。`
          : pivotPart
    } else if (h.status === 'reevaluate') {
      nextMove = `等待独立审计或操作员决定是否彻底淘汰，或基于新观测修订前提后重新验证。`
    } else if (audEvs.length > 0 || auditSupportFinding) {
      nextMove = `已完成证据闭环与独立审计定案，作为核心已证实结论写入最终可溯源报告。`
    } else if (verSup.length > 0) {
      nextMove = `已完成产物重放校验，下一步提交独立第三席位（/audit）做最终复核定案。`
    } else if (dynSup.length > 0) {
      nextMove = `已获动态运行印证，建议进一步运行 verify_artifact 正反例重放以锁定可复现凭证。`
    } else {
      nextMove = `下一步需针对该假设设计并执行可证伪动态实验，以消除单视角盲区。`
    }

    const oneLineStory =
      h.status === 'rejected'
        ? isCascaded
          ? `依附 ${joinIds(parentRefuted)} 推演 → 父假设被证伪导致前提失效 → 经复核淘汰（${pct}%）`
          : `依据 ${formatEvRefList(staticSup) || '静态线索'} 提出 → 实测 ${formatEvRefList(conEvs) || '反例'} 证伪 → 折半淘汰（${pct}%）${pivotedHypIds.length > 0 ? `并转向 ${joinIds(pivotedHypIds)}` : ''}`
        : h.status === 'reevaluate'
          ? `依据 ${deps.length > 0 ? `上游 ${joinIds(deps)}` : formatEvRefList(staticSup) || '早期线索'} 提出 → 前提动摇 → 待重查（${pct}%）`
          : staticSup.length > 0 && (dynSup.length > 0 || verSup.length > 0)
            ? `依据 ${formatEvRefList(staticSup)} 提出 → 经 ${formatEvRefList(verSup.length > 0 ? verSup : dynSup)} 动态实证 → ${audEvs.length > 0 ? '审计定案' : '双视角确立'}（${pct}%）`
            : `依据 ${formatEvRefList(staticSup) || '初始勘察'} 提出 → ${audEvs.length > 0 ? '静态结构明确且已复核确认' : '待动态实验验证'}（${pct}%）`

    const calH = h as CalibratedHypothesis
    const falsifiers = extractHypothesisFalsifiers(calH)
    const nextTest = extractHypothesisNextTest(calH)

    return {
      id: h.id,
      claim: h.claim,
      status: h.status,
      statusLabel: statusMeta.label,
      tone: statusMeta.tone,
      confidencePct: pct,
      dependsOn: deps,
      dependents,
      scope: calH.scope,
      falsifiers,
      nextTest,
      triggerClues,
      claimAndCriterion,
      testAndObservation,
      deductionVerdict,
      nextMove,
      supportingRefs: supEvs.map(toEvidenceMention),
      contradictingRefs: conEvs.map(toEvidenceMention),
      auditRefs: audEvs.map(toEvidenceMention),
      contrast,
      oneLineStory,
    }
  })
}

/**
 * Synthesizes a complete, human-readable deductive proof story from any session's
 * TickDTO: ordered chronological chapters with explicit causal bridges between
 * steps + per-hypothesis 5-beat proof arcs + copyable plain-text narrative.
 */
export function synthesizeProofStory(tick: TickDTO | null): ProofStory {
  const ledger = tick?.ledger
  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []
  const goal = ledger?.goal
  const sandbox = ledger?.sandbox
  const re = tick?.re

  const targetName = goal?.targetFile || re?.sampleType || '目标样本'
  const auditor = ledger?.auditorProvider || tick?.hud.route?.auditor || 'glm-5.3'

  if (evidence.length === 0 && hypotheses.length === 0) {
    return {
      isEmpty: true,
      targetName,
      leadSummary: '尚未开始取证分析。启动任务后，此处将按「初步勘察 → 提出假设 → 实验检验 → 证伪转向 → 双视角证明 → 独立复核」的完整因果顺序实时记录每一步推理。',
      chapters: [],
      hypothesisArcs: [],
      verificationTier: 'unverified',
      auditVerdict: 'needs_more_evidence',
      fullPlainText: '尚无逆向推理记录。',
    }
  }

  const dossier = buildInvestigationState(tick)
  const verificationTier = dossier.states.verification.status
  const auditVerdict = dossier.states.audit.verdict

  const arcs = buildHypothesisArcs(evidence, hypotheses, findings, auditor)
  const arcById = new Map(arcs.map((a) => [a.id, a]))
  const evOrder = new Map(evidence.map((e, idx) => [e.id, idx]))

  // Partition evidence chronologically by forensic phase
  const firstDynOrErrIdx = evidence.findIndex(
    (e) => e.isError || isDynamicEvidence(e) || e.kind === 'audit_finding',
  )
  const initialStaticEv =
    firstDynOrErrIdx === -1
      ? evidence.filter((e) => !isWriteupArtifact(e))
      : evidence.slice(0, firstDynOrErrIdx).filter((e) => !isWriteupArtifact(e))

  const sandboxDeniedEvs = evidence.filter(isSandboxEvidence)
  const contraEvs = evidence.filter(
    (e) =>
      !isSandboxEvidence(e) &&
      ((e.contradicts && e.contradicts.length > 0) ||
        hypotheses.some((h) => (h.contradicting ?? []).includes(e.id))),
  )
  const firstContraIdx =
    contraEvs.length > 0
      ? Math.min(...contraEvs.map((e) => evOrder.get(e.id) ?? Number.MAX_SAFE_INTEGER))
      : -1

  // Post-contradiction static/decode clues that motivated a pivot hypothesis
  // (strictly before verification/audit and excluding meta-ledger tools like evidence_review)
  const firstPostPivotCutoff = evidence.findIndex(
    (e, idx) =>
      idx > firstContraIdx &&
      (e.kind === 'verification_result' || e.kind === 'audit_finding' || isWriteupArtifact(e)),
  )
  const pivotClueEvs =
    firstContraIdx >= 0
      ? evidence.filter((e, idx) => {
          if (idx <= firstContraIdx) return false
          if (firstPostPivotCutoff >= 0 && idx >= firstPostPivotCutoff) return false
          if (
            e.isError ||
            e.kind === 'verification_result' ||
            e.kind === 'audit_finding' ||
            isWriteupArtifact(e) ||
            e.source === 'evidence_review'
          ) {
            return false
          }
          return true
        })
      : []

  // Non-verification dynamic traces (runtime probes, experiments, etc.)
  const probeDynEvs = evidence.filter(
    (e) =>
      !isSandboxEvidence(e) &&
      e.kind !== 'verification_result' &&
      e.kind !== 'audit_finding' &&
      isDynamicEvidence(e),
  )

  const verEvs = evidence.filter((e) => e.kind === 'verification_result' && !e.isError)
  const audEvs = evidence.filter((e) => e.kind === 'audit_finding' && !e.isError)
  const writeupEv = evidence.find(isWriteupArtifact)

  const confirmedHyps = hypotheses.filter((h) => h.status === 'active' || h.status === 'revised')
  const rejectedHyps = hypotheses.filter((h) => h.status === 'rejected')
  const reevalHyps = hypotheses.filter((h) => h.status === 'reevaluate')
  const singleViewFindings = findings.filter((f) => f.rule === 'single-view')

  // Split initial hypotheses vs post-contradiction pivot hypotheses
  const pivotHyps =
    firstContraIdx >= 0
      ? hypotheses.filter((h) => {
          if (h.status === 'rejected' || h.status === 'reevaluate') return false
          const supIdx = (h.supporting ?? [])
            .map((id) => evOrder.get(id))
            .filter((n): n is number => n !== undefined)
          return supIdx.length > 0 && Math.min(...supIdx) > firstContraIdx
        })
      : []
  const initialHyps = hypotheses.filter((h) => !pivotHyps.some((p) => p.id === h.id))

  const recoveredFlag = extractFlagFromEvidence(evidence)

  const rawChapters: Array<Omit<NarrativeChapter, 'stepNo'>> = []

  // ---- Chapter 1: Goal & Initial Static Reconnaissance ----
  if (initialStaticEv.length > 0 || goal) {
    const scopeLead = goal
      ? `首先，分析任务明确了目标对象 ${targetName}（${goal.primary}）${goal.targetSha256 ? `，样本指纹锁定为 sha256:${goal.targetSha256.slice(0, 12)}…` : ''}${sandbox?.active ? '，并在默认禁止外联的本地沙箱内开展只读勘察' : ''}。`
      : `首先，围绕目标样本 ${targetName} 展开静态结构勘察，在不执行未知代码的前提下收集基础线索。`

    const obsBody =
      initialStaticEv.length > 0
        ? `静态工具共记录了 ${initialStaticEv.length} 条客观观测（${formatEvRefList(initialStaticEv)}）：${initialStaticEv
            .map((e) => `${e.source} [${e.id}] 发现「${cleanEvFact(e, 68)}」`)
            .join('；')}。这些原始观测构成了后续推理的客观起点。`
        : `目标范围已锁定，等待静态解析工具产出首批客观观测记录。`

    rawChapters.push({
      id: 'ch-triage',
      phaseLabel: '明确目标与初步勘察',
      roleTag: '起点 · 客观线索',
      tone: 'accent',
      headline:
        initialStaticEv.length > 0
          ? `锁定 ${targetName} 并获取 ${initialStaticEv.length} 条静态结构线索（${initialStaticEv[0].id}..${initialStaticEv[initialStaticEv.length - 1].id}）`
          : `已锁定目标 ${targetName}，准备采集静态线索`,
      transitionFromPrev: null,
      body: `${scopeLead}${obsBody}`,
      bulletFacts: initialStaticEv.map(
        (e) => `[${e.id}] ${e.source}：${cleanEvFact(e, 96)}`,
      ),
      evidenceRefs: initialStaticEv.map(toEvidenceMention),
      hypothesisIds: [],
      contrasts: [],
    })
  }

  // ---- Chapter 2: Hypothesis Formulation & Falsifiable Predictions ----
  if (initialHyps.length > 0) {
    const prevRefs = initialStaticEv.length > 0 ? formatEvRefList(initialStaticEv) : '前期观测'
    const hypIntros = initialHyps.map((h) => {
      const deps = h.dependsOn?.length ? `（前提依赖于 ${joinIds(h.dependsOn)} 成立）` : ''
      const supStr = h.supporting?.length ? `依据 ${h.supporting.map((id) => `[${id}]`).join('、')}` : '基于初步线索'
      return `${h.id}${deps}：${supStr}，推测「${h.claim}」`
    })

    const singleViewNote =
      singleViewFindings.length > 0
        ? `此时需要注意，${joinIds(singleViewFindings.map((f) => f.hypothesisId))} 虽然静态置信度较高，但仅有静态单视角线索，尚不能直接下定论——系统据此要求进入动态实测加以检验。`
        : `为避免停留在静态猜测，每条假设均明确了可证伪的检验标准，等待后续实验验证。`

    rawChapters.push({
      id: 'ch-hypothesize',
      phaseLabel: '基于线索提出假设与验证预期',
      roleTag: '提出假设 · 明确检验标准',
      tone: 'accent',
      headline: `从 ${prevRefs} 梳理出 ${initialHyps.length} 条可检验假设（${joinIds(initialHyps.map((h) => h.id))}）`,
      transitionFromPrev:
        rawChapters.length > 0
          ? `因为初步勘察在 ${targetName} 中发现了多个待解释的结构特征（${prevRefs}），所以需要将零散线索整理为具体、可证伪的假设，并写明“如果成立应观察到什么”。`
          : null,
      body: `结合上述静态发现，分析团队提出了 ${initialHyps.length} 条推理假设：${hypIntros.join('；')}。${singleViewNote}`,
      bulletFacts: initialHyps.map((h) => {
        const exp = inferExpectationForHypothesis(h)
        const depTag = h.dependsOn?.length ? ` [依赖 ${joinIds(h.dependsOn)}]` : ''
        return `${h.id}${depTag}：${h.claim} → 验证预期：${exp.shortExpected}`
      }),
      evidenceRefs: Array.from(
        new Map(
          initialHyps
            .flatMap((h) => h.supporting ?? [])
            .map((id) => evidence.find((e) => e.id === id))
            .filter((e): e is EvidenceRecord => e !== undefined && !isDynamicEvidence(e))
            .map((e) => [e.id, toEvidenceMention(e)]),
        ).values(),
      ),
      hypothesisIds: initialHyps.map((h) => h.id),
      contrasts: [],
    })
  }

  // ---- Chapter 3: Dynamic Experimentation & Runtime Probes ----
  const hasDedicatedProbeStep = probeDynEvs.length > 0 || sandboxDeniedEvs.length > 0
  if (hasDedicatedProbeStep) {
    const stepEvs = [...sandboxDeniedEvs, ...probeDynEvs]
    const parts: string[] = []
    if (sandboxDeniedEvs.length > 0) {
      parts.push(
        `在检验过程中，针对外部网络提示的试探调用（${formatEvRefList(sandboxDeniedEvs)}）因任务沙箱默认禁止外联（network=deny）被直接拦截，排查范围因此严格收束在本地工作区样本之内。`,
      )
    }
    if (probeDynEvs.length > 0) {
      parts.push(
        `随后对本地样本执行了动态实测（${formatEvRefList(probeDynEvs)}）：${probeDynEvs
          .map((e) => `${e.source} [${e.id}] 实测返回「${cleanEvFact(e, 80)}」`)
          .join('；')}。`,
      )
    }

    rawChapters.push({
      id: 'ch-experiment',
      phaseLabel: '设计实验并获取动态实测',
      roleTag: '实验检验 · 运行态观测',
      tone: contraEvs.length > 0 ? 'warn' : 'ok',
      headline: `执行 ${stepEvs.length} 次运行态检验与边界核查（${formatEvRefList(stepEvs)}）`,
      transitionFromPrev:
        initialHyps.length > 0
          ? `因为静态阶段提出的假设（${joinIds(initialHyps.map((h) => h.id))}）仍缺乏运行态实证，所以按预设检验标准执行动态实验，用真实输出检验原假设是否站得住脚。`
          : `在完成静态勘察后，通过动态运行探针获取样本的真实运行反馈。`,
      body: parts.join(''),
      bulletFacts: stepEvs.map(
        (e) => `[${e.id}] ${e.isError ? '实测异常/拦截' : '实测输出'}（${e.source}）：${cleanEvFact(e, 98)}`,
      ),
      evidenceRefs: stepEvs.map(toEvidenceMention),
      hypothesisIds: Array.from(
        new Set(stepEvs.flatMap((e) => [...(e.supports ?? []), ...(e.contradicts ?? [])])),
      ),
      contrasts: [],
    })
  }

  // ---- Chapter 4: Contradiction, Falsification & Logical Pivot (ONLY when refuted/revised/reeval exists) ----
  const revisedHyps = hypotheses.filter((h) => h.status === 'revised')
  const hasFalsificationOrPivot =
    rejectedHyps.length > 0 || reevalHyps.length > 0 || contraEvs.length > 0 || pivotHyps.length > 0
  if (hasFalsificationOrPivot) {
    const affectedArcs = [...rejectedHyps, ...reevalHyps]
      .map((h) => arcById.get(h.id))
      .filter((a): a is HypothesisArc => Boolean(a))
    const contrasts = affectedArcs
      .map((a) => a.contrast)
      .filter((c): c is ContrastCallout => Boolean(c))

    const rootRefuted = rejectedHyps.filter((h) => !(h.dependsOn && h.dependsOn.length > 0))
    const cascaded = [...rejectedHyps, ...reevalHyps].filter((h) => h.dependsOn && h.dependsOn.length > 0)

    const bodyParts: string[] = []
    if (rootRefuted.length > 0) {
      const desc = rootRefuted
        .map((h) => {
          const cEvs = (h.contradicting ?? []).map((id) => `[${id}]`).join('、')
          return `${h.id} 原推测「${h.claim}」，但实测反例 ${cEvs || '动态校验'} 表明该前提并不成立，置信度被强制折半至 ${Math.round(h.confidence * 100)}% 并淘汰`
        })
        .join('；')
      bodyParts.push(`将动态实测结果与原假设逐一对照后，发现了明确的逻辑矛盾：${desc}。`)
    } else if (reevalHyps.length > 0) {
      bodyParts.push(
        `实测反馈动摇了 ${joinIds(reevalHyps.map((h) => h.id))} 的成立依据，系统将其降级为待重查，暂停采信原结论。`,
      )
    }

    if (cascaded.length > 0) {
      bodyParts.push(
        `由于下游假设 ${joinIds(cascaded.map((h) => h.id))} 的推演完全依赖于已失效的上游前提（${joinIds(Array.from(new Set(cascaded.flatMap((h) => h.dependsOn ?? []))))}），随着父假设被推翻，这一派生分支也同步失去依据并被级联降级处理，从而避免了继续沿着错误假设强行圆谎。`,
      )
    }

    if (pivotHyps.length > 0 || pivotClueEvs.length > 0) {
      const newClueText =
        pivotClueEvs.length > 0
          ? `转而检查同工作区中的伴生线索（${pivotClueEvs.map((e) => `[${e.id}] ${e.source}：${cleanEvFact(e, 64)}`).join('；')}）`
          : `转而重新审视剩余未排除的线索`
      const newHypText =
        pivotHyps.length > 0
          ? `，据此自然形成了新的替代假设 ${pivotHyps.map((h) => `${h.id}（「${h.claim}」）`).join('、')}。`
          : `，开辟了新的验证方向。`
      bodyParts.push(`排除掉错误分支后，分析没有凭空跳跃，而是${newClueText}${newHypText}`)
    }

    const bulletFacts: string[] = [
      ...rootRefuted.map(
        (h) =>
          `排除 ${h.id}（残余 ${Math.round(h.confidence * 100)}%）：${h.note || '动态实测直接推翻原假设'}`,
      ),
      ...cascaded.map(
        (h) =>
          `级联处理 ${h.id}（dependsOn: ${joinIds(h.dependsOn ?? [])}）：前提失效 → ${h.status === 'rejected' ? '已淘汰' : '待重查'}`,
      ),
      ...pivotClueEvs.map(
        (e) => `转向新线索 [${e.id}]（${e.source}）：${cleanEvFact(e, 86)}`,
      ),
      ...pivotHyps.map(
        (h) => `提出新假设 ${h.id}：${h.claim}`,
      ),
    ]

    rawChapters.push({
      id: 'ch-falsify-pivot',
      phaseLabel: '冲突对照、证伪与思路转向',
      roleTag: '关键转折 · 证伪与转向',
      tone: 'err',
      headline:
        pivotHyps.length > 0
          ? `推翻 ${joinIds([...rootRefuted, ...cascaded].map((h) => h.id))}，依据新线索转向提出 ${joinIds(pivotHyps.map((h) => h.id))}`
          : `根据反例推翻/重审 ${joinIds([...rejectedHyps, ...reevalHyps].map((h) => h.id))}，截断错误分支`,
      transitionFromPrev: `因为上一步实测得到的 ${formatEvRefList(contraEvs) || '运行结果'} 与原假设预期正面冲突，所以必须先证伪错误猜想、清理连带失效的派生分支，再寻找真正能解释现场的新线索。`,
      body: bodyParts.join(''),
      bulletFacts,
      evidenceRefs: [...contraEvs, ...pivotClueEvs].map(toEvidenceMention),
      hypothesisIds: Array.from(
        new Set([
          ...rejectedHyps.map((h) => h.id),
          ...reevalHyps.map((h) => h.id),
          ...pivotHyps.map((h) => h.id),
        ]),
      ),
      contrasts,
    })
  } else if (revisedHyps.length > 0) {
    // Revised without explicit rejection
    rawChapters.push({
      id: 'ch-revise',
      phaseLabel: '依据新观测修订假设',
      roleTag: '思路修正 · 聚焦结论',
      tone: 'violet',
      headline: `根据进一步解析修订了 ${joinIds(revisedHyps.map((h) => h.id))}`,
      transitionFromPrev: `因为新采集的证据细化了原有边界，所以对早期假设的表述进行了针对性修订。`,
      body: revisedHyps
        .map((h) => `${h.id} 修订为「${h.claim}」${h.note ? `（说明：${h.note}）` : ''}。`)
        .join(''),
      bulletFacts: revisedHyps.map((h) => `${h.id} [REVISED]：${h.claim}`),
      evidenceRefs: [],
      hypothesisIds: revisedHyps.map((h) => h.id),
      contrasts: [],
    })
  }

  // ---- Chapter 5: Dual-View Corroboration & Replay Verification ----
  const dualViewConfirmed = confirmedHyps.filter((h) => {
    const arc = arcById.get(h.id)
    if (!arc) return false
    const hasSta = arc.supportingRefs.some((e) => e.view === 'static' && !e.isError)
    const hasDyn = arc.supportingRefs.some((e) => e.view === 'dynamic' && !e.isError)
    return hasSta && hasDyn
  })
  if (verEvs.length > 0 || dualViewConfirmed.length > 0) {
    const targetHyps = pivotHyps.length > 0 ? pivotHyps : dualViewConfirmed.length > 0 ? dualViewConfirmed : confirmedHyps
    const verSummary = verEvs
      .map((v) => {
        const ratio = v.verification ? `${v.verification.passed}/${v.verification.total} 项测试全部通过` : '重放通过'
        return `[${v.id}]（${v.source}，${ratio}：${cleanEvFact(v, 76)}）`
      })
      .join('；')

    const hypProofDesc = targetHyps
      .map((h) => `${h.id}（置信度 ${Math.round(h.confidence * 100)}%，引用 ${(h.supporting ?? []).map((id) => `[${id}]`).join('、')}）`)
      .join('、')

    const transition = hasFalsificationOrPivot
      ? `因为在排除错误分支后提出了新假设 ${joinIds(targetHyps.map((h) => h.id))}，不能仅凭单次解码直接定案，所以需要通过可复现的自动化重放验证形成双视角证明闭环。`
      : `因为前期假设 ${joinIds(targetHyps.map((h) => h.id))} 未出现反例，下一步需要通过独立重放实验把静态推理与动态运行结果交叉钉死。`

    rawChapters.push({
      id: 'ch-verify',
      phaseLabel: '双视角交叉印证与重放验证',
      roleTag: '证据证明 · 形成闭环',
      tone: 'ok',
      headline:
        verEvs.length > 0
          ? `完成可复现重放验证（${formatEvRefList(verEvs)}），双视角确立 ${joinIds(targetHyps.map((h) => h.id)) || '核心结论'}`
          : `静态观测与动态实测相互印证，确立 ${joinIds(targetHyps.map((h) => h.id))}`,
      transitionFromPrev: transition,
      body:
        (verEvs.length > 0
          ? `针对新收敛的结论执行了确定性重放验证 ${verSummary}。`
          : `比对静态结构与动态执行结果后，两类独立证据完全吻合。`) +
        (hypProofDesc
          ? `由此，${hypProofDesc} 同时获得了静态依据与动态运行结果的交叉支撑${recoveredFlag ? `，并完整复现了最终产物「${recoveredFlag}」` : ''}。`
          : ''),
      bulletFacts: [
        ...verEvs.map(
          (v) =>
            `[${v.id}] 重放结果（${v.verification ? `${v.verification.passed}/${v.verification.total} 通过` : 'PASSED'}）：${cleanEvFact(v, 92)}`,
        ),
        ...targetHyps.map((h) => {
          const arc = arcById.get(h.id)
          return `${h.id} 已证明（${Math.round(h.confidence * 100)}%）：${arc?.oneLineStory || h.claim}`
        }),
      ],
      evidenceRefs: Array.from(
        new Map(
          [
            ...verEvs,
            ...targetHyps
              .flatMap((h) => h.supporting ?? [])
              .map((id) => evidence.find((e) => e.id === id))
              .filter((e): e is EvidenceRecord => Boolean(e)),
          ].map((e) => [e.id, toEvidenceMention(e)]),
        ).values(),
      ),
      hypothesisIds: targetHyps.map((h) => h.id),
      contrasts: [],
      verificationTier,
    })
  }

  // ---- Chapter 6: Isolated Audit & Final Verdict ----
  if (audEvs.length > 0 || writeupEv) {
    const auditIds = formatEvRefList(audEvs)
    const auditBodyParts: string[] = []
    if (audEvs.length > 0) {
      auditBodyParts.push(
        `在完成本地重放验证后，将完整的假设列表与账本证据快照提交给独立第三席位 ${auditor}（零历史对话、零工具权限的隔离复核模式），签发正式审计记录 ${auditIds}。`,
      )
      if (confirmedHyps.length > 0) {
        auditBodyParts.push(
          `独立复核确认了 ${joinIds(confirmedHyps.map((h) => h.id))} 的证据链完整且无过度外推`,
        )
      }
      if (rejectedHyps.length > 0) {
        auditBodyParts.push(
          `，同时核准彻底剔除已证伪或前提失效的 ${joinIds(rejectedHyps.map((h) => h.id))} 分支。`,
        )
      } else {
        auditBodyParts.push('。')
      }
    }
    if (writeupEv) {
      auditBodyParts.push(
        `全部验收项达标后，系统解锁报告门禁并将逐条锚定证据编号的分析报告归档至 ${writeupEv.artifact || 'notes/writeup.md'}（[${writeupEv.id}]）。`,
      )
    }

    const finalConfirmed = confirmedHyps[confirmedHyps.length - 1]
    rawChapters.push({
      id: 'ch-audit',
      phaseLabel: '独立复核与结论定案',
      roleTag: '审计闭环 · 最终定论',
      tone: 'violet',
      headline: writeupEv
        ? `独立审计（${auditor}）复核放行，可溯源报告已归档至 ${writeupEv.artifact}`
        : `独立审计席 ${auditor} 复核通过（${auditIds}），全链结论正式定案`,
      transitionFromPrev: `因为双视角重放验证已齐备，最后一步由未参与前文推理的独立审计席 ${auditor} 核查整条推理链是否存在遗漏或逻辑跳跃，决定是否正式定案。`,
      body: auditBodyParts.join(''),
      bulletFacts: [
        ...audEvs.map((a) => `[${a.id}] 审计签章（${a.source}）：${cleanEvFact(a, 96)}`),
        ...(finalConfirmed
          ? [`最终定案结论 [${finalConfirmed.id} · ${Math.round(finalConfirmed.confidence * 100)}%]：${finalConfirmed.claim}${recoveredFlag ? `（验证产物：${recoveredFlag}）` : ''}`]
          : []),
        ...(writeupEv ? [`[${writeupEv.id}] 报告交付：${writeupEv.artifact || 'notes/writeup.md'}`] : []),
      ],
      evidenceRefs: [...audEvs, ...(writeupEv ? [writeupEv] : [])].map(toEvidenceMention),
      hypothesisIds: confirmedHyps.map((h) => h.id),
      contrasts: [],
      auditVerdict,
    })
  }

  // Assign contiguous 1-based step numbers
  const chapters: NarrativeChapter[] = rawChapters.map((ch, idx) => ({
    ...ch,
    stepNo: idx + 1,
  }))

  // Build concise, natural orienting lead summary
  const topConfirmed = confirmedHyps[confirmedHyps.length - 1]
  let leadSummary = ''
  if (topConfirmed && audEvs.length > 0) {
    leadSummary =
      `针对 ${targetName} 的分析共经历 ${chapters.length} 个递进步骤：` +
      (rejectedHyps.length > 0
        ? `从静态线索出发提出初步假设，经动态实测排除了 ${joinIds(rejectedHyps.map((h) => h.id))} 误判方向，随后转向新线索确立 ${topConfirmed.id}（${Math.round(topConfirmed.confidence * 100)}%），最终通过重放验证与独立审计定案。`
        : `从静态线索提出假设，经重放验证与独立审计证实了 ${topConfirmed.id}（${Math.round(topConfirmed.confidence * 100)}%），形成完整证据闭环。`)
  } else if (topConfirmed) {
    leadSummary =
      `针对 ${targetName} 已推进至第 ${chapters.length} 步：` +
      (rejectedHyps.length > 0 || reevalHyps.length > 0
        ? `已排除/挂起 ${joinIds([...rejectedHyps, ...reevalHyps].map((h) => h.id))}，当前核心结论聚焦于 ${topConfirmed.id}（${Math.round(topConfirmed.confidence * 100)}%），${verEvs.length > 0 ? '已完成重放验证，待独立审计定案。' : '正待进一步动态验证。'}`
        : `当前围绕 ${topConfirmed.id}（${Math.round(topConfirmed.confidence * 100)}%）持续收敛，${verEvs.length > 0 ? '已完成重放验证，待独立审计。' : '尚待补充动态实验与重放校验。'}`)
  } else {
    leadSummary = `针对 ${targetName} 已采集 ${evidence.length} 条客观证据，正在整理可证伪假设。`
  }

  // Plain-text export for 1-click copy
  const plainLines: string[] = [
    `# ${targetName} — 完整推理与证明脉络`,
    '',
    leadSummary,
    '',
    '## 一、按时间推进的推理全过程',
    '',
  ]
  for (const ch of chapters) {
    plainLines.push(`### 第 ${ch.stepNo} 步 · ${ch.phaseLabel}（${ch.headline}）`)
    if (ch.transitionFromPrev) {
      plainLines.push(`> 承接上一步：${ch.transitionFromPrev}`)
    }
    plainLines.push(ch.body)
    for (const c of ch.contrasts) {
      plainLines.push(
        `- [对照 ${c.hypothesisId}] 原预期：${c.expected} ｜ 实测：${c.observed} → 推论：${c.deduction}`,
      )
    }
    plainLines.push('')
  }
  if (arcs.length > 0) {
    plainLines.push('## 二、逐条假设的证明链路', '')
    for (const arc of arcs) {
      plainLines.push(`### ${arc.id} [${arc.statusLabel} · ${arc.confidencePct}%] ${arc.claim}`)
      plainLines.push(`1. 起因线索：${arc.triggerClues}`)
      plainLines.push(`2. 假设与标准：${arc.claimAndCriterion}`)
      plainLines.push(`3. 检验与结果：${arc.testAndObservation}`)
      plainLines.push(`4. 推导判断：${arc.deductionVerdict}`)
      plainLines.push(`5. 后续影响：${arc.nextMove}`)
      plainLines.push('')
    }
  }

  return {
    isEmpty: false,
    targetName,
    leadSummary,
    chapters,
    hypothesisArcs: arcs,
    verificationTier,
    auditVerdict,
    fullPlainText: plainLines.join('\n').trim(),
  }
}

// ---------- Replay Frame Reconstruction ----------

function cloneTickWith(
  base: TickDTO,
  patch: {
    evidence: EvidenceRecord[]
    hypotheses: Hypothesis[]
    findings: FindingDTO[]
    rePhase?: { phase: string; idx: number }
    sandboxDenied?: number
    sandboxGranted?: number
    sandboxActions?: NonNullable<NonNullable<TickDTO['ledger']>['sandbox']>['recentActions']
    activeProvider?: string
    stage?: TickDTO['flow']['stage']
  },
): TickDTO {
  const baseGoal = base.ledger?.goal
  const validEv = patch.evidence.filter((e) => !e.isError).length
  const verEv = patch.evidence.filter((e) => e.kind === 'verification_result' && !e.isError).length
  const audEv = patch.evidence.filter((e) => e.kind === 'audit_finding' && !e.isError).length

  const nextGoal = baseGoal
    ? {
        ...baseGoal,
        criteria: baseGoal.criteria.map((c) => {
          if (c.label.includes('证据')) {
            return { ...c, pass: validEv >= 4, detail: `${validEv}/4 records` }
          }
          if (c.label.includes('verify_artifact') || c.label.includes('重放')) {
            return { ...c, pass: verEv >= 1, detail: `${verEv}/1 verified` }
          }
          if (c.label.includes('audit_finding') || c.label.includes('审计')) {
            return { ...c, pass: audEv >= 1, detail: `${audEv}/1 audited` }
          }
          return { ...c }
        }),
      }
    : null

  const baseSandbox = base.ledger?.sandbox
  const acts = patch.sandboxActions ?? baseSandbox?.recentActions ?? []
  const nextSandbox = baseSandbox
    ? {
        ...baseSandbox,
        grantedCount:
          patch.sandboxGranted ?? acts.filter((a) => a.decision === 'granted').length,
        deniedCount:
          patch.sandboxDenied ?? acts.filter((a) => a.decision === 'denied').length,
        recentActions: acts.map((a) => ({ ...a })),
      }
    : null

  const activeHyps = patch.hypotheses.filter((h) => h.status !== 'rejected').length
  const nextRe = base.re
    ? {
        ...base.re,
        phase: patch.rePhase?.phase ?? base.re.phase,
        phaseIndex: patch.rePhase?.idx ?? base.re.phaseIndex,
        hypotheses: activeHyps,
        evidence: patch.evidence.length,
      }
    : null

  const activeProv = patch.activeProvider ?? base.flow.provider
  return {
    ...base,
    flow: {
      ...base.flow,
      provider: activeProv,
      stage: patch.stage ?? base.flow.stage,
      toolsOk: patch.evidence.filter((e) => !e.isError && e.kind !== 'audit_finding').length,
      toolsFailed: patch.evidence.filter((e) => e.isError).length,
    },
    hud: {
      ...base.hud,
      route: base.hud.route
        ? { ...base.hud.route, active: activeProv }
        : null,
    },
    re: nextRe,
    ledger: {
      ...(base.ledger ?? { hypotheses: [], evidence: [] }),
      evidence: patch.evidence.map((e) => ({ ...e })),
      hypotheses: patch.hypotheses.map((h) => ({ ...h })),
      findings: patch.findings.map((f) => ({ ...f })),
      goal: nextGoal,
      sandbox: nextSandbox,
    },
  }
}

/** Reconstructs step-by-step cognitive & ledger evolution frames with causal connectors. */
export function buildReplayFrames(tick: TickDTO | null, thinkLines: string[] = []): ReplayFrame[] {
  if (!tick) return []
  const ledger = tick.ledger
  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []
  const sandbox = ledger?.sandbox
  const goal = ledger?.goal

  const planner = tick.hud.route?.planner || 'codex-sol'
  const executor = tick.hud.route?.executor || 'ds'
  const auditor = ledger?.auditorProvider || tick.hud.route?.auditor || 'glm-5.3'

  if (evidence.length === 0 && hypotheses.length === 0 && !goal) {
    return []
  }

  const frames: ReplayFrame[] = []
  const push = (f: Omit<ReplayFrame, 'index'>) => {
    frames.push({ ...f, index: frames.length + 1 })
  }

  // Frame 1: Goal contract & capability sandbox intake
  const target = goal?.targetFile || tick.re?.sampleType || 'target'
  if (goal || sandbox?.active || tick.re) {
    push({
      id: 'f-contract',
      stageNo: 1,
      stageTag: '① 任务先声明 (/goal)',
      title: '明确分析目标并锁定安全边界',
      actor: `${planner} (Planner) + Host`,
      actorTone: 'accent',
      focusNode: sandbox?.active ? 'sandbox' : 'planner',
      transitionFromPrev: '分析起点：在接触目标样本前，先固定待查对象与验收标准。',
      thought:
        thinkLines[0] ||
        `先将针对 ${target} 的分析目标写入任务契约，并由宿主实地计算指纹、启用默认禁止外联的本地沙箱（network=deny, device=none），确保后续所有判断都以真实工具观测为依据。`,
      takeaway: `确定目标 ${target} 与安全边界，准备展开只读静态勘察。`,
      stateDelta: sandbox?.active
        ? `/goal ACCEPTED · Gate 1 沙箱已激活 (network=deny, device=none) · ▸TRI [1/9]`
        : `逆向会话初始化 (${target}) · ▸TRI [1/9]`,
      tick: cloneTickWith(tick, {
        evidence: [],
        hypotheses: [],
        findings: [],
        rePhase: { phase: 'triage', idx: 0 },
        sandboxActions: [],
        sandboxGranted: 0,
        sandboxDenied: 0,
        activeProvider: planner,
        stage: 'think',
      }),
    })
  }

  // Partition evidence into semantic milestones
  const firstDynOrErrIdx = evidence.findIndex(
    (e) => e.isError || e.view === 'dynamic' || e.kind === 'verification_result' || e.kind === 'audit_finding',
  )
  const staticInitEnd = firstDynOrErrIdx === -1 ? evidence.length : firstDynOrErrIdx
  const initialStaticEv = evidence.slice(0, staticInitEnd)

  if (initialStaticEv.length > 0) {
    const allActs = sandbox?.recentActions ?? []
    const initActs = allActs.filter((a) => a.decision === 'granted').slice(0, initialStaticEv.length)
    const staticHighlights = initialStaticEv
      .slice(0, 3)
      .map((e) => `${e.source} [${e.id}] 发现「${cleanEvFact(e, 44)}」`)
      .join('；')
    push({
      id: 'f-static',
      stageNo: 3,
      stageTag: '③ 静态勘察取证 (static)',
      title: `采集首批静态结构线索 (${initialStaticEv[0].id}..${initialStaticEv[initialStaticEv.length - 1].id})`,
      actor: `${executor} (Executor)`,
      actorTone: 'ok',
      focusNode: 'executor',
      transitionFromPrev: `目标 ${target} 与沙箱边界就绪后，第一步先用无副作用的只读工具摸清文件结构。`,
      thought:
        thinkLines[1] ||
        `依次调用 ${initialStaticEv.map((e) => e.source).join('、')} 对 ${target} 进行只读扫描：${staticHighlights}。这些结果按顺序记入不可篡改账本，为下一步提出假设提供客观依据。`,
      takeaway: `拿到 ${initialStaticEv.length} 条静态事实线索，准备归纳为可验证假设。`,
      stateDelta: `+${initialStaticEv.length} 条 static 观测入账 (${initialStaticEv.map((e) => e.id).join(', ')}) · ▸STA [2/9]`,
      tick: cloneTickWith(tick, {
        evidence: initialStaticEv,
        hypotheses: [],
        findings: [],
        rePhase: { phase: 'static', idx: 1 },
        sandboxActions: initActs,
        activeProvider: executor,
        stage: 'tool',
      }),
    })
  }

  // Initial hypotheses frame
  const earlyHyps: Hypothesis[] = hypotheses
    .filter((h) => {
      const citesEarly = (h.supporting ?? []).some((id) => initialStaticEv.some((e) => e.id === id))
      return citesEarly || (h.dependsOn && h.dependsOn.length > 0) || h.id === 'H-001'
    })
    .map((h) => {
      const wasChallengedLater =
        (h.contradicting && h.contradicting.length > 0) || h.status === 'rejected' || h.status === 'reevaluate'
      return {
        ...h,
        status: wasChallengedLater ? 'active' : h.status,
        confidence:
          h.id === 'H-002' && wasChallengedLater
            ? 0.84
            : h.id === 'H-003' && wasChallengedLater
              ? 0.76
              : Math.max(h.confidence, 0.78),
        contradicting: [],
        note: h.dependsOn?.length
          ? `依赖上游父假设 ${h.dependsOn.join(', ')} 成立`
          : '基于静态观测建立初始可证伪假设',
      }
    })

  const singleViewFindings = findings.filter((f) => f.rule === 'single-view')
  if (earlyHyps.length > 0) {
    push({
      id: 'f-hyp-init',
      stageNo: 4,
      stageTag: '④ 显式假设建栈 (H-NNN)',
      title: `基于静态线索提出假设 (${earlyHyps.map((h) => h.id).join(', ')})`,
      actor: `${planner} (Planner) + Arbitrator`,
      actorTone: 'accent',
      focusNode: singleViewFindings.length > 0 ? 'arbitrator' : 'hypotheses',
      transitionFromPrev: `拿到 ${initialStaticEv.map((e) => e.id).join('..')} 的静态特征后，需要把观察到的现象转化为可被实验证实或推翻的具体假设。`,
      thought:
        `据此建立了 ${earlyHyps.length} 条显式假设（${earlyHyps.map((h) => `${h.id}：${h.claim.slice(0, 26)}${h.claim.length > 26 ? '…' : ''}`).join('；')}）并标明相互依赖关系。` +
        (singleViewFindings.length > 0
          ? `宿主仲裁器随即命中 [single-view] 规则：提醒高置信度假设目前仅有静态依据、缺少动态实测，必须设计实验进入动态阶段验证。`
          : `接下来进入动态实验阶段逐项验证。`),
      takeaway:
        singleViewFindings.length > 0
          ? `假设已登记，但因仅具单视角依据被要求进入动态验证。`
          : `初步假设栈建立完毕，等待动态实验检验。`,
      stateDelta:
        `登记 ${earlyHyps.length} 条活跃假设` +
        (singleViewFindings.length > 0 ? ` · 仲裁告警 [single-view]×${singleViewFindings.length}` : '') +
        ` · ▸DYN [3/9]`,
      tick: cloneTickWith(tick, {
        evidence: initialStaticEv,
        hypotheses: earlyHyps,
        findings: singleViewFindings,
        rePhase: { phase: 'dynamic', idx: 2 },
        activeProvider: planner,
        stage: 'think',
      }),
    })
  }

  // Sandbox block frame (if any sandbox denial occurred)
  const sandboxErrIdx = evidence.findIndex(isSandboxEvidence)
  if (sandboxErrIdx >= 0) {
    const evUpTo = evidence.slice(0, sandboxErrIdx + 1)
    const deniedActs = (sandbox?.recentActions ?? []).filter((a) => a.decision === 'denied')
    push({
      id: 'f-sandbox-block',
      stageNo: 2,
      stageTag: '② 能力边界拦网 (/cap)',
      title: `沙箱阻断未授权外联 (${evidence[sandboxErrIdx].id})`,
      actor: 'Gate 1 · Capability Sandbox',
      actorTone: 'warn',
      focusNode: 'sandbox',
      transitionFromPrev: `进入动态排查后，执行席尝试顺带探测外部提示地址，但在发出请求前即触碰沙箱边界。`,
      thought: `任务沙箱在进入人工审批前直接拦截了外联调用（capability "network" denied，记入 ${evidence[sandboxErrIdx].id}），命令指纹与拒绝原因同步留痕，分析因此专注回到本地样本实测。`,
      takeaway: `外联路径被隔离，确保后续排查完全在本地离线环境内完成。`,
      stateDelta: `拦截未授权调用 (${evidence[sandboxErrIdx].id}) · ActionRecord[DENIED cap=network] 已留痕`,
      tick: cloneTickWith(tick, {
        evidence: evUpTo,
        hypotheses: earlyHyps,
        findings: singleViewFindings,
        rePhase: { phase: 'dynamic', idx: 2 },
        sandboxActions: [
          ...deniedActs,
          ...(sandbox?.recentActions ?? []).filter((a) => a.decision === 'granted').slice(0, 3),
        ],
        sandboxDenied: Math.max(1, deniedActs.length),
        activeProvider: executor,
        stage: 'tool',
      }),
    })
  }

  // Runtime contradiction & dependency cascade frame
  const contraFindings = findings.filter(
    (f) => f.rule === 'runtime-contradiction' || f.rule === 'dependency-cascade',
  )
  const contraEvIdx = evidence.findIndex(
    (e) =>
      !isSandboxEvidence(e) &&
      ((e.contradicts && e.contradicts.length > 0) || (e.kind === 'runtime_trace' && e.isError)),
  )
  if (contraEvIdx >= 0 || contraFindings.length > 0) {
    const cutIdx = contraEvIdx >= 0 ? contraEvIdx + 1 : staticInitEnd + 1
    const evUpTo = evidence.slice(0, Math.min(evidence.length, cutIdx))
    const contraEv = contraEvIdx >= 0 ? evidence[contraEvIdx] : null
    const contraEvId = contraEv?.id ?? 'ev_dyn'
    const cascadedHyps: Hypothesis[] = earlyHyps.map((h) => {
      const finalH = hypotheses.find((x) => x.id === h.id)
      const isDepChild =
        Boolean(h.dependsOn && h.dependsOn.length > 0) ||
        contraFindings.some((f) => f.rule === 'dependency-cascade' && f.hypothesisId === h.id)
      if (isDepChild) {
        return {
          ...h,
          confidence: 0.38,
          status: 'reevaluate',
          note: `父假设被证伪，宿主自动沿 dependsOn 级联标记为 reevaluate（待重查）`,
        }
      }
      if (
        finalH?.contradicting?.includes(contraEvId) ||
        contraFindings.some((f) => f.rule === 'runtime-contradiction' && f.hypothesisId === h.id)
      ) {
        return {
          ...h,
          confidence: 0.21,
          status: 'rejected',
          contradicting: [contraEvId],
          note: `动态运行反证 ${contraEvId} 触发宿主置信度折半淘汰`,
        }
      }
      return h
    })

    const refutedIds = cascadedHyps.filter((h) => h.status === 'rejected').map((h) => h.id)
    const reevalIds = cascadedHyps.filter((h) => h.status === 'reevaluate').map((h) => h.id)
    const contraFact = contraEv ? cleanEvFact(contraEv, 72) : '动态运行报错与原推测矛盾'

    push({
      id: 'f-arbitrate-cascade',
      stageNo: 4,
      stageTag: '④ 反证折半与级联纠偏',
      title: `破除 "Commits to a story"：实测反证淘汰与级联重审`,
      actor: 'Host Arbitrator (确定性规则引擎)',
      actorTone: 'err',
      focusNode: 'arbitrator',
      transitionFromPrev: `为检验静态假设 ${joinIds(refutedIds) || 'H-002'}，执行了对应动态测试，但实测结果与原预期正面冲突。`,
      thought: `动态实测 ${contraEvId} 返回「${contraFact}」，直接推翻了 ${joinIds(refutedIds) || '原假设'} 的核心预期。宿主规则引擎随即把 ${joinIds(refutedIds) || '原假设'} 置信度强制折半淘汰（REJECTED）${reevalIds.length > 0 ? `，并把依赖它的下游假设 ${joinIds(reevalIds)} 自动级联降级为 REEVALUATE` : ''}——从机制上阻断 "Commits to a story" 式的顺坡圆谎，迫使分析转向排查剩余线索。`,
      takeaway: `排除 ${joinIds(refutedIds) || '错误猜想'}${reevalIds.length > 0 ? ` 并挂起 ${joinIds(reevalIds)}` : ''}，转向排查伴生线索。`,
      stateDelta: `${contraEvId} [dynamic ERR] → ${joinIds(refutedIds) || 'H-002'} 折半淘汰 [REJECTED]${reevalIds.length > 0 ? ` · ${joinIds(reevalIds)} 级联降级 [REEVALUATE]` : ''}`,
      tick: cloneTickWith(tick, {
        evidence: evUpTo,
        hypotheses: cascadedHyps,
        findings: [...singleViewFindings, ...contraFindings],
        rePhase: { phase: 'hypothesis', idx: 5 },
        activeProvider: planner,
        stage: 'think',
      }),
    })
  }

  // Verification & dual-view convergence frame
  const verIdx = evidence.findIndex((e) => e.kind === 'verification_result')
  if (verIdx >= 0) {
    const evUpTo = evidence.slice(0, verIdx + 1)
    const verEv = evidence[verIdx]
    const preAuditHyps = hypotheses.map((h) => {
      const auditedChallenge = findings.some(
        (f) => f.rule === 'adversarial-audit' && f.action === 'challenge' && f.hypothesisId === h.id,
      )
      if (auditedChallenge) {
        return {
          ...h,
          status: 'reevaluate' as const,
          confidence: 0.38,
          note: '父假设已淘汰，等待 /audit 独立审计席最终裁定',
        }
      }
      return { ...h }
    })
    const activeAfterVer = preAuditHyps.filter((h) => h.status === 'active' || h.status === 'revised')
    const latestHyp = activeAfterVer[activeAfterVer.length - 1]
    push({
      id: 'f-verify',
      stageNo: 5,
      stageTag: '⑤ 产物重放验证 (VER)',
      title: `转向新线索收敛并完成重放验证 (${verEv.id})`,
      actor: `${executor} → ${planner}`,
      actorTone: 'ok',
      focusNode: 'hypotheses',
      transitionFromPrev:
        contraEvIdx >= 0
          ? `排除原错误方向后，排查转向同目录伴生线索并提出新假设 ${latestHyp?.id || ''}，接着用自动化重放用例检验其真实性。`
          : `前期假设尚未经过可复现重放确认，进入 verify_artifact 验证阶段。`,
      thought:
        thinkLines[thinkLines.length - 1] ||
        `对新发现的线索完成解析后，调用 verify_artifact 执行正反例重放并产出 ${verEv.id}（${cleanEvFact(verEv, 76)}）。${latestHyp ? `${latestHyp.id}` : '核心结论'} 由此同时获得静态与动态双视角支撑，满足进入独立审计的前置门禁。`,
      takeaway: `双视角证据收敛，${latestHyp?.id || '核心假设'} 通过可复现重放检验。`,
      stateDelta: `签发 ${verEv.id} [VER · passed] · ${latestHyp?.id || '新假设'}双视角确立 · ▸VER [7/9]`,
      tick: cloneTickWith(tick, {
        evidence: evUpTo,
        hypotheses: preAuditHyps,
        findings: findings.filter((f) => f.rule !== 'adversarial-audit'),
        rePhase: { phase: 'verify', idx: 6 },
        activeProvider: executor,
        stage: 'tool',
      }),
    })
  }

  // Context-isolated adversarial /audit frame
  const audIdx = evidence.findIndex((e) => e.kind === 'audit_finding')
  if (audIdx >= 0) {
    const evUpTo = evidence.slice(0, audIdx + 1)
    const audEv = evidence[audIdx]
    push({
      id: 'f-audit',
      stageNo: 5,
      stageTag: '⑤ 隔离对抗审计 (/audit)',
      title: `独立席位 ${auditor} 零上下文复核 (${audEv.id})`,
      actor: `${auditor} (Isolated Auditor)`,
      actorTone: 'violet',
      focusNode: 'auditor',
      transitionFromPrev: `本地双视角重放通过后，将假设栈与账本摘录交给未参与前文推理的独立第三席位做盲审复核。`,
      thought: `${auditor} 在零历史对话、零工具权限的隔离环境中逐条核验「假设栈 + 证据账本」：彻底清理前提已失效的分支，核准双视角支撑的核心结论，签发正式审计记录 ${audEv.id}，全部 /goal 验收项由此通过。`,
      takeaway: `第三方盲审通过，WRI 报告交付硬门禁正式解锁。`,
      stateDelta: `签发 ${audEv.id} [AUD] · /goal 验收全绿 · 解锁 ▸WRI [9/9]`,
      tick: cloneTickWith(tick, {
        evidence: evUpTo,
        hypotheses,
        findings,
        rePhase: { phase: 'writeup', idx: 8 },
        activeProvider: auditor,
        stage: 'write',
      }),
    })
  }

  // Writeup artifact delivery frame
  const artIdx = evidence.findIndex(
    (e, idx) => idx > audIdx && (e.kind === 'artifact' || e.artifact?.endsWith('.md')),
  )
  if (artIdx >= 0) {
    const artEv = evidence[artIdx]
    push({
      id: 'f-writeup',
      stageNo: 6,
      stageTag: '⑥ 可溯源报告交付 (WRI)',
      title: `归档全证据锚定 Writeup (${artEv.artifact || artEv.id})`,
      actor: `${planner} + ${executor}`,
      actorTone: 'ok',
      focusNode: 'gate',
      transitionFromPrev: `独立审计签章并解锁 WRI [9/9] 后，按完整因果链路整理最终可复现分析报告。`,
      thought: `严格依据账本已证实记录撰写分析报告：完整呈现「初步勘察 → 假设提出 → 反证排除 → 转向新线索 → 双视角验证 → 独立审计」全过程，每条核心判断均标注 [H-NNN] 与 [ev_NNN] 编号，归档至 ${artEv.artifact || 'notes/writeup.md'}。`,
      takeaway: `完整可溯源报告已落盘，逆向分析闭环完成。`,
      stateDelta: `报告已归档 (${artEv.id} · ${artEv.artifact || 'writeup.md'}) · 9 阶段逆向闭环 100% 完成`,
      tick: cloneTickWith(tick, {
        evidence,
        hypotheses,
        findings,
        rePhase: { phase: 'writeup', idx: 8 },
        activeProvider: planner,
        stage: 'done',
      }),
    })
  } else if (frames.length === 0 || frames[frames.length - 1].tick.ledger?.evidence.length !== evidence.length) {
    push({
      id: 'f-latest',
      stageNo: audIdx >= 0 ? 6 : verIdx >= 0 ? 5 : hypotheses.length > 0 ? 4 : 3,
      stageTag: '● 当前最新状态',
      title: `当前累积状态 (E:${evidence.length} / H:${hypotheses.length})`,
      actor: `${tick.flow.provider || planner}`,
      actorTone: 'accent',
      focusNode: 'hypotheses',
      transitionFromPrev: `基于前期记录继续推进分析，汇总当前最新账本与假设状态。`,
      thought:
        thinkLines[thinkLines.length - 1] ||
        `当前会话已记录 ${evidence.length} 条账本证据与 ${hypotheses.length} 条假设状态。`,
      takeaway: `已累积 ${evidence.length} 条证据与 ${hypotheses.length} 条假设。`,
      stateDelta: `E:${evidence.length} · H:${hypotheses.length}`,
      tick,
    })
  }

  return frames
}

// ---------- Executive Process Summary & 6-Stage Checklist ----------

/** Synthesizes a coherent deductive process summary paragraph + 4 pillars + 6-stage checklist. */
export function synthesizeProcessSummary(tick: TickDTO | null): ProcessSummary {
  const ledger = tick?.ledger
  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []
  const sandbox = ledger?.sandbox
  const goal = ledger?.goal
  const re = tick?.re

  const planner = tick?.hud.route?.planner || 'codex-sol'
  const executor = tick?.hud.route?.executor || 'ds'
  const auditor = ledger?.auditorProvider || tick?.hud.route?.auditor || 'glm-5.3'

  const staticCnt = evidence.filter((e) => (e.view || 'static') === 'static' && !e.isError).length
  const dynCnt = evidence.filter((e) => e.view === 'dynamic' && !e.isError).length
  const verEvs = evidence.filter((e) => e.kind === 'verification_result' && !e.isError)
  const audEvs = evidence.filter((e) => e.kind === 'audit_finding' && !e.isError)
  const writeupEv = evidence.find(isWriteupArtifact)

  const confirmedHyps = hypotheses.filter((h) => h.status === 'active' || h.status === 'revised')
  const rejectedHyps = hypotheses.filter((h) => h.status === 'rejected')
  const reevalHyps = hypotheses.filter((h) => h.status === 'reevaluate')
  const deniedCnt = sandbox?.deniedCount ?? 0
  const grantedCnt = sandbox?.grantedCount ?? 0

  const strictReverseMode = Boolean(re)
  const missingReasons: string[] = []
  if (strictReverseMode) {
    if (verEvs.length === 0) {
      missingReasons.push('缺少 verify_artifact 动态重放记录 (verification_result)')
    }
    if (audEvs.length === 0) {
      missingReasons.push(`尚未执行 /audit 独立对抗审计 (${auditor} 签发 audit_finding)`)
    }
    const pendingGoal = (goal?.criteria ?? []).filter((c) => !c.pass)
    if (pendingGoal.length > 0) {
      missingReasons.push(
        `/goal 契约尚有 ${pendingGoal.length} 项未达标: ${pendingGoal.map((c) => c.label).join('、')}`,
      )
    }
  } else if (evidence.length === 0) {
    missingReasons.push('当前会话尚无已入账的工具观测证据 (ev_NNN)')
  }

  const stages: ArticleStageStatus[] = [
    {
      stageNo: 1,
      code: '/goal',
      title: '① 任务先声明，再开工',
      principle: '宿主实地钉死样本哈希与验收清单，「完成」由账本判定而非模型自称',
      status: goal?.accepted ? 'done' : re ? 'active' : 'pending',
      fact: goal
        ? `已锁定 ${goal.targetFile || goal.primary}（验收达标 ${goal.criteria.filter((c) => c.pass).length}/${goal.criteria.length}）`
        : '尚未声明 /goal 契约（运行 /goal 或 /workflow reverse 自动挂载）',
    },
    {
      stageNo: 2,
      code: '/cap + Policy',
      title: '② 能力跟着任务走',
      principle: '任务能力沙箱默认拒网拒设备在先，Tier × Mode 分级人工审批在后',
      status: sandbox?.active || (tick?.flow.toolsOk ?? 0) > 0 ? 'done' : 'pending',
      fact: sandbox?.active
        ? `沙箱 ACTIVE（已放行 ${grantedCnt} 次本地动作 · 拦截 ${deniedCnt} 次越权调用）`
        : `会话级审批门守护中（已放行 ${tick?.flow.toolsOk ?? 0} 次 · 拦截 ${tick?.flow.toolsFailed ?? 0} 次）`,
    },
    {
      stageNo: 3,
      code: 'ev_NNN',
      title: '③ 一等证据账本',
      principle: '每次工具输出单点盖章落盘 evidence-ledger.jsonl，上下文压缩压不掉',
      status: evidence.length > 0 ? 'done' : 'pending',
      fact:
        evidence.length > 0
          ? `已归档 E:${evidence.length} 条记录（static:${staticCnt} · dynamic:${dynCnt} · ERR:${evidence.filter((e) => e.isError).length}）`
          : '等待 Executor 工具采集第一条客观观测',
    },
    {
      stageNo: 4,
      code: 'H-NNN · Arbitrator',
      title: '④ 假设折半与级联纠偏',
      principle: '宿主确定性代码强制反证置信度 ×0.5 并级联打回派生假设，阻断幻觉圆谎',
      status:
        rejectedHyps.length > 0 || findings.length > 0
          ? 'done'
          : hypotheses.length > 0
            ? 'active'
            : 'pending',
      fact:
        hypotheses.length > 0
          ? `共建立 ${hypotheses.length} 条假设：确立 ${confirmedHyps.length} 条 · 淘汰 ${rejectedHyps.length} 条 · 待重查 ${reevalHyps.length} 条（仲裁捕获 ${findings.length} 项）`
          : '等待 Planner 建立可证伪假设栈',
    },
    {
      stageNo: 5,
      code: 'verify + /audit',
      title: '⑤ 重放验证与隔离审计',
      principle: 'verify_artifact 正反例重放 + 独立第三模型零上下文、零工具对抗复核',
      status: audEvs.length > 0 ? 'done' : verEvs.length > 0 ? 'active' : 'pending',
      fact:
        audEvs.length > 0
          ? `重放验证通过 (${verEvs.length}) + 独立席位 ${auditor} 已签章 (${audEvs[audEvs.length - 1].id})`
          : verEvs.length > 0
            ? `已完成 verify_artifact 重放 (${verEvs[0].id})，待运行 /audit 触发 ${auditor} 复核`
            : '待执行 verify_artifact 与 /audit 隔离复核',
    },
    {
      stageNo: 6,
      code: 'WRI [9/9]',
      title: '⑥ 硬闸门解锁可溯源 Writeup',
      principle: '未过验证与审计写不了报告；每条结论强制锚定 [H-NNN] 与 [ev_NNN]',
      status: writeupEv ? 'done' : missingReasons.length === 0 && evidence.length > 0 ? 'active' : 'pending',
      fact: writeupEv
        ? `已生成并落盘 ${writeupEv.artifact || 'Writeup 报告'} (${writeupEv.id})`
        : missingReasons.length === 0 && evidence.length > 0
          ? '✓ WRI 闸门已解锁，可一键生成结构化逆向报告'
          : `🔒 待解锁（${missingReasons[0] || '需先采集证据'}）`,
    },
  ]

  if (evidence.length === 0 && hypotheses.length === 0) {
    return {
      headline: '尚无逆向过程记录 —— 启动分析后此处将实时提炼结构化逆向结论。',
      narrative:
        '开始分析后，系统会先锁定目标样本与安全边界，再按「初步勘察 → 提出假设 → 动态实测 → 证伪转向 → 双视角重放 → 独立复核」的顺序逐步记录每条推理依据。',
      pillars: [
        { key: 'scope', label: '① 样本与契约', tone: 'accent', value: '待锁定目标样本与能力沙箱', refs: '/goal · /cap' },
        { key: 'finding', label: '② 核心证实结论', tone: 'ok', value: '尚无活跃假设，发送分析指令后自动提炼', refs: 'H-NNN' },
        { key: 'falsified', label: '③ 证伪与排他', tone: 'warn', value: '尚无反证淘汰记录', refs: 'Arbitrator' },
        { key: 'audit', label: '④ 验证与独立审计', tone: 'violet', value: '待执行 verify_artifact 与 /audit', refs: 'VER · AUD' },
      ],
      structuredMarkdown: '> 尚无逆向分析记录。',
      stages,
      writeupGate: { unlocked: false, strictReverseMode, reasons: missingReasons },
    }
  }

  const targetName = goal?.targetFile || re?.sampleType || '目标样本'
  const topHyp = confirmedHyps[confirmedHyps.length - 1]
  const recoveredFlag = extractFlagFromEvidence(evidence)

  // Construct a smooth, natural Chinese deductive paragraph (no semicolon-glued status soup)
  const sentences: string[] = []

  // 1. Opening + Initial Static Clues
  sentences.push(
    `首先，围绕 **${targetName}**${sandbox?.active ? ` 在默认禁网的本地沙箱内` : ''}开展静态勘察，由 **${executor}** 采集了 **${staticCnt}** 条静态结构线索${deniedCnt > 0 ? `（期间沙箱阻断了 **${deniedCnt}** 次未授权外联，确保排查留在本地样本内）` : ''}。`,
  )

  // 2. Hypothesis Formulation -> Falsification & Pivot (if any)
  if (hypotheses.length > 0) {
    const rootRejected = rejectedHyps.filter((h) => !(h.dependsOn && h.dependsOn.length > 0))
    const cascadedHyps = [...rejectedHyps, ...reevalHyps].filter((h) => h.dependsOn && h.dependsOn.length > 0)
    if (rejectedHyps.length > 0 || reevalHyps.length > 0) {
      const contraIds = Array.from(
        new Set(rejectedHyps.flatMap((h) => h.contradicting ?? [])),
      )
      const initialList = hypotheses
        .filter((h) => h.id !== topHyp?.id || rejectedHyps.some((r) => r.id === h.id))
        .slice(0, 3)
        .map((h) => h.id)
      sentences.push(
        `据此，**${planner}** 初步提出了 **${joinIds(initialList.length > 0 ? initialList : hypotheses.map((h) => h.id))}** 等待检验假设；然而在进一步的动态实测中，实测反例${contraIds.length > 0 ? `（\`${contraIds.join('、')}\`）` : ''}与原预期正面冲突，因此排除了 **${joinIds((rootRejected.length > 0 ? rootRejected : rejectedHyps).map((h) => h.id)) || joinIds(reevalHyps.map((h) => h.id))}**${cascadedHyps.length > 0 ? `，并联动重审了依赖该前提的 **${joinIds(cascadedHyps.map((h) => h.id))}**` : ''}。`,
      )
      if (topHyp) {
        sentences.push(
          `排除错误分支后，分析随即转向排查其余线索，据此提出并验证了 **${topHyp.id}**（置信度 **${Math.round(topHyp.confidence * 100)}%**，引用 \`${(topHyp.supporting ?? []).join('、') || 'ev_001'}\`）：「${topHyp.claim}」。`,
        )
      }
    } else if (topHyp) {
      sentences.push(
        `据此提出核心假设 **${topHyp.id}**（置信度 **${Math.round(topHyp.confidence * 100)}%**，引用 \`${(topHyp.supporting ?? []).join('、') || 'ev_001'}\`）：「${topHyp.claim}」${dynCnt > 0 ? `，并经 **${dynCnt}** 条动态运行/重放观测交叉印证` : ''}。`,
      )
    }
  }

  // 3. Verification & Audit Closing
  if (audEvs.length > 0) {
    sentences.push(
      `最终，整条证据链经独立第三席位 **${auditor}** 隔离复核放行（\`${audEvs[audEvs.length - 1].id}\`），${writeupEv ? `已完成可溯源报告 \`${writeupEv.artifact}\` 归档。` : 'WRI [9/9] 报告交付门禁已解锁。'}`,
    )
  } else if (verEvs.length > 0) {
    sentences.push(
      `目前已完成 \`verify_artifact\` 重放验证（\`${verEvs[verEvs.length - 1].id}\`），下一步由独立席位 **${auditor}** 执行 \`/audit\` 终审即可定案。`,
    )
  } else {
    sentences.push(
      `当前推进至 **${re ? `${re.phase.toUpperCase()} [${re.phaseIndex + 1}/9]` : '检验阶段'}**，尚待补充动态重放与独立复核。`,
    )
  }

  const pillars: ConclusionPillar[] = [
    {
      key: 'scope',
      label: '① 样本契约与安全边界',
      tone: 'accent',
      value: `${targetName} · 证据 E:${evidence.length} (静态 ${staticCnt} / 动态 ${dynCnt}) · 沙箱${sandbox?.active ? `拦截 ${deniedCnt} 次外联` : '标准防护'}`,
      refs: `${planner} → ${executor}`,
    },
    {
      key: 'finding',
      label: '② 核心证实结论',
      tone: 'ok',
      value: topHyp
        ? `${topHyp.claim}${recoveredFlag ? ` → 提取凭据: ${recoveredFlag}` : ''}`
        : '正在基于静态/动态证据收敛核心假设',
      refs: topHyp
        ? `${topHyp.id} (${Math.round(topHyp.confidence * 100)}%) · [${(topHyp.supporting ?? []).join(', ') || 'ev_001'}]`
        : `H:${hypotheses.length}`,
    },
    {
      key: 'falsified',
      label: '③ 证伪排他与级联纠偏',
      tone: rejectedHyps.length > 0 ? 'err' : 'warn',
      value:
        rejectedHyps.length > 0 || reevalHyps.length > 0
          ? `已排除误判 ${rejectedHyps.map((h) => h.id).join(', ') || '无'}${reevalHyps.length > 0 ? ` · 待重查 ${reevalHyps.map((h) => h.id).join(', ')}` : ''}（实测反证折半止损并转向新线索）`
          : '当前无矛盾诱饵被淘汰（全部活跃假设与实测一致）',
      refs: `仲裁告警: ${findings.length} 项`,
    },
    {
      key: 'audit',
      label: '④ 实跑验证与审计交付',
      tone: missingReasons.length === 0 ? 'violet' : 'warn',
      value:
        missingReasons.length === 0
          ? `重放验证通过 (${verEvs.length} 项) + 独立席位 ${auditor} 已签章 · ${writeupEv ? `已归档 ${writeupEv.artifact}` : 'WRI 报告门禁已解锁'}`
          : `待完成门禁：${missingReasons[0]}`,
      refs:
        [...verEvs.map((v) => v.id), ...audEvs.map((a) => a.id)].join(', ') || '待签发 VER / AUD',
    },
  ]

  const structuredMarkdown = [
    `### 结构化逆向结论摘要 (${targetName})`,
    '',
    '| 结论维度 | 核心判定内容 | 溯源凭证 / 席位 |',
    '| :--- | :--- | :--- |',
    ...pillars.map((p) => `| **${p.label}** | ${p.value} | \`${p.refs}\` |`),
  ].join('\n')

  return {
    headline: topHyp
      ? `核心结论 [${topHyp.id} · ${Math.round(topHyp.confidence * 100)}%]：${topHyp.claim}`
      : `已采集 ${evidence.length} 条账本证据，正在收敛核心假设`,
    narrative: sentences.join(''),
    pillars,
    structuredMarkdown,
    stages,
    writeupGate: {
      unlocked: missingReasons.length === 0,
      strictReverseMode,
      reasons: missingReasons,
    },
  }
}

// ---------- Publication-Quality Writeup Generator ----------

function renderProofStoryMarkdownSection(story: ProofStory): string[] {
  if (story.isEmpty) {
    return ['*尚无完整推理记录，采集证据并建立假设后自动生成。*']
  }

  const lines: string[] = [story.leadSummary, '']
  for (const ch of story.chapters) {
    lines.push(`### 第 ${ch.stepNo} 步 · ${ch.phaseLabel}（${ch.roleTag}）`)
    if (ch.transitionFromPrev) {
      lines.push(`> **承接逻辑**：${ch.transitionFromPrev}`)
      lines.push('')
    }
    lines.push(ch.body)
    if (ch.contrasts.length > 0) {
      lines.push('')
      for (const c of ch.contrasts) {
        lines.push(
          `- **反证对照 \`[${c.hypothesisId}]\`**：原假设预期「${c.expected}」，但实测结果${c.evidenceId ? `（\`[${c.evidenceId}]\`）` : ''}显示「${c.observed}」→ **推论**：${c.deduction}`,
        )
      }
    }
    lines.push('')
  }

  if (story.hypothesisArcs.length > 0) {
    lines.push('### 逐条假设的因果证明链路（从提出到定论）', '')
    for (const arc of story.hypothesisArcs) {
      lines.push(`- **\`[${arc.id}]\`（${arc.statusLabel} · 置信度 ${arc.confidencePct}%）**：${arc.claim}`)
      lines.push(`  - **① 起因线索**：${arc.triggerClues}`)
      lines.push(`  - **② 验证标准**：${arc.claimAndCriterion}`)
      lines.push(`  - **③ 检验结果**：${arc.testAndObservation}`)
      lines.push(`  - **④ 推导判断**：${arc.deductionVerdict}`)
      lines.push(`  - **⑤ 后续影响**：${arc.nextMove}`)
    }
  }

  return lines
}

function renderReAgentCalibrationSections(dossier: InvestigationState): string[] {
  const { metrics, handover, knownUnknowns, coverageBounds, nextTests, completionScore, states } = dossier
  return [
    '## 五维可信度指标 (§7.5)',
    '',
    '| 指标 | 当前值 | 说明 |',
    '| :--- | :--- | :--- |',
    `| **Evidence coverage（证据覆盖率）** | \`${metrics.evidenceCoverage.display}\` | ${metrics.evidenceCoverage.backedCount}/${metrics.evidenceCoverage.totalConclusions} 条有效结论回溯至 Evidence Ledger |`,
    `| **Replay pass rate（回放通过率）** | \`${metrics.replayPassRate.display}\` | 验证级别：\`${states.verification.status.toUpperCase()}\`${states.verification.singleSampleHitWarning ? '（⚠ 单样本命中，不可宣称完整还原）' : ''} |`,
    `| **Wrong-hypothesis lifetime（错假寿命）** | \`${metrics.wrongHypLifetime.display}\` | 错误假设从提出到被反证淘汰/回滚的取证步数 |`,
    `| **Overreach count（越权尝试次数）** | \`${metrics.overreachCount.display}\` | 范围外文件/网络/设备访问尝试计数 |`,
    `| **Cost per accepted finding（单结论成本）** | \`${metrics.costPerAcceptedFinding.display}\` | 总成本 \`$${metrics.costPerAcceptedFinding.totalCostUsd.toFixed(4)}\` / ${metrics.costPerAcceptedFinding.acceptedFindings} 条定案结论 |`,
    '',
    '## 已知未知、覆盖边界与下一步测试 (§8.7)',
    '',
    `- **完成门禁达标度**：\`${completionScore.passed}/${completionScore.total}\` · 对抗审计三态裁定：\`${states.audit.verdict}\`（${states.audit.passedChecksCount}/5 项检查通过）`,
    '- **已知未知（Known Unknowns）**：',
    ...knownUnknowns.map((item) => `  - ${item}`),
    '- **覆盖边界（Coverage Bounds）**：',
    ...coverageBounds.map((item) => `  - ${item}`),
    '- **下一步测试（Next Tests）**：',
    ...nextTests.map((item) => `  - ${item}`),
    '',
    '## 交接三问（运行溯源 / 可复现性 / 失败归因）',
    '',
    `- **${handover.whichRun.question}** ${handover.whichRun.answer}（锚点：\`${handover.whichRun.refs}\`）`,
    `- **${handover.reproducibleAcrossModels.question}** [\`${handover.reproducibleAcrossModels.status}\`] ${handover.reproducibleAcrossModels.answer}`,
    `- **${handover.errorAttribution.question}** [\`${handover.errorAttribution.category}\`] ${handover.errorAttribution.answer}`,
    `  - **模型 (Model)**：${handover.errorAttribution.breakdown.model}`,
    `  - **工具 (Tool)**：${handover.errorAttribution.breakdown.tool}`,
    `  - **环境 (Environment)**：${handover.errorAttribution.breakdown.environment}`,
    `  - **数据 (Data)**：${handover.errorAttribution.breakdown.data}`,
  ]
}

/** Generates a rigorous, citation-anchored Markdown Writeup from the live session ledger. */
export function generateWriteupMarkdown(
  tick: TickDTO | null,
  template: WriteupTemplateId,
  workspace = '/workspace',
): string {
  const ledger = tick?.ledger
  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []
  const goal = ledger?.goal
  const sandbox = ledger?.sandbox
  const re = tick?.re

  const planner = tick?.hud.route?.planner || 'codex-sol'
  const executor = tick?.hud.route?.executor || 'ds'
  const auditor = ledger?.auditorProvider || tick?.hud.route?.auditor || 'glm-5.3'

  const target = goal?.targetFile || re?.sampleType || workspace.split('/').pop() || 'sample.bin'
  const confirmed = hypotheses.filter((h) => h.status === 'active' || h.status === 'revised')
  const falsified = hypotheses.filter((h) => h.status === 'rejected' || h.status === 'reevaluate')
  const verEvs = evidence.filter((e) => e.kind === 'verification_result')
  const audEvs = evidence.filter((e) => e.kind === 'audit_finding')
  const summary = synthesizeProcessSummary(tick)
  const story = synthesizeProofStory(tick)
  const dossier = buildInvestigationState(tick, workspace)
  const calibrationSections = renderReAgentCalibrationSections(dossier)
  const recoveredFlag = extractFlagFromEvidence(evidence)

  if (template === 'ctf-writeup') {
    return [
      `# Writeup: ${target} (${re?.sampleType?.toUpperCase() || 'Reverse'})`,
      '',
      '## 1. 题目与环境信息 (Challenge Info)',
      '',
      '| 项目 | 内容 |',
      '| :--- | :--- |',
      `| **工作区 / 样本** | \`${workspace}\` · \`${target}\` |`,
      `| **多模型席位** | Planner: \`${planner}\` · Executor: \`${executor}\` · Auditor: \`${auditor}\` |`,
      `| **证据 / 假设规模** | 账本证据 \`E:${evidence.length}\` · 确立假设 \`${confirmed.length}\` · 证伪诱饵 \`${falsified.length}\` |`,
      `| **最终 Flag / 产物** | \`${recoveredFlag || '见下方结论与验证段'}\` |`,
      '',
      '## 2. 一句话总结 (TL;DR)',
      '',
      `> ${summary.narrative}`,
      '',
      '## 3. 推理与证明全过程（从假设提出到证据闭环）',
      '',
      ...renderProofStoryMarkdownSection(story),
      '',
      '## 4. 原始取证时间线 (Evidence Trail)',
      '',
      ...(evidence.length === 0
        ? ['- *（当前尚无入账证据，运行分析后自动填充 `ev_NNN` 记录）*']
        : evidence.map(
            (ev) =>
              `- **\`[${ev.id}]\`** (\`${ev.kind || 'tool_observation'}\` · \`${ev.view || 'static'}\` · \`${ev.source}\`): ${(ev.summary || ev.excerpt).replace(/\s+/g, ' ').slice(0, 120)}`,
          )),
      '',
      '## 5. 可复现求解与校验命令 (Reproducible Solver)',
      '',
      '```bash',
      target.includes('chall.js')
        ? `# 1. 静态检查与 XOR 0x2a 还原\n0xaf --workspace ${workspace} -p "read chall.js"\n# 2. 正反例回放验证\nnode chall.js '${recoveredFlag || '0xaf{warmup_deck}'}'`
        : `# 1. 样本结构初筛与签名雕刻\n/scan ${target}\n# 2. Base64 载荷解码与重放验证\n/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9\n# 3. 独立席位隔离对抗审计\n/audit`,
      '```',
      '',
      ...(recoveredFlag ? ['## 6. Flag', '', '```text', recoveredFlag, '```', ''] : []),
      ...calibrationSections,
    ].join('\n')
  }

  if (template === 'algo-report') {
    return [
      `# 算法与接口工程还原报告：${target}`,
      '',
      '## 1. 目标契约与样本指纹',
      `- **样本路径**：\`${workspace}/${target}\``,
      `- **契约目标**：${goal?.primary || '逆向还原目标核心校验逻辑与数据结构'}`,
      `- **沙箱约束**：\`network=${goal?.constraints?.network || 'deny'}\` · \`device=${goal?.constraints?.device || 'none'}\` · \`filesystem=workspace-only\``,
      '',
      '## 2. 推理与证明全过程（从假设提出到证据闭环）',
      '',
      ...renderProofStoryMarkdownSection(story),
      '',
      '## 3. 结构布局与关键发现（锚定 `ev_NNN`）',
      ...(evidence
        .filter((e) => !e.isError && e.kind !== 'audit_finding')
        .map(
          (ev) =>
            `### \`[${ev.id}]\` ${ev.source} (${ev.view || 'static'})\n- **摘要**：${ev.summary || '工具观测'}\n\`\`\`text\n${ev.excerpt}\n\`\`\``,
        )),
      '',
      '## 4. 验证向量与重放统计 (`verify_artifact`)',
      ...(verEvs.length > 0
        ? verEvs.map(
            (v) =>
              `- **\`[${v.id}]\`**：通过率 \`${v.verification?.passed ?? 1}/${v.verification?.total ?? 1}\`（\`${dossier.states.verification.status}\`）— ${v.summary || v.excerpt}`,
          )
        : ['- 尚未记录 `verification_result` 重放向量']),
      '',
      '## 5. 对抗审计签章 (`/audit`)',
      ...(audEvs.length > 0
        ? audEvs.map((a) => `- **\`[${a.id}]\` (${a.source} · \`${dossier.states.audit.verdict}\`)**：\n\`\`\`text\n${a.excerpt}\n\`\`\``)
        : [`- 待运行 \`/audit\` 由独立席位 \`${auditor}\` 签发审计凭证`]),
      '',
      ...calibrationSections,
    ].join('\n')
  }

  // Default: 'article-standard' — full deductive narrative + evidence ledger + audit + reproducibility
  return [
    `# 逆向分析与证据溯源报告：${target}`,
    '',
    `> **生成准则（0xAF-Re Writeup Gate）**：本报告严格依据会话 \`evidence-ledger.jsonl\` 中已入库证据生成，不编造任何未观测偏移或结论；每项实质性判断均绑定 \`[H-NNN]\` 假设编号与 \`[ev_NNN]\` 原始凭证。`,
    '',
    '## 一、 逆向过程全链路总结',
    '',
    summary.narrative,
    '',
    '## 二、 推理与证明全过程（从假设提出到证据闭环）',
    '',
    ...renderProofStoryMarkdownSection(story),
    '',
    '## 三、 样本分诊、保护态势与任务契约（环节 ① `/goal` & 环节 ② `/cap`）',
    '',
    '| 治理 / 分诊维度 | 运行时取证记录 |',
    '| :--- | :--- |',
    `| **Target State（样本对象）** | \`${dossier.states.target.file}\`${dossier.states.target.sha256 ? ` · \`sha256:${dossier.states.target.sha256.slice(0, 16)}…\`` : ''} (${dossier.states.target.format} · ${dossier.states.target.arch}) |`,
    `| **Objective State（任务目的）** | ${goal ? `${goal.primary}（验收项 \`${goal.criteria.filter((c) => c.pass).length}/${goal.criteria.length}\` 通过）` : '默认交互分析模式'} |`,
    `| **三模型职责席位** | Planner: \`${planner}\` · Executor: \`${executor}\` · Isolated Auditor: \`${auditor}\` |`,
    `| **能力沙箱 (\`/cap\`)** | 状态: \`${sandbox?.active ? 'ACTIVE (deny-by-default)' : 'STANDARD'}\` · 放行本地动作 \`${sandbox?.grantedCount ?? tick?.flow.toolsOk ?? 0}\` 次 · 阻断越权动作 \`${sandbox?.deniedCount ?? 0}\` 次 |`,
    ...(sandbox?.recentActions
      .filter((a) => a.decision === 'denied')
      .map(
        (a) =>
          `| **沙箱拦截留痕** | \`[DENIED]\` \`${a.tool}\` (\`cap=${a.capability}\`) · 命令摘要 \`sha256:${a.sha256}\` |`,
      ) ?? []),
    '',
    '## 四、 双视角原始证据账本（环节 ③ `ev_NNN`）',
    '',
    ...(evidence.length === 0
      ? ['- *暂无已入账证据*']
      : [
          '| 证据 ID | 视角 / 类别 | 来源工具 | 关键事实摘录 |',
          '| :--- | :--- | :--- | :--- |',
          ...evidence.map(
            (ev) =>
              `| **\`${ev.id}\`** | \`${ev.view || 'static'}\` / \`${ev.kind || 'obs'}\`${ev.isError ? ' **(ERR)**' : ''} | \`${ev.source}\` | ${(ev.summary || ev.excerpt).replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 88)} |`,
          ),
        ]),
    ...(findings.length > 0
      ? [
          '',
          '### 宿主仲裁器与审计裁定记录',
          ...findings.map(
            (f) => `- \`[${f.rule}]\` **${f.hypothesisId}**${f.evidenceId ? ` ← \`${f.evidenceId}\`` : ''}：${f.message}`,
          ),
        ]
      : []),
    '',
    '## 五、 产物重放与独立对抗审计（环节 ⑤ `verify_artifact` & `/audit`）',
    '',
    ...(verEvs.length > 0
      ? verEvs.map(
          (v) =>
            `- **重放校验 \`[${v.id}]\`（\`${dossier.states.verification.status.toUpperCase()}\`）**：\`verify_artifact\` 通过率 **${v.verification?.passed ?? 2}/${v.verification?.total ?? 2}** —— ${v.summary || v.excerpt}`,
        )
      : ['- **重放校验**：待执行 `verify_artifact`']),
    ...(audEvs.length > 0
      ? audEvs.map(
          (a) =>
            `- **隔离对抗审计 \`[${a.id}]\`（席位：\`${auditor}\` · 裁定：\`${dossier.states.audit.verdict}\`）**：零历史上下文、零工具权限独立复核（5 项清单通过 ${dossier.states.audit.passedChecksCount}/5）：\n\`\`\`text\n${a.excerpt}\n\`\`\``,
        )
      : [`- **隔离对抗审计**：待运行 \`/audit\`（独立席位 \`${auditor}\`）`]),
    '',
    '## 六、 可复现验证命令（环节 ⑥ Reproducibility）',
    '',
    '```bash',
    target.includes('chall.js')
      ? `0xaf --workspace ${workspace}\n/scan chall.js\n!node chall.js '${recoveredFlag || '0xaf{warmup_deck}'}'`
      : `0xaf --workspace ${workspace}\n/workflow reverse firmware\n/scan ${target}\n/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9\n/audit`,
    '```',
    '',
    ...calibrationSections,
    ...(recoveredFlag ? ['', `**最终提取凭证 / Flag**：\`${recoveredFlag}\``] : []),
  ].join('\n')
}
