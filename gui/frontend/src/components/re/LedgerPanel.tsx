// LedgerPanel + LedgerDetailDialog — live inspector for the evidence ledger
// (ev_NNN) and hypothesis assumption stack (H-NNN). Works identically for both
// real Wails Go sessions (fed by TickDTO.ledger) and the Demo Sandbox.
import { useMemo, useState, type CSSProperties } from 'react'
import type { HypothesisStatus, LedgerDTO } from '../../lib/types'
import { PanelBox, ProSelect, type ProSelectOption } from '../crt'
import { Btn, Dialog, fieldStyle } from '../session/Dialog'
import type { WorkbenchTab } from './HypothesisWorkbenchDialog'
import {
  buildProvenanceChain,
  formatEvidenceCitation,
  formatHypothesisCitation,
} from './forensics'
import { buildHypothesisArcs } from './cognitiveSynthesis'
import './re-pro.css'

export type LedgerTab = 'evidence' | 'hypotheses'

// ---------- visual mappings ----------

const HYP_TONE: Record<HypothesisStatus, 'accent' | 'violet' | 'warn' | 'err'> = {
  active: 'accent',
  revised: 'violet',
  reevaluate: 'warn',
  rejected: 'err',
}

function kindMeta(kind?: string, isError?: boolean): { label: string; tone: 'accent' | 'violet' | 'ok' | 'warn' | 'err' | 'muted' } {
  if (isError) return { label: 'ERR', tone: 'err' }
  switch (kind) {
    case 'verification_result':
      return { label: 'VER', tone: 'ok' }
    case 'audit_finding':
      return { label: 'AUD', tone: 'violet' }
    case 'runtime_trace':
      return { label: 'TRC', tone: 'warn' }
    case 'artifact':
      return { label: 'ART', tone: 'accent' }
    case 'model_claim':
      return { label: 'CLM', tone: 'violet' }
    default:
      return { label: 'OBS', tone: 'muted' }
  }
}

function fmtConf(c: number): string {
  return `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`
}

function confBar(c: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, c)) * 5)
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled)
}

function fmtStamp(ms: number): string {
  if (!ms) return ''
  try {
    return new Date(ms).toTimeString().slice(0, 8)
  } catch {
    return ''
  }
}

function shortText(s: string, max = 96): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

const KIND_HINT: Record<string, string> = {
  OBS: 'tool_observation · 静态或工具原始观测记录',
  VER: 'verification_result · verify_artifact 确定性重放验证凭证',
  AUD: 'audit_finding · 独立对抗审计或人工审查签章',
  TRC: 'runtime_trace · 动态执行或实验实跑轨迹',
  ART: 'artifact · 逆向解包产物或输出文件指纹',
  CLM: 'model_claim · 模型声明记录',
  ERR: 'error · 执行异常、报错或拦截记录（不可充当正向支撑）',
}

const EV_FILTER_HINT: Record<'all' | 'static' | 'dynamic' | 'verified' | 'err', string> = {
  all: '显示全部已入账证据 (ev_NNN)',
  static: '仅显示静态观测视角 (static)',
  dynamic: '仅显示动态执行与运行轨迹 (dynamic)',
  verified: '仅显示重放验证凭证与审计签章 (VER / AUD)',
  err: '仅显示报错或失败记录 (ERR)',
}

const HYP_FILTER_HINT: Record<'all' | 'active' | 'conflict', string> = {
  all: '显示全部假设 (H-NNN)',
  active: '仅显示活跃或已修订假设 (active / revised)',
  conflict: '仅显示含反证冲突、待重审或已淘汰假设',
}

// ---------- compact side-rail panel ----------

