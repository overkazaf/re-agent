// FLOW — the live dataflow strip as DOM: planner⇉executor wires carrying
// packet particles (FlowDTO.packets[i] = per-wire cell offsets), the
// nine-stage badge rail, provider/model annotation, the active-tool line and
// the error glow. Pure render over FlowDTO; motion is CSS animation only
// (TUI reference: internal/ui/flow.go RenderFlow / phaseLabel).
import type { CSSProperties, ReactNode } from 'react'
import { PanelBox, Spinner } from '../crt'
import type { FlowDTO, FlowStage } from '../../lib/types'
import '../re/re-pro.css'
import { compactNumber, fmtDuration } from './format'

export const STAGES: readonly FlowStage[] = [
  'idle', 'send', 'wait', 'think', 'calls', 'tool', 'write', 'done', 'error',
]

const STAGE_TONE: Record<FlowStage, string> = {
  idle: 'faint',
  send: 'accent',
  wait: 'muted',
  think: 'violet',
  calls: 'violet',
  tool: 'warn',
  write: 'ok',
  done: 'ok',
  error: 'err',
}

const BOX_ACCENT: Partial<Record<FlowStage, 'accent' | 'violet' | 'ok' | 'warn' | 'err'>> = {
  think: 'violet',
  calls: 'violet',
  tool: 'warn',
  write: 'ok',
  done: 'ok',
  error: 'err',
}

const STAGE_HINT: Record<FlowStage, string> = {
  idle: '空闲就绪：等待输入逆向任务或斜杠命令',
  send: '发送上下文与提示词至规划/执行席模型',
  wait: '等待上游模型返回首字节响应 (TTFT)',
  think: '模型正在进行隐式链式推理 (Reasoning)',
  calls: '模型已产出结构化工具调用请求',
  tool: '宿主正在沙箱与策略门禁下执行逆向工具',
  write: '模型正在流式输出分析结论与报告',
  done: '本轮推理与取证闭环已完成',
  error: '请求或工具链路发生异常，可查看下方错误详情',
}

/** Seconds one packet takes to cross a wire; negative delays phase packets. */
const PACKET_PERIOD_S = 1.6

/**
 * One wire track. `offsets` is packets[i] — cell positions along the wire.
 * Each dot's inline `left` is its rest position (what reduced-motion shows),
 * and the negative animation-delay phases the loop so the dot starts there.
 */
function Wire({ offsets, left = false, tone }: { offsets: number[]; left?: boolean; tone: string }) {
  const len = Math.max(16, ...offsets, 4)
  return (
    <div className={left ? 'wire wire-left' : 'wire'} style={{ '--wire-tone': `var(--${tone})` } as CSSProperties}>
      {offsets.map((offset, i) => {
        const pct = Math.min(100, (offset / len) * 100)
        return (
          <span
            key={i}
            className="packet"
            style={{ left: `${pct}%`, animationDelay: `${(-pct / 100) * PACKET_PERIOD_S}s` }}
          />
        )
      })}
    </div>
  )
}

function Node({ label, on, tone = 'accent', hint }: { label: string; on: boolean; tone?: string; hint?: string }) {
  return (
    <span
      className="flow-node"
      data-hint={hint}
      style={{ color: on ? `var(--${tone})` : 'var(--faint)' }}
    >
      {label}
    </span>
  )
}

/** Right-edge phase readout, TUI phaseLabel parity. */
function phaseLabel(flow: FlowDTO): ReactNode {
  const d = fmtDuration(Math.max(0, Date.now() - flow.since))
  switch (flow.stage) {
    case 'send':
      return <>⇢ sending {d}</>
    case 'wait':
      return <><Spinner tone="muted" /> waiting {d}</>
    case 'think':
      return <><Spinner tone="violet" /> thinking {d}</>
    case 'calls':
      return <>⇠ {flow.pendingCalls} call{flow.pendingCalls === 1 ? '' : 's'}</>
    case 'tool':
      return <>⋯ awaiting tools</>
    case 'write':
      return <>✎ writing {d}</>
    case 'done':
      return <>✓ done</>
    case 'error':
      return <>✗ {flow.error !== '' ? flow.error : 'failed'}</>
    default:
      return null
  }
}

