// ProofNarrativePanel — typography-first deductive forensic narrative view.
// Presents the complete Hypothesis → Experiment → Contradiction/Pivot →
// Verification → Audit reasoning chain in natural, continuous Chinese prose
// with causal connectors, expandable raw evidence pills, and explicit
// "原预期 vs 实测结果" contrast callouts.
import { useMemo, useState } from 'react'
import type { TickDTO } from '../../lib/types'
import {
  synthesizeProofStory,
  type ContrastCallout,
  type EvidenceMention,
  type HypothesisArc,
  type NarrativeChapter,
} from './cognitiveSynthesis'
import './re-pro.css'

export type ProofNarrativeMode = 'timeline' | 'hypotheses'

export function ProofNarrativePanel({
  tick,
  defaultMode = 'timeline',
  onOpenEvidence,
}: {
  tick: TickDTO | null
  defaultMode?: ProofNarrativeMode
  onOpenEvidence?: (evId: string) => void
}) {
  const [mode, setMode] = useState<ProofNarrativeMode>(defaultMode)
  const [expandedEvKey, setExpandedEvKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const story = useMemo(() => synthesizeProofStory(tick), [tick])

  const copyStory = () => {
    navigator.clipboard?.writeText(story.fullPlainText).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section
      className="re-narrative-panel"
      data-testid="proof-narrative-panel"
      aria-label="完整推理与证明脉络"
    >
      {/* Header + mode switch + copy button */}
      <div className="re-narrative-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span className="re-narrative-title">
            ◈ 推理与证明脉络
          </span>
          <span
            className="re-hint-dot"
            data-hint="按「假设 → 实验 → 冲突/转向 → 重放验证 → 独立审计」连贯还原完整证明链；可切换按时间叙事或逐假设五拍拆解，点击 [ev_NNN] 展开原始实测摘录"
          >
            ?
          </span>
          {!story.isEmpty && (
            <span className="re-narrative-meta re-mono-num">
              {story.chapters.length} 步递进 · {story.hypothesisArcs.length} 条假设
            </span>
          )}
        </div>

        {!story.isEmpty && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="re-narrative-tab"
              data-active={mode === 'timeline' ? '1' : undefined}
              onClick={() => setMode('timeline')}
              aria-label="完整推理脉络（按时间叙事）"
              data-hint="按时间演进顺序串起完整取证与转向逻辑"
            >
              时间叙事
            </button>
            <button
              type="button"
              className="re-narrative-tab"
              data-active={mode === 'hypotheses' ? '1' : undefined}
              onClick={() => setMode('hypotheses')}
              aria-label="逐假设证明链路（按 H-NNN 拆解）"
              data-hint="逐条展开每个假设的「起因 → 主张 → 实测 → 推导 → 后续」五拍证明链"
            >
              逐假设拆解
            </button>
            <button
              type="button"
              className="re-narrative-copy"
              data-copied={copied ? '1' : undefined}
              onClick={copyStory}
              aria-label="复制完整推理叙述"
              data-hint="复制纯文本完整推理叙述"
            >
              {copied ? '✓ 已复制' : '⎘ 复制叙述'}
            </button>
          </div>
        )}
      </div>

      {/* Orienting Lead Summary */}
      <div className="re-narrative-lead">{story.leadSummary}</div>

      {story.isEmpty ? null : mode === 'timeline' ? (
        <div className="re-narrative-rail">
          {story.chapters.map((ch) => (
            <ChapterBlock
              key={ch.id}
              chapter={ch}
              expandedEvKey={expandedEvKey}
              onToggleEv={(key) => setExpandedEvKey((cur) => (cur === key ? null : key))}
              onOpenEvidence={onOpenEvidence}
            />
          ))}
        </div>
      ) : (
        <div className="re-arc-list">
          {story.hypothesisArcs.length === 0 ? (
            <div className="re-narrative-empty">
              当前尚未提出显式假设（H-NNN），完成静态勘察并建立假设后将在此展开逐条五拍证明链路。
            </div>
          ) : (
            story.hypothesisArcs.map((arc) => (
              <HypothesisArcCard
                key={arc.id}
                arc={arc}
                expandedEvKey={expandedEvKey}
                onToggleEv={(key) => setExpandedEvKey((cur) => (cur === key ? null : key))}
                onOpenEvidence={onOpenEvidence}
              />
            ))
          )}
        </div>
      )}
    </section>
  )
}

