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
import type { EvidenceRecord, FindingDTO, Hypothesis, TickDTO } from '../../lib/types'
import { PanelBox } from '../crt'
import {
  buildReplayFrames,
  synthesizeProcessSummary,
  type ReplayFrame,
} from './cognitiveSynthesis'
import { WriteupStudioPanel } from './WriteupStudioPanel'
import { ZoomableSvgViewport } from './ZoomableSvgViewport'
import type { WorkbenchTab } from './HypothesisWorkbenchDialog'

export type GraphViewMode = 'pipeline' | 'dag' | 'writeup'

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
    title: 'PLANNER · deepseek (任务建模与假设推演)',
    modulePath: 'internal/app/goal.go · internal/workflow/delegate.go',
    summary:
      '负责高层认知建模：将自然语言目标编译为可机器校验的 /goal JSON 契约，拆解 update_plan 步骤，并通过 hypothesis_create / hypothesis_update 维护显式假设栈。',
    rules: [
      '起草 /goal 契约时不填写文件哈希——目标 SHA256 与二进制格式由宿主强制实地计算注入，防止模型幻觉。',
      '委托模式（caveman/specialist）下仅持有只读规划工具，将重型静态/动态取证交由 codex 执行席位。',
      '每次请求自动由宿主在 System Prompt 尾部重注入最新 Hypothesis Stack 与 Evidence Digest，抵抗上下文压缩遗忘。',
    ],
  },
  executor: {
    id: 'executor',
    zone: 'ZONE I · 席位路由',
    title: 'EXECUTOR · codex (工具执行与动态重放)',
    modulePath: 'internal/tools/* · internal/providers/clitmux.go',
    summary:
      '驱动 34 个内置逆向工具（纯 Go ELF/PE/Mach-O/APK 解析、字节雕刻、熵扫描、Unicorn/r2/Ghidra 封装及 verify_artifact 重放校验），产出可溯源原始观测。',
    rules: [
      '所有外部命令（run_command / remote_exec / verify_artifact）执行前必须串行穿过 Gate 1 能力沙箱与 Gate 2 策略审批门。',
      '工具返回结果由宿主自动分配递增编号 ev_NNN，并在返回给模型的文本末尾加盖 [evidence ev_NNN saved] 水印。',
      '宿主自动按工具性质打标视角：磁盘解析归入 static，子进程运行与重放归入 dynamic。',
    ],
  },
  auditor: {
    id: 'auditor',
    zone: 'ZONE I · 席位路由',
    title: 'AUDITOR · glm (隔离上下文对抗审计 / Researcher)',
    modulePath: 'internal/core/auditor.go (AgentLoop.Audit)',
    summary:
      '担任独立第三席位（自动回避 Planner 与 Executor）：在零历史对话、零工具权限的纯净沙箱中重审「假设栈 + 证据账本」数据包，专门挑刺单视角臆断与过度外推。',
    rules: [
      '上下文完全隔离（Isolated: true, FreshSession: true, Tools: []），审计模型无法接触目标文件或顺着前文圆谎。',
      '输出严格受控判定行：AUDIT H-NNN CHALLENGE|SUPPORT ev_NNN <reason>，由宿主正则解析并直接作用于假设栈。',
      '审计通过后向账本签发正式 audit_finding 证据记录（基于摘要 FNV 哈希幂等去重），解锁最终 WRI [9/9] 阶段。',
    ],
  },
  sandbox: {
    id: 'sandbox',
    zone: 'ZONE II · 安全防线',
    title: 'GATE 1 · Task Capability Sandbox (任务能力沙箱)',
    modulePath: 'internal/security/capability.go (Sandbox.Authorize)',
    summary:
      '基于 /goal 契约激活的任务级硬边界（默认拒绝 deny-by-default）：管控 network（curl/ssh/remote_exec 等）与 device（adb/frida/hdc/idevice 等）两类高危能力轴。',
    rules: [
      '未授权能力直接同步拦截（不弹窗打扰），返回缺失能力名并提示由操作员显式执行 /cap network on 或 /cap device on <id>。',
      '每次授权判定均生成不可篡改的 ActionRecord（含时间戳、工具名、能力轴、命令 SHA256 前 16 位、granted/denied 决策与授权来源）。',
      '/goal clear 结束任务时立即吊销全部任务期临时能力，绝不跨任务泄漏权限。',
    ],
  },
  approval: {
    id: 'approval',
    zone: 'ZONE II · 安全防线',
    title: 'GATE 2 · Execution Policy & Approval Bridge (策略与人工审批)',
    modulePath: 'internal/security/policy.go · gui/approval.go',
    summary:
      '会话级安全兜底网：即使通过沙箱边界，仍对破坏性正则（rm -rf / dd / sudo）、敏感凭据路径（.ssh / .aws / .env / keychain）及写盘/执行风险分级拦截确认。',
    rules: [
      'GUI 将同步 Confirm 阻塞转为异步事件推送（kind=approval），生命周期切换至 awaiting_approval，工具协程挂起等待人工拍板。',
      '弹窗默认聚焦 deny 且 Esc 键映射为 deny，防止误触回车放行高危命令。',
      '支持 allow / allow-always / deny / deny-always 四态决策，always 策略仅写入当前会话克隆副本，跨会话严格隔离。',
    ],
  },
  ledger: {
    id: 'ledger',
    zone: 'ZONE III · 元认知核心',
    title: 'EVIDENCE LEDGER · 证据账本 (evidence-ledger.jsonl)',
    modulePath: 'internal/evidence/ledger.go · internal/core/metacog.go',
    summary:
      '独立于对话历史的只追加（append-only）事实底座：每条非宿主状态工具输出均落盘为 ev_NNN，记录来源工具、static/dynamic 视角、SHA256、字节数与 400 字关键摘录。',
    rules: [
      '双路持久化：一面写入磁盘 evidence-ledger.jsonl（/new 重置内存也不擦除磁盘归档），一面镜像至会话 JSONL 供 Resume 无损水合。',
      '区分四大门禁类别：tool_observation（静态观测）、runtime_trace（动态运行）、verification_result（含 passed/total 统计）、audit_finding（审计结论）。',
      '所有假设引用与交付门禁仅认账本中真实存在的 ev_NNN 编号，口头声称一律无效。',
    ],
  },
  hypotheses: {
    id: 'hypotheses',
    zone: 'ZONE III · 元认知核心',
    title: 'HYPOTHESIS STACK · 假设依赖栈 (H-001..H-064)',
    modulePath: 'internal/hypothesis/tracker.go',
    summary:
      '显式可证伪推理栈：每条假设携带置信度（0..1）、supporting 支撑证据集、contradicting 反证集及 dependsOn 父假设依赖链，状态迁移由宿主数学规则强制执行。',
    rules: [
      '反证折半定律（Confidence Halving）：每收到一条新反证 Challenge(H, ev)，置信度强制折半 c ← c × 0.5；低于 0.25 自动降级为 reevaluate。',
      '依赖级联定律（Dependency Cascade）：当父假设被 Revise 或 Reject 时，所有 dependsOn 指向它的下游子假设自动级联标记为 reevaluate（待重审）。',
      '幂等保护：同一对 (H-NNN, ev_NNN) 反证最多生效一次，重放或重复审计不会重复扣减置信度。',
    ],
  },
  arbitrator: {
    id: 'arbitrator',
    zone: 'ZONE IV · 仲裁与门禁',
    title: 'HOST ARBITRATOR · 宿主确定性证据仲裁器',
    modulePath: 'internal/verify/arbitrator.go (Arbitrator.Review)',
    summary:
      '不依赖大模型的纯代码确定性巡检器：在证据账本与假设栈之间执行四条硬规则交叉比对，发现矛盾立即自动注入反证并触发置信度折半与级联重审。',
    rules: [
      '规则 1 [dangling-citation]：假设引用了账本中不存在的 ev_NNN → 自动合成审计反证并触发 Challenge。',
      '规则 2 [error-support]：假设将 isError=true 的报错记录列为支撑证据 → 自动转为 Challenge 降权。',
      '规则 3 [runtime-contradiction]：dynamic 动态运行报错摘录命中静态假设的核心主语标识符（sub_* / 0x* / 符号名）→ 跨视角自动 Challenge。',
      '规则 4 [single-view]：置信度 ≥ 0.80 却仅靠单一视角（纯 static 或纯 dynamic），且另一视角存在同主语未关联证据 → 发出单视角盲区告警。',
    ],
  },
  gate: {
    id: 'gate',
    zone: 'ZONE IV · 仲裁与门禁',
    title: 'PHASE & GOAL GATE · 9阶段与验收硬门禁',
    modulePath: 'internal/workflow/phase.go · internal/goal/declaration.go',
    summary:
      '阻止 Agent「半途编造总结报告」的终极机械闸门：跳阶段（skip_to）必须逐级通过全部前置阶段门禁，且进入 WRI [9/9] 前必须同时满足审计凭证与 /goal 验收指标。',
    rules: [
      'STA 门禁：tool_observation ≥ 1 · DYN 门禁：活跃假设 H ≥ 1 · VER 门禁：runtime_trace ≥ 1 或静态观测 ≥ 3。',
      'AUD 门禁：verification_result ≥ 1（必须跑过 verify_artifact 重放校验）。',
      'WRI 终极门禁：audit_finding ≥ 1（完成仲裁/GLM 对抗审计）且 /goal 声明中的所有指标（build_pass / replay_pass / differential_cases / evidence_count）100% 达标。',
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

  const ledger = effectiveTick?.ledger
  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []
  const sandbox = ledger?.sandbox
  const goal = ledger?.goal
  const route = effectiveTick?.hud.route
  const flow = effectiveTick?.flow
  const re = effectiveTick?.re

  const plannerName = route?.planner || 'deepseek'
  const executorName = route?.executor || 'codex'
  const auditorName = ledger?.auditorProvider || route?.auditor || route?.researcher || 'glm'
  const activeProvider = flow?.provider || route?.active || ''
  const busy = activeFrame
    ? true
    : Boolean(flow && flow.stage !== 'idle' && flow.stage !== 'done' && flow.stage !== 'error')

  const stats = useMemo(() => {
    const staticCnt = evidence.filter((e) => (e.view || 'static') === 'static' && !e.isError).length
    const dynCnt = evidence.filter((e) => e.view === 'dynamic' && !e.isError).length
    const verCnt = evidence.filter((e) => e.kind === 'verification_result').length
    const audCnt = evidence.filter((e) => e.kind === 'audit_finding').length
    const errCnt = evidence.filter((e) => e.isError).length

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
      audCnt,
      errCnt,
      activeH,
      revisedH,
      reevalH,
      rejectedH,
      goalPass,
      goalTotal,
    }
  }, [evidence, hypotheses, goal])

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
      title="governance & provenance graph — 假设 · 证据 · 审核 · 安全 · Writeup 闭环"
      accent={mode === 'writeup' ? 'ok' : mode === 'dag' ? 'violet' : 'accent'}
      tier="spotlight"
      badge="◈ 焦点中枢"
      collapsible={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {/* Sub-header mode switch + seat legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setMode('pipeline')}
            style={modeTabStyle(mode === 'pipeline', 'accent')}
          >
            ◈ 机制协同架构图
          </button>
          <button
            type="button"
            onClick={() => setMode('dag')}
            style={modeTabStyle(mode === 'dag', 'violet')}
          >
            ☍ 实时因果证据图谱 (ev:{evidence.length} ↔ H:{hypotheses.length})
          </button>
          <button
            type="button"
            onClick={() => setMode('writeup')}
            style={modeTabStyle(mode === 'writeup', 'ok')}
          >
            ✎ 过程总结与 Writeup 工坊
          </button>

          {onOpenWorkbench && (
            <button
              type="button"
              onClick={() => onOpenWorkbench('hypothesis')}
              title="新增/编辑假设、挂载并实跑实验、执行 verify_artifact 验证或签发审查结论（证据账本严格只追加不可手改）"
              style={{
                border: '1px solid var(--accent)',
                background: 'rgba(34, 211, 238, 0.1)',
                color: 'var(--accent)',
                fontSize: 11,
                padding: '3px 10px',
                cursor: 'pointer',
              }}
            >
              🧪 假设实验与验证台
            </button>
          )}

          <span style={{ flex: 1 }} />

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5 }}>
            <span style={seatBadgeStyle('accent', activeProvider === plannerName && Boolean(busy))}>
              Planner: <b>{plannerName}</b>
            </span>
            <span style={seatBadgeStyle('ok', activeProvider === executorName && Boolean(busy))}>
              Executor: <b>{executorName}</b>
            </span>
            <span style={seatBadgeStyle('violet', activeProvider === auditorName && Boolean(busy))}>
              Auditor: <b>{auditorName}</b>
            </span>
          </div>
        </div>

        {/* Cognitive Replay Scrubber (available in both Pipeline & DAG views whenever frames exist) */}
        {mode !== 'writeup' && replayFrames.length > 0 && (
          <div style={replayBarStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={startOrToggleReplay}
                style={{
                  ...replayBtnStyle,
                  borderColor: playing ? 'var(--warn)' : 'var(--accent)',
                  color: playing ? 'var(--warn)' : 'var(--accent)',
                  background: playing ? 'rgba(251, 191, 36, 0.1)' : 'rgba(34, 211, 238, 0.1)',
                }}
              >
                {playing ? '⏸ 暂停回放' : '▶ 回放思考过程'}
              </button>
              <button
                type="button"
                onClick={() => jumpReplayFrame(0)}
                title="跳至第 1 帧"
                style={replayBtnStyle}
              >
                ⏮
              </button>
              <button
                type="button"
                onClick={() => jumpReplayFrame((replayIdx ?? replayFrames.length - 1) - 1)}
                title="上一演化帧"
                style={replayBtnStyle}
              >
                ◀
              </button>
              <button
                type="button"
                onClick={() => jumpReplayFrame((replayIdx ?? -1) + 1)}
                title="下一演化帧"
                style={replayBtnStyle}
              >
                ▶
              </button>
              <button
                type="button"
                onClick={() => setFastReplay((v) => !v)}
                title="切换回放倍速"
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
                      title={`${fr.stageTag} — ${fr.title}`}
                      style={{
                        ...replayBtnStyle,
                        borderColor: cur ? `var(--${fr.actorTone})` : 'var(--rule)',
                        color: cur ? `var(--${fr.actorTone})` : 'var(--muted)',
                        background: cur ? 'rgba(15, 23, 42, 0.9)' : 'transparent',
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
                  style={{ ...replayBtnStyle, borderColor: 'var(--ok)', color: 'var(--ok)' }}
                >
                  ● 回到实时 (LIVE)
                </button>
              ) : (
                <span style={{ color: 'var(--ok)', fontSize: 10 }}>
                  ● LIVE ({replayFrames.length} 个演化节点可回放)
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
                <div style={{ color: 'var(--text)', fontSize: 11, lineHeight: 1.45 }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>💭 思考与决策回放：</span>
                  {activeFrame.thought}
                </div>
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
              title="机制协同架构图 (deepseek · codex · glm)"
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

                {/* Zone Swimlane Headers */}
                {[
                  { x: 14, w: 224, label: 'I. 三模型职责席位 (ROLES)' },
                  { x: 266, w: 236, label: 'II. 双层安全防线 (SECURITY)' },
                  { x: 530, w: 244, label: 'III. 证据与假设双核 (METACOG)' },
                  { x: 802, w: 224, label: 'IV. 仲裁审核与门禁 (AUDIT & GATE)' },
                ].map((z) => (
                  <g key={z.label}>
                    <rect
                      x={z.x}
                      y={8}
                      width={z.w}
                      height={402}
                      fill="rgba(5, 8, 12, 0.35)"
                      stroke="var(--rule)"
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
                  x: 26,
                  y: 42,
                  w: 200,
                  h: 82,
                  tone: 'accent',
                  selected: selectedNode === 'planner',
                  hot: activeProvider === plannerName && Boolean(busy),
                  title: `PLANNER · ${plannerName}`,
                  line1: seatSubtitle(plannerName, '推理规划席'),
                  line2: `/goal 契约 · 计划 · 假设栈`,
                  badge: activeProvider === plannerName && busy ? '● RUNNING' : 'SEAT 1',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'executor',
                  x: 26,
                  y: 162,
                  w: 200,
                  h: 86,
                  tone: 'ok',
                  selected: selectedNode === 'executor',
                  hot: activeProvider === executorName && Boolean(busy),
                  title: `EXECUTOR · ${executorName}`,
                  line1: seatSubtitle(executorName, '工具执行席'),
                  line2: `34 逆向工具 · ✓${flow?.toolsOk ?? 0} ✗${flow?.toolsFailed ?? 0}`,
                  badge: flow?.activeTool ? `⚙ ${flow.activeTool}` : 'SEAT 2',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'auditor',
                  x: 26,
                  y: 288,
                  w: 200,
                  h: 90,
                  tone: 'violet',
                  selected: selectedNode === 'auditor',
                  hot: stats.audCnt > 0 || (activeProvider === auditorName && Boolean(busy)),
                  title: `AUDITOR · ${auditorName}`,
                  line1: seatSubtitle(auditorName, '独立对抗审计席'),
                  line2: '零对话 · 零工具 · 专挑盲区',
                  badge: stats.audCnt > 0 ? `✓ AUD:${stats.audCnt}` : 'ISOLATED',
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
                  line1: sandbox?.active ? '● ACTIVE (deny-by-default)' : '○ 未激活 (走基础策略)',
                  line2: `network / device · SHA256留痕`,
                  line3: `放行:${sandbox?.grantedCount ?? 0} · 拦截:${sandbox?.deniedCount ?? 0}`,
                  badge: '/cap',
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
                  line1: 'evidence-ledger.jsonl (只追加)',
                  line2: `static:${stats.staticCnt} · dynamic:${stats.dynCnt}`,
                  line3: `VER:${stats.verCnt} · AUD:${stats.audCnt} · ERR:${stats.errCnt}`,
                  badge: `E:${evidence.length}`,
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
                  line1: '显式可证伪假设与依赖图',
                  line2: `active:${stats.activeH} · revised:${stats.revisedH}`,
                  line3: `reeval:${stats.reevalH} · rejected:${stats.rejectedH}`,
                  badge: `H:${hypotheses.length}`,
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'arbitrator',
                  x: 814,
                  y: 66,
                  w: 200,
                  h: 108,
                  tone: findings.length > 0 ? 'warn' : 'muted',
                  selected: selectedNode === 'arbitrator',
                  hot: findings.length > 0,
                  title: 'HOST ARBITRATOR',
                  line1: '宿主 4 规则确定性交叉仲裁',
                  line2: '悬空引用 · 报错支撑 · 动静矛盾',
                  line3: `单视角盲区 · 已捕获:${findings.length}`,
                  badge: 'VERIFY',
                  onSelect: setSelectedNode,
                })}

                {renderSvgNode({
                  id: 'gate',
                  x: 814,
                  y: 238,
                  w: 200,
                  h: 114,
                  tone: re?.phase === 'writeup' ? 'ok' : 'accent',
                  selected: selectedNode === 'gate',
                  hot: re?.phase === 'writeup',
                  title: 'DELIVERY GATE',
                  line1: re
                    ? `RE 阶段: ${re.phase.toUpperCase()} [${re.phaseIndex + 1}/${re.phaseCount}]`
                    : 'RE 阶段: 未开启 (/workflow reverse)',
                  line2:
                    stats.goalTotal > 0
                      ? `/goal 验收: ${stats.goalPass}/${stats.goalTotal} 达标`
                      : '/goal 验收: 未声明契约',
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

        {/* Structured Executive Process Summary Strip (visible in Pipeline & DAG modes once analysis begins) */}
        {mode !== 'writeup' && (evidence.length > 0 || hypotheses.length > 0) && (
          <div style={summaryBannerStyle}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
                <span style={{ color: 'var(--ok)', fontWeight: 700 }}>✦ 逆向过程总结：</span>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{processSummary.headline}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 5 }}>
                {processSummary.pillars.map((p) => (
                  <div
                    key={p.key}
                    style={{
                      border: `1px solid color-mix(in srgb, var(--${p.tone}) 40%, var(--rule))`,
                      borderLeft: `2px solid var(--${p.tone})`,
                      background: 'rgba(3, 6, 10, 0.65)',
                      padding: '3px 7px',
                      fontSize: 10,
                      lineHeight: 1.35,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                      <b style={{ color: `var(--${p.tone})` }}>{p.label}</b>
                      <span style={{ color: 'var(--faint)', fontSize: 9 }}>{p.refs}</span>
                    </div>
                    <div style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.value}>
                      {p.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMode('writeup')}
              style={{
                ...replayBtnStyle,
                borderColor: 'var(--ok)',
                color: 'var(--ok)',
                background: 'rgba(74, 222, 128, 0.12)',
                flexShrink: 0,
                alignSelf: 'center',
              }}
            >
              ✎ 生成 Writeup 报告 →
            </button>
          </div>
        )}
      </div>
    </PanelBox>
  )
}

// ---------- SVG Node Helper ----------

function seatSubtitle(provider: string, roleLabel: string): string {
  const p = provider.toLowerCase()
  if (p.includes('deepseek')) return `deepseek-chat (${roleLabel})`
  if (p.includes('codex')) return `gpt-5.3-codex (${roleLabel})`
  if (p.includes('glm')) return `glm-4.6 (${roleLabel})`
  if (p.includes('opus')) return `claude-opus-4-6 (${roleLabel})`
  if (p.includes('sonnet')) return `claude-sonnet-4-5 (${roleLabel})`
  return `${provider} (${roleLabel})`
}

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
        fill={opts.selected ? 'rgba(16, 28, 42, 0.92)' : 'rgba(8, 14, 22, 0.88)'}
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
      <text x={opts.x + 8} y={opts.y + 40} fill="var(--text)" fontSize="10.5">
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
    const allActs = ctx.sandbox?.recentActions ?? []
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
              [{a.decision.toUpperCase()}] {a.tool} {a.capability ? `cap=${a.capability}` : ''} · sha256:{a.sha256.slice(0, 10)} ({a.subject.slice(0, 30)})
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
                  fill={isSel ? 'rgba(18, 32, 48, 0.95)' : 'rgba(8, 14, 22, 0.9)'}
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
                  fill={isSel ? 'rgba(18, 32, 48, 0.95)' : 'rgba(8, 14, 22, 0.9)'}
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
              fill="rgba(8, 14, 22, 0.92)"
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
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)' }}>
          <span><b style={{ color: 'var(--ok)' }}>━━▶</b> 支撑引用 (supporting)</span>
          <span><b style={{ color: 'var(--err)' }}>╌╌▶</b> 反证挑战 (contradicting · 置信度×0.5)</span>
          <span><b style={{ color: 'var(--violet)' }}>┈┈▶</b> 假设依赖 (dependsOn · 级联 reevaluate)</span>
          <span style={{ marginLeft: 'auto', color: 'var(--faint)' }}>点击图中任意 ev_NNN 或 H-NNN 节点查看原始详情</span>
        </div>

        {activeEv && (
          <div style={liveStripStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--ok)', fontWeight: 700 }}>
                {activeEv.id} · {activeEv.source} ({activeEv.kind || 'tool_observation'} · {activeEv.view || 'static'})
              </span>
              <span style={{ fontSize: 10, color: 'var(--faint)', border: '1px solid var(--rule)', padding: '0 5px' }}>
                🔒 IMMUTABLE · 实跑产物入账（禁止人工修改或删除）
              </span>
            </div>
            {activeEv.summary && <div style={{ color: 'var(--text)' }}>{activeEv.summary}</div>}
            <pre style={{ margin: '4px 0 0', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{activeEv.excerpt}</pre>
          </div>
        )}

        {activeHyp && (
          <div style={liveStripStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                {activeHyp.id} [{activeHyp.status}] · 置信度 {Math.round(activeHyp.confidence * 100)}%
              </span>
              {activeHyp.experiments && activeHyp.experiments.length > 0 && (
                <span style={{ color: 'var(--ok)', fontSize: 10 }}>
                  🧪 已挂实验: {activeHyp.experiments.length} 项
                </span>
              )}
            </div>
            <div style={{ color: 'var(--text)' }}>{activeHyp.claim}</div>
            {activeHyp.note && <div style={{ color: 'var(--warn)' }}>原因/备注: {activeHyp.note}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- styles ----------

function modeTabStyle(active: boolean, tone: 'accent' | 'violet' | 'ok'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--rule)'}`,
    background: active ? `color-mix(in srgb, var(--${tone}) 14%, transparent)` : 'transparent',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 11,
    padding: '3px 10px',
    cursor: 'pointer',
  }
}

const replayBarStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--violet) 38%, var(--rule))',
  background: 'rgba(6, 10, 18, 0.72)',
  padding: '5px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
}

const replayBtnStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(8, 14, 22, 0.85)',
  color: 'var(--text)',
  fontSize: 10.5,
  padding: '1px 7px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const replayThoughtBoxStyle: CSSProperties = {
  borderTop: '1px dashed var(--rule)',
  paddingTop: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const summaryBannerStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--accent) 40%, var(--rule))',
  background: 'rgba(5, 12, 20, 0.72)',
  padding: '6px 10px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

function seatBadgeStyle(tone: 'accent' | 'ok' | 'violet', active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--rule)'}`,
    background: active ? `color-mix(in srgb, var(--${tone}) 15%, transparent)` : 'rgba(5, 8, 12, 0.45)',
    color: `var(--${tone})`,
    padding: '1px 7px',
  }
}

const inspectorBoxStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(5, 8, 12, 0.5)',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
}

const liveStripStyle: CSSProperties = {
  marginTop: 4,
  paddingTop: 6,
  borderTop: '1px dashed var(--rule)',
  fontSize: 11,
  lineHeight: 1.5,
}

const liveCardStyle: CSSProperties = {
  borderLeft: '2px solid var(--accent-dim)',
  background: 'rgba(3, 6, 10, 0.55)',
  padding: '6px 10px',
  fontSize: 10.5,
  lineHeight: 1.48,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}
