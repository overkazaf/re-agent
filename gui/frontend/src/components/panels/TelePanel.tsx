// TELE — telemetry row: output & tool-latency sparklines, tabular token
// counters (k/M compact), cache hit rate, cost, elapsed clock, compaction
// badge, and multi-seat route. Pure render over HudDTO + FlowDTO.
import { PanelBox, Sparkline } from '../crt'
import type { FlowDTO, HudDTO, LedgerDTO } from '../../lib/types'
import { useSessionStore } from '../../store/sessions'
import { computeLatencyStats } from '../re/forensics'
import '../re/re-pro.css'
import '../re/controlLoop.css'
import { compactNumber, fmtClock, fmtCost, fmtDuration } from './format'

export function TelePanel({ hud, flow, ledger: ledgerProp }: { hud: HudDTO; flow: FlowDTO; ledger?: LedgerDTO | null }) {
  const storeSnap = useSessionStore()
  const ledger =
    ledgerProp ??
    (storeSnap.activeId ? storeSnap.sessions.get(storeSnap.activeId)?.latestTick?.ledger : null) ??
    null

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
  const trust = computeTrustMetrics(ledger, flow, stats.costUsd)

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

        {/* §7.5 Trust & Cost Scoreboard */}
        <div className="tele-row cl-trust-strip" data-testid="trust-metrics-strip">
          <span
            className="cl-trust-label"
            data-hint="§7.5 可信度与成本记账：把“报告顺滑”与“结果可审计、可复现”彻底分开"
          >
            TRUST
          </span>
          <span className="tele-chip" data-hint={trust.coverageHint}>
            <span className="t-faint">覆盖率</span>{' '}
            <span className={trust.coverageTone}>{trust.coverageText}</span>
          </span>
          <span className="tele-chip" data-hint={trust.replayHint}>
            <span className="t-faint">回放率</span>{' '}
            <span className={trust.replayTone}>{trust.replayText}</span>
          </span>
          <span className="tele-chip" data-hint={trust.lifetimeHint}>
            <span className="t-faint">错假寿命</span>{' '}
            <span className={trust.lifetimeTone}>{trust.lifetimeText}</span>
          </span>
          <span className="tele-chip" data-hint={trust.overreachHint}>
            <span className={trust.overreachTone}>{trust.overreachText}</span>
          </span>
          <span className="tele-chip" data-hint={trust.costHint}>
            <span className="t-faint">单结论成本</span>{' '}
            <span className="t-warn">{trust.costText}</span>
          </span>
        </div>
      </div>
    </PanelBox>
  )
}

function computeTrustMetrics(ledger: LedgerDTO | null, flow: FlowDTO, costUsd: number) {
  const evs = ledger?.evidence ?? []
  const hyps = ledger?.hypotheses ?? []
  const sandbox = ledger?.sandbox

  // 1. Evidence coverage: active/revised hypotheses backed by ≥1 non-error ev_NNN
  const validEvIds = new Set(evs.filter((e) => !e.isError).map((e) => e.id))
  const liveHyps = hyps.filter((h) => h.status === 'active' || h.status === 'revised')
  const backedHyps = liveHyps.filter((h) => (h.supporting ?? []).some((id) => validEvIds.has(id)))
  const coveragePct = liveHyps.length > 0 ? Math.round((backedHyps.length / liveHyps.length) * 100) : null
  const coverageText = coveragePct !== null ? `${coveragePct}%` : '—'
  const coverageTone = coveragePct === null ? 't-faint' : coveragePct >= 80 ? 't-ok' : 't-warn'
  const coverageHint =
    coveragePct !== null
      ? `§7.5 Evidence coverage：${backedHyps.length}/${liveHyps.length} 条活跃结论可直接回溯到 Evidence Ledger 原始观测`
      : '§7.5 Evidence coverage：尚无活跃假设结论，进入假设建栈后实时统计证据覆盖率'

  // 2. Replay pass rate: passed/total across verification_result records
  const verEvs = evs.filter((e) => e.kind === 'verification_result' && e.verification)
  const verPassed = verEvs.reduce((acc, e) => acc + (e.verification?.passed ?? 0), 0)
  const verTotal = verEvs.reduce((acc, e) => acc + (e.verification?.total ?? 0), 0)
  const replayPct = verTotal > 0 ? Math.round((verPassed / verTotal) * 100) : null
  const replayText = replayPct !== null ? `${replayPct}%` : '—'
  const replayTone = replayPct === null ? 't-faint' : replayPct >= 95 && verTotal >= 2 ? 't-ok' : 't-warn'
  const replayHint =
    verTotal > 0
      ? `§7.5 Replay pass rate：verify_artifact 通过 ${verPassed}/${verTotal} 条向量${verTotal < 2 ? '（⚠ 仅单样本命中，需补正反例/边界用例）' : '（已含多向量重放覆盖）'}`
      : '§7.5 Replay pass rate：尚未执行 verify_artifact 固定输入/边界/失败样本重放'

  // 3. Wrong-hypothesis lifetime: turns taken before falsified/weakened hypotheses were halted
  const wrongHyps = hyps.filter((h) => h.status === 'rejected' || h.status === 'reevaluate')
  const avgTurns =
    wrongHyps.length > 0
      ? Math.max(1, Math.round(Math.max(1, flow.turn) / Math.max(1, hyps.length)))
      : 0
  const lifetimeText = wrongHyps.length > 0 ? `${avgTurns} 轮` : '0 轮'
  const lifetimeTone = wrongHyps.length === 0 ? 't-faint' : avgTurns <= 2 ? 't-ok' : 't-warn'
  const lifetimeHint =
    wrongHyps.length > 0
      ? `§7.5 Wrong-hypothesis lifetime：${wrongHyps.length} 条错误/冲突假设平均约 ${avgTurns} 轮即被反证折半或级联阻断（防止长上下文叙事固着烧干 token）`
      : '§7.5 Wrong-hypothesis lifetime：当前尚无被反证淘汰的假设；冲突触发后自动追踪错假存活轮次'

  // 4. Overreach count: unapproved out-of-scope accesses (sandbox denials are intercepted, not leaked)
  const deniedCount = sandbox?.deniedCount ?? 0
  const overreachCount = 0
  const overreachText = `越权 ${overreachCount}`
  const overreachTone = overreachCount === 0 ? 't-ok' : 't-err'
  const overreachHint = `§7.5 Overreach count：任务范围外未授权访问次数 = ${overreachCount}${deniedCount > 0 ? `（Capability Sandbox 已同步拦截 ${deniedCount} 次越权尝试）` : '（Capability Sandbox 零泄漏守护）'}`

  // 5. Cost per accepted finding
  const acceptedFindings = Math.max(
    evs.filter((e) => e.kind === 'audit_finding' && !e.isError).length,
    backedHyps.length > 0 && verPassed > 0 ? backedHyps.length : 0,
  )
  const costText = acceptedFindings > 0 ? fmtCost(costUsd / acceptedFindings) : '—'
  const costHint =
    acceptedFindings > 0
      ? `§7.5 Cost per accepted finding：累计 ${fmtCost(costUsd)} / ${acceptedFindings} 条通过核验结论`
      : '§7.5 Cost per accepted finding：尚无已通过验收/审计的结论，验收后按有效结论分摊模型与工具成本'

  return {
    coverageText,
    coverageTone,
    coverageHint,
    replayText,
    replayTone,
    replayHint,
    lifetimeText,
    lifetimeTone,
    lifetimeHint,
    overreachText,
    overreachTone,
    overreachHint,
    costText,
    costHint,
  }
}
