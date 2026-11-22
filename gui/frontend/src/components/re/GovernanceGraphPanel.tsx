// GovernanceGraphPanel — rigorous interactive SVG visualization of 0xAF-Re's
// multi-model roles (deepseek / codex / glm), dual-layer security gates
// (Task Capability Sandbox + Policy Approval), Evidence Ledger (ev_NNN),
// Hypothesis Stack (H-NNN confidence halving + dependency cascade),
// Deterministic Arbitrator, and Context-Isolated GLM Adversarial Audit.
//
// Offers two synchronized SVG views:
//   1) ◈ 机制架构图 (System Pipeline): the 9-node engineering topology, live-lit
//      by the active session's state; click any node to inspect its exact rules
//      and live runtime telemetry.
//   2) ☍ 因果证据图谱 (Provenance DAG): dynamic citation & contradiction graph
//      built live from ev_NNN ↔ H-NNN ↔ Arbitrator/GLM Audit ↔ Delivery Gate.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type {
  EvidenceRecord,
  FindingDTO,
  GoalSummaryDTO,
  Hypothesis,
  LedgerDTO,
  SandboxActionDTO,
  TickDTO,
  VerificationStats,
} from '../../lib/types'
import { PanelBox } from '../crt'
import {
  buildHypothesisArcs,
  buildReplayFrames,
  synthesizeProcessSummary,
  type ReplayFrame,
} from './cognitiveSynthesis'
import { WriteupStudioPanel } from './WriteupStudioPanel'
import { ZoomableSvgViewport } from './ZoomableSvgViewport'
import type { WorkbenchTab } from './HypothesisWorkbenchDialog'
import {
  buildProvenanceChain,
  evaluatePhaseGates,
  formatEvidenceCitation,
  formatHypothesisCitation,
} from './forensics'
import './re-pro.css'
import './controlLoop.css'

export type GraphViewMode = 'pipeline' | 'dag' | 'writeup'

type StructuredHypothesis = Hypothesis & {
  scope?: string
  falsifiers?: string[]
  nextTest?: string
}

type BoundSandboxAction = SandboxActionDTO & {
  hypothesisId?: string
}

type ExtendedGoalSummary = GoalSummaryDTO & {
  targetArch?: string
  targetFormat?: string
  targetVersion?: string
  targetScope?: string
  deliverables?: string[]
  stopConditions?: string[]
}

type ExtendedVerificationStats = VerificationStats & {
  status?: 'candidate' | 'verified' | string
}

type DeliveryOutcome = 'accepted' | 'candidate' | 'needs_more_evidence' | 'rejected'

type ExtendedLedger = LedgerDTO & {
  auditVerdict?: DeliveryOutcome | string
}

type RuntimeRoleId = 'router' | 'ledger' | 'verifier' | 'auditor'

type NodeId =
  | 'planner'
  | 'executor'
  | 'auditor'
  | 'sandbox'
  | 'approval'
  | 'ledger'
  | 'hypotheses'
  | 'arbitrator'
  | 'gate'

interface NodeSpec {
  id: NodeId
  zone: string
  title: string
  modulePath: string
  summary: string
  rules: string[]
}

const NODE_SPECS: Record<NodeId, NodeSpec> = {
  planner: {
    id: 'planner',
    zone: 'ZONE I · 席位路由',
    title: 'PLANNER · 强推理规划席 (codex sol / gemini 4 carbon)',
    modulePath: 'internal/app/goal.go · internal/workflow/delegate.go',
    summary:
      '选用强推理旗舰模型（codex sol / gemini 4 carbon）负责高层认知建模：起草 /goal JSON 契约，拆解 update_plan 步骤，并通过 hypothesis_create / hypothesis_update 维护显式假设栈。',
    rules: [
      '起草 /goal 契约时不填写文件哈希——目标 SHA256 与二进制格式由宿主强制实地计算注入，防止模型幻觉。',
      '委托模式（caveman/specialist）下仅持有只读规划工具，将高频静态/动态取证下放给高吞吐执行席位（ds / gemini 4 neon / glm-5.3-flash）。',
      '每次请求自动由宿主在 System Prompt 尾部重注入最新 Hypothesis Stack 与 Evidence Digest，抵抗上下文压缩遗忘。',
    ],
  },
  executor: {
    id: 'executor',
    zone: 'ZONE I · 席位路由',
    title: 'EXECUTOR · 高速取证执行席 (ds / gemini 4 neon / glm-5.3-flash)',
    modulePath: 'internal/tools/* · internal/providers/clitmux.go',
    summary:
      '选用高吞吐低延迟模型（ds / gemini 4 neon / glm-5.3-flash）高频驱动 34 个内置逆向工具（纯 Go ELF/PE/Mach-O/APK 解析、字节雕刻、熵扫描及 verify_artifact 重放校验），产出可溯源原始观测。',
    rules: [
      '所有外部命令（run_command / remote_exec / verify_artifact）执行前必须串行穿过 Gate 1 能力沙箱与 Gate 2 策略审批门。',
      '工具返回结果由宿主自动分配递增编号 ev_NNN，并在返回给模型的文本末尾加盖 [evidence ev_NNN saved] 水印。',
      '宿主自动按工具性质打标视角：磁盘解析归入 static，子进程运行与重放归入 dynamic。',
    ],
  },
  auditor: {
    id: 'auditor',
    zone: 'ZONE I · 防线⑤ 独立对抗审计',
    title: 'AUDITOR · 独立对抗审计席 (Adversarial Auditor)',
    modulePath: 'internal/core/auditor.go (AgentLoop.Audit)',
    summary:
      '防线⑤ Adversarial Auditor：选用独立强逻辑模型，在零历史对话、零工具权限的隔离上下文中，仅读范围声明、Evidence Ledger、候选结论与验证结果，逐条执行 5 项对抗核查。',
    rules: [
      '上下文完全隔离（Isolated: true, FreshSession: true, Tools: []），不继承主 Agent 叙事，防止替流畅故事打分。',
      '5 项强制核查：① 直接证据 ② 异常/失败输入覆盖 ③ 替代解释排查 ④ 零越权动作 ⑤ 产物步骤一致。',
      '输出三态裁定 accepted | needs_more_evidence | rejected 并签发 audit_finding（单样本命中退回补证）。',
    ],
  },
  sandbox: {
    id: 'sandbox',
    zone: 'ZONE II · 防线① 能力沙箱',
    title: 'GATE 1 · Capability Sandbox (防线① 任务能力沙箱)',
    modulePath: 'internal/security/capability.go (Sandbox.Authorize)',
    summary:
      '防线① Capability Sandbox：基于 /goal 契约的最小权限硬边界（deny-by-default），杜绝环境泄漏（如 SOLUTION.txt、工作区外凭据），并将每次高风险动作绑定目标假设写入 Action State。',
    rules: [
      '未授权能力直接同步拦截（network / device / 工作区外路径），绝不因“顺手可见”把环境线索冒充逆向证据。',
      '每次授权判定均生成不可篡改 ActionRecord（时间、工具、能力轴、命令 SHA256、granted/denied 及绑定 hypothesisId）。',
      '任务结束或假设回滚时立即吊销临时能力，确保跨任务零权限残留。',
    ],
  },
  approval: {
    id: 'approval',
    zone: 'ZONE II · 策略审批兜底',
    title: 'GATE 2 · Execution Policy & Approval Bridge (策略与人工审批)',
    modulePath: 'internal/security/policy.go · gui/approval.go',
    summary:
      '会话级安全兜底网：在能力沙箱之外对破坏性命令、敏感凭据路径（.ssh / .aws / .env）及写盘/执行动作执行分级确认。',
    rules: [
      'GUI 将同步 Confirm 阻塞转为异步审批事件（awaiting_approval），挂起工具协程等待人工拍板。',
      '弹窗默认聚焦 deny 且 Esc 键映射为 deny，防止误触回车放行高危命令。',
      '支持 allow / allow-always / deny / deny-always 四态决策，always 策略跨会话严格隔离。',
    ],
  },
  ledger: {
    id: 'ledger',
    zone: 'ZONE III · 防线② 证据账本',
    title: 'EVIDENCE LEDGER · 防线② 不可篡改观测账本 (evidence-ledger.jsonl)',
    modulePath: 'internal/evidence/ledger.go · internal/core/metacog.go',
    summary:
      '防线② Evidence Ledger：只追加观测事实底座，严格隔离 UNTRUSTED DATA（样本字符串与原始输出仅作数据，防止函数名/隐形字符投毒上下文），绝不把模型总结混入事实。',
    rules: [
      '双路持久化：落盘 evidence-ledger.jsonl 并镜像会话 JSONL；每条 ev_NNN 携带来源工具、视角、SHA256 与字节数。',
      '样本字符串与原始工具输出标记为 UNTRUSTED DATA，与验证凭证 (VER) 和审计签章 (AUD) 明确分层。',
      '所有假设引用与交付门禁仅认账本中真实存在的 ev_NNN 编号，口头声称一律无效。',
    ],
  },
  hypotheses: {
    id: 'hypotheses',
    zone: 'ZONE III · 防线③ 假设管理',
    title: 'HYPOTHESIS MANAGER · 防线③ 结构化可证伪假设栈 (H-001..H-064)',
    modulePath: 'internal/hypothesis/tracker.go',
    summary:
      '防线③ Hypothesis Manager：拒绝“上下文里一句话”式叙事固着，每条假设显式声明 claim / scope / confidence / supporting / falsifiers / next_test，冲突时自动削弱、冻结或级联回滚。',
    rules: [
      '反证折半定律（Confidence Halving）：收到新反证 Challenge(H, ev) 时置信度 c ← c × 0.5；低于 0.25 降级为 reevaluate。',
      '依赖级联定律（Dependency Cascade）：父假设被 Revise/Reject 时，所有下游 dependsOn 子假设自动级联重审。',
      '动态动作绑定（§8.4）：每次动态实验必须声明验证哪条假设的 next_test，未命中即记为 weakened。',
    ],
  },
  arbitrator: {
    id: 'arbitrator',
    zone: 'ZONE IV · 防线④ 执行验证与仲裁',
    title: 'HOST ARBITRATOR & EXECUTION VERIFIER · 防线④ 行为重放与差分仲裁',
    modulePath: 'internal/verify/arbitrator.go · verify_artifact',
    summary:
      '防线④ Execution Verifier + 确定性仲裁器：以构建、固定输入回放、边界/失败样本与差分比对检验行为等价性（区分 candidate 与 verified），并执行四条硬规则交叉仲裁。',
    rules: [
      '单样本守卫（§8.5）：单样本命中仅标为 candidate，必须通过正反例 + 边界/差分门槛才晋升为 verified。',
      '规则 1/2 [dangling-citation / error-support]：悬空 ev_NNN 或误把报错记录作支撑 → 自动转 Challenge。',
      '规则 3/4 [runtime-contradiction / single-view]：动静跨视角矛盾自动折半，高置信单视角触发盲区告警。',
    ],
  },
  gate: {
    id: 'gate',
    zone: 'ZONE IV · 交付裁定门禁',
    title: 'DELIVERY GATE · 7 项完成条件与三态交付门禁',
    modulePath: 'internal/workflow/phase.go · internal/goal/declaration.go',
    summary:
      'Target State ≠ Objective State 硬契约闸门：仅当可复现回放、差分验证、5 项对抗审计与 /goal 验收全部达标时输出 accepted，否则保持 candidate 或退回 needs_more_evidence。',
    rules: [
      'Target State（样本路径/SHA256/架构）与 Objective State（任务意图/交付物/停止条件）严格解耦，防任务漂移。',
      '三态交付面：accepted（可复现报告）/ candidate（未验收候选）/ needs_more_evidence（退回补证）。',
      'WRI [9/9] 终极门禁：verify_artifact 多向量通过 + audit_finding ≥ 1 + /goal 验收项 100% 达标。',
    ],
  },
}

