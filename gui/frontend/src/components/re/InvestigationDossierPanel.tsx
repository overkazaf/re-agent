// InvestigationDossierPanel — Minimalist, high-craft 7-State Investigation State
// Dossier calibrated 1:1 to README.md (§§ 6, 7.5, 8).
// Follows strict "优雅简洁 + 悬停提示 (data-hint)" ergonomics: zero text walls,
// theme-safe tokens across all 10 themes (including daylight `paper`).
import { useMemo, useState } from 'react'
import type { TickDTO } from '../../lib/types'
import {
  buildInvestigationState,
  type DefenseStatus,
  type InvestigationState,
  type InvestigationStateKey,
} from './investigationState'
import './re-pro.css'

const STATE_TABS: ReadonlyArray<{
  key: InvestigationStateKey
  num: string
  label: string
  hint: string
}> = [
  { key: 'target', num: '①', label: 'Target', hint: 'Target State (§8.1)：记录样本路径、SHA-256、架构、格式与边界，与 Objective 严格分离' },
  { key: 'objective', num: '②', label: 'Objective', hint: 'Objective State (§8.1)：记录任务意图、交付物、验收门槛与停止条件，防止分析偷换目标' },
  { key: 'evidence', num: '③', label: 'Evidence', hint: 'Evidence State (§8.1)：只追加工具原始观察，隔离不可信样本字符串，不混入模型总结' },
  { key: 'hypothesis', num: '④', label: 'Hypothesis', hint: 'Hypothesis State (§8.3)：结构化假设含 scope / falsifiers / next_test 与计算置信度' },
  { key: 'action', num: '⑤', label: 'Action', hint: 'Action State (§8.4)：能力沙箱审批留痕与假设绑定的动态动作记录' },
  { key: 'verification', num: '⑥', label: 'Verify', hint: 'Verification State (§8.5)：区分 candidate 与 verified，防止单样本命中冒充已还原' },
  { key: 'audit', num: '⑦', label: 'Audit', hint: 'Audit State (§8.6)：隔离第三席位 5 项对抗审计清单与三态裁定' },
]

function defenseTone(status: DefenseStatus): 'ok' | 'warn' | 'err' | 'accent' {
  if (status === 'pass') return 'ok'
  if (status === 'warn') return 'warn'
  if (status === 'blocked') return 'err'
  return 'accent'
}

function verdictShort(verdict: InvestigationState['states']['audit']['verdict']): string {
  if (verdict === 'accepted') return 'ACCEPTED'
  if (verdict === 'rejected') return 'REJECTED'
  return 'NEEDS MORE EVIDENCE'
}

