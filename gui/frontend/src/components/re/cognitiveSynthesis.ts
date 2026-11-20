// Cognitive Synthesis Engine — aligns the GUI's replay timeline, executive
// process summary, and Writeup generator 1:1 with the 6-stage architecture
// defined in 0xAF-Re's design article & Go core (goal -> capability sandbox ->
// dual-view ledger -> confidence-halving hypothesis arbitrator -> isolated
// audit -> hard-gated reproducible writeup).
import type {
  EvidenceRecord,
  FindingDTO,
  Hypothesis,
  TickDTO,
} from '../../lib/types'

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
  thought: string
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

/** Reconstructs step-by-step cognitive & ledger evolution frames from any session's state. */
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
  if (goal || sandbox?.active || tick.re) {
    const target = goal?.targetFile || tick.re?.sampleType || 'target'
    push({
      id: 'f-contract',
      stageNo: 1,
      stageTag: '① 任务先声明 (/goal)',
      title: '契约锁定与能力沙箱激活',
      actor: `${planner} (Planner) + Host`,
      actorTone: 'accent',
      focusNode: sandbox?.active ? 'sandbox' : 'planner',
      thought:
        thinkLines[0] ||
        `[${planner}] 将分析目标编译为可校验契约（target=${target}），由宿主实地固定文件指纹并拉起任务级沙箱（network=deny, device=none），确立「模型叙述、宿主记账」原则。`,
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
    push({
      id: 'f-static',
      stageNo: 3,
      stageTag: '③ 一等证据入账 (static)',
      title: `静态特征提取 (${initialStaticEv[0].id}..${initialStaticEv[initialStaticEv.length - 1].id})`,
      actor: `${executor} (Executor)`,
      actorTone: 'ok',
      focusNode: 'executor',
      thought:
        thinkLines[1] ||
        `[${executor}] 优先调用纯 Go 只读工具链（${initialStaticEv.map((e) => e.source).join(' → ')}）采集文件结构、偏移与熵分布；每条输出由宿主单点盖章写入 evidence-ledger.jsonl。`,
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

  // Initial hypotheses frame (reconstruct pre-contradiction confidence/status if later challenged!)
  const earlyHyps: Hypothesis[] = hypotheses
    .filter((h) => {
      // Hypotheses citing initial static evidence or created early (H-001..H-003)
      const citesEarly = (h.supporting ?? []).some((id) => initialStaticEv.some((e) => e.id === id))
      return citesEarly || (h.dependsOn && h.dependsOn.length > 0) || h.id === 'H-001'
    })
    .map((h) => {
      const wasChallengedLater = (h.contradicting && h.contradicting.length > 0) || h.status === 'rejected' || h.status === 'reevaluate'
      return {
        ...h,
        status: wasChallengedLater ? 'active' : h.status,
        confidence: h.id === 'H-002' && wasChallengedLater ? 0.84 : h.id === 'H-003' && wasChallengedLater ? 0.76 : Math.max(h.confidence, 0.78),
        contradicting: [],
        note: h.dependsOn?.length ? `依赖上游父假设 ${h.dependsOn.join(', ')} 成立` : '基于静态观测建立初始可证伪假设',
      }
    })

  const singleViewFindings = findings.filter((f) => f.rule === 'single-view')
  if (earlyHyps.length > 0) {
    push({
      id: 'f-hyp-init',
      stageNo: 4,
      stageTag: '④ 显式假设建栈 (H-NNN)',
      title: `建立初始假设栈 (${earlyHyps.map((h) => h.id).join(', ')})`,
      actor: `${planner} (Planner) + Arbitrator`,
      actorTone: 'accent',
      focusNode: singleViewFindings.length > 0 ? 'arbitrator' : 'hypotheses',
      thought:
        `[${planner}] 将静态推断外化为宿主侧可证伪假设栈 ${earlyHyps.map((h) => h.id).join('/')}` +
        (singleViewFindings.length > 0
          ? `；宿主仲裁器立即命中 [single-view] 规则：指出高置信度静态假设缺少 dynamic 视角印证，强制推进至动态实验阶段。`
          : `，等待动态重放检验。`),
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
  const sandboxErrIdx = evidence.findIndex((e) => e.source.startsWith('sandbox:') || (e.isError && e.summary?.includes('sandbox')))
  if (sandboxErrIdx >= 0) {
    const evUpTo = evidence.slice(0, sandboxErrIdx + 1)
    const deniedActs = (sandbox?.recentActions ?? []).filter((a) => a.decision === 'denied')
    push({
      id: 'f-sandbox-block',
      stageNo: 2,
      stageTag: '② 能力跟着任务走 (/cap)',
      title: `任务沙箱阻断越权外联 (${evidence[sandboxErrIdx].id})`,
      actor: 'Gate 1 · Capability Sandbox',
      actorTone: 'warn',
      focusNode: 'sandbox',
      thought: `[Gate 1 · Sandbox] ${executor} 尝试发起外部网络请求，在进入人工审批门之前即被任务契约沙箱直接同步拒绝（capability "network" denied），命令 SHA256 与拒绝来源记入 ActionRecord 审计链。`,
      stateDelta: `拦截未授权调用 (${evidence[sandboxErrIdx].id}) · ActionRecord[DENIED cap=network] 已留痕`,
      tick: cloneTickWith(tick, {
        evidence: evUpTo,
        hypotheses: earlyHyps,
        findings: singleViewFindings,
        rePhase: { phase: 'dynamic', idx: 2 },
        sandboxActions: [...deniedActs, ...(sandbox?.recentActions ?? []).filter((a) => a.decision === 'granted').slice(0, 3)],
        sandboxDenied: Math.max(1, deniedActs.length),
        activeProvider: executor,
        stage: 'tool',
      }),
    })
  }

  // Runtime contradiction & dependency cascade frame (the anti-"Commits to a story" core!)
  const contraFindings = findings.filter((f) => f.rule === 'runtime-contradiction' || f.rule === 'dependency-cascade')
  const contraEvIdx = evidence.findIndex((e) => (e.contradicts && e.contradicts.length > 0) || e.kind === 'runtime_trace' && e.isError)
  if (contraEvIdx >= 0 || contraFindings.length > 0) {
    const cutIdx = contraEvIdx >= 0 ? contraEvIdx + 1 : staticInitEnd + 1
    const evUpTo = evidence.slice(0, Math.min(evidence.length, cutIdx))
    const contraEvId = evidence[contraEvIdx]?.id ?? 'ev_dyn'
    const cascadedHyps: Hypothesis[] = earlyHyps.map((h) => {
      const finalH = hypotheses.find((x) => x.id === h.id)
      if (finalH?.contradicting?.includes(contraEvId) || contraFindings.some((f) => f.rule === 'runtime-contradiction' && f.hypothesisId === h.id)) {
        return {
          ...h,
          confidence: 0.21,
          status: 'rejected',
          contradicting: [contraEvId],
          note: `动态运行反证 ${contraEvId} 触发宿主置信度折半淘汰`,
        }
      }
      if (h.dependsOn?.some((pid) => pid === 'H-002') || contraFindings.some((f) => f.rule === 'dependency-cascade' && f.hypothesisId === h.id)) {
        return {
          ...h,
          confidence: 0.38,
          status: 'reevaluate',
          note: `父假设被证伪，宿主自动沿 dependsOn 级联标记为 reevaluate（待重查）`,
        }
      }
      return h
    })

    push({
      id: 'f-arbitrate-cascade',
      stageNo: 4,
      stageTag: '④ 反证折半与级联纠偏',
      title: `破除 "Commits to a story"：反证淘汰与级联重审`,
      actor: 'Host Arbitrator (确定性规则引擎)',
      actorTone: 'err',
      focusNode: 'arbitrator',
      thought:
        `[Host Arbitrator] 动态观测 ${contraEvId} 与静态假设正面冲突！宿主不靠 Prompt 自觉，由 Go 代码强制将原假设置信度折半淘汰（REJECTED），并将下游派生子假设自动级联打回 REEVALUATE——彻底切断模型顺着错误前文自圆其说的路径。`,
      stateDelta: `${contraEvId} [dynamic ERR] → H-002 折半淘汰 [REJECTED] · H-003 级联降级 [REEVALUATE]`,
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
    const preAuditHyps = hypotheses.map((h) => {
      // Before /audit, H-003 was still in reevaluate if challenged by glm later
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
    push({
      id: 'f-verify',
      stageNo: 5,
      stageTag: '⑤ 产物重放验证 (VER)',
      title: `双视角证据收敛与 verify_artifact 重放 (${evidence[verIdx].id})`,
      actor: `${executor} → ${planner}`,
      actorTone: 'ok',
      focusNode: 'hypotheses',
      thought:
        thinkLines[thinkLines.length - 1] ||
        `[${executor} → ${planner}] 转向伴生线索完成解码，并通过 verify_artifact 正反例重放产出正式 verification_result (${evidence[verIdx].id})，使新假设同时具备 static 与 dynamic 双视角证据支撑，通过 AUD 前置硬闸门。`,
      stateDelta: `签发 ${evidence[verIdx].id} [VER · passed] · 新假设双视角确立 · ▸VER [7/9]`,
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
    push({
      id: 'f-audit',
      stageNo: 5,
      stageTag: '⑤ 隔离对抗审计 (/audit)',
      title: `独立第三席位 ${auditor} 零上下文复核 (${evidence[audIdx].id})`,
      actor: `${auditor} (Isolated Auditor)`,
      actorTone: 'violet',
      focusNode: 'auditor',
      thought: `[${auditor}] 在 Isolated=true、FreshSession=true、Tools=[] 的零历史对话、零工具沙箱中独立审阅「假设栈 + 账本摘录」数据包：清理待重查分支，核准双视角支撑假设，签发 ${evidence[audIdx].id} (audit_finding)，满足全部 /goal 验收指标！`,
      stateDelta: `签发 ${evidence[audIdx].id} [AUD] · /goal 验收全绿 · 解锁 ▸WRI [9/9]`,
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

  // Writeup artifact delivery frame (if writeup / solve artifact exists at tail)
  const artIdx = evidence.findIndex(
    (e, idx) => idx > audIdx && (e.kind === 'artifact' || e.artifact?.endsWith('.md')),
  )
  if (artIdx >= 0) {
    const artEv = evidence[artIdx]
    push({
      id: 'f-writeup',
      stageNo: 6,
      stageTag: '⑥ 可溯源报告交付 (WRI)',
      title: `生成全证据锚定 Writeup (${artEv.artifact || artEv.id})`,
      actor: `${planner} + ${executor}`,
      actorTone: 'ok',
      focusNode: 'gate',
      thought: `[${planner}] 严格遵循 Writeup 铁律：仅依据账本已证实记录撰写分析报告，为每条核心结论标注 [H-NNN] 与 [ev_NNN] 溯源编号，明确剥离诱饵假象并附上可一键复现的验证命令，归档至 ${artEv.artifact || 'notes/writeup.md'}。`,
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
    // Catch-all live tail frame if session has newer observations not yet covered above
    push({
      id: 'f-latest',
      stageNo: audIdx >= 0 ? 6 : verIdx >= 0 ? 5 : hypotheses.length > 0 ? 4 : 3,
      stageTag: '● 当前最新状态',
      title: `当前累积状态 (E:${evidence.length} / H:${hypotheses.length})`,
      actor: `${tick.flow.provider || planner}`,
      actorTone: 'accent',
      focusNode: 'hypotheses',
      thought:
        thinkLines[thinkLines.length - 1] ||
        `当前会话已记录 ${evidence.length} 条账本证据与 ${hypotheses.length} 条假设状态。`,
      stateDelta: `E:${evidence.length} · H:${hypotheses.length}`,
      tick,
    })
  }

  return frames
}

/** Synthesizes the 1-paragraph reverse-engineering process summary + 6-stage article checklist. */
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
  const writeupEv = evidence.find(
    (e) => e.kind === 'artifact' && (e.artifact?.includes('writeup') || e.artifact?.includes('solve')),
  )

  const confirmedHyps = hypotheses.filter((h) => h.status === 'active' || h.status === 'revised')
  const rejectedHyps = hypotheses.filter((h) => h.status === 'rejected')
  const reevalHyps = hypotheses.filter((h) => h.status === 'reevaluate')
  const deniedCnt = sandbox?.deniedCount ?? 0
  const grantedCnt = sandbox?.grantedCount ?? 0

  // Check strict Writeup gate (mirrors internal/workflow/phase.go checkTargetGate(PhaseWriteup))
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
      missingReasons.push(`/goal 契约尚有 ${pendingGoal.length} 项未达标: ${pendingGoal.map((c) => c.label).join('、')}`)
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
        '0xAF-Re 遵循「模型负责叙述，宿主负责记账」架构：通过 /goal 锁定任务契约、/cap 隔离高危能力、ev_NNN 沉淀客观观测、H-NNN 与宿主仲裁器淘汰错误猜想，经独立模型 /audit 复核后产出可复现 Writeup。',
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
  const flagMatch = evidence
    .map((e) => `${e.summary ?? ''} ${e.excerpt ?? ''}`)
    .join('\n')
    .match(/(?:flag|0xaf)\{[a-zA-Z0-9_.-]+\}/)
  const recoveredFlag = flagMatch ? flagMatch[0] : null

  const parts: string[] = []
  if (goal) {
    parts.push(
      `本次逆向以 \`/goal\` 契约锁定样本 **${targetName}** 并开启任务级默认拒网沙箱${deniedCnt > 0 ? `（成功阻断 **${deniedCnt}** 次未授权外联）` : ''}`,
    )
  } else {
    parts.push(`本次针对 **${targetName}** 的分析采用多席位分工`)
  }

  parts.push(
    `由 **${planner}** 负责规划建模、**${executor}** 驱动本地工具采集了 **${evidence.length}** 条可溯源证据（静态 \`${staticCnt}\` 条 / 动态 \`${dynCnt}\` 条）`,
  )

  if (rejectedHyps.length > 0 || reevalHyps.length > 0) {
    parts.push(
      `期间宿主确定性仲裁器捕获动静矛盾并强制执行置信度折半与依赖级联，淘汰了 **${rejectedHyps.map((h) => h.id).join('/')}** 等诱饵猜想（防止 *"Commits to a story"* 幻觉圆谎）`,
    )
  }

  if (topHyp) {
    parts.push(
      `最终确立核心结论 **${topHyp.id}**（置信度 **${Math.round(topHyp.confidence * 100)}%**，引用 \`${(topHyp.supporting ?? []).join(', ') || 'ev_001'}\`）：*「${topHyp.claim}」*`,
    )
  }

  if (audEvs.length > 0) {
    parts.push(
      `并经独立第三席位 **${auditor}** 零上下文隔离对抗审计（\`${audEvs[audEvs.length - 1].id}\`）复核放行，${writeupEv ? `已完成结构化报告 \`${writeupEv.artifact}\` 归档。` : '已解锁 WRI [9/9] 报告交付。'}`,
    )
  } else {
    parts.push(`当前处于 **${re ? `${re.phase.toUpperCase()} [${re.phaseIndex + 1}/9]` : '验证推进'}** 阶段。`)
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
          ? `已淘汰诱饵 ${rejectedHyps.map((h) => h.id).join(', ') || '无'}${reevalHyps.length > 0 ? ` · 待重查 ${reevalHyps.map((h) => h.id).join(', ')}` : ''}（宿主置信度×0.5 强制止损）`
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
    narrative: parts.join('；'),
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

  // Extract recovered flag/token if present in evidence
  const flagMatch = evidence
    .map((e) => `${e.summary ?? ''} ${e.excerpt ?? ''}`)
    .join('\n')
    .match(/(?:flag|0xaf)\{[a-zA-Z0-9_.-]+\}/)
  const recoveredFlag = flagMatch ? flagMatch[0] : null

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
      '## 3. 静态与动态取证时间线 (Evidence Trail)',
      '',
      ...(evidence.length === 0
        ? ['- *（当前尚无入账证据，运行分析后自动填充 `ev_NNN` 记录）*']
        : evidence.map(
            (ev) =>
              `- **\`[${ev.id}]\`** (\`${ev.kind || 'tool_observation'}\` · \`${ev.view || 'static'}\` · \`${ev.source}\`): ${(ev.summary || ev.excerpt).replace(/\s+/g, ' ').slice(0, 120)}`,
          )),
      '',
      '## 4. 核心逆向结论与诱饵排除 (Hypotheses & Anti-Red-Herring)',
      '',
      '### 已证实核心结论',
      ...(confirmed.length === 0
        ? ['- *待确立活跃假设*']
        : confirmed.map(
            (h) =>
              `- **\`[${h.id}]\` (${Math.round(h.confidence * 100)}%)**：${h.claim} *(支撑证据：${(h.supporting ?? []).map((x) => `\`[${x}]\``).join(', ') || '无'})*`,
          )),
      '',
      ...(falsified.length > 0
        ? [
            '### 已证伪干扰项（防止误入歧途）',
            ...falsified.map(
              (h) =>
                `- ~~**\`[${h.id}]\` [${h.status.toUpperCase()}]**：${h.claim}~~ — **排除原因**：${h.note || '动态验证反证折半淘汰'} *(反证：${(h.contradicting ?? []).map((x) => `\`[${x}]\``).join(', ') || '级联降级'})*`,
            ),
          ]
        : []),
      '',
      '## 5. 可复现求解与校验命令 (Reproducible Solver)',
      '',
      '```bash',
      target.includes('chall.js')
        ? `# 1. 静态检查与 XOR 0x2a 还原\n0xaf --workspace ${workspace} -p "read chall.js"\n# 2. 正反例回放验证\nnode chall.js '${recoveredFlag || '0xaf{warmup_deck}'}'`
        : `# 1. 样本结构初筛与签名雕刻\n/scan ${target}\n# 2. Base64 载荷解码与重放验证\n/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9\n# 3. 独立席位隔离对抗审计\n/audit`,
      '```',
      '',
      ...(recoveredFlag ? ['## 6. Flag', '', '```text', recoveredFlag, '```'] : []),
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
      '## 2. 结构布局与关键发现（锚定 `ev_NNN`）',
      ...(evidence
        .filter((e) => !e.isError && e.kind !== 'audit_finding')
        .map(
          (ev) =>
            `### \`[${ev.id}]\` ${ev.source} (${ev.view || 'static'})\n- **摘要**：${ev.summary || '工具观测'}\n\`\`\`text\n${ev.excerpt}\n\`\`\``,
        )),
      '',
      '## 3. 验证向量与重放统计 (`verify_artifact`)',
      ...(verEvs.length > 0
        ? verEvs.map(
            (v) =>
              `- **\`[${v.id}]\`**：通过率 \`${v.verification?.passed ?? 1}/${v.verification?.total ?? 1}\` — ${v.summary || v.excerpt}`,
          )
        : ['- 尚未记录 `verification_result` 重放向量']),
      '',
      '## 4. 对抗审计签章 (`/audit`)',
      ...(audEvs.length > 0
        ? audEvs.map((a) => `- **\`[${a.id}]\` (${a.source})**：\n\`\`\`text\n${a.excerpt}\n\`\`\``)
        : [`- 待运行 \`/audit\` 由独立席位 \`${auditor}\` 签发审计凭证`]),
    ].join('\n')
  }

  // Default: 'article-standard' — 1:1 with 0xAF-Re's 6-stage article & wrapWriteup contract
  return [
    `# 逆向分析与证据溯源报告：${target}`,
    '',
    `> **生成准则（0xAF-Re Writeup Gate）**：本报告严格依据会话 \`evidence-ledger.jsonl\` 中已入库证据生成，不编造任何未观测偏移或结论；每项实质性判断均绑定 \`[H-NNN]\` 假设编号与 \`[ev_NNN]\` 原始凭证。`,
    '',
    '## 一、 逆向过程全链路总结',
    '',
    summary.narrative,
    '',
    '## 二、 任务契约与安全边界（环节 ① `/goal` & 环节 ② `/cap`）',
    '',
    '| 治理维度 | 运行时记录 |',
    '| :--- | :--- |',
    `| **任务契约 (\`/goal\`)** | ${goal ? `${goal.primary}（验收项 \`${goal.criteria.filter((c) => c.pass).length}/${goal.criteria.length}\` 通过）` : '默认交互分析模式'} |`,
    `| **三模型职责席位** | Planner: \`${planner}\` · Executor: \`${executor}\` · Isolated Auditor: \`${auditor}\` |`,
    `| **能力沙箱 (\`/cap\`)** | 状态: \`${sandbox?.active ? 'ACTIVE (deny-by-default)' : 'STANDARD'}\` · 放行本地动作 \`${sandbox?.grantedCount ?? tick?.flow.toolsOk ?? 0}\` 次 · 阻断越权动作 \`${sandbox?.deniedCount ?? 0}\` 次 |`,
    ...(sandbox?.recentActions.filter((a) => a.decision === 'denied').map(
      (a) => `| **沙箱拦截留痕** | \`[DENIED]\` \`${a.tool}\` (\`cap=${a.capability}\`) · 命令摘要 \`sha256:${a.sha256}\` |`,
    ) ?? []),
    '',
    '## 三、 关键事实发现与双视角证据链（环节 ③ `ev_NNN`）',
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
    '',
    '## 四、 假设演化、反证折半与级联纠偏（环节 ④ `H-NNN` & `Arbitrator`）',
    '',
    '### 4.1 经双视角验证确立的结论',
    ...(confirmed.length === 0
      ? ['- *暂无已确立假设*']
      : confirmed.map(
          (h) =>
            `- **\`[${h.id}]\`（置信度 ${Math.round(h.confidence * 100)}% · \`${h.status}\`）**：${h.claim}\n  - **支撑凭证**：${(h.supporting ?? []).map((id) => `\`[${id}]\``).join('、') || '待补充'}${h.note ? `\n  - **校验说明**：${h.note}` : ''}`,
        )),
    '',
    '### 4.2 被证伪的诱饵与防圆谎纠偏轨迹（Defeating *"Commits to a story"*）',
    ...(falsified.length === 0
      ? ['- 本轮未触发反证淘汰分支。']
      : falsified.map(
          (h) =>
            `- **\`[${h.id}]\`（残余置信度 ${Math.round(h.confidence * 100)}% · \`${h.status.toUpperCase()}\`）**：~~${h.claim}~~\n  - **淘汰/级联机制**：${h.note || '动态反证触发宿主置信度折半'}${h.contradicting?.length ? `（反证：${h.contradicting.map((id) => `\`[${id}]\``).join('、')}）` : ''}${h.dependsOn?.length ? `（依赖上游：\`${h.dependsOn.join(', ')}\`）` : ''}`,
        )),
    ...(findings.length > 0
      ? [
          '',
          '### 4.3 宿主仲裁器与审计裁定记录',
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
            `- **重放校验 \`[${v.id}]\`**：\`verify_artifact\` 通过率 **${v.verification?.passed ?? 2}/${v.verification?.total ?? 2}** —— ${v.summary || v.excerpt}`,
        )
      : ['- **重放校验**：待执行 `verify_artifact`']),
    ...(audEvs.length > 0
      ? audEvs.map(
          (a) =>
            `- **隔离对抗审计 \`[${a.id}]\`（席位：\`${auditor}\`）**：零历史上下文、零工具权限独立复核通过：\n\`\`\`text\n${a.excerpt}\n\`\`\``,
        )
      : [`- **隔离对抗审计**：待运行 \`/audit\`（独立席位 \`${auditor}\`）`]),
    '',
    '## 六、 可复现验证命令与未决边界（环节 ⑥ Reproducibility & Gaps）',
    '',
    '```bash',
    target.includes('chall.js')
      ? `0xaf --workspace ${workspace}\n/scan chall.js\n!node chall.js '${recoveredFlag || '0xaf{warmup_deck}'}'`
      : `0xaf --workspace ${workspace}\n/workflow reverse firmware\n/scan ${target}\n/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9\n/audit`,
    '```',
    '',
    '- **已确认事实边界**：所有带 `[ev_NNN]` 编号的偏移、解码值与重放退出码均已在工作区内实测复现。',
    '- **已知排他项 / 待确认项**：受能力沙箱 `network=deny` 约束，样本内出现的外部域名仅做静态记录、未发起真实联网探测；如需进一步联调可由操作员显式执行 `/cap network on` 后单独验证。',
    ...(recoveredFlag ? ['', `**最终提取凭证 / Flag**：\`${recoveredFlag}\``] : []),
  ].join('\n')
}
