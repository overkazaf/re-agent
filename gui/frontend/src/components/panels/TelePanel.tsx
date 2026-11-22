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
  const counters: Array<[label: string, value: number, tone: string, hint: string]> = [
    ['in', stats.input, 'text', `累计输入 ${stats.input.toLocaleString()} tokens`],
    ['think', stats.thinking, 'violet', `链式思考消耗 ${stats.thinking.toLocaleString()} tokens`],
    ['cache', stats.cacheRead, 'ok', `Prompt 缓存命中读取 ${stats.cacheRead.toLocaleString()} tokens`],
    ['out', stats.output, 'accent', `累计输出 ${stats.output.toLocaleString()} tokens`],
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
          <span className="t-faint" data-hint="输出 Token 吞吐曲线">out</span>
          <Sparkline data={hud.spark} h={14} />
          <span className="t-text">{compactNumber(stats.output)}</span>
          {tokPerSec > 0 && (
            <span className="re-tele-kpi t-accent" data-hint={`平均输出吞吐速率：${tokPerSec} tokens/s`}>
              {tokPerSec} tok/s
            </span>
          )}
          {latency.samples.length > 0 && (
            <span
              className="tele-chip"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
              data-hint={`工具调用耗时：平均 ${fmtDuration(latency.avgMs)} · P95 ${fmtDuration(latency.p95Ms)} · 峰值 ${fmtDuration(latency.maxMs)}`}
            >
              <span className="t-faint">lat</span>
              <Sparkline data={latency.samples.slice(-14)} h={12} />
              <span className="t-muted">{fmtDuration(latency.avgMs)}</span>
            </span>
          )}
          {hud.queueCount > 0 && (
            <span className="tele-chip t-muted" data-hint={`当前有 ${hud.queueCount} 条追问在 FIFO 队列中等待执行`}>
              ⠿ {hud.queueCount}
            </span>
          )}
        </div>

        {/* counters · cache hit · cost · clock · compaction */}
        <div className="tele-row">
          {counters.map(([label, value, tone, hint]) => (
            <span key={label} className="tele-chip" data-hint={hint}>
              <span className="t-faint">{label}</span> <span className={`t-${tone}`}>{compactNumber(value)}</span>
            </span>
          ))}
          {cacheHitPct > 0 && (
            <span className="re-tele-kpi t-ok" data-hint={`Prompt 缓存命中率 ${cacheHitPct}%（有效降低重复上下文费用）`}>
              hit {cacheHitPct}%
            </span>
          )}
          <span className="tele-chip" data-hint={`当前会话累计估算开销：${fmtCost(stats.costUsd)}`}>
            <span className="t-faint">$</span> <span className="t-warn">{fmtCost(stats.costUsd)}</span>
          </span>
          <span className="tele-chip" data-hint={`会话累计运行时长：${fmtClock(hud.elapsedMs)}`}>
            <span className="t-faint">◷</span> <span className="t-ok">{fmtClock(hud.elapsedMs)}</span>
          </span>
          {flow.hasCompacted && (
            <span
              className="tele-chip t-warn"
              data-hint={`上下文已自动压缩：裁剪 ${flow.compactedDrop} 条历史消息，省略 ${flow.compactedElide} 条工具长输出（假设栈与账本摘要不受影响）`}
            >
              ⌢ -{flow.compactedDrop}
            </span>
          )}
        </div>

        {/* route */}
        <div className="tele-row">
          {hud.route !== null ? (
            <>
              <span className="tele-chip" data-hint="规划席 (Planner)：负责目标契约、任务拆解与假设栈建模">
                <span className="t-faint">planner</span> <span className="t-muted">{hud.route.planner}</span>
              </span>
              <span className="tele-chip" data-hint="执行席 (Executor)：负责高频调用静态/动态逆向工具取证">
                <span className="t-faint">executor</span> <span className="t-muted">{hud.route.executor}</span>
              </span>
              {hud.route.auditor && (
                <span className="tele-chip" data-hint="独立对抗审计席 (Auditor)：零历史上下文隔离复核证据闭环">
                  <span className="t-faint">auditor</span> <span className="t-violet">{hud.route.auditor}</span>
                </span>
              )}
              <span className="tele-chip t-accent" data-hint={`当前活跃执行席位：${hud.route.active}`}>
                ▸ {hud.route.active}
              </span>
            </>
          ) : (
            <span className="t-faint">route —</span>
          )}
          <span className="tele-chip t-faint" data-hint="当前宿主会话生命周期状态">{hud.phase}</span>
        </div>
      </div>
    </PanelBox>
  )
}