export function FlowPanel({ flow }: { flow: FlowDTO }) {
  // packets can arrive shorter than the 5 edges (idle sends one empty row).
  const pk = (i: number): number[] => (Array.isArray(flow.packets) ? flow.packets[i] ?? [] : [])
  const toolsRan = flow.toolsOk + flow.toolsFailed > 0
  const bottomOn = flow.stage === 'calls' || flow.stage === 'tool' || toolsRan
  const requestOn = flow.stage === 'send'
  const modelHot = flow.stage === 'send' || flow.stage === 'wait' || flow.stage === 'think'
    || flow.stage === 'write' || flow.stage === 'calls'
  const replyMode = flow.stage === 'write' || (flow.pendingCalls === 0 && flow.replyChars > 0)

  return (
    <PanelBox title="flow" accent={BOX_ACCENT[flow.stage] ?? 'accent'} tier="primary">
      <div className="flow-body">
        {/* stage rail + plan badge */}
        <div className="stage-rail">
          {STAGES.map(s => {
            const on = s === flow.stage
            const tone = STAGE_TONE[s]
            return (
              <span
                key={s}
                className={on ? 'stage-badge stage-on' : 'stage-badge'}
                data-hint={STAGE_HINT[s]}
                style={on ? { color: `var(--${tone})`, borderColor: `var(--${tone})` } : undefined}
              >
                {s}
              </span>
            )
          })}
          <span className="flow-spacer" />
          {flow.plan && (
            <span
              className="flow-plan"
              data-hint={`当前任务计划进度：已完成 ${flow.plan.done}/${flow.plan.total} 步 (${flow.plan.source || 'plan'})`}
            >
              ◈ <b>{flow.plan.done}/{flow.plan.total}</b> <i>{flow.plan.source}</i>
            </span>
          )}
        </div>

        {/* request path: you → ctx → model */}
        <div className="flow-row">
          <Node label="[you]" on={requestOn} hint="操作员输入与斜杠命令入口" />
          <Wire offsets={pk(0)} tone="accent" />
          <Node label="[ctx]" on={requestOn} hint="宿主上下文组装器：自动重注入最新假设栈与证据摘要" />
          <Wire offsets={pk(1)} tone="accent" />
          <span className="flow-model-wrap">
            {toolsRan && <span className="flow-backmark" data-hint="工具实测结果已回流模型">▲</span>}
            <Node
              label={`((${flow.provider}))`}
              on={modelHot}
              tone="violet"
              hint={`当前活跃席位：${flow.provider} · ${flow.model}${flow.endpoint ? ` (${flow.endpoint})` : ''}`}
            />
          </span>
          <span className="flow-phase">{phaseLabel(flow)}</span>
        </div>
        <div className="flow-sub re-mono-num">
          <span className="t-muted">
            {flow.model}
            {flow.turn > 0 && <span className="t-faint"> · T#{flow.turn}</span>}
            {flow.sentTokens > 0 && (
              <span
                className="t-faint"
                data-hint={`上下文发送 ${compactNumber(flow.sentTokens)} tokens · ${flow.messages} 条消息`}
              >
                {' '}· ctx {compactNumber(flow.sentTokens)}tok
              </span>
            )}
          </span>
          {flow.endpoint && (
            <span className="t-faint" data-hint={`上游接入点：${flow.endpoint}`}>
              {flow.endpoint}
            </span>
          )}
        </div>

        {/* tool path: tools ◀ calls (or the reply box once writing) */}
        {bottomOn && (
          <div className="flow-row flow-row2">
            <Node label="[tools]" on={flow.stage === 'tool'} tone="ok" hint="宿主内置逆向工具与沙箱执行层" />
            <Wire offsets={pk(3)} left tone="violet" />
            <Node
              label={replyMode ? `[reply ${compactNumber(flow.usage.output)}tok]` : `[calls×${Math.max(flow.pendingCalls, 1)}]`}
              on={flow.stage === 'calls' || flow.stage === 'tool'}
              tone="violet"
              hint={replyMode ? `已输出 ${flow.usage.output} tokens` : `待执行工具调用数：${Math.max(flow.pendingCalls, 1)}`}
            />
            <span className="flow-tool-line">
              {flow.activeTool !== '' && flow.stage === 'tool' && (
                <>
                  <Spinner tone="ok" />
                  <span className="glow-ok">{flow.activeTool}</span>
                  {/* toolMs lands on tool_end (FlowDTO has no live ToolStartedAt),
                      so a mid-flight tool reads "running" like the TUI does */}
                  <span>{flow.toolMs > 0 ? fmtDuration(flow.toolMs) : 'running'}</span>
                </>
              )}
              <span
                className="flow-tally"
                data-hint={`工具执行统计：成功 ${flow.toolsOk} 次 · 失败 ${flow.toolsFailed} 次`}
              >
                <span className="t-ok">✓{flow.toolsOk}</span>
                {flow.toolsFailed > 0 && <span className="t-err"> ✗{flow.toolsFailed}</span>}
              </span>
            </span>
          </div>
        )}

        {flow.stage === 'error' && flow.error !== '' && (
          <div className="flow-error">✗ {flow.error}</div>
        )}
      </div>
    </PanelBox>
  )
}
