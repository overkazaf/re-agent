// TELE — telemetry row: output & tool-latency sparklines, tabular token
// counters (k/M compact), cache hit rate, cost, elapsed clock, compaction
// badge, and multi-seat route. Pure render over HudDTO + FlowDTO.
import { PanelBox, Sparkline } from '../crt'
import type { FlowDTO, HudDTO } from '../../lib/types'
import { computeLatencyStats } from '../re/forensics'
import '../re/re-pro.css'
import { compactNumber, fmtClock, fmtCost, fmtDuration } from './format'

export function TelePanel({ hud, flow }: { hud: HudDTO; flow: FlowDTO }) {
  const stats = hud.stats
  const counters: Array<[label: string, value: number, tone: string]> = [
    ['in', stats.input, 'text'],
    ['think', stats.thinking, 'violet'],
    ['cache', stats.cacheRead, 'ok'],
    ['out', stats.output, 'accent'],
  ]
  const totalIn = stats.input + stats.cacheRead
  const cacheHitPct = totalIn > 0 ? Math.round((stats.cacheRead / totalIn) * 100) : 0
  const tokPerSec = hud.elapsedMs >= 1000 && stats.output > 0 ? Math.round((stats.output * 1000) / hud.elapsedMs) : 0
  const latency = computeLatencyStats(flow.toolRuns)

  return (
    <PanelBox title="tele" tier="secondary">
      <div className="tele-rows re-mono-num">
        {/* output throughput + tool latency sparklines */}
        <div className="tele-row">
          <span className="t-faint">out</span>
          <Sparkline data={hud.spark} h={14} />
          <span className="t-text">{compactNumber(stats.output)}</span>
          {tokPerSec > 0 && (
            <span className="re-tele-kpi t-accent" title="Average output throughput">
              {tokPerSec} tok/s
            </span>
          )}
          {latency.samples.length > 0 && (
            <span className="tele-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title={`Tool latency avg ${fmtDuration(latency.avgMs)} · p95 ${fmtDuration(latency.p95Ms)}`}>
              <span className="t-faint">lat</span>
              <Sparkline data={latency.samples.slice(-14)} h={12} />
              <span className="t-muted">{fmtDuration(latency.avgMs)}</span>
            </span>
          )}
          {hud.queueCount > 0 && (
            <span className="tele-chip t-muted" title="prompts queued while running">
              ⠿ {hud.queueCount}
            </span>
          )}
        </div>

        {/* counters · cache hit · cost · clock · compaction */}
        <div className="tele-row">
          {counters.map(([label, value, tone]) => (
            <span key={label} className="tele-chip">
              <span className="t-faint">{label}</span> <span className={`t-${tone}`}>{compactNumber(value)}</span>
            </span>
          ))}
          {cacheHitPct > 0 && (
            <span className="re-tele-kpi t-ok" title="Prompt cache hit ratio">
              hit {cacheHitPct}%
            </span>
          )}
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
              {hud.route.auditor && (
                <span className="tele-chip">
                  <span className="t-faint">auditor</span> <span className="t-violet">{hud.route.auditor}</span>
                </span>
              )}
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