function ChapterBlock({
  chapter,
  expandedEvKey,
  onToggleEv,
  onOpenEvidence,
}: {
  chapter: NarrativeChapter
  expandedEvKey: string | null
  onToggleEv: (key: string) => void
  onOpenEvidence?: (evId: string) => void
}) {
  const activeEv = chapter.evidenceRefs.find((e) => expandedEvKey === `${chapter.id}:${e.id}`) ?? null

  return (
    <div className="re-narrative-step-wrap">
      {chapter.transitionFromPrev && (
        <div className="re-narrative-bridge">
          <span className="re-narrative-bridge-arrow" aria-hidden="true">↳</span>
          <span>{chapter.transitionFromPrev}</span>
        </div>
      )}

      <article className="re-narrative-card" data-tone={chapter.tone}>
        <div className="re-narrative-card-head">
          <span className="re-step-badge re-mono-num" data-tone={chapter.tone}>
            0{chapter.stepNo}
          </span>
          <span className="re-step-phase">{chapter.phaseLabel}</span>
          <span className="re-step-role">{chapter.roleTag}</span>
          {chapter.hypothesisIds.length > 0 && (
            <span className="re-step-hyps re-mono-num">
              {chapter.hypothesisIds.join(' · ')}
            </span>
          )}
        </div>

        <div className="re-narrative-headline">{chapter.headline}</div>
        <p className="re-narrative-body">{chapter.body}</p>

        {chapter.contrasts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {chapter.contrasts.map((c, idx) => (
              <ContrastBox key={`${c.hypothesisId}-${idx}`} contrast={c} />
            ))}
          </div>
        )}

        {chapter.bulletFacts.length > 0 && (
          <ul className="re-narrative-bullets">
            {chapter.bulletFacts.map((fact, idx) => (
              <li key={idx}>{fact}</li>
            ))}
          </ul>
        )}

        {chapter.evidenceRefs.length > 0 && (
          <div className="re-ev-pill-row">
            <span className="re-ev-pill-label">凭证</span>
            {chapter.evidenceRefs.map((ev) => {
              const key = `${chapter.id}:${ev.id}`
              const open = expandedEvKey === key
              const preview = (ev.summary || ev.excerpt || '').replace(/\s+/g, ' ').slice(0, 120)
              return (
                <button
                  key={ev.id}
                  type="button"
                  className="re-ev-pill re-mono-num"
                  data-open={open ? '1' : undefined}
                  data-tone={ev.isError ? 'err' : ev.kind === 'audit_finding' ? 'violet' : ev.view === 'dynamic' ? 'ok' : 'accent'}
                  onClick={() => onToggleEv(key)}
                  data-hint={`${ev.source} (${ev.view}) · ${preview} — 点击展开原始摘录`}
                >
                  [{ev.id}] {ev.source}
                </button>
              )
            })}
          </div>
        )}

        {activeEv && (
          <EvidenceDrawer ev={activeEv} onOpenEvidence={onOpenEvidence} />
        )}
      </article>
    </div>
  )
}

