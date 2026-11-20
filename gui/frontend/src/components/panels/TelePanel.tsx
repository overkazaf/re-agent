// TELE — telemetry row: output sparkline, the four token counters (k/M
// compact), cost, elapsed clock, the compaction badge and the
// planner/executor route. Pure render over HudDTO + FlowDTO (TUI reference:
// internal/ui/hud.go telemetryLine / counterChips).
import { PanelBox, Sparkline } from '../crt'
import type { FlowDTO, HudDTO } from '../../lib/types'
import { compactNumber, fmtClock, fmtCost } from './format'

export function TelePanel({ hud, flow }: { hud: HudDTO; flow: FlowDTO }) {
  const stats = hud.stats
  const counters: Array<[label: string, value: number, tone: string]> = [
    ['in', stats.input, 'text'],
    ['think', stats.thinking, 'violet'],
    ['cache', stats.cacheRead, 'ok'],
    ['out', stats.output, 'accent'],
  ]

  return (
    <PanelBox title="tele" tier="secondary">
      <div className="tele-rows">
        {/* output throughput */}
        <div className="tele-row">
          <span className="t-faint">out</span>
          <Sparkline data={hud.spark} h={14} />
          <span className="t-text">{compactNumber(stats.output)}</span>
          {hud.queueCount > 0 && (
            <span className="tele-chip t-muted" title="prompts queued while running">
              ⠿ {hud.queueCount}
            </span>
          )}
        </div>

        {/* counters · cost · clock · compaction */}
        <div className="tele-row">
          {counters.map(([label, value, tone]) => (
            <span key={label} className="tele-chip">
              <span className="t-faint">{label}</span> <span className={`t-${tone}`}>{compactNumber(value)}</span>
            </span>
          ))}
          <span className="tele-chip">
            <span className="t-faint">$</span> <span className="t-warn">{fmtCost(stats.costUsd)}</span>
          </span>
          <span className="tele-chip">
            <span className="t-faint">◷</span> <span className="t-ok">{fmtClock(hud.elapsedMs)}</span>
          </span>
          {flow.hasCompacted && (
            <span
              className="tele-chip t-warn"
              title={`context compacted: -${flow.compactedDrop} messages, ${flow.compactedElide} tool results elided`}
            >
              ⌢ -{flow.compactedDrop}
              {flow.compactedElide > 0 && <span className="t-faint"> · {flow.compactedElide} elided</span>}
            </span>
          )}
        </div>

        {/* route */}
        <div className="tele-row">
          {hud.route !== null ? (
            <>
              <span className="tele-chip">
                <span className="t-faint">planner</span> <span className="t-muted">{hud.route.planner}</span>
              </span>
              <span className="tele-chip">
                <span className="t-faint">executor</span> <span className="t-muted">{hud.route.executor}</span>
              </span>
              <span className="tele-chip t-accent">▸ {hud.route.active}</span>
            </>
          ) : (
            <span className="t-faint">route —</span>
          )}
          <span className="tele-chip t-faint">{hud.phase}</span>
        </div>
      </div>
    </PanelBox>
  )
}
