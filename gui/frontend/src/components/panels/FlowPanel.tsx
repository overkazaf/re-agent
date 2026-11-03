// FLOW — the live dataflow strip as DOM: planner⇉executor wires carrying
// packet particles (FlowDTO.packets[i] = per-wire cell offsets), the
// nine-stage badge rail, provider/model annotation, the active-tool line and
// the error glow. Pure render over FlowDTO; motion is CSS animation only
// (TUI reference: internal/ui/flow.go RenderFlow / phaseLabel).
import type { CSSProperties, ReactNode } from 'react'
import { PanelBox, Spinner } from '../crt'
import type { FlowDTO, FlowStage } from '../../lib/types'
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

function Node({ label, on, tone = 'accent' }: { label: string; on: boolean; tone?: string }) {
  return <span className="flow-node" style={{ color: on ? `var(--${tone})` : 'var(--faint)' }}>{label}</span>
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
    <PanelBox title="flow" accent={BOX_ACCENT[flow.stage]}>
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
                style={on ? { color: `var(--${tone})`, borderColor: `var(--${tone})` } : undefined}
              >
                {s}
              </span>
            )
          })}
          <span className="flow-spacer" />
          {flow.plan && (
            <span className="flow-plan">
              ◈ <b>{flow.plan.done}/{flow.plan.total}</b> <i>{flow.plan.source}</i>
            </span>
          )}
        </div>

        {/* request path: you → ctx → model */}
        <div className="flow-row">
          <Node label="[you]" on={requestOn} />
          <Wire offsets={pk(0)} tone="accent" />
          <Node label="[ctx]" on={requestOn} />
          <Wire offsets={pk(1)} tone="accent" />
          <span className="flow-model-wrap">
            {toolsRan && <span className="flow-backmark">▲</span>}
            <Node label={`((${flow.provider}))`} on={modelHot} tone="violet" />
          </span>
          <span className="flow-phase">{phaseLabel(flow)}</span>
        </div>
        <div className="flow-sub">
          <span className="t-muted">{flow.model}</span>
          <span className="t-faint">{flow.endpoint}</span>
        </div>

        {/* tool path: tools ◀ calls (or the reply box once writing) */}
        {bottomOn && (
          <div className="flow-row flow-row2">
            <Node label="[tools]" on={flow.stage === 'tool'} tone="ok" />
            <Wire offsets={pk(3)} left tone="violet" />
            <Node
              label={replyMode ? `[reply ${compactNumber(flow.usage.output)}tok]` : `[calls×${Math.max(flow.pendingCalls, 1)}]`}
              on={flow.stage === 'calls' || flow.stage === 'tool'}
              tone="violet"
            />
            <span className="flow-tool-line">
              {flow.activeTool !== '' && flow.stage === 'tool' && (
                <>
                  <Spinner tone="ok" />
                  <span className="glow-ok">{flow.activeTool}</span>
                  <span>{fmtDuration(flow.toolMs)}</span>
                </>
              )}
              <span className="flow-tally">
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