export function InvestigationDossierPanel({
  tick,
  workspace = '/demo/reverse-lab',
  initialState = 'target',
}: {
  tick: TickDTO | null
  workspace?: string
  initialState?: InvestigationStateKey
}) {
  const [activeState, setActiveState] = useState<InvestigationStateKey>(initialState)
  const [gatesOpen, setGatesOpen] = useState(false)

  const dossier = useMemo(
    () => buildInvestigationState(tick, workspace),
    [tick, workspace],
  )

  const { states, defenses, metrics, completionCriteria, completionScore, handover } = dossier
  const auditVerdict = states.audit.verdict

  return (
    <section
      className="re-dossier-panel"
      data-testid="investigation-dossier-panel"
      aria-label="Investigation State 任务档案"
    >
      {/* 1. Compact Header: Audit Verdict Pill + Completion Gate + 5-Defense Status Dots */}
      <div className="re-dossier-head">
        <div className="re-dossier-title-group">
          <span className="re-dossier-title">◈ Investigation State</span>
          <span
            className="re-hint-dot"
            data-hint="跨轮次、跨模型、跨工具的可续跑逆向任务档案 (§8.1)：七类状态各司其职，模型只读摘要，宿主保存原始记录与裁定"
          >
            ?
          </span>
          <span
            className="re-audit-pill re-mono-num"
            data-verdict={auditVerdict}
            data-hint={`对抗审计三态裁定 (§8.6)：${states.audit.verdictLabel} · 席位 ${states.audit.auditorSeat}（${states.audit.passedChecksCount}/5 项通过）`}
          >
            {verdictShort(auditVerdict)}
          </span>
          <span
            className="re-dossier-gate-badge re-mono-num"
            data-pass={completionScore.passed === completionScore.total ? '1' : undefined}
            data-hint={`§8.7 完成门禁：${completionScore.passed}/${completionScore.total} 项达标（点击下方抽屉查看 7 项清单与交接三问）`}
          >
            {completionScore.passed}/{completionScore.total} 达标
          </span>
        </div>

        {/* 5 Defenses Live Status Dots (§6) */}
        <div className="re-defense-strip" aria-label="五道防线实时态势">
          {defenses.map((d) => (
            <span
              key={d.id}
              className="re-defense-chip re-mono-num"
              data-tone={defenseTone(d.status)}
              data-hint={`${d.hint}`}
            >
              <span className="re-defense-dot" data-tone={defenseTone(d.status)} aria-hidden="true" />
              <span>{d.code}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 2. Sleek 7-State Segmented Selector */}
      <div className="re-state-tabs" role="tablist" aria-label="七类任务档案状态">
        {STATE_TABS.map((tab) => {
          const isActive = activeState === tab.key
          const indicator =
            tab.key === 'target'
              ? states.target.status === 'ready'
              : tab.key === 'objective'
                ? states.objective.status === 'accepted'
                : tab.key === 'evidence'
                  ? states.evidence.total > 0
                  : tab.key === 'hypothesis'
                    ? states.hypothesis.status === 'converged'
                    : tab.key === 'action'
                      ? states.action.status === 'enforced'
                      : tab.key === 'verification'
                        ? states.verification.status === 'verified'
                        : states.audit.verdict === 'accepted'
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="re-state-tab re-mono-num"
              data-active={isActive ? '1' : undefined}
              data-ready={indicator ? '1' : undefined}
              onClick={() => setActiveState(tab.key)}
              data-hint={tab.hint}
            >
              <span>{tab.num} {tab.label}</span>
            </button>
          )
        })}
      </div>

      {/* 3. Selected State Crisp YAML-like Key/Value View */}
      <div className="re-dossier-body" role="tabpanel">
        <StateDetailView
          activeState={activeState}
          dossier={dossier}
          onSwitchState={setActiveState}
        />
      </div>

      {/* 4. Compact 5-Metric Trust Strip (§7.5) */}
      <div className="re-trust-strip re-mono-num" aria-label="五维可信度指标">
        <div className="re-trust-cell" data-tone={metrics.evidenceCoverage.tone} data-hint={metrics.evidenceCoverage.hint}>
          <span className="re-trust-k">证据覆盖</span>
          <span className="re-trust-v">{metrics.evidenceCoverage.display}</span>
        </div>
        <div className="re-trust-cell" data-tone={metrics.replayPassRate.tone} data-hint={metrics.replayPassRate.hint}>
          <span className="re-trust-k">回放通过</span>
          <span className="re-trust-v">{metrics.replayPassRate.display}</span>
        </div>
        <div className="re-trust-cell" data-tone={metrics.wrongHypLifetime.tone} data-hint={metrics.wrongHypLifetime.hint}>
          <span className="re-trust-k">错假寿命</span>
          <span className="re-trust-v">{metrics.wrongHypLifetime.display}</span>
        </div>
        <div className="re-trust-cell" data-tone={metrics.overreachCount.tone} data-hint={metrics.overreachCount.hint}>
          <span className="re-trust-k">越权尝试</span>
          <span className="re-trust-v">{metrics.overreachCount.display}</span>
        </div>
        <div className="re-trust-cell" data-tone={metrics.costPerAcceptedFinding.tone} data-hint={metrics.costPerAcceptedFinding.hint}>
          <span className="re-trust-k">单结论成本</span>
          <span className="re-trust-v">{metrics.costPerAcceptedFinding.display}</span>
        </div>
      </div>

      {/* 5. Collapsible 7 Completion Gates & 3 Handover Questions Drawer (starts collapsed) */}
      <div className="re-dossier-footer">
        <button
          type="button"
          className="re-disclosure-btn"
          onClick={() => setGatesOpen((v) => !v)}
          aria-expanded={gatesOpen}
          data-hint="展开或收起 §8.7 七项完成门禁清单与收尾交接三问（运行溯源 / 跨模型复现 / 四维归因）"
        >
          <span>{gatesOpen ? '7 项完成门禁 & 交接三问 ▴' : '7 项完成门禁 & 交接三问 ▾'}</span>
          <span className="re-mono-num" style={{ opacity: 0.78 }}>
            ({completionScore.passed}/7)
          </span>
        </button>

        {gatesOpen && (
          <div className="re-gates-drawer">
            <div className="re-gates-col">
              <div className="re-gates-col-title">§8.7 什么时候才叫完成 ({completionScore.passed}/7)</div>
              <div className="re-gates-list">
                {completionCriteria.map((c) => (
                  <div
                    key={c.key}
                    className="re-gate-row"
                    data-pass={c.pass ? '1' : undefined}
                    data-hint={c.detail}
                  >
                    <span className="re-gate-glyph re-mono-num">{c.pass ? '✓' : '○'}</span>
                    <span className="re-gate-label">{c.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="re-gates-col">
              <div className="re-gates-col-title">§8.7 交接三问（可续跑 / 可复现 / 可归因）</div>
              <div className="re-handover-list">
                <div className="re-handover-item" data-hint={`溯源锚点：${handover.whichRun.refs}`}>
                  <span className="re-handover-q">{handover.whichRun.question}</span>
                  <span className="re-handover-a">{handover.whichRun.answer}</span>
                </div>
                <div className="re-handover-item">
                  <span className="re-handover-q">
                    {handover.reproducibleAcrossModels.question}
                    <span className="re-mini-tag re-mono-num" data-tone={handover.reproducibleAcrossModels.status === 'reproducible' ? 'ok' : 'warn'}>
                      {handover.reproducibleAcrossModels.status}
                    </span>
                  </span>
                  <span className="re-handover-a">{handover.reproducibleAcrossModels.answer}</span>
                </div>
                <div
                  className="re-handover-item"
                  data-hint={`模型：${handover.errorAttribution.breakdown.model} ｜ 工具：${handover.errorAttribution.breakdown.tool} ｜ 环境：${handover.errorAttribution.breakdown.environment} ｜ 数据：${handover.errorAttribution.breakdown.data}`}
                >
                  <span className="re-handover-q">
                    {handover.errorAttribution.question}
                    <span className="re-mini-tag re-mono-num" data-tone={handover.errorAttribution.category === 'none' ? 'ok' : 'warn'}>
                      {handover.errorAttribution.category}
                    </span>
                  </span>
                  <span className="re-handover-a">{handover.errorAttribution.answer}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function StateDetailView({
  activeState,
  dossier,
  onSwitchState,
}: {
  activeState: InvestigationStateKey
  dossier: InvestigationState
  onSwitchState: (next: InvestigationStateKey) => void
}) {
  const { target, objective, evidence, hypothesis, action, verification, audit } = dossier.states

  if (activeState === 'target') {
    return (
      <div className="re-yaml-card">
        <div className="re-yaml-meta">
          <span className="re-yaml-title">① target_state · 样本对象（严格独立于 Objective）</span>
          <span className="re-yaml-owner re-mono-num" data-hint={target.separationNote}>
            writer: {target.writer}
          </span>
        </div>
        <div className="re-kv-grid re-mono-num">
          <KvRow k="file" v={target.file} />
          <KvRow k="sha256" v={target.sha256 ? `${target.sha256.slice(0, 20)}…` : '未计算'} hint={target.sha256 || '待宿主计算文件哈希'} />
          <KvRow k="format / arch" v={`${target.format} · ${target.arch}`} />
          <KvRow k="scope" v={target.scope} />
          <KvRow k="allowed_ops" v={target.allowedOps.join(' · ')} />
        </div>
        <div className="re-separation-bar">
          <span className="re-separation-tag">样本 ≠ 目的</span>
          <span className="re-separation-text">
            当前对应 Objective：{objective.primary}
          </span>
          <button
            type="button"
            className="re-disclosure-btn"
            onClick={() => onSwitchState('objective')}
            data-hint="切换查看 Objective State（任务意图、交付物与停止条件）"
          >
            对比 Objective →
          </button>
        </div>
      </div>
    )
  }

  if (activeState === 'objective') {
    return (
      <div className="re-yaml-card">
        <div className="re-yaml-meta">
          <span className="re-yaml-title">② objective_state · 任务意图与验收契约</span>
          <span className="re-yaml-owner re-mono-num">
            writer: {objective.writer} · {objective.status}
          </span>
        </div>
        <div className="re-kv-grid">
          <KvRow k="primary" v={objective.primary} />
          <KvRow k="deliverables" v={objective.deliverables.join(' · ')} mono />
          <KvRow
            k="acceptance"
            v={
              objective.acceptanceCriteria.length > 0
                ? objective.acceptanceCriteria.map((c) => `${c.pass ? '✓' : '○'} ${c.label}`).join('  ')
                : '尚未声明 /goal 验收项'
            }
          />
          <KvRow k="stop_conditions" v={objective.stopConditions.join('；')} />
        </div>
        <div className="re-separation-bar">
          <span className="re-separation-tag">目的 ≠ 样本</span>
          <span className="re-separation-text re-mono-num">
            绑定 Target：{target.file} ({target.format} · {target.arch})
          </span>
          <button
            type="button"
            className="re-disclosure-btn"
            onClick={() => onSwitchState('target')}
            data-hint="切回查看 Target State（样本指纹与分析范围）"
          >
            ← 对比 Target
          </button>
        </div>
      </div>
    )
  }

  if (activeState === 'evidence') {
    return (
      <div className="re-yaml-card">
        <div className="re-yaml-meta">
          <span className="re-yaml-title">③ evidence_state · 追加式客观证据账本</span>
          <span className="re-yaml-owner re-mono-num">writer: {evidence.writer}</span>
        </div>
        <div className="re-kv-grid re-mono-num">
          <KvRow
            k="records"
            v={`total:${evidence.total} · static:${evidence.staticCount} · dynamic:${evidence.dynamicCount} · verify:${evidence.verifyCount} · audit:${evidence.auditCount}`}
          />
          <KvRow
            k="untrusted_iso"
            v={`${evidence.untrustedIsolatedCount} 条原始样本输出已按不可信输入隔离`}
            hint="样本中的函数名、字符串与注释均视为数据而非指令，防止策略投毒污染上下文 (§4)"
          />
          <KvRow k="hash_coverage" v={`${evidence.hashedCount}/${evidence.total} (${evidence.hashCoveragePct}%)`} />
          <KvRow k="ledger_path" v={evidence.ledgerPath} />
        </div>
      </div>
    )
  }

  if (activeState === 'hypothesis') {
    return (
      <div className="re-yaml-card">
        <div className="re-yaml-meta">
          <span className="re-yaml-title">④ hypothesis_state · 假设竞争与反例回滚</span>
          <span className="re-yaml-owner re-mono-num">{hypothesis.rollbackSummary}</span>
        </div>
        {hypothesis.items.length === 0 ? (
          <div className="re-dossier-empty">尚未提出结构化假设（H-NNN）。</div>
        ) : (
          <div className="re-hyp-compact-list">
            {hypothesis.items.map((h) => {
              const tone =
                h.status === 'rejected'
                  ? 'err'
                  : h.status === 'reevaluate'
                    ? 'warn'
                    : h.hasDualView
                      ? 'ok'
                      : 'accent'
              return (
                <div
                  key={h.id}
                  className="re-hyp-compact-row"
                  data-tone={tone}
                  data-hint={`scope: ${h.scope} ｜ 可证伪条件: ${h.falsifiers.join('；')} ｜ 下一步检验: ${h.nextTest}`}
                >
                  <span className="re-mini-tag re-mono-num" data-tone={tone}>{h.id}</span>
                  <span className="re-hyp-compact-claim" data-rejected={h.status === 'rejected' ? '1' : undefined}>
                    {h.claim}
                  </span>
                  <span className="re-hyp-compact-meta re-mono-num">
                    {h.status} · 标称{h.confidencePct}% / 实算{h.computedConfidencePct}%
                  </span>
                  <div className="re-hyp-compact-sub">
                    <span><b>scope:</b> {h.scope}</span>
                    <span><b>falsifier:</b> {h.falsifiers[0]}</span>
                    <span><b>next_test:</b> {h.nextTest}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  if (activeState === 'action') {
    return (
      <div className="re-yaml-card">
        <div className="re-yaml-meta">
          <span className="re-yaml-title">⑤ action_state · 能力沙箱与假设绑定动作</span>
          <span className="re-yaml-owner re-mono-num">
            sandbox: {action.sandboxActive ? 'ACTIVE (deny-by-default)' : 'STANDARD'}
          </span>
        </div>
        <div className="re-kv-grid re-mono-num">
          <KvRow k="decisions" v={`granted:${action.grantedCount} · denied:${action.deniedCount} · overreach:${action.overreachCount}`} />
          <KvRow
            k="hyp_binding"
            v={`已绑定假设 ${action.hypothesisBoundCount}/${action.dynamicActionCount} 次动态动作${action.unboundDynamicCount > 0 ? `（未绑定 ${action.unboundDynamicCount}）` : ''}`}
            hint="§8.4：每次动态动作都要回答「为了验证哪条假设」，避免盲目探索"
          />
          {action.recentActions.length > 0 && (
            <KvRow
              k="recent"
              v={action.recentActions
                .slice(0, 3)
                .map((a) => `[${a.decision.toUpperCase()}] ${a.tool}(${a.capability})${a.hypothesisId ? `→${a.hypothesisId}` : ''}`)
                .join(' ｜ ')}
            />
          )}
        </div>
      </div>
    )
  }

  if (activeState === 'verification') {
    const tierTone = verification.status === 'verified' ? 'ok' : verification.status === 'candidate' ? 'warn' : 'muted'
    return (
      <div className="re-yaml-card">
        <div className="re-yaml-meta">
          <span className="re-yaml-title">⑥ verification_state · 行为重放与差分验收</span>
          <span className="re-mini-tag re-mono-num" data-tone={tierTone} data-hint={verification.verdictNote}>
            {verification.status.toUpperCase()}
          </span>
        </div>
        <div className="re-kv-grid re-mono-num">
          <KvRow k="build / replay" v={`build:${verification.buildPass === null ? '—' : verification.buildPass ? 'PASS' : 'FAIL'} · replay:${verification.passedCases}/${verification.totalCases}${verification.replayPassRatePct !== null ? ` (${verification.replayPassRatePct}%)` : ''}`} />
          <KvRow k="coverage" v={`boundary:${verification.boundaryCovered ? 'COVERED' : 'MISSING'} · diff:${verification.differentialCovered ? 'COVERED' : 'MISSING'}`} />
          {verification.singleSampleHitWarning && (
            <KvRow
              k="guard"
              v="⚠ 单样本命中 (total < 2) — 按 §8.5 保持 CANDIDATE，不可宣称已完整还原"
              tone="warn"
            />
          )}
          <KvRow k="uncovered" v={verification.uncoveredPaths.join('；') || '无'} />
        </div>
      </div>
    )
  }

  // activeState === 'audit'
  return (
    <div className="re-yaml-card">
      <div className="re-yaml-meta">
        <span className="re-yaml-title">⑦ audit_state · 零上下文对抗审计 (§8.6)</span>
        <span className="re-audit-pill re-mono-num" data-verdict={audit.verdict}>
          {audit.auditorSeat} · {verdictShort(audit.verdict)}
        </span>
      </div>
      <div className="re-audit-checklist">
        {audit.checklist.map((item) => (
          <div
            key={item.key}
            className="re-audit-check-row"
            data-pass={item.pass ? '1' : undefined}
            data-hint={`${item.question} — ${item.detail}`}
          >
            <span className="re-gate-glyph re-mono-num">{item.pass ? '✓' : '✗'}</span>
            <span className="re-audit-check-lbl">{item.label}</span>
            <span className="re-audit-check-det">{item.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function KvRow({
  k,
  v,
  hint,
  mono,
  tone,
}: {
  k: string
  v: string
  hint?: string
  mono?: boolean
  tone?: 'warn' | 'err' | 'ok'
}) {
  return (
    <div className="re-kv-row" data-hint={hint} data-tone={tone}>
      <span className="re-kv-k re-mono-num">{k}:</span>
      <span className={`re-kv-v${mono ? ' re-mono-num' : ''}`}>{v}</span>
    </div>
  )
}