export function GovernanceGraphPanel({
  tick,
  thinkLines = [],
  workspace,
  onRunAgentWriteup,
  onOpenWorkbench,
  initialMode = 'pipeline',
}: {
  tick: TickDTO | null
  thinkLines?: string[]
  workspace?: string
  onRunAgentWriteup?: () => void
  onOpenWorkbench?: (tab: WorkbenchTab, hypId?: string) => void
  initialMode?: GraphViewMode
}) {
  const [mode, setMode] = useState<GraphViewMode>(initialMode)
  const [selectedNode, setSelectedNode] = useState<NodeId>('hypotheses')
  const [selectedEntity, setSelectedEntity] = useState<{ kind: 'ev' | 'hyp'; id: string } | null>(null)
  const [replayIdx, setReplayIdx] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [fastReplay, setFastReplay] = useState(false)

  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  const replayFrames = useMemo(() => buildReplayFrames(tick, thinkLines), [tick, thinkLines])
  const processSummary = useMemo(() => synthesizeProcessSummary(tick), [tick])

  const liveBusy = Boolean(
    tick?.flow && tick.flow.stage !== 'idle' && tick.flow.stage !== 'done' && tick.flow.stage !== 'error',
  )
  useEffect(() => {
    if (liveBusy) {
      setPlaying(false)
      setReplayIdx(null)
    }
  }, [liveBusy])

  useEffect(() => {
    if (replayIdx !== null && replayFrames.length === 0) {
      setReplayIdx(null)
      setPlaying(false)
    } else if (replayIdx !== null && replayIdx >= replayFrames.length) {
      setReplayIdx(replayFrames.length - 1)
    }
  }, [replayFrames.length, replayIdx])

  useEffect(() => {
    if (!playing || replayFrames.length === 0) return
    const cur = replayIdx ?? 0
    setSelectedNode(replayFrames[cur]?.focusNode ?? 'hypotheses')
    if (cur >= replayFrames.length - 1) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(
      () => {
        const next = Math.min(replayFrames.length - 1, cur + 1)
        setReplayIdx(next)
        if (replayFrames[next]) {
          setSelectedNode(replayFrames[next].focusNode)
        }
      },
      fastReplay ? 850 : 1550,
    )
    return () => clearTimeout(timer)
  }, [playing, replayIdx, replayFrames, fastReplay])

  const activeFrame: ReplayFrame | null =
    replayIdx !== null && replayFrames[replayIdx] ? replayFrames[replayIdx] : null
  const effectiveTick = activeFrame ? activeFrame.tick : tick
  const phaseGates = useMemo(() => evaluatePhaseGates(effectiveTick), [effectiveTick])

  const ledger = (effectiveTick?.ledger ?? null) as ExtendedLedger | null
  const evidence = ledger?.evidence ?? []
  const hypotheses = (ledger?.hypotheses ?? []) as StructuredHypothesis[]
  const findings = ledger?.findings ?? []
  const sandbox = ledger?.sandbox
  const goal = (ledger?.goal ?? null) as ExtendedGoalSummary | null
  const route = effectiveTick?.hud.route
  const flow = effectiveTick?.flow
  const re = effectiveTick?.re

  const plannerName = route?.planner || 'codex-sol'
  const executorName = route?.executor || 'ds'
  const auditorName = ledger?.auditorProvider || route?.auditor || 'glm-5.3'
  const activeProvider = flow?.provider || route?.active || ''
  const busy = activeFrame
    ? true
    : Boolean(flow && flow.stage !== 'idle' && flow.stage !== 'done' && flow.stage !== 'error')

  const stats = useMemo(() => {
    const staticCnt = evidence.filter((e) => (e.view || 'static') === 'static' && !e.isError).length
    const dynCnt = evidence.filter((e) => e.view === 'dynamic' && !e.isError).length
    const verEvs = evidence.filter((e) => !e.isError && e.kind === 'verification_result')
    const verCnt = verEvs.length
    const audCnt = evidence.filter((e) => e.kind === 'audit_finding').length
    const errCnt = evidence.filter((e) => e.isError).length
    const untrustedCnt = evidence.filter(
      (e) => e.untrustedInput === true || (e.untrustedInput !== false && e.kind !== 'verification_result' && e.kind !== 'audit_finding'),
    ).length
    const verVerified = verEvs.some((e) => {
      const vs = e.verification as ExtendedVerificationStats | null | undefined
      return vs?.status === 'verified' || ((vs?.total ?? 0) >= 2 && vs?.passed === vs?.total)
    })

    const activeH = hypotheses.filter((h) => h.status === 'active').length
    const revisedH = hypotheses.filter((h) => h.status === 'revised').length
    const reevalH = hypotheses.filter((h) => h.status === 'reevaluate').length
    const rejectedH = hypotheses.filter((h) => h.status === 'rejected').length

    const goalPass = goal?.criteria.filter((c) => c.pass).length ?? 0
    const goalTotal = goal?.criteria.length ?? 0

    return {
      staticCnt,
      dynCnt,
      verCnt,
      verVerified,
      audCnt,
      errCnt,
      untrustedCnt,
      activeH,
      revisedH,
      reevalH,
      rejectedH,
      goalPass,
      goalTotal,
    }
  }, [evidence, hypotheses, goal])

  const activeRuntimeRole: RuntimeRoleId = useMemo(() => {
    const toolName = (flow?.activeTool || '').toLowerCase()
    if (toolName.includes('verify')) return 'verifier'
    if (toolName.includes('audit') || (activeProvider === auditorName && busy)) return 'auditor'
    if (flow?.stage === 'tool' || flow?.stage === 'calls') return 'router'
    if (re?.phase === 'audit' || (re?.phase === 'writeup' && stats.audCnt > 0)) return 'auditor'
    if (re?.phase === 'verify') return 'verifier'
    if (evidence.length > 0 && (re?.phase === 'evidence' || re?.phase === 'static' || flow?.stage === 'write')) {
      return 'ledger'
    }
    return 'router'
  }, [flow?.activeTool, flow?.stage, activeProvider, auditorName, busy, re?.phase, stats.audCnt, evidence.length])

  const deliveryOutcome: DeliveryOutcome = useMemo(() => {
    const explicit = ledger?.auditVerdict
    if (
      explicit === 'accepted' ||
      explicit === 'candidate' ||
      explicit === 'needs_more_evidence' ||
      explicit === 'rejected'
    ) {
      return explicit
    }
    const goalOk = stats.goalTotal === 0 || stats.goalPass === stats.goalTotal
    if ((stats.audCnt > 0 && stats.verCnt > 0 && goalOk && stats.reevalH === 0) || re?.phase === 'writeup') {
      return 'accepted'
    }
    if (
      stats.reevalH > 0 ||
      findings.some((f) => f.action === 'challenge' || f.rule === 'runtime-contradiction') ||
      (stats.verCnt > 0 && !stats.verVerified)
    ) {
      return 'needs_more_evidence'
    }
    return 'candidate'
  }, [ledger?.auditVerdict, stats, findings, re?.phase])

  const spec = NODE_SPECS[selectedNode]

  const startOrToggleReplay = () => {
    if (replayFrames.length === 0) return
    if (playing) {
      setPlaying(false)
      return
    }
    const startAt =
      replayIdx === null || replayIdx >= replayFrames.length - 1 ? 0 : replayIdx
    setReplayIdx(startAt)
    if (replayFrames[startAt]) setSelectedNode(replayFrames[startAt].focusNode)
    setPlaying(true)
  }

  const jumpReplayFrame = (idx: number) => {
    setPlaying(false)
    const clamped = Math.max(0, Math.min(replayFrames.length - 1, idx))
    setReplayIdx(clamped)
    if (replayFrames[clamped]) setSelectedNode(replayFrames[clamped].focusNode)
  }

  const exitReplayToLive = () => {
    setPlaying(false)
    setReplayIdx(null)
  }

  const inspectorCard = (
    <div style={inspectorBoxStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--violet)', fontSize: 10, letterSpacing: '0.08em' }}>{spec.zone}</span>
        <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 12 }}>{spec.title}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 10 }}>{spec.modulePath}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ color: 'var(--text)', fontSize: 11.5, lineHeight: 1.45 }}>{spec.summary}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {spec.rules.map((r, i) => (
              <div key={i} style={{ color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.4 }}>
                <span style={{ color: 'var(--accent)' }}>▸ </span>
                {r}
              </div>
            ))}
          </div>
        </div>

        {renderLiveNodeTelemetry(selectedNode, {
          evidence,
          hypotheses,
          findings,
          sandbox,
          goal,
          plannerName,
          executorName,
          auditorName,
          toolRuns: flow?.toolRuns ?? [],
          planSteps: effectiveTick?.plan?.steps ?? [],
        })}
      </div>
    </div>
  )

  return (
    <PanelBox
      title="governance & provenance graph"
      accent={mode === 'writeup' ? 'ok' : mode === 'dag' ? 'violet' : 'accent'}
      tier="spotlight"
      collapsible={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {/* Sub-header mode switch + seat legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            aria-label="◈ 机制协同架构图"
            data-hint="9 节点多席位协同与双层安全门禁实时拓扑"
            onClick={() => setMode('pipeline')}
            style={modeTabStyle(mode === 'pipeline', 'accent')}
          >
            ◈ 架构图
          </button>
          <button
            type="button"
            aria-label={`☍ 实时因果证据图谱 (ev:${evidence.length} ↔ H:${hypotheses.length})`}
            data-hint="实时因果引用图谱：点击 ev_NNN 或 H-NNN 节点查看支撑/反证与依赖级联链路"
            onClick={() => setMode('dag')}
            style={modeTabStyle(mode === 'dag', 'violet')}
          >
            ☍ 证据图谱 <span className="re-mono-num" style={{ opacity: 0.78 }}>{evidence.length}·{hypotheses.length}</span>
          </button>
          <button
            type="button"
            aria-label="✎ 过程总结与 Writeup 工坊"
            data-hint="完整推理叙事、六阶段认知对齐与证据锚定 Writeup 导出"
            onClick={() => setMode('writeup')}
            style={modeTabStyle(mode === 'writeup', 'ok')}
          >
            ✎ 报告
          </button>

          {onOpenWorkbench && (
            <button
              type="button"
              aria-label="🧪 假设实验与验证台"
              onClick={() => onOpenWorkbench('hypothesis')}
              data-hint="新增/编辑可证伪假设、实跑实验取证、执行 verify_artifact 重放或签发审查结论（证据账本严格只追加）"
              style={{
                border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--rule))',
                borderRadius: 'var(--radius-xs)',
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                fontSize: 11,
                padding: '3px 10px',
                cursor: 'pointer',
              }}
            >
              🧪 实验台
            </button>
          )}

          <span style={{ flex: 1 }} />

          <div className="re-mono-num" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5 }}>
            <span
              style={seatBadgeStyle('accent', activeProvider === plannerName && Boolean(busy))}
              data-hint={`规划席 (Planner: ${plannerName}) — 负责 /goal 契约、任务拆解与假设栈建模`}
            >
              P:<b>{plannerName}</b>
            </span>
            <span
              style={seatBadgeStyle('ok', activeProvider === executorName && Boolean(busy))}
              data-hint={`执行席 (Executor: ${executorName}) — 负责高频调用 34 项静态/动态逆向工具取证`}
            >
              E:<b>{executorName}</b>
            </span>
            <span
              style={seatBadgeStyle('violet', activeProvider === auditorName && Boolean(busy))}
              data-hint={`对抗审计席 (Auditor: ${auditorName}) — 零对话历史隔离复核假设与证据闭环`}
            >
              A:<b>{auditorName}</b>
            </span>
          </div>
        </div>

        {/* 9-Phase Hard-Gate Readiness Strip (Pipeline & DAG modes) */}
        {mode !== 'writeup' && (
          <div className="re-gate-strip" data-testid="phase-gate-strip">
            <span
              style={{ color: 'var(--faint)', letterSpacing: '0.06em' }}
              data-hint="9 阶段机械硬门禁：前置阶段凭证不足时宿主拒绝跨级推进或提前输出总结"
            >
              GATES
            </span>
            {phaseGates.map((g) => (
              <span
                key={g.code}
                className="re-gate-pill"
                data-ready={g.ready}
                data-hint={`${g.code} (${g.phase}) — ${g.criterion} [${g.progress}]`}
              >
                <span>{g.ready === 'pass' ? '✓' : g.ready === 'current' ? '▸' : g.ready === 'blocked' ? '🔒' : '○'}</span>
                <b>{g.code}</b>
                <span style={{ opacity: 0.78 }}>{g.progress}</span>
              </span>
            ))}
          </div>
        )}

        {/* §8.7 4 Rotating Runtime States + 3 Delivery Outcomes Strip */}
        {mode !== 'writeup' && (
          <div className="cl-runtime-bar" data-testid="runtime-states-strip">
            <div className="cl-runtime-group">
              <span
                className="cl-bar-label"
                data-hint="§8.7 运行态状态轮换：每次动作在 Tool Router、Evidence Ledger、Execution Verifier 与 Adversarial Auditor 之间显式交接"
              >
                LOOP
              </span>
              {(
                [
                  ['router', 'Tool Router', 'accent', '按任务能力边界路由工具调用与动态动作'],
                  ['ledger', 'Evidence Ledger', 'ok', '只追加记录原始观测并按 UNTRUSTED DATA 隔离样本输入'],
                  ['verifier', 'Execution Verifier', 'warn', '执行构建、正反例回放与差分比较（区分 candidate 与 verified）'],
                  ['auditor', 'Adversarial Auditor', 'violet', '零历史隔离上下文 5 项核查，裁定 accepted / needs_more_evidence / rejected'],
                ] as const
              ).map(([id, label, tone, hint], idx) => (
                <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {idx > 0 && <span className="cl-role-arrow">⇄</span>}
                  <span
                    className="cl-role-pill"
                    data-active={activeRuntimeRole === id ? '1' : undefined}
                    data-tone={tone}
                    data-hint={hint}
                  >
                    {activeRuntimeRole === id ? '●' : '○'} {label}
                  </span>
                </span>
              ))}
            </div>

            <div className="cl-runtime-group">
              <span
                className="cl-bar-label"
                data-hint="右侧交付面三态裁定：只有通过回放、差分与 5 项对抗审计的结论才能进入 accepted"
              >
                DELIVERY
              </span>
              {(
                [
                  ['accepted', 'accepted · 可复现报告', '通过行为回放、差分对比与隔离审计，可交付可复现任务档案'],
                  ['candidate', 'candidate · 未验收候选', '尚处探索或单样本命中阶段，不可宣称已还原算法'],
                  ['needs_more_evidence', 'needs_more_evidence · 退回补证', '存在反证冲突、边界盲区或单样本命中，需补充实验后重审'],
                ] as const
              ).map(([verdict, label, hint]) => (
                <span
                  key={verdict}
                  className="cl-outcome-pill"
                  data-verdict={verdict}
                  data-active={deliveryOutcome === verdict ? '1' : undefined}
                  data-hint={hint}
                >
                  {deliveryOutcome === verdict ? '▸' : '○'} {label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Green Intake Isolation & Target State ≠ Objective State Strip (§8.1) */}
        {mode === 'pipeline' && (
          <div className="cl-intake-bar re-mono-num" data-testid="intake-isolation-strip">
            <span
              className="cl-isolation-badge"
              data-hint="第四章 & 第六章防投毒防线：样本字符串、函数名与隐藏字符先按 UNTRUSTED DATA 隔离，禁止直接作为指令进入任务上下文"
            >
              🛡 样本字符串仅作数据 · 防投毒隔离 ({stats.untrustedCnt})
            </span>
            <span
              className="cl-split-chip"
              data-hint={`§8.1 Target State（被分析对象本身）：${goal?.targetFile || '待声明样本'}${goal?.targetArch ? ` · ${goal.targetArch}` : ''}${goal?.targetFormat ? ` · ${goal.targetFormat}` : ''}${goal?.targetSha256 ? ` · sha256:${goal.targetSha256.slice(0, 12)}` : ''}`}
            >
              <b style={{ color: 'var(--ok)' }}>Target</b>
              <span>{goal?.targetFile || re?.sampleType || '未绑定目标样本'}</span>
            </span>
            <span
              className="cl-split-neq"
              data-hint="§8.1 架构铁律：Target State ≠ Objective State —— 同一样本可对应不同分析目标，严格解耦防止任务漂移"
            >
              ≠
            </span>
            <span
              className="cl-split-chip"
              data-hint={`§8.1 Objective State（任务意图与验收标准）：${goal?.primary || '待通过 /goal 声明任务意图与验收门槛'}`}
            >
              <b style={{ color: 'var(--accent)' }}>Objective</b>
              <span>{goal?.primary || '任务意图与验收标准'}</span>
            </span>
          </div>
        )}

        {/* Cognitive Replay Scrubber (available in both Pipeline & DAG views whenever frames exist) */}
        {mode !== 'writeup' && replayFrames.length > 0 && (
          <div style={replayBarStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={startOrToggleReplay}
                data-hint="按时间轴逐步回放多席位推理、实验冲突与仲裁决策演化过程"
                style={{
                  ...replayBtnStyle,
                  borderColor: playing ? 'var(--warn)' : 'var(--accent)',
                  color: playing ? 'var(--warn)' : 'var(--accent)',
                  background: playing ? 'var(--warn-soft)' : 'var(--accent-soft)',
                }}
              >
                {playing ? '⏸ 暂停回放' : '▶ 回放思考过程'}
              </button>
              <button
                type="button"
                onClick={() => jumpReplayFrame(0)}
                data-hint="跳至第 1 演化帧"
                style={replayBtnStyle}
              >
                ⏮
              </button>
              <button
                type="button"
                onClick={() => jumpReplayFrame((replayIdx ?? replayFrames.length - 1) - 1)}
                data-hint="上一演化帧"
                style={replayBtnStyle}
              >
                ◀
              </button>
              <button
                type="button"
                onClick={() => jumpReplayFrame((replayIdx ?? -1) + 1)}
                data-hint="下一演化帧"
                style={replayBtnStyle}
              >
                ▶
              </button>
              <button
                type="button"
                onClick={() => setFastReplay((v) => !v)}
                data-hint="切换回放倍速 (1× / 2×)"
                style={{ ...replayBtnStyle, color: fastReplay ? 'var(--accent)' : 'var(--faint)' }}
              >
                {fastReplay ? '2×' : '1×'}
              </button>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                {replayFrames.map((fr, idx) => {
                  const cur = replayIdx === idx
                  return (
                    <button
                      key={fr.id}
                      type="button"
                      onClick={() => jumpReplayFrame(idx)}
                      data-hint={`${fr.stageTag} — ${fr.title}`}
                      style={{
                        ...replayBtnStyle,
                        borderColor: cur ? `var(--${fr.actorTone})` : 'var(--border-subtle)',
                        color: cur ? `var(--${fr.actorTone})` : 'var(--muted)',
                        background: cur ? 'var(--surface-2)' : 'transparent',
                        fontSize: 10,
                      }}
                    >
                      {idx + 1}.{fr.stageTag.replace(/^[①②③④⑤⑥●]\s*/, '').slice(0, 6)}
                    </button>
                  )
                })}
              </div>

              <span style={{ flex: 1 }} />

              {activeFrame ? (
                <button
                  type="button"
                  onClick={exitReplayToLive}
                  style={{ ...replayBtnStyle, borderColor: 'var(--ok)', color: 'var(--ok)', background: 'var(--ok-soft)' }}
                >
                  ● 回到实时 (LIVE)
                </button>
              ) : (
                <span className="re-mono-num" style={{ color: 'var(--ok)', fontSize: 10 }} data-hint={`当前同步实时态，共捕获 ${replayFrames.length} 个可回放决策节点`}>
                  ● LIVE · {replayFrames.length} 帧
                </span>
              )}
            </div>

            {activeFrame && (
              <div style={replayThoughtBoxStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5 }}>
                  <span style={{ color: `var(--${activeFrame.actorTone})`, fontWeight: 700 }}>
                    [帧 {activeFrame.index}/{replayFrames.length} · {activeFrame.stageTag}]
                  </span>
                  <span style={{ color: 'var(--text)', fontWeight: 600 }}>{activeFrame.title}</span>
                  <span style={{ color: 'var(--muted)' }}>席位: {activeFrame.actor}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--ok)' }}>{activeFrame.stateDelta}</span>
                </div>
                {activeFrame.transitionFromPrev && (
                  <div style={{ color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.45 }}>
                    <span style={{ color: 'var(--violet)', fontWeight: 600 }}>↳ 承接上步：</span>
                    {activeFrame.transitionFromPrev}
                  </div>
                )}
                <div style={{ color: 'var(--text)', fontSize: 11, lineHeight: 1.5 }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>💭 思考与决策回放：</span>
                  {activeFrame.thought}
                </div>
                {activeFrame.takeaway && (
                  <div style={{ color: 'var(--ok)', fontSize: 10.5, lineHeight: 1.42 }}>
                    <span style={{ fontWeight: 600 }}>→ 本步结论：</span>
                    {activeFrame.takeaway}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {mode === 'writeup' ? (
          <WriteupStudioPanel
            tick={tick}
            workspace={workspace}
            onRunAgentWriteup={onRunAgentWriteup}
          />
        ) : mode === 'pipeline' ? (
          <>
            {/* Interactive Zoomable Architecture SVG */}
            <ZoomableSvgViewport
              title="机制协同架构图 (codex sol / gemini 4 carbon · ds / neon / flash · glm-5.3)"
              fullscreenFooter={inspectorCard}
              maxInlineHeight={285}
            >
              {(inFullscreen) => (
                <svg
                  viewBox="0 0 1040 416"
                  style={{
                    width: '100%',
                    maxHeight: inFullscreen ? 'none' : 285,
                    height: 'auto',
                    display: 'block',
                    minWidth: 740,
                  }}
                  role="img"
                  aria-label="0xAF-Re multi-model security, evidence, hypothesis, and audit architecture graph"
                >
                <defs>
                  <marker id="arr-cyan" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)" />
                  </marker>
                  <marker id="arr-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--ok)" />
                  </marker>
                  <marker id="arr-violet" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--violet)" />
                  </marker>
                  <marker id="arr-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--warn)" />
                  </marker>
                  <marker id="arr-err" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--err)" />
                  </marker>
                </defs>

                <style>{`
                  @keyframes dashFlow { to { stroke-dashoffset: -24; } }
                  .edge-live { stroke-dasharray: 6 6; animation: dashFlow 0.9s linear infinite; }
                  .g-node { cursor: pointer; transition: opacity 0.15s ease; }
                  .g-node:hover rect.node-box { filter: brightness(1.25); }
                `}</style>

                {/* Zone Swimlane Headers — Mapped 1:1 to the 5 Defenses Control Spine (§6 + §8) */}
                {[
                  { x: 14, w: 224, label: 'I. 席位路由 & ⑤ 对抗审计' },
                  { x: 266, w: 236, label: 'II. ① 能力沙箱 & 审批门' },
                  { x: 530, w: 244, label: 'III. ② 证据账本 & ③ 假设管理' },
                  { x: 802, w: 224, label: 'IV. ④ 执行验证 & 交付裁定' },
                ].map((z) => (
                  <g key={z.label}>
                    <rect
                      x={z.x}
                      y={8}
                      width={z.w}
                      height={402}
                      fill="color-mix(in srgb, var(--surface-2) 38%, transparent)"
                      stroke="var(--border-subtle)"
                      strokeDasharray="3 3"
                    />
                    <text x={z.x + 10} y={26} fill="var(--faint)" fontSize="10" letterSpacing="0.08em">
                      {z.label}
                    </text>
                  </g>
                ))}

                {/* ---- Directed Edges ---- */}
                {/* deepseek -> sandbox (/goal contract) */}
                <path
                  d="M 226 78 C 248 78, 252 96, 278 96"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.4"
                  markerEnd="url(#arr-cyan)"
                  className={goal?.accepted ? 'edge-live' : undefined}
                />
                <text x="235" y="70" fill="var(--accent)" fontSize="9">/goal 契约</text>

                {/* deepseek -> hypotheses (create/revise H-NNN) */}
                <path
                  d="M 226 62 C 370 28, 430 28, 542 268"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.4"
                  strokeOpacity="0.85"
                  markerEnd="url(#arr-cyan)"
                  className={activeProvider === plannerName && busy ? 'edge-live' : undefined}
                />
                <text x="358" y="44" fill="var(--accent)" fontSize="9">建模 / 修订 H-NNN</text>

                {/* codex -> sandbox (tool call) */}
                <path
                  d="M 226 205 C 252 205, 252 132, 278 132"
                  fill="none"
                  stroke="var(--ok)"
                  strokeWidth="1.6"
                  markerEnd="url(#arr-ok)"
                  className={flow?.stage === 'tool' || flow?.stage === 'calls' ? 'edge-live' : undefined}
                />
                <text x="232" y="182" fill="var(--ok)" fontSize="9">工具调用</text>

                {/* sandbox -> approval */}
                <path
                  d="M 384 166 L 384 228"
                  fill="none"
                  stroke={sandbox?.deniedCount ? 'var(--warn)' : 'var(--ok)'}
                  strokeWidth="1.5"
                  markerEnd="url(#arr-warn)"
                />
                <text x="392" y="202" fill="var(--muted)" fontSize="9">能力放行 → 分级策略检查</text>

                {/* approval -> ledger (stamp ev_NNN) */}
                <path
                  d="M 490 278 C 516 278, 516 116, 542 116"
                  fill="none"
                  stroke="var(--ok)"
                  strokeWidth="1.6"
                  markerEnd="url(#arr-ok)"
                  className={evidence.length > 0 ? 'edge-live' : undefined}
                />
                <text x="495" y="198" fill="var(--ok)" fontSize="8.5">盖章 ev_NNN</text>

                {/* ledger <-> hypotheses (cite / contradict) */}
                <path
                  d="M 652 176 L 652 238"
                  fill="none"
                  stroke="var(--ok)"
                  strokeWidth="1.5"
                  markerEnd="url(#arr-ok)"
                />
                <text x="660" y="211" fill="var(--ok)" fontSize="9">静态/动态引用支撑</text>

                {/* ledger + hypotheses -> arbitrator */}
                <path
                  d="M 762 116 C 786 116, 788 104, 814 104"
                  fill="none"
                  stroke="var(--warn)"
                  strokeWidth="1.4"
                  markerEnd="url(#arr-warn)"
                />
                <path
                  d="M 762 280 C 790 280, 788 134, 814 134"
                  fill="none"
                  stroke="var(--warn)"
                  strokeWidth="1.4"
                  markerEnd="url(#arr-warn)"
                />

                {/* arbitrator -> hypotheses (auto-challenge ×0.5 + cascade) */}
                <path
                  d="M 814 156 C 785 198, 785 312, 762 312"
                  fill="none"
                  stroke="var(--err)"
                  strokeWidth="1.4"
                  strokeDasharray="4 3"
                  markerEnd="url(#arr-err)"
                />
                <text x="765" y="224" fill="var(--err)" fontSize="8.5">反证×0.5/级联</text>

                {/* ledger + hypotheses -> glm auditor (isolated packet) */}
                <path
                  d="M 542 334 C 430 374, 320 374, 226 344"
                  fill="none"
                  stroke="var(--violet)"
                  strokeWidth="1.4"
                  strokeDasharray="5 4"
                  markerEnd="url(#arr-violet)"
                />
                <text x="330" y="366" fill="var(--violet)" fontSize="8.5">脱敏快照包 (零工具隔离输入 /audit)</text>

                {/* glm auditor -> gate (audit_finding + verdict) */}
                <path
                  d="M 226 368 C 450 408, 675 408, 814 338"
                  fill="none"
                  stroke="var(--violet)"
                  strokeWidth="1.6"
                  markerEnd="url(#arr-violet)"
                  className={stats.audCnt > 0 ? 'edge-live' : undefined}
                />
                <text x="490" y="404" fill="var(--violet)" fontSize="8.5">AUDIT 判定行 + audit_finding 凭证</text>

                {/* arbitrator -> gate */}
                <path
                  d="M 914 174 L 914 238"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                  markerEnd="url(#arr-cyan)"
                />
                <text x="922" y="210" fill="var(--muted)" fontSize="9">门禁计数校验</text>

                {/* ---- 9 Interactive Nodes ---- */}
                {renderSvgNode({
                  id: 'planner',
                  x: 20,
                  y: 42,
                  w: 212,
                  h: 82,
                  tone: 'accent',
                  selected: selectedNode === 'planner',
                  hot: activeProvider === plannerName && Boolean(busy),
                  title: `PLANNER · ${plannerName}`,
                  line1: 'codex sol / gemini 4 carbon',
                  line2: `/goal 契约 · 计划 · 假设栈`,
                  badge: activeProvider === plannerName && busy ? '● RUNNING' : 'SEAT 1',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'executor',
                  x: 20,
                  y: 162,
                  w: 212,
                  h: 86,
                  tone: 'ok',
                  selected: selectedNode === 'executor',
                  hot: activeProvider === executorName && Boolean(busy),
                  title: `EXECUTOR · ${executorName}`,
                  line1: 'ds / gemini 4 neon / glm-5.3-flash',
                  line2: `34 逆向工具 · ✓${flow?.toolsOk ?? 0} ✗${flow?.toolsFailed ?? 0}`,
                  badge: flow?.activeTool ? `⚙ ${flow.activeTool}` : 'SEAT 2',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'auditor',
                  x: 20,
                  y: 288,
                  w: 212,
                  h: 90,
                  tone: 'violet',
                  selected: selectedNode === 'auditor',
                  hot: stats.audCnt > 0 || (activeProvider === auditorName && Boolean(busy)),
                  title: `AUDITOR · ${auditorName}`,
                  line1: '⑤ Adversarial Auditor · 隔离5项核查',
                  line2: '零对话 · 零工具 · 专挑盲区',
                  badge: stats.audCnt > 0 ? `⑤ AUD:${stats.audCnt}` : '⑤ ISOLATED',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'sandbox',
                  x: 278,
                  y: 66,
                  w: 212,
                  h: 100,
                  tone: sandbox?.deniedCount ? 'warn' : sandbox?.active ? 'accent' : 'muted',
                  selected: selectedNode === 'sandbox',
                  hot: Boolean(sandbox?.active),
                  title: 'GATE 1 · 能力沙箱',
                  line1: sandbox?.active ? '① ACTIVE (deny-by-default)' : '① 未激活 (走基础策略)',
                  line2: `防环境泄漏 · 动作绑定 H-NNN`,
                  line3: `放行:${sandbox?.grantedCount ?? 0} · 拦截:${sandbox?.deniedCount ?? 0}`,
                  badge: '① /cap',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'approval',
                  x: 278,
                  y: 228,
                  w: 212,
                  h: 104,
                  tone: (flow?.toolsFailed ?? 0) > 0 ? 'warn' : 'ok',
                  selected: selectedNode === 'approval',
                  hot: tick?.hud.phase === 'awaiting_approval',
                  title: 'GATE 2 · 策略与审批门',
                  line1: '高危命令 / 敏感路径正则扫描',
                  line2: 'allow / deny (Esc=deny防误触)',
                  line3: `已审通过:${flow?.toolsOk ?? 0} · 拒绝:${flow?.toolsFailed ?? 0}`,
                  badge: 'POLICY',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'ledger',
                  x: 542,
                  y: 66,
                  w: 220,
                  h: 110,
                  tone: 'ok',
                  selected: selectedNode === 'ledger',
                  hot: evidence.length > 0,
                  title: 'EVIDENCE LEDGER',
                  line1: '② 只追加账本 · 原始输入隔离',
                  line2: `static:${stats.staticCnt} · dynamic:${stats.dynCnt}`,
                  line3: `VER:${stats.verCnt} · AUD:${stats.audCnt} · ERR:${stats.errCnt}`,
                  badge: `② E:${evidence.length}`,
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'hypotheses',
                  x: 542,
                  y: 238,
                  w: 220,
                  h: 114,
                  tone: stats.reevalH > 0 || stats.rejectedH > 0 ? 'violet' : 'accent',
                  selected: selectedNode === 'hypotheses',
                  hot: hypotheses.length > 0,
                  title: 'HYPOTHESIS STACK',
                  line1: '③ scope · falsifiers · next_test',
                  line2: `active:${stats.activeH} · revised:${stats.revisedH}`,
                  line3: `reeval:${stats.reevalH} · rejected:${stats.rejectedH}`,
                  badge: `③ H:${hypotheses.length}`,
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'arbitrator',
                  x: 814,
                  y: 66,
                  w: 200,
                  h: 108,
                  tone: findings.length > 0 ? 'warn' : stats.verVerified ? 'ok' : 'muted',
                  selected: selectedNode === 'arbitrator',
                  hot: findings.length > 0 || stats.verCnt > 0,
                  title: 'HOST ARBITRATOR',
                  line1: `④ ${stats.verVerified ? 'verified' : 'candidate'} 差分回放 + 4规则`,
                  line2: '悬空引用 · 报错支撑 · 动静矛盾',
                  line3: `单视角盲区 · 已捕获:${findings.length}`,
                  badge: '④ VERIFY',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'gate',
                  x: 814,
                  y: 238,
                  w: 200,
                  h: 114,
                  tone: deliveryOutcome === 'accepted' ? 'ok' : deliveryOutcome === 'needs_more_evidence' ? 'warn' : 'accent',
                  selected: selectedNode === 'gate',
                  hot: re?.phase === 'writeup' || deliveryOutcome === 'accepted',
                  title: 'DELIVERY GATE',
                  line1: re
                    ? `RE 阶段: ${re.phase.toUpperCase()} [${re.phaseIndex + 1}/${re.phaseCount}]`
                    : 'RE 阶段: 未开启 (/workflow reverse)',
                  line2: `裁定: ${deliveryOutcome} (${stats.goalPass}/${stats.goalTotal})`,
                  line3: stats.audCnt > 0 ? '✓ WRI 交付门禁已解锁' : '🔒 待 VER + /audit 解锁 WRI',
                  badge: re ? `${re.phaseIndex + 1}/9` : 'GATE',
                  onSelect: setSelectedNode,
                })}
                </svg>
              )}
            </ZoomableSvgViewport>

            {/* Selected Node Deep Inspector */}
            {inspectorCard}
          </>
        ) : (
          <ProvenanceDagView
            evidence={evidence}
            hypotheses={hypotheses}
            findings={findings}
            goal={goal ?? null}
            rePhase={re ? `${re.phase.toUpperCase()} [${re.phaseIndex + 1}/${re.phaseCount}]` : 'OFF'}
            auditorName={auditorName}
            selected={selectedEntity}
            onSelect={setSelectedEntity}
          />
        )}

        {/* Compact Executive Process Summary Strip (visible in Pipeline & DAG modes once analysis begins) */}
        {mode !== 'writeup' && (evidence.length > 0 || hypotheses.length > 0) && (
          <div style={summaryBannerStyle}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11 }}>
                <span style={{ color: 'var(--ok)', fontWeight: 700 }}>✦ 逆向过程总结：</span>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{processSummary.headline}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {processSummary.pillars.map((p) => (
                  <span
                    key={p.key}
                    data-hint={`${p.label} (${p.refs})：${p.value}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      border: `1px solid color-mix(in srgb, var(--${p.tone}) 38%, var(--border-subtle))`,
                      borderLeft: `2px solid var(--${p.tone})`,
                      borderRadius: 'var(--radius-xs)',
                      background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
                      padding: '2px 7px',
                      fontSize: 10,
                      maxWidth: 260,
                    }}
                  >
                    <b style={{ color: `var(--${p.tone})`, flexShrink: 0 }}>{p.label}</b>
                    <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.value}
                    </span>
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMode('writeup')}
              data-hint="切换至完整推理叙事与 Markdown Writeup 工坊"
              style={{
                ...replayBtnStyle,
                borderColor: 'color-mix(in srgb, var(--ok) 55%, var(--rule))',
                color: 'var(--ok)',
                background: 'var(--ok-soft)',
                flexShrink: 0,
                alignSelf: 'center',
              }}
            >
              ✎ 报告工坊 →
            </button>
          </div>
        )}
      </div>
    </PanelBox>
  )
}

// ---------- SVG Node Helper ----------

function renderSvgNode(opts: {
  id: NodeId
  x: number
  y: number
  w: number
  h: number
  tone: 'accent' | 'ok' | 'violet' | 'warn' | 'err' | 'muted'
  selected: boolean
  hot: boolean
  title: string
  line1: string
  line2: string
  line3?: string
  badge: string
  onSelect: (id: NodeId) => void
}) {
  const stroke = opts.selected
    ? `var(--${opts.tone === 'muted' ? 'accent' : opts.tone})`
    : opts.hot
      ? `color-mix(in srgb, var(--${opts.tone === 'muted' ? 'accent' : opts.tone}) 65%, var(--rule))`
      : 'var(--rule)'
  const titleColor = `var(--${opts.tone === 'muted' ? 'text' : opts.tone})`
  return (
    <g className="g-node" onClick={() => opts.onSelect(opts.id)}>
      <rect
        className="node-box"
        x={opts.x}
        y={opts.y}
        width={opts.w}
        height={opts.h}
        rx={3}
        fill={opts.selected ? 'var(--surface-2)' : 'var(--surface-1)'}
        stroke={stroke}
        strokeWidth={opts.selected ? 1.8 : 1}
      />
      {/* Header strip */}
      <rect
        x={opts.x}
        y={opts.y}
        width={opts.w}
        height={22}
        fill={`color-mix(in srgb, ${titleColor} 12%, transparent)`}
      />
      <text x={opts.x + 8} y={opts.y + 15} fill={titleColor} fontSize="10.5" fontWeight="700">
        {opts.title}
      </text>
      <text x={opts.x + opts.w - 8} y={opts.y + 15} fill="var(--muted)" fontSize="9.5" textAnchor="end">
        {opts.badge}
      </text>
      <text x={opts.x + 8} y={opts.y + 40} fill="var(--text)" fontSize={opts.line1.length > 28 ? '9.1' : '10.5'}>
        {opts.line1}
      </text>
      <text x={opts.x + 8} y={opts.y + 58} fill="var(--muted)" fontSize="10">
        {opts.line2}
      </text>
      {opts.line3 && (
        <text x={opts.x + 8} y={opts.y + 76} fill="var(--faint)" fontSize="10">
          {opts.line3}
        </text>
      )}
    </g>
  )
}

function renderLiveNodeTelemetry(
  nodeId: NodeId,
  ctx: {
    evidence: EvidenceRecord[]
    hypotheses: Hypothesis[]
    findings: FindingDTO[]
    sandbox?: NonNullable<TickDTO['ledger']>['sandbox']
    goal?: NonNullable<TickDTO['ledger']>['goal']
    plannerName: string
    executorName: string
    auditorName: string
    toolRuns: NonNullable<TickDTO['flow']>['toolRuns']
    planSteps: NonNullable<TickDTO['plan']>['steps']
  },
) {
  if (nodeId === 'sandbox') {
    const allActs = (ctx.sandbox?.recentActions ?? []) as BoundSandboxAction[]
    const denied = allActs.filter((a) => a.decision === 'denied').slice(-3)
    const granted = allActs.filter((a) => a.decision !== 'denied').slice(-3)
    const acts = [...denied, ...granted]
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--accent)', fontWeight: 600 }}>
          实时沙箱动作日志 ({ctx.sandbox?.active ? 'ACTIVE · deny-by-default' : 'INACTIVE'})
        </div>
        {acts.length === 0 ? (
          <div style={{ color: 'var(--faint)' }}>暂无动作记录（执行外部命令后自动记录 SHA256 与授权结果）</div>
        ) : (
          acts.map((a, i) => (
            <div key={i} style={{ color: a.decision === 'denied' ? 'var(--err)' : 'var(--ok)' }}>
              [{a.decision.toUpperCase()}] {a.tool} {a.capability ? `cap=${a.capability}` : ''}
              {a.hypothesisId ? ` → ${a.hypothesisId}` : ''} · sha256:{a.sha256.slice(0, 10)} ({a.subject.slice(0, 30)})
            </div>
          ))
        )}
      </div>
    )
  }
  if (nodeId === 'arbitrator') {
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--warn)', fontWeight: 600 }}>
          实时仲裁 / 审计发现 ({ctx.findings.length})
        </div>
        {ctx.findings.length === 0 ? (
          <div style={{ color: 'var(--faint)' }}>○ 当前尚无矛盾或盲区告警</div>
        ) : (
          ctx.findings.slice(-6).map((f, i) => (
            <div key={i} style={{ color: f.action === 'support' ? 'var(--ok)' : 'var(--warn)' }}>
              [{f.rule}] {f.hypothesisId} {f.evidenceId ? `← ${f.evidenceId}` : ''}: {f.message}
            </div>
          ))
        )}
      </div>
    )
  }
  if (nodeId === 'gate') {
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--accent)', fontWeight: 600 }}>
          /goal 契约验收项 {ctx.goal ? `(${ctx.goal.targetFile || ctx.goal.primary})` : '(未声明)'}
        </div>
        {ctx.goal && ctx.goal.criteria.length > 0 ? (
          ctx.goal.criteria.map((c, i) => (
            <div key={i} style={{ color: c.pass ? 'var(--ok)' : 'var(--warn)' }}>
              {c.pass ? '✓' : '○'} {c.label} {c.detail ? `(${c.detail})` : ''}
            </div>
          ))
        ) : (
          <div style={{ color: 'var(--faint)' }}>运行 /goal 或 /workflow reverse 后在此追踪硬验收指标</div>
        )}
      </div>
    )
  }
  if (nodeId === 'hypotheses') {
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--accent)', fontWeight: 600 }}>当前假设栈状态 (H:{ctx.hypotheses.length})</div>
        {ctx.hypotheses.length === 0 ? (
          <div style={{ color: 'var(--faint)' }}>○ 暂无活跃假设</div>
        ) : (
          ctx.hypotheses.slice(0, 5).map((h) => (
            <div
              key={h.id}
              style={{
                color:
                  h.status === 'rejected'
                    ? 'var(--err)'
                    : h.status === 'reevaluate'
                      ? 'var(--warn)'
                      : 'var(--text)',
              }}
            >
              <b>{h.id}</b> [{h.status}] {Math.round(h.confidence * 100)}%
              {h.dependsOn?.length ? ` (dependsOn:${h.dependsOn.join(',')})` : ''} — {h.claim.slice(0, 34)}…
            </div>
          ))
        )}
      </div>
    )
  }
  if (nodeId === 'ledger') {
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--ok)', fontWeight: 600 }}>最近入账证据 (E:{ctx.evidence.length})</div>
        {ctx.evidence.length === 0 ? (
          <div style={{ color: 'var(--faint)' }}>○ 暂无入账记录</div>
        ) : (
          ctx.evidence.slice(-5).map((ev) => (
            <div key={ev.id} style={{ color: ev.isError ? 'var(--err)' : 'var(--text)' }}>
              <b style={{ color: 'var(--ok)' }}>{ev.id}</b> [{ev.kind || 'obs'} · {ev.view || 'static'}] {ev.source}
            </div>
          ))
        )}
      </div>
    )
  }
  if (nodeId === 'auditor') {
    const audEvs = ctx.evidence.filter((e) => e.kind === 'audit_finding')
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--violet)', fontWeight: 600 }}>
          独立对抗审计席 ({ctx.auditorName}) · 已签章:{audEvs.length}
        </div>
        {audEvs.length === 0 ? (
          <div style={{ color: 'var(--faint)' }}>○ 待运行 /audit 触发零上下文隔离复核</div>
        ) : (
          audEvs.map((ev) => (
            <div key={ev.id} style={{ color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
              <b style={{ color: 'var(--violet)' }}>{ev.id}</b>: {ev.excerpt}
            </div>
          ))
        )}
      </div>
    )
  }
  if (nodeId === 'executor') {
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--ok)', fontWeight: 600 }}>执行席最近工具调用 ({ctx.executorName})</div>
        {ctx.toolRuns.length === 0 ? (
          <div style={{ color: 'var(--faint)' }}>○ 尚无工具执行记录</div>
        ) : (
          ctx.toolRuns.slice(-5).map((r) => (
            <div key={r.id} style={{ color: r.status === 'failed' ? 'var(--err)' : 'var(--text)' }}>
              {r.status === 'failed' ? '✗' : '✓'} <b>{r.name}</b> ({r.argsText.slice(0, 32)})
            </div>
          ))
        )}
      </div>
    )
  }
  if (nodeId === 'planner') {
    return (
      <div style={liveCardStyle}>
        <div style={{ color: 'var(--accent)', fontWeight: 600 }}>规划席任务拆解 ({ctx.plannerName})</div>
        {ctx.planSteps.length === 0 ? (
          <div style={{ color: 'var(--faint)' }}>○ 尚无活跃计划步骤</div>
        ) : (
          ctx.planSteps.map((st) => (
            <div key={st.id} style={{ color: st.status === 'completed' ? 'var(--ok)' : 'var(--text)' }}>
              {st.status === 'completed' ? '✓' : st.status === 'in_progress' ? '▸' : '○'} {st.text}
            </div>
          ))
        )}
      </div>
    )
  }
  return (
    <div style={liveCardStyle}>
      <div style={{ color: 'var(--ok)', fontWeight: 600 }}>会话级安全审批统计</div>
      <div style={{ color: 'var(--muted)' }}>
        高危执行与写盘操作默认聚焦 deny（Esc 键拒绝），审批策略仅在当前会话生效。
      </div>
    </div>
  )
}

// ---------- Tab 2: Dynamic Provenance Citation DAG ----------

function ProvenanceDagView({
  evidence,
  hypotheses,
  findings,
  goal,
  rePhase,
  auditorName,
  selected,
  onSelect,
}: {
  evidence: EvidenceRecord[]
  hypotheses: Hypothesis[]
  findings: FindingDTO[]
  goal: NonNullable<TickDTO['ledger']>['goal']
  rePhase: string
  auditorName: string
  selected: { kind: 'ev' | 'hyp'; id: string } | null
  onSelect: (sel: { kind: 'ev' | 'hyp'; id: string } | null) => void
}) {
  if (evidence.length === 0 && hypotheses.length === 0) {
    return (
      <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--faint)', fontSize: 12, border: '1px solid var(--rule)' }}>
        ○ 当前会话尚无证据或假设节点 —— 发送一条逆向分析指令（或在顶部引导条点击「▶ 自动执行」），即可实时生成 `ev_NNN ↔ H-NNN ↔ 审计门禁` 因果图谱。
      </div>
    )
  }

  const evSlice = evidence.slice(-10)
  const hypSlice = hypotheses.slice(0, 8)
  const rowCount = Math.max(evSlice.length, hypSlice.length + 1, 4)
  const svgH = Math.max(300, 56 + rowCount * 48)

  const evPos = new Map<string, { x: number; y: number }>()
  evSlice.forEach((ev, idx) => {
    evPos.set(ev.id, { x: 24, y: 46 + idx * 46 })
  })

  const hypPos = new Map<string, { x: number; y: number }>()
  hypSlice.forEach((h, idx) => {
    hypPos.set(h.id, { x: 400, y: 54 + idx * 68 })
  })

  const gatePos = { x: 780, y: Math.max(64, Math.floor(svgH / 2) - 70) }

  const activeEv = selected?.kind === 'ev' ? evidence.find((e) => e.id === selected.id) : null
  const activeHyp = selected?.kind === 'hyp' ? hypotheses.find((h) => h.id === selected.id) : null
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const activeChain = useMemo(
    () => (activeHyp ? buildProvenanceChain(activeHyp, evidence, findings) : null),
    [activeHyp, evidence, findings],
  )
  const activeArc = useMemo(() => {
    if (!activeHyp) return null
    return (
      buildHypothesisArcs(evidence, hypotheses, findings, auditorName).find((a) => a.id === activeHyp.id) ??
      null
    )
  }, [activeHyp, evidence, hypotheses, findings, auditorName])
  const activeHypFindings = useMemo(
    () => (activeHyp ? findings.filter((f) => f.hypothesisId === activeHyp.id) : []),
    [activeHyp, findings],
  )
  const activeEvFindings = useMemo(
    () => (activeEv ? findings.filter((f) => f.evidenceId === activeEv.id) : []),
    [activeEv, findings],
  )

  const copyCite = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ZoomableSvgViewport title="实时因果证据图谱 (ev_NNN ↔ H-NNN DAG)" maxInlineHeight={320}>
        {(inFullscreen) => (
          <svg
            viewBox={`0 0 1020 ${svgH}`}
            style={{
              width: '100%',
              maxHeight: inFullscreen ? 'none' : 320,
              height: 'auto',
              display: 'block',
              minWidth: 740,
            }}
          >
          <defs>
            <marker id="dag-sup" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--ok)" />
            </marker>
            <marker id="dag-con" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--err)" />
            </marker>
            <marker id="dag-dep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--violet)" />
            </marker>
          </defs>

          {/* Column titles */}
          <text x={24} y={24} fill="var(--faint)" fontSize="10" letterSpacing="0.08em">
            EVIDENCE LEDGER (静态 / 动态 / 验证 / 审计记录)
          </text>
          <text x={400} y={24} fill="var(--faint)" fontSize="10" letterSpacing="0.08em">
            HYPOTHESIS STACK (置信度 · 支撑/反证 · 级联依赖)
          </text>
          <text x={780} y={24} fill="var(--faint)" fontSize="10" letterSpacing="0.08em">
            ARBITRATOR & GLM AUDIT GATE
          </text>

          {/* Support & Contradiction Bezier Edges: ev -> hyp */}
          {hypSlice.map((h) => {
            const hp = hypPos.get(h.id)
            if (!hp) return null
            const supEdges = (h.supporting ?? []).map((evId) => {
              const ep = evPos.get(evId)
              if (!ep) return null
              const hi =
                (selected?.kind === 'hyp' && selected.id === h.id) ||
                (selected?.kind === 'ev' && selected.id === evId)
              return (
                <path
                  key={`sup-${evId}-${h.id}`}
                  d={`M ${ep.x + 250} ${ep.y + 18} C ${ep.x + 320} ${ep.y + 18}, ${hp.x - 70} ${hp.y + 24}, ${hp.x} ${hp.y + 24}`}
                  fill="none"
                  stroke="var(--ok)"
                  strokeWidth={hi ? 2.2 : 1.3}
                  strokeOpacity={hi ? 1 : 0.72}
                  markerEnd="url(#dag-sup)"
                />
              )
            })
            const conEdges = (h.contradicting ?? []).map((evId) => {
              const ep = evPos.get(evId)
              if (!ep) return null
              return (
                <path
                  key={`con-${evId}-${h.id}`}
                  d={`M ${ep.x + 250} ${ep.y + 18} C ${ep.x + 320} ${ep.y + 18}, ${hp.x - 70} ${hp.y + 32}, ${hp.x} ${hp.y + 32}`}
                  fill="none"
                  stroke="var(--err)"
                  strokeWidth={1.8}
                  strokeDasharray="5 3"
                  markerEnd="url(#dag-con)"
                />
              )
            })
            const depEdges = (h.dependsOn ?? []).map((parentId) => {
              const pp = hypPos.get(parentId)
              if (!pp) return null
              const midY = Math.round((pp.y + 54 + hp.y) / 2) + 3
              return (
                <g key={`dep-${parentId}-${h.id}`}>
                  <path
                    d={`M ${pp.x + 135} ${pp.y + 54} L ${hp.x + 135} ${hp.y}`}
                    fill="none"
                    stroke="var(--violet)"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    markerEnd="url(#dag-dep)"
                  />
                  <text x={pp.x + 142} y={midY} fill="var(--violet)" fontSize="8.5">
                    dependsOn
                  </text>
                </g>
              )
            })
            return (
              <g key={`edges-${h.id}`}>
                {supEdges}
                {conEdges}
                {depEdges}
              </g>
            )
          })}

          {/* Hypothesis -> Gate edges */}
          {hypSlice.map((h) => {
            const hp = hypPos.get(h.id)
            if (!hp) return null
            const color =
              h.status === 'rejected'
                ? 'var(--err)'
                : h.status === 'reevaluate'
                  ? 'var(--warn)'
                  : h.status === 'revised'
                    ? 'var(--violet)'
                    : 'var(--accent)'
            return (
              <path
                key={`gate-${h.id}`}
                d={`M ${hp.x + 270} ${hp.y + 26} C ${hp.x + 325} ${hp.y + 26}, ${gatePos.x - 55} ${gatePos.y + 65}, ${gatePos.x} ${gatePos.y + 65}`}
                fill="none"
                stroke={color}
                strokeWidth="1.2"
                strokeOpacity="0.65"
                strokeDasharray={h.status === 'rejected' ? '4 4' : undefined}
              />
            )
          })}

          {/* Evidence Nodes */}
          {evSlice.map((ev) => {
            const p = evPos.get(ev.id)!
            const isSel = selected?.kind === 'ev' && selected.id === ev.id
            const tone = ev.isError
              ? 'var(--err)'
              : ev.kind === 'audit_finding'
                ? 'var(--violet)'
                : ev.kind === 'verification_result'
                  ? 'var(--ok)'
                  : ev.view === 'dynamic'
                    ? 'var(--warn)'
                    : 'var(--accent)'
            const tag = ev.isError
              ? 'ERR'
              : ev.kind === 'audit_finding'
                ? 'AUD'
                : ev.kind === 'verification_result'
                  ? 'VER'
                  : (ev.view || 'STA').slice(0, 3).toUpperCase()
            return (
              <g
                key={ev.id}
                style={{ cursor: 'pointer' }}
                onClick={() => onSelect(isSel ? null : { kind: 'ev', id: ev.id })}
              >
                <rect
                  x={p.x}
                  y={p.y}
                  width={250}
                  height={36}
                  rx={3}
                  fill={isSel ? 'var(--surface-2)' : 'var(--surface-1)'}
                  stroke={isSel ? tone : 'var(--rule)'}
                  strokeWidth={isSel ? 1.8 : 1}
                />
                <text x={p.x + 8} y={p.y + 15} fill={tone} fontSize="10" fontWeight="700">
                  {ev.id} · {tag}
                </text>
                <text x={p.x + 84} y={p.y + 15} fill="var(--muted)" fontSize="10">
                  {ev.source.slice(0, 22)}
                </text>
                <text x={p.x + 8} y={p.y + 29} fill="var(--faint)" fontSize="9.5">
                  {(ev.summary || ev.excerpt).replace(/\s+/g, ' ').slice(0, 34)}
                </text>
              </g>
            )
          })}

          {/* Hypothesis Nodes */}
          {hypSlice.map((h) => {
            const p = hypPos.get(h.id)!
            const isSel = selected?.kind === 'hyp' && selected.id === h.id
            const tone =
              h.status === 'rejected'
                ? 'var(--err)'
                : h.status === 'reevaluate'
                  ? 'var(--warn)'
                  : h.status === 'revised'
                    ? 'var(--violet)'
                    : 'var(--accent)'
            const pct = Math.round(h.confidence * 100)
            return (
              <g
                key={h.id}
                style={{ cursor: 'pointer' }}
                onClick={() => onSelect(isSel ? null : { kind: 'hyp', id: h.id })}
              >
                <rect
                  x={p.x}
                  y={p.y}
                  width={270}
                  height={54}
                  rx={3}
                  fill={isSel ? 'var(--surface-2)' : 'var(--surface-1)'}
                  stroke={tone}
                  strokeWidth={isSel ? 2 : 1.2}
                />
                <text x={p.x + 8} y={p.y + 16} fill={tone} fontSize="10.5" fontWeight="700">
                  {h.id} [{h.status.toUpperCase()}]
                </text>
                <text x={p.x + 262} y={p.y + 16} fill="var(--text)" fontSize="10" textAnchor="end">
                  {pct}%
                </text>
                {/* Confidence bar */}
                <rect x={p.x + 8} y={p.y + 22} width={254} height={4} fill="var(--rule)" />
                <rect x={p.x + 8} y={p.y + 22} width={Math.max(4, Math.round(2.54 * pct))} height={4} fill={tone} />
                <text x={p.x + 8} y={p.y + 42} fill="var(--text)" fontSize="10">
                  {h.claim.slice(0, 30)}{h.claim.length > 30 ? '…' : ''}
                </text>
              </g>
            )
          })}

          {/* Right Verdict & Gate Box */}
          <g>
            <rect
              x={gatePos.x}
              y={gatePos.y}
              width={216}
              height={146}
              rx={3}
              fill="var(--surface-1)"
              stroke="var(--violet)"
              strokeWidth="1.4"
            />
            <text x={gatePos.x + 10} y={gatePos.y + 18} fill="var(--violet)" fontSize="10.5" fontWeight="700">
              AUDIT & DELIVERY VERDICT
            </text>
            <text x={gatePos.x + 10} y={gatePos.y + 38} fill="var(--text)" fontSize="10">
              Auditor Seat: {auditorName}
            </text>
            <text x={gatePos.x + 10} y={gatePos.y + 56} fill="var(--accent)" fontSize="10">
              RE Phase: {rePhase}
            </text>
            <text x={gatePos.x + 10} y={gatePos.y + 74} fill="var(--muted)" fontSize="10">
              Arbitrator Findings: {findings.length}
            </text>
            <text
              x={gatePos.x + 10}
              y={gatePos.y + 94}
              fill={evidence.some((e) => e.kind === 'verification_result') ? 'var(--ok)' : 'var(--faint)'}
              fontSize="10"
            >
              {evidence.some((e) => e.kind === 'verification_result') ? '✓ verify_artifact 已通过' : '○ 待执行 verify_artifact'}
            </text>
            <text
              x={gatePos.x + 10}
              y={gatePos.y + 112}
              fill={evidence.some((e) => e.kind === 'audit_finding') ? 'var(--ok)' : 'var(--faint)'}
              fontSize="10"
            >
              {evidence.some((e) => e.kind === 'audit_finding') ? `✓ ${auditorName} 对抗审计已签发` : `○ 待运行 /audit (${auditorName})`}
            </text>
            {goal && (
              <text
                x={gatePos.x + 10}
                y={gatePos.y + 130}
                fill={goal.criteria.every((c) => c.pass) ? 'var(--ok)' : 'var(--warn)'}
                fontSize="10"
              >
                /goal 契约: {goal.criteria.filter((c) => c.pass).length}/{goal.criteria.length} 满足
              </text>
            )}
          </g>
          </svg>
        )}
      </ZoomableSvgViewport>

      {/* Legend + Clicked Entity Detail */}
      <div style={inspectorBoxStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)' }}>
          <span data-hint="实测证据正向支撑假设"><b style={{ color: 'var(--ok)' }}>━━▶</b> 支撑</span>
          <span data-hint="实测或仲裁反证挑战假设，触发置信度折半 (×0.5)"><b style={{ color: 'var(--err)' }}>╌╌▶</b> 反证 ×0.5</span>
          <span data-hint="父假设被修订或淘汰时，下游依赖子假设自动级联重审"><b style={{ color: 'var(--violet)' }}>┈┈▶</b> 依赖级联</span>
          <span
            className="re-hint-dot"
            style={{ marginLeft: 'auto' }}
            data-hint="点击图中任意 ev_NNN 或 H-NNN 节点即可展开原始实测摘录、校准状态与因果推导链"
          >
            ?
          </span>
        </div>

        {activeEv && (
          <div style={liveStripStyle}>
            <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--ok)', fontWeight: 700 }}>
                {activeEv.id} · {activeEv.source} ({activeEv.kind || 'tool_observation'} · {activeEv.view || 'static'})
              </span>
              {activeEv.sha256 && (
                <span style={{ color: 'var(--faint)', fontSize: 10 }} data-hint={`完整 SHA256: ${activeEv.sha256}`}>
                  sha256:{activeEv.sha256.slice(0, 12)}…
                </span>
              )}
              <span
                data-hint="所有证据均由宿主实跑工具或验证命令后自动哈希盖章入账，严格只追加不可修改"
                style={{ fontSize: 10, color: 'var(--faint)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xs)', padding: '0 5px' }}
              >
                🔒 IMMUTABLE
              </span>
              <button
                type="button"
                className="re-copy-chip"
                data-copied={copiedId === activeEv.id ? '1' : undefined}
                onClick={() => copyCite(activeEv.id, formatEvidenceCitation(activeEv))}
                data-hint={`复制取证引用：${formatEvidenceCitation(activeEv)}`}
                style={{ marginLeft: 'auto' }}
              >
                {copiedId === activeEv.id ? '✓ 已复制' : '⎘ 引用'}
              </button>
            </div>
            {activeEv.summary && <div style={{ color: 'var(--text)' }}>{activeEv.summary}</div>}
            <pre style={{ margin: '4px 0 0', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{activeEv.excerpt}</pre>
            {activeEvFindings.length > 0 && (
              <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: 'var(--warn)', fontSize: 10, fontWeight: 700 }}>⚖ 关联仲裁理由:</span>
                {activeEvFindings.map((f, i) => (
                  <div key={i} style={{ color: 'var(--muted)', fontSize: 10.5 }}>
                    [{f.rule} · {f.action || 'advisory'}] {f.hypothesisId}: {f.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeHyp && (
          <div style={liveStripStyle}>
            <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                {activeHyp.id} [{activeHyp.status}] · 置信度 {Math.round(activeHyp.confidence * 100)}%
              </span>
              {activeChain && (
                <>
                  <span className="re-verdict-badge" data-verdict={activeChain.verdict}>
                    {activeChain.verdict === 'ANTI_ANALYSIS' ? 'ANTI-ANALYSIS' : activeChain.verdict}
                  </span>
                  <span
                    className="re-calib-pill"
                    data-tone={activeChain.calibration.tone}
                    data-hint={activeChain.calibration.reason}
                  >
                    {activeChain.calibration.status}
                  </span>
                </>
              )}
              {activeHyp.experiments && activeHyp.experiments.length > 0 && (
                <span style={{ color: 'var(--ok)', fontSize: 10 }}>
                  🧪 {activeHyp.experiments.length} 项实验
                </span>
              )}
              <button
                type="button"
                className="re-copy-chip"
                data-copied={copiedId === activeHyp.id ? '1' : undefined}
                onClick={() => copyCite(activeHyp.id, formatHypothesisCitation(activeHyp))}
                data-hint={`复制假设引用：${formatHypothesisCitation(activeHyp)}`}
                style={{ marginLeft: 'auto' }}
              >
                {copiedId === activeHyp.id ? '✓ 已复制' : '⎘ 引用'}
              </button>
            </div>
            <div style={{ color: 'var(--text)', marginTop: 2 }}>{activeHyp.claim}</div>
            {activeChain && (
              <div className="re-chain" style={{ marginTop: 4 }}>
                <span className="re-chain-step" data-hit={activeChain.staticEvs.length > 0 ? 'static' : undefined}>
                  Static ({activeChain.staticEvs.length})
                </span>
                <span className="re-chain-arrow">→</span>
                <span
                  className="re-chain-step"
                  data-hit={
                    activeChain.contradictEvs.length > 0
                      ? 'conflict'
                      : activeChain.dynamicEvs.length > 0
                        ? '1'
                        : undefined
                  }
                >
                  Dynamic ({activeChain.dynamicEvs.length}{activeChain.contradictEvs.length > 0 ? `/✗${activeChain.contradictEvs.length}` : ''})
                </span>
                <span className="re-chain-arrow">→</span>
                <span className="re-chain-step" data-hit={activeChain.verifyEvs.length > 0 ? '1' : undefined}>
                  Oracle ({activeChain.verifyEvs.length})
                </span>
                <span className="re-chain-arrow">→</span>
                <span className="re-chain-step" data-hit={activeChain.auditEvs.length > 0 ? 'audit' : undefined}>
                  Audit ({activeChain.auditEvs.length})
                </span>
              </div>
            )}
            {activeHyp.note && <div style={{ color: 'var(--warn)', marginTop: 3 }}>原因/备注: {activeHyp.note}</div>}
            {activeArc && (
              <div
                className="re-causal-strip"
                data-tone={activeArc.tone === 'err' ? 'err' : activeArc.tone === 'ok' ? 'ok' : activeArc.tone === 'warn' ? 'warn' : undefined}
                style={{ marginTop: 5 }}
              >
                <div className="re-causal-row">
                  <span className="re-causal-k">提出依据</span>
                  <span>{activeArc.triggerClues}</span>
                </div>
                <div className="re-causal-row">
                  <span className="re-causal-k">检验结果</span>
                  <span>{activeArc.testAndObservation}</span>
                </div>
                <div className="re-causal-row">
                  <span className="re-causal-k">推导定论</span>
                  <span>{activeArc.deductionVerdict}</span>
                </div>
              </div>
            )}
            {activeHypFindings.length > 0 && (
              <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: 'var(--violet)', fontSize: 10, fontWeight: 700 }}>
                  ⚖ 仲裁与对抗审计理由 ({activeHypFindings.length}):
                </span>
                {activeHypFindings.map((f, i) => (
                  <div key={i} style={{ color: f.action === 'support' ? 'var(--ok)' : 'var(--warn)', fontSize: 10.5 }}>
                    [{f.rule} · {f.action || 'advisory'}{f.applied ? ' · applied' : ''}]
                    {f.evidenceId ? ` ← ${f.evidenceId}` : ''}: {f.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- styles ----------

function modeTabStyle(active: boolean, tone: 'accent' | 'violet' | 'ok'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-xs)',
    background: active ? `color-mix(in srgb, var(--${tone}) 13%, transparent)` : 'transparent',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    padding: '3px 10px',
    cursor: 'pointer',
  }
}

const replayBarStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--violet) 32%, var(--border-subtle))',
  borderRadius: 'var(--radius-sm)',
  background: 'color-mix(in srgb, var(--surface-2) 68%, transparent)',
  padding: '6px 9px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const replayBtnStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-1) 90%, transparent)',
  color: 'var(--text)',
  fontSize: 10.5,
  padding: '2px 7px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const replayThoughtBoxStyle: CSSProperties = {
  borderTop: '1px dashed var(--border-subtle)',
  paddingTop: 5,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

const summaryBannerStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--ok) 35%, var(--border-subtle))',
  borderLeft: '3px solid var(--ok)',
  borderRadius: 'var(--radius-sm)',
  background: 'color-mix(in srgb, var(--ok) 4%, var(--surface-1))',
  padding: '8px 11px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

function seatBadgeStyle(tone: 'accent' | 'ok' | 'violet', active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-xs)',
    background: active ? `color-mix(in srgb, var(--${tone}) 14%, transparent)` : 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
    color: `var(--${tone})`,
    padding: '1px 7px',
    cursor: 'default',
  }
}

const inspectorBoxStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'color-mix(in srgb, var(--surface-1) 86%, transparent)',
  padding: '9px 11px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const liveStripStyle: CSSProperties = {
  marginTop: 4,
  paddingTop: 7,
  borderTop: '1px dashed var(--border-subtle)',
  fontSize: 11,
  lineHeight: 1.55,
}

const liveCardStyle: CSSProperties = {
  borderLeft: '2px solid var(--accent-dim)',
  borderRadius: '0 var(--radius-xs) var(--radius-xs) 0',
  background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
  padding: '7px 10px',
  fontSize: 10.5,
  lineHeight: 1.5,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}