function HypothesisArcCard({
  arc,
  expandedEvKey,
  onToggleEv,
  onOpenEvidence,
}: {
  arc: HypothesisArc
  expandedEvKey: string | null
  onToggleEv: (key: string) => void
  onOpenEvidence?: (evId: string) => void
}) {
  const allRefs = [
    ...arc.supportingRefs,
    ...arc.contradictingRefs.filter((c) => !arc.supportingRefs.some((s) => s.id === c.id)),
    ...arc.auditRefs.filter(
      (a) => !arc.supportingRefs.some((s) => s.id === a.id) && !arc.contradictingRefs.some((c) => c.id === a.id),
    ),
  ]
  const activeEv = allRefs.find((e) => expandedEvKey === `${arc.id}:${e.id}`) ?? null

  const beats: Array<{ no: string; label: string; text: string; accent?: boolean }> = [
    { no: '①', label: '起因线索', text: arc.triggerClues },
    { no: '②', label: '假设与标准', text: arc.claimAndCriterion },
    { no: '③', label: '检验与实测', text: arc.testAndObservation },
    { no: '④', label: '推导判断', text: arc.deductionVerdict, accent: true },
    { no: '⑤', label: '后续影响', text: arc.nextMove },
  ]

  return (
    <article className="re-arc-card" data-tone={arc.tone}>
      <div className="re-arc-head">
        <span className="re-step-badge re-mono-num" data-tone={arc.tone}>
          {arc.id}
        </span>
        <span className="re-arc-status" data-tone={arc.tone}>
          {arc.statusLabel}
        </span>
        <span className="re-mono-num" style={{ color: 'var(--muted)', fontSize: 10.5 }}>
          置信度 {arc.confidencePct}%
        </span>
        {arc.dependsOn.length > 0 && (
          <span className="re-arc-dep re-mono-num">
            依赖上游：{arc.dependsOn.join('、')}
          </span>
        )}
        {arc.dependents.length > 0 && (
          <span className="re-arc-dep re-mono-num">
            影响下游：{arc.dependents.join('、')}
          </span>
        )}
      </div>

      <div
        className="re-arc-claim"
        style={{ textDecoration: arc.status === 'rejected' ? 'line-through' : 'none', opacity: arc.status === 'rejected' ? 0.75 : 1 }}
      >
        {arc.claim}
      </div>

      {arc.contrast && <ContrastBox contrast={arc.contrast} />}

      <div className="re-arc-beats">
        {beats.map((b) => (
          <div key={b.no} className="re-arc-beat" data-emphasis={b.accent ? '1' : undefined}>
            <span className="re-arc-beat-tag">
              {b.no} {b.label}
            </span>
            <span className="re-arc-beat-text">{b.text}</span>
          </div>
        ))}
      </div>

      {allRefs.length > 0 && (
        <div className="re-ev-pill-row">
          <span className="re-ev-pill-label">凭证</span>
          {allRefs.map((ev) => {
            const key = `${arc.id}:${ev.id}`
            const open = expandedEvKey === key
            const isContra = arc.contradictingRefs.some((c) => c.id === ev.id)
            const preview = (ev.summary || ev.excerpt || '').replace(/\s+/g, ' ').slice(0, 120)
            return (
              <button
                key={ev.id}
                type="button"
                className="re-ev-pill re-mono-num"
                data-open={open ? '1' : undefined}
                data-tone={isContra || ev.isError ? 'err' : ev.kind === 'audit_finding' ? 'violet' : ev.view === 'dynamic' ? 'ok' : 'accent'}
                onClick={() => onToggleEv(key)}
                data-hint={`${isContra ? '反证' : '支撑'} · ${ev.source} (${ev.view})：${preview}`}
              >
                {isContra ? '✗' : '+'}[{ev.id}] {ev.source}
              </button>
            )
          })}
        </div>
      )}

      {activeEv && <EvidenceDrawer ev={activeEv} onOpenEvidence={onOpenEvidence} />}
    </article>
  )
}

function ContrastBox({ contrast }: { contrast: ContrastCallout }) {
  return (
    <div className="re-contrast-box" data-testid={`contrast-${contrast.hypothesisId}`}>
      <div className="re-contrast-head">
        <span>⚡ 预期与实测冲突对照 · {contrast.hypothesisId}</span>
        {contrast.evidenceId && (
          <span className="re-mono-num" style={{ opacity: 0.85 }}>
            反证凭证 [{contrast.evidenceId}]
          </span>
        )}
      </div>
      <div className="re-contrast-grid">
        <div className="re-contrast-col">
          <div className="re-contrast-lbl">原假设预期</div>
          <div className="re-contrast-val">{contrast.expected}</div>
        </div>
        <div className="re-contrast-col" data-kind="observed">
          <div className="re-contrast-lbl">动态实测结果</div>
          <div className="re-contrast-val">{contrast.observed}</div>
        </div>
      </div>
      <div className="re-contrast-deduction">
        <b>逻辑推论：</b>
        {contrast.deduction}
      </div>
    </div>
  )
}

function EvidenceDrawer({
  ev,
  onOpenEvidence,
}: {
  ev: EvidenceMention
  onOpenEvidence?: (evId: string) => void
}) {
  return (
    <div className="re-ev-drawer">
      <div className="re-ev-drawer-head re-mono-num">
        <span>
          <b>[{ev.id}]</b> · {ev.source} · {ev.view} · {ev.kind}
        </span>
        {ev.verification && (
          <span style={{ color: 'var(--ok)' }}>
            ✓ 重放 {ev.verification.passed}/{ev.verification.total} 通过
          </span>
        )}
        {onOpenEvidence && (
          <button
            type="button"
            className="re-narrative-tab"
            style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 10 }}
            onClick={() => onOpenEvidence(ev.id)}
          >
            在账本中定位 →
          </button>
        )}
      </div>
      {ev.summary && <div style={{ color: 'var(--text)', fontSize: 11 }}>{ev.summary}</div>}
      {ev.excerpt && ev.excerpt !== ev.summary && (
        <pre className="re-ev-drawer-pre">{ev.excerpt}</pre>
      )}
    </div>
  )
}