export function LedgerPanel({
  ledger,
  onOpenDetail,
  onOpenGraph,
  onOpenWorkbench,
  style,
}: {
  ledger: LedgerDTO | null | undefined
  onOpenDetail?: (tab: LedgerTab, highlightId?: string) => void
  onOpenGraph?: () => void
  onOpenWorkbench?: (tab: WorkbenchTab, hypId?: string) => void
  style?: CSSProperties
}) {
  const [tab, setTab] = useState<LedgerTab>('evidence')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [evQuickFilter, setEvQuickFilter] = useState<'all' | 'static' | 'dynamic' | 'verified' | 'err'>('all')
  const [hypQuickFilter, setHypQuickFilter] = useState<'all' | 'active' | 'conflict'>('all')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []

  const copyCite = (id: string, citation: string) => {
    navigator.clipboard?.writeText(citation).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400)
  }

  const recentEv = useMemo(() => {
    return evidence
      .filter((ev) => {
        if (evQuickFilter === 'all') return true
        if (evQuickFilter === 'err') return Boolean(ev.isError)
        if (evQuickFilter === 'verified') return ev.kind === 'verification_result' || ev.kind === 'audit_finding'
        if (evQuickFilter === 'dynamic') return ev.view === 'dynamic' || ev.kind === 'runtime_trace'
        return (ev.view || 'static') === 'static' && !ev.isError
      })
      .slice(-12)
      .reverse()
  }, [evidence, evQuickFilter])

  const filteredHyps = useMemo(() => {
    return hypotheses.filter((h) => {
      if (hypQuickFilter === 'all') return true
      if (hypQuickFilter === 'active') return h.status === 'active' || h.status === 'revised'
      return h.status === 'rejected' || h.status === 'reevaluate' || (h.contradicting?.length ?? 0) > 0
    })
  }, [hypotheses, hypQuickFilter])

  const arcsById = useMemo(
    () =>
      new Map(
        buildHypothesisArcs(evidence, hypotheses, findings, ledger?.auditorProvider).map((a) => [a.id, a]),
      ),
    [evidence, hypotheses, findings, ledger?.auditorProvider],
  )

  return (
    <div style={style}>
      <PanelBox title="ledger" accent="ok" tier="spotlight">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Tab strip + full detail trigger */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setTab('evidence')}
              data-hint="只追加不可篡改证据账本 (ev_NNN)"
              style={tabBtnStyle(tab === 'evidence', 'ok')}
            >
              证据 {evidence.length}
            </button>
            <button
              type="button"
              onClick={() => setTab('hypotheses')}
              data-hint="显式可证伪假设栈 (H-NNN)，支持反证折半与级联重审"
              style={tabBtnStyle(tab === 'hypotheses', 'accent')}
            >
              假设 {hypotheses.length}
            </button>
            <span style={{ flex: 1 }} />
            {onOpenWorkbench && (
              <button
                type="button"
                onClick={() => onOpenWorkbench(tab === 'hypotheses' ? 'hypothesis' : 'verify')}
                data-hint={
                  tab === 'hypotheses'
                    ? '新增/编辑可证伪假设并挂载实跑实验'
                    : '实跑产物重放验证 (证据仅可通过真实执行入账，不可手改)'
                }
                style={{ ...detailBtnStyle, borderColor: 'color-mix(in srgb, var(--accent) 48%, var(--rule))', color: 'var(--accent)' }}
              >
                {tab === 'hypotheses' ? '+ 实验' : '+ 验证'}
              </button>
            )}
            {onOpenGraph && (
              <button
                type="button"
                onClick={onOpenGraph}
                data-hint="以因果图谱 (DAG) 形式查看证据与假设关联"
                style={{ ...detailBtnStyle, borderColor: 'color-mix(in srgb, var(--violet) 48%, var(--rule))', color: 'var(--violet)' }}
              >
                ☍ 图谱
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenDetail?.(tab)}
              data-hint="展开完整证据账本与假设栈检视器"
              style={detailBtnStyle}
            >
              ⤢ 详情
            </button>
          </div>

          {tab === 'evidence' ? (
            <>
              {evidence.length > 0 && (
                <div className="re-filter-strip re-mono-num">
                  {(
                    [
                      ['all', 'ALL'],
                      ['static', 'STA'],
                      ['dynamic', 'DYN'],
                      ['verified', 'VER/AUD'],
                      ['err', 'ERR'],
                    ] as const
                  ).map(([k, lbl]) => (
                    <button
                      key={k}
                      type="button"
                      className="re-filter-chip"
                      data-active={evQuickFilter === k ? '1' : undefined}
                      data-hint={EV_FILTER_HINT[k]}
                      onClick={() => setEvQuickFilter(k)}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              )}
              {recentEv.length === 0 ? (
                <div style={{ color: 'var(--faint)', fontSize: 11, padding: '2px 0' }}>
                  {evidence.length === 0
                    ? '○ 暂无证据'
                    : '○ 无匹配记录'}
                </div>
              ) : (
                <div style={listStyle}>
                  {recentEv.map((ev) => {
                    const meta = kindMeta(ev.kind, ev.isError)
                    const open = expandedId === ev.id
                    const headline = ev.summary || ev.excerpt
                    return (
                      <div
                        key={ev.id}
                        onClick={() => setExpandedId(open ? null : ev.id)}
                        style={{
                          ...itemStyle,
                          borderColor: open ? `var(--${meta.tone})` : 'var(--border-subtle)',
                        }}
                      >
                        <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                          <span style={{ color: 'var(--ok)', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                            {ev.id}
                          </span>
                          <span style={chipStyle(meta.tone)} data-hint={KIND_HINT[meta.label]}>
                            {meta.label}
                          </span>
                          <span style={{ color: 'var(--muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {ev.source}
                          </span>
                          {ev.view && (
                            <span
                              style={{ color: 'var(--faint)', fontSize: 9 }}
                              data-hint={ev.view === 'dynamic' ? '动态运行视角' : '静态分析视角'}
                            >
                              {ev.view}
                            </span>
                          )}
                          <button
                            type="button"
                            className="re-copy-chip"
                            data-copied={copiedId === ev.id ? '1' : undefined}
                            onClick={(e) => {
                              e.stopPropagation()
                              copyCite(ev.id, formatEvidenceCitation(ev))
                            }}
                            data-hint={`复制取证引用：${formatEvidenceCitation(ev)}`}
                            style={{ padding: '0 4px', fontSize: 9 }}
                          >
                            {copiedId === ev.id ? '✓' : '⎘'}
                          </button>
                        </div>
                        <div
                          style={{
                            color: ev.isError ? 'var(--err)' : 'var(--text)',
                            fontSize: 11,
                            lineHeight: 1.4,
                            whiteSpace: open ? 'pre-wrap' : 'nowrap',
                            overflow: open ? 'visible' : 'hidden',
                            textOverflow: open ? 'clip' : 'ellipsis',
                            wordBreak: 'break-word',
                          }}
                        >
                          {open ? ev.summary || ev.excerpt : shortText(headline, 72)}
                        </div>
                        {open && ev.summary && ev.excerpt && ev.excerpt !== ev.summary && (
                          <pre style={miniExcerptStyle}>{ev.excerpt}</pre>
                        )}
                        {open && ev.verification && (
                          <div className="re-mono-num" style={{ color: 'var(--ok)', fontSize: 10 }}>
                            ✓ verify: {ev.verification.passed}/{ev.verification.total} passed
                            {ev.verification.build ? ' · build ok' : ''}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : hypotheses.length === 0 ? (
            <div style={{ color: 'var(--faint)', fontSize: 11, padding: '2px 0' }}>
              ○ 暂无假设
            </div>
          ) : (
            <>
              <div className="re-filter-strip re-mono-num">
                {(
                  [
                    ['all', 'ALL'],
                    ['active', 'ACTIVE'],
                    ['conflict', 'CONFLICT'],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className="re-filter-chip"
                    data-active={hypQuickFilter === k ? '1' : undefined}
                    data-hint={HYP_FILTER_HINT[k]}
                    onClick={() => setHypQuickFilter(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div style={listStyle}>
                {filteredHyps.map((h) => {
                  const tone = HYP_TONE[h.status] ?? 'accent'
                  const open = expandedId === h.id
                  const chain = buildProvenanceChain(h, evidence, findings)
                  const arc = arcsById.get(h.id)
                  return (
                    <div
                      key={h.id}
                      onClick={() => setExpandedId(open ? null : h.id)}
                      style={{
                        ...itemStyle,
                        borderColor: open ? `var(--${tone})` : 'var(--border-subtle)',
                      }}
                    >
                      <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ color: `var(--${tone})`, fontSize: 10, fontWeight: 700 }}>{h.id}</span>
                        <span style={chipStyle(tone)}>{h.status}</span>
                        <span
                          className="re-verdict-badge"
                          data-verdict={chain.verdict}
                          style={{ fontSize: 8.5, padding: '0 4px' }}
                          data-hint={chain.calibration.reason}
                        >
                          {chain.verdict === 'ANTI_ANALYSIS' ? 'ANTI' : chain.verdict}
                        </span>
                        <span style={{ color: 'var(--muted)', fontSize: 10, marginLeft: 'auto' }}>
                          {fmtConf(h.confidence)}
                        </span>
                        <button
                          type="button"
                          className="re-copy-chip"
                          data-copied={copiedId === h.id ? '1' : undefined}
                          onClick={(e) => {
                            e.stopPropagation()
                            copyCite(h.id, formatHypothesisCitation(h))
                          }}
                          data-hint={`复制假设引用：${formatHypothesisCitation(h)}`}
                          style={{ padding: '0 4px', fontSize: 9 }}
                        >
                          {copiedId === h.id ? '✓' : '⎘'}
                        </button>
                      </div>
                      <div
                        style={{
                          color: h.status === 'rejected' ? 'var(--faint)' : 'var(--text)',
                          textDecoration: h.status === 'rejected' ? 'line-through' : 'none',
                          fontSize: 11,
                          lineHeight: 1.4,
                          whiteSpace: open ? 'pre-wrap' : 'nowrap',
                          overflow: open ? 'visible' : 'hidden',
                          textOverflow: open ? 'clip' : 'ellipsis',
                          wordBreak: 'break-word',
                        }}
                      >
                        {open ? h.claim : shortText(h.claim, 68)}
                      </div>
                      {open && (
                        <div className="re-chain" style={{ fontSize: 9.5 }}>
                          <span className="re-chain-step" data-hit={chain.staticEvs.length > 0 ? 'static' : undefined} data-hint={`静态视角证据 ${chain.staticEvs.length} 条`}>
                            S:{chain.staticEvs.length}
                          </span>
                          <span className="re-chain-arrow">→</span>
                          <span
                            className="re-chain-step"
                            data-hit={chain.contradictEvs.length > 0 ? 'conflict' : chain.dynamicEvs.length > 0 ? '1' : undefined}
                            data-hint={`动态实测证据 ${chain.dynamicEvs.length} 条 · 反证 ${chain.contradictEvs.length} 条`}
                          >
                            D:{chain.dynamicEvs.length}
                          </span>
                          <span className="re-chain-arrow">→</span>
                          <span className="re-chain-step" data-hit={chain.verifyEvs.length > 0 ? '1' : undefined} data-hint={`verify_artifact 重放凭证 ${chain.verifyEvs.length} 条`}>
                            V:{chain.verifyEvs.length}
                          </span>
                          <span className="re-calib-pill" data-tone={chain.calibration.tone} data-hint={chain.calibration.reason}>
                            {chain.calibration.status}
                          </span>
                        </div>
                      )}
                      {open && arc && (
                        <div
                          className="re-causal-strip"
                          data-tone={arc.tone === 'err' ? 'err' : arc.tone === 'ok' ? 'ok' : arc.tone === 'warn' ? 'warn' : undefined}
                          style={{ fontSize: 10 }}
                        >
                          <div className="re-causal-row">
                            <span className="re-causal-k">来龙去脉</span>
                            <span>{arc.oneLineStory}</span>
                          </div>
                        </div>
                      )}
                      {open && h.note && (
                        <div style={{ color: 'var(--muted)', fontSize: 10, borderLeft: '2px solid var(--rule)', paddingLeft: 6 }}>
                          note: {h.note}
                        </div>
                      )}
                      {h.supporting && h.supporting.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {h.supporting.map((evId) => (
                            <button
                              key={evId}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                onOpenDetail?.('evidence', evId)
                              }}
                              title={`查看引用证据 ${evId}`}
                              style={refLinkStyle}
                            >
                              {evId}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </PanelBox>
    </div>
  )
}

// ---------- full-detail inspector modal ----------

export function LedgerDetailDialog({
  ledger,
  initialTab = 'evidence',
  initialHighlightId,
  onOpenWorkbench,
  onClose,
}: {
  ledger: LedgerDTO | null | undefined
  initialTab?: LedgerTab
  initialHighlightId?: string
  onOpenWorkbench?: (tab: WorkbenchTab, hypId?: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<LedgerTab>(initialTab)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<string>('all')
  const [viewFilter, setViewFilter] = useState<'all' | 'static' | 'dynamic' | 'error'>('all')
  const [hypStatusFilter, setHypStatusFilter] = useState<'all' | HypothesisStatus>('all')
  const [highlightId, setHighlightId] = useState<string | null>(initialHighlightId ?? null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []

  const copyCite = (id: string, citation: string) => {
    navigator.clipboard?.writeText(citation).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400)
  }

  const filteredEv = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...evidence]
      .reverse()
      .filter((ev) => {
        if (kindFilter !== 'all' && (ev.kind || 'tool_observation') !== kindFilter) return false
        if (viewFilter === 'error' && !ev.isError) return false
        if (viewFilter === 'static' && (ev.view || 'static') !== 'static') return false
        if (viewFilter === 'dynamic' && ev.view !== 'dynamic' && ev.kind !== 'runtime_trace' && ev.kind !== 'verification_result') return false
        if (!q) return true
        return [ev.id, ev.source, ev.kind, ev.view, ev.summary, ev.excerpt, ev.artifact]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      })
  }, [evidence, query, kindFilter, viewFilter])

  const filteredHyp = useMemo(() => {
    const q = query.trim().toLowerCase()
    return hypotheses.filter((h) => {
      if (hypStatusFilter !== 'all' && h.status !== hypStatusFilter) return false
      if (!q) return true
      return [h.id, h.claim, h.status, h.note, ...(h.supporting ?? []), ...(h.contradicting ?? [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [hypotheses, query, hypStatusFilter])

  const detailArcsById = useMemo(
    () =>
      new Map(
        buildHypothesisArcs(evidence, hypotheses, findings, ledger?.auditorProvider).map((a) => [a.id, a]),
      ),
    [evidence, hypotheses, findings, ledger?.auditorProvider],
  )

  const kindOptions = useMemo<ProSelectOption[]>(
    () => [
      { value: 'all', label: `全部类型 (${evidence.length})`, badge: String(evidence.length) },
      { value: 'tool_observation', label: 'tool_observation', badge: 'OBS', description: '静态/工具原始观测' },
      { value: 'verification_result', label: 'verification_result', badge: 'VER', description: 'verify_artifact 确定性重放' },
      { value: 'audit_finding', label: 'audit_finding', badge: 'AUD', description: '独立模型或人工审查签章' },
      { value: 'artifact', label: 'artifact', badge: 'ART', description: '逆向产物与解包文件' },
      { value: 'runtime_trace', label: 'runtime_trace', badge: 'TRC', description: '动态执行与实验轨迹' },
    ],
    [evidence.length],
  )

  function jumpToEvidence(evId: string) {
    setTab('evidence')
    setKindFilter('all')
    setViewFilter('all')
    setQuery('')
    setHighlightId(evId)
  }

  return (
    <Dialog title="evidence ledger & hypothesis stack" accent="accent" width={780} onClose={onClose}>
      {/* Top bar: path + tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setTab('evidence')}
          data-hint="只追加不可篡改：ev_NNN 仅由工具实跑、实验命令或 verify_artifact 自动生成并附 SHA256 指纹"
          style={tabBtnStyle(tab === 'evidence', 'ok')}
        >
          🔒 证据 E:{evidence.length}
        </button>
        <button
          type="button"
          onClick={() => setTab('hypotheses')}
          data-hint="可演进实验驱动：支持新增/修订假设并挂载可证伪实验，反证自动触发置信度折半 (×0.5)"
          style={tabBtnStyle(tab === 'hypotheses', 'accent')}
        >
          ◈ 假设 H:{hypotheses.length}
        </button>
        <span
          className="re-hint-dot"
          data-hint={
            tab === 'evidence'
              ? 'ev_NNN 严格只追加不可手改或删除；点击右上角按钮可发起新的实跑验证'
              : '点击假设下的 ev_NNN 标签可直接跳转定位对应原始实测记录'
          }
        >
          ?
        </span>
        <span style={{ flex: 1 }} />
        {onOpenWorkbench && (
          <>
            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenWorkbench('hypothesis')
              }}
              data-hint="打开假设实验台新增或修订假设"
              style={{ ...detailBtnStyle, borderColor: 'color-mix(in srgb, var(--accent) 55%, var(--rule))', color: 'var(--accent)', padding: '2px 8px' }}
            >
              + 假设/实验
            </button>
            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenWorkbench('verify')
              }}
              data-hint="执行 verify_artifact 确定性产物重放验证"
              style={{ ...detailBtnStyle, borderColor: 'color-mix(in srgb, var(--ok) 55%, var(--rule))', color: 'var(--ok)', padding: '2px 8px' }}
            >
              ▶ 实跑验证
            </button>
            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenWorkbench('review')
              }}
              data-hint="触发宿主确定性仲裁、独立模型审计或人工审查签章"
              style={{ ...detailBtnStyle, borderColor: 'color-mix(in srgb, var(--violet) 55%, var(--rule))', color: 'var(--violet)', padding: '2px 8px' }}
            >
              ⚖ 仲裁/审查
            </button>
          </>
        )}
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          style={{ ...fieldStyle, flex: 1, minWidth: 200 }}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlightId(null)
          }}
          placeholder={tab === 'evidence' ? '搜索 ev_NNN / 工具来源 / 摘录内容…' : '搜索 H-NNN / 假设内容 / 引用证据…'}
        />
        {tab === 'evidence' ? (
          <>
            <ProSelect
              ariaLabel="evidence kind filter"
              size="sm"
              searchable={false}
              popoverMinWidth={240}
              style={{ width: 175 }}
              value={kindFilter}
              options={kindOptions}
              onChange={setKindFilter}
            />
            <div className="re-filter-strip re-mono-num">
              {(
                [
                  ['all', '全部视角'],
                  ['static', 'Static'],
                  ['dynamic', 'Dynamic'],
                  ['error', 'ERR'],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  className="re-filter-chip"
                  data-active={viewFilter === k ? '1' : undefined}
                  onClick={() => setViewFilter(k)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="re-filter-strip re-mono-num">
            {(
              [
                ['all', `全部 (${hypotheses.length})`],
                ['active', 'ACTIVE'],
                ['revised', 'REVISED'],
                ['reevaluate', 'REEVAL'],
                ['rejected', 'REJECTED'],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                className="re-filter-chip"
                data-active={hypStatusFilter === k ? '1' : undefined}
                onClick={() => setHypStatusFilter(k)}
              >
                {lbl}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ maxHeight: 440, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tab === 'evidence' ? (
          filteredEv.length === 0 ? (
            <div style={{ color: 'var(--faint)', fontSize: 12, padding: '12px 4px' }}>
              ○ 当前没有匹配的证据记录
            </div>
          ) : (
            filteredEv.map((ev) => {
              const meta = kindMeta(ev.kind, ev.isError)
              const hi = highlightId === ev.id
              return (
                <div
                  key={ev.id}
                  style={{
                    border: `1px solid ${hi ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    borderRadius: 'var(--radius-sm)',
                    boxShadow: hi ? '0 0 12px var(--accent-soft)' : 'none',
                    background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
                    padding: '9px 11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
                    <span style={{ color: 'var(--ok)', fontWeight: 700 }}>{ev.id}</span>
                    <span style={chipStyle(meta.tone)} data-hint={KIND_HINT[meta.label]}>
                      {ev.kind || 'tool_observation'}
                    </span>
                    <span style={{ color: 'var(--accent)' }}>{ev.source}</span>
                    {ev.view && <span style={{ color: 'var(--faint)' }}>view:{ev.view}</span>}
                    {ev.bytes > 0 && <span style={{ color: 'var(--faint)' }}>{ev.bytes}B</span>}
                    {ev.artifact && <span style={{ color: 'var(--violet)' }}>artifact:{ev.artifact}</span>}
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        className="re-copy-chip"
                        data-copied={copiedId === ev.id ? '1' : undefined}
                        onClick={() => copyCite(ev.id, formatEvidenceCitation(ev))}
                        data-hint={`复制取证引用：${formatEvidenceCitation(ev)}`}
                      >
                        {copiedId === ev.id ? '✓ 已复制' : '⎘ 引用'}
                      </button>
                      <span style={{ color: 'var(--faint)', fontSize: 10 }}>
                        {fmtStamp(ev.createdAt)}
                      </span>
                    </span>
                  </div>

                  {ev.summary && (
                    <div style={{ color: ev.isError ? 'var(--err)' : 'var(--text)', fontSize: 12 }}>
                      {ev.summary}
                    </div>
                  )}

                  {ev.excerpt && (
                    <pre style={fullExcerptStyle}>{ev.excerpt}</pre>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 10, color: 'var(--faint)' }}>
                    {ev.verification && (
                      <span style={{ color: 'var(--ok)' }}>
                        ✓ verify {ev.verification.passed}/{ev.verification.total}
                        {ev.verification.build ? ' · build ok' : ''}
                      </span>
                    )}
                    {ev.sha256 && <span>sha256:{ev.sha256.slice(0, 16)}…</span>}
                    {ev.supports && ev.supports.length > 0 && (
                      <span style={{ color: 'var(--ok)' }}>supports: {ev.supports.join(', ')}</span>
                    )}
                    {ev.contradicts && ev.contradicts.length > 0 && (
                      <span style={{ color: 'var(--err)' }}>contradicts: {ev.contradicts.join(', ')}</span>
                    )}
                  </div>
                </div>
              )
            })
          )
        ) : filteredHyp.length === 0 ? (
          <div style={{ color: 'var(--faint)', fontSize: 12, padding: '12px 4px' }}>
            ○ 当前没有匹配的假设记录
          </div>
        ) : (
          filteredHyp.map((h) => {
            const tone = HYP_TONE[h.status] ?? 'accent'
            const chain = buildProvenanceChain(h, evidence, findings)
            const arc = detailArcsById.get(h.id)
            return (
              <div
                key={h.id}
                style={{
                  border: `1px solid var(--border-subtle)`,
                  borderLeft: `3px solid var(--${tone})`,
                  borderRadius: 'var(--radius-sm)',
                  background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
                  padding: '9px 11px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11 }}>
                  <span style={{ color: `var(--${tone})`, fontWeight: 700 }}>{h.id}</span>
                  <span style={chipStyle(tone)}>{h.status}</span>
                  <span className="re-verdict-badge" data-verdict={chain.verdict}>
                    {chain.verdict === 'ANTI_ANALYSIS' ? 'ANTI-ANALYSIS' : chain.verdict}
                  </span>
                  <span style={{ color: 'var(--accent)', letterSpacing: 1 }}>{confBar(h.confidence)}</span>
                  <span style={{ color: 'var(--muted)' }}>{fmtConf(h.confidence)}</span>
                  <span
                    className="re-calib-pill"
                    data-tone={chain.calibration.tone}
                    data-hint={chain.calibration.reason}
                  >
                    {chain.calibration.status}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      className="re-copy-chip"
                      data-copied={copiedId === h.id ? '1' : undefined}
                      onClick={() => copyCite(h.id, formatHypothesisCitation(h))}
                      data-hint={`复制假设引用：${formatHypothesisCitation(h)}`}
                    >
                      {copiedId === h.id ? '✓ 已复制' : '⎘ 引用'}
                    </button>
                    <span style={{ color: 'var(--faint)', fontSize: 10 }}>
                      {fmtStamp(h.updatedAt)}
                    </span>
                  </span>
                </div>

                <div
                  style={{
                    color: h.status === 'rejected' ? 'var(--faint)' : 'var(--text)',
                    textDecoration: h.status === 'rejected' ? 'line-through' : 'none',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {h.claim}
                </div>

                {/* Provenance Chain: Static Finding -> Dynamic Trace -> Verification Oracle -> Audit */}
                <div className="re-chain">
                  <span className="re-chain-step" data-hit={chain.staticEvs.length > 0 ? 'static' : undefined}>
                    Static ({chain.staticEvs.length})
                  </span>
                  <span className="re-chain-arrow">→</span>
                  <span
                    className="re-chain-step"
                    data-hit={
                      chain.contradictEvs.length > 0
                        ? 'conflict'
                        : chain.dynamicEvs.length > 0
                          ? '1'
                          : undefined
                    }
                  >
                    Dynamic ({chain.dynamicEvs.length}{chain.contradictEvs.length > 0 ? `/✗${chain.contradictEvs.length}` : ''})
                  </span>
                  <span className="re-chain-arrow">→</span>
                  <span className="re-chain-step" data-hit={chain.verifyEvs.length > 0 ? '1' : undefined}>
                    Oracle ({chain.verifyEvs.length})
                  </span>
                  <span className="re-chain-arrow">→</span>
                  <span className="re-chain-step" data-hit={chain.auditEvs.length > 0 ? 'audit' : undefined}>
                    Audit ({chain.auditEvs.length})
                  </span>
                  {chain.falsificationCriteria && (
                    <span style={{ color: 'var(--faint)', fontSize: 10, marginLeft: 4 }}>
                      证伪判据: {chain.falsificationCriteria}
                    </span>
                  )}
                </div>

                {arc && (
                  <div
                    className="re-causal-strip"
                    data-tone={arc.tone === 'err' ? 'err' : arc.tone === 'ok' ? 'ok' : arc.tone === 'warn' ? 'warn' : undefined}
                  >
                    <div className="re-causal-row">
                      <span className="re-causal-k">提出依据</span>
                      <span>{arc.triggerClues}</span>
                    </div>
                    <div className="re-causal-row">
                      <span className="re-causal-k">检验结果</span>
                      <span>{arc.testAndObservation}</span>
                    </div>
                    <div className="re-causal-row">
                      <span className="re-causal-k">当前定论</span>
                      <span>{arc.deductionVerdict}</span>
                    </div>
                  </div>
                )}

                {h.note && (
                  <div style={{ color: 'var(--muted)', fontSize: 11, borderLeft: '2px solid var(--rule)', paddingLeft: 8 }}>
                    {h.note}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 10 }}>
                  {h.supporting && h.supporting.length > 0 && (
                    <>
                      <span style={{ color: 'var(--faint)' }}>supporting:</span>
                      {h.supporting.map((evId) => (
                        <button key={evId} type="button" onClick={() => jumpToEvidence(evId)} style={refLinkStyle}>
                          {evId}
                        </button>
                      ))}
                    </>
                  )}
                  {h.contradicting && h.contradicting.length > 0 && (
                    <>
                      <span style={{ color: 'var(--err)' }}>contradicting:</span>
                      {h.contradicting.map((evId) => (
                        <button key={evId} type="button" onClick={() => jumpToEvidence(evId)} style={refLinkStyle}>
                          {evId}
                        </button>
                      ))}
                    </>
                  )}
                  {h.dependsOn && h.dependsOn.length > 0 && (
                    <span style={{ color: 'var(--faint)' }}>dependsOn: {h.dependsOn.join(', ')}</span>
                  )}
                  {h.experiments && h.experiments.length > 0 && (
                    <span style={{ color: 'var(--ok)' }}>
                      🧪 实验: {h.experiments.map((ex) => `${ex.id}[${ex.status}${ex.evidenceId ? `→${ex.evidenceId}` : ''}]`).join(', ')}
                    </span>
                  )}
                  {onOpenWorkbench && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose()
                        onOpenWorkbench('hypothesis', h.id)
                      }}
                      style={{ ...detailBtnStyle, marginLeft: 'auto', borderColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                    >
                      ✎ 编辑 / +实验
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        <Btn onClick={onClose}>close</Btn>
      </div>
    </Dialog>
  )
}

// ---------- styles ----------

function tabBtnStyle(active: boolean, tone: 'ok' | 'accent'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-xs)',
    background: active ? `color-mix(in srgb, var(--${tone}) 12%, transparent)` : 'transparent',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    padding: '2px 8px',
    cursor: 'pointer',
  }
}

function chipStyle(tone: string): CSSProperties {
  return {
    color: `var(--${tone})`,
    border: `1px solid color-mix(in srgb, var(--${tone}) 48%, var(--rule))`,
    borderRadius: 'var(--radius-xs)',
    padding: '0 4px',
    fontSize: 9,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    flexShrink: 0,
  }
}

const detailBtnStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  background: 'transparent',
  color: 'var(--muted)',
  fontSize: 10,
  padding: '1px 6px',
  cursor: 'pointer',
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  maxHeight: 240,
  overflowY: 'auto',
}

const itemStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-2) 48%, transparent)',
  padding: '6px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  cursor: 'pointer',
}

const miniExcerptStyle: CSSProperties = {
  margin: 0,
  padding: '5px 7px',
  background: 'var(--surface-0)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  color: 'var(--muted)',
  fontSize: 10,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 90,
  overflowY: 'auto',
}

const fullExcerptStyle: CSSProperties = {
  margin: 0,
  padding: '7px 9px',
  background: 'var(--surface-0)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  color: 'var(--muted)',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 140,
  overflowY: 'auto',
}

const refLinkStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--ok) 48%, var(--rule))',
  borderRadius: 'var(--radius-xs)',
  color: 'var(--ok)',
  background: 'var(--ok-soft)',
  fontSize: 10,
  padding: '0 5px',
  cursor: 'pointer',
}
