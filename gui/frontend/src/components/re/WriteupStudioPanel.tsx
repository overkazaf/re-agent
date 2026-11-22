// WriteupStudioPanel — aligns the session's live ledger (ev_NNN), hypothesis
// stack (H-NNN), capability sandbox (/cap), and audit verdicts (/audit) into:
//   1) The 6-stage cognitive alignment map from the 0xAF-Re article
//   2) One-click copyable executive reverse-engineering process summary
//   3) Evidence-anchored Markdown Writeup Studio (3 templates, live preview,
//      citation chips, .md download, and 1-click Agent write_file trigger).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TickDTO } from '../../lib/types'
import { ProSelect, type ProSelectOption } from '../crt'
import {
  generateWriteupMarkdown,
  synthesizeProcessSummary,
  type WriteupTemplateId,
} from './cognitiveSynthesis'
import { buildForensicJsonBundle } from './forensics'
import { buildInvestigationState } from './investigationState'
import { InvestigationDossierPanel } from './InvestigationDossierPanel'
import { ProofNarrativePanel } from './ProofNarrativePanel'
import './re-pro.css'

const WRITEUP_TEMPLATE_OPTIONS: readonly ProSelectOption<WriteupTemplateId>[] = [
  {
    value: 'article-standard',
    label: '模板：0xAF 证据闭环标准报告',
    badge: '0xAF',
    description: '六阶段认知对齐 + 完整推演叙事 + 证据账本闭环',
  },
  {
    value: 'ctf-writeup',
    label: '模板：CTF 解题标准 Writeup',
    badge: 'CTF',
    description: '题目速览 + 核心机制剖析 + 求解脚本与 Flag 复现',
  },
  {
    value: 'algo-report',
    label: '模板：算法与接口工程还原报告',
    badge: 'ALGO',
    description: '数据结构、加密算法流程与工程级接口复原文档',
  },
]

const STAGE_SHORT: Record<number, string> = {
  1: '①契约',
  2: '②沙箱',
  3: '③账本',
  4: '④仲裁',
  5: '⑤审计',
  6: '⑥报告',
}

const mdPreviewComponents = {
  p: ({ children }: { children?: ReactNode }) => <p style={{ margin: '0.35em 0', lineHeight: 1.58 }}>{children}</p>,
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 style={{ fontSize: 15, margin: '0.4em 0 0.3em', color: 'var(--accent)', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 4 }}>
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 style={{ fontSize: 13, margin: '0.7em 0 0.25em', color: 'var(--accent)' }}>{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 style={{ fontSize: 12, margin: '0.5em 0 0.2em', color: 'var(--violet)' }}>{children}</h3>
  ),
  ul: ({ children }: { children?: ReactNode }) => <ul style={{ margin: '0.3em 0', paddingLeft: 18 }}>{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol style={{ margin: '0.3em 0', paddingLeft: 18 }}>{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li style={{ margin: '0.2em 0', lineHeight: 1.5 }}>{children}</li>,
  code: ({ children, className }: { children?: ReactNode; className?: string }) =>
    className ? (
      <code style={{ display: 'block', background: 'var(--surface-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xs)', padding: 8, overflowX: 'auto', fontSize: 11.5 }}>
        {children}
      </code>
    ) : (
      <code style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 'var(--radius-xs)', padding: '0 4px', fontSize: 11.5 }}>
        {children}
      </code>
    ),
  pre: ({ children }: { children?: ReactNode }) => <pre style={{ margin: '0.35em 0' }}>{children}</pre>,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote style={{ margin: '0.4em 0', borderLeft: '2px solid var(--accent)', paddingLeft: 10, color: 'var(--muted)' }}>
      {children}
    </blockquote>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <table style={{ borderCollapse: 'collapse', fontSize: 11, margin: '0.4em 0', width: '100%' }}>{children}</table>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th style={{ border: '1px solid var(--border-subtle)', padding: '4px 8px', textAlign: 'left', color: 'var(--accent)', background: 'var(--surface-2)' }}>
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td style={{ border: '1px solid var(--border-subtle)', padding: '4px 8px', verticalAlign: 'top' }}>{children}</td>
  ),
}

export function WriteupStudioPanel({
  tick,
  workspace = '/demo/reverse-lab',
  onRunAgentWriteup,
}: {
  tick: TickDTO | null
  workspace?: string
  onRunAgentWriteup?: () => void
}) {
  const [template, setTemplate] = useState<WriteupTemplateId>('article-standard')
  const [studioMode, setStudioMode] = useState<'dossier' | 'narrative' | 'report'>('report')
  const [viewMode, setViewMode] = useState<'split' | 'preview' | 'edit'>('preview')
  const [dirty, setDirty] = useState(false)
  const [draft, setDraft] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [stagesOpen, setStagesOpen] = useState(false)
  const [matrixOpen, setMatrixOpen] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const summary = useMemo(() => synthesizeProcessSummary(tick), [tick])
  const dossier = useMemo(() => buildInvestigationState(tick, workspace), [tick, workspace])
  const autoMarkdown = useMemo(
    () => generateWriteupMarkdown(tick, template, workspace),
    [tick, template, workspace],
  )

  useEffect(() => {
    if (!dirty) {
      setDraft(autoMarkdown)
    }
  }, [autoMarkdown, dirty])

  const evidence = tick?.ledger?.evidence ?? []
  const hypotheses = tick?.ledger?.hypotheses ?? []

  const copyText = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1500)
  }

  const insertCitation = (tag: string) => {
    setDirty(true)
    const el = editorRef.current
    if (!el) {
      setDraft((d) => `${d} \`[${tag}]\``)
      return
    }
    const start = el.selectionStart ?? draft.length
    const end = el.selectionEnd ?? draft.length
    const snippet = `\`[${tag}]\``
    const next = draft.slice(0, start) + snippet + draft.slice(end)
    setDraft(next)
    if (viewMode === 'preview') setViewMode('split')
  }

  const downloadMarkdown = () => {
    const blob = new Blob([draft], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const base = (tick?.ledger?.goal?.targetFile || tick?.re?.sampleType || '0xaf-re').replace(/[^a-zA-Z0-9._-]/g, '_')
    a.href = url
    a.download = `${base}-writeup.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadForensicBundle = () => {
    const bundle = buildForensicJsonBundle(tick, template, workspace, draft)
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const base = (tick?.ledger?.goal?.targetFile || tick?.re?.sampleType || '0xaf-re').replace(/[^a-zA-Z0-9._-]/g, '_')
    a.href = url
    a.download = `${base}-forensic-bundle.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sectionChecks = useMemo(() => {
    const txt = draft.toLowerCase()
    return [
      { key: 'exec', label: 'Executive Summary', ok: /总结|tl;dr|summary|一、/.test(txt) },
      { key: 'triage', label: 'Triage & Mitigations', ok: /契约|指纹|sha256|mitigation|沙箱|题目/.test(txt) },
      { key: 'root', label: 'Root-Cause & Hyps', ok: /假设|h-\d{3}|结论|算法/.test(txt) },
      { key: 'chain', label: 'Evidence Chain', ok: /ev_\d{3}|证据链|evidence/.test(txt) },
      { key: 'verify', label: 'Verify & Audit', ok: /verify_artifact|\/audit|审计|重放/.test(txt) },
      { key: 'repro', label: 'Reproduction Script', ok: /```(?:bash|sh|python)|复现|solver/.test(txt) },
    ]
  }, [draft])

  const doneStages = summary.stages.filter((s) => s.status === 'done').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 1. Compact 1-Line 6-Stage Progress Strip (progressive disclosure) */}
      <div className="re-compact-bar">
        <div className="re-stage-strip">
          <span style={{ color: 'var(--violet)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em' }}>
            ◈ 文章六大核心环节认知对齐
          </span>
          <span
            className="re-hint-dot"
            data-hint="模型负责叙述，宿主负责记账：悬停各环节芯片查看原则与当前事实，或展开完整六格视图"
          >
            ?
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {summary.stages.map((st) => {
              const glyph = st.status === 'done' ? '✓' : st.status === 'active' ? '▸' : '○'
              return (
                <span
                  key={st.stageNo}
                  className="re-stage-chip re-mono-num"
                  data-status={st.status}
                  data-hint={`${st.title} (${st.code}) · ${st.fact} — ${st.principle}`}
                >
                  <span>{glyph}</span>
                  <span>{STAGE_SHORT[st.stageNo] ?? st.title}</span>
                </span>
              )
            })}
          </div>
          <span className="re-mono-num" style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 10 }}>
            已完成 {doneStages} / 6 环节
          </span>
          <button
            type="button"
            className="re-disclosure-btn"
            onClick={() => setStagesOpen((v) => !v)}
            data-hint={stagesOpen ? '收起六大核心环节详情网格' : '展开全部六大核心环节的工程原则与当前证据事实'}
          >
            {stagesOpen ? '收起 ▴' : '展开详情 ▾'}
          </button>
        </div>

        {stagesOpen && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 7 }}>
            {summary.stages.map((st) => {
              const tone = st.status === 'done' ? 'ok' : st.status === 'active' ? 'accent' : 'muted'
              const glyph = st.status === 'done' ? '✓' : st.status === 'active' ? '▸' : '○'
              return (
                <div
                  key={st.stageNo}
                  style={{
                    border: `1px solid ${st.status === 'done' ? 'color-mix(in srgb, var(--ok) 40%, var(--rule))' : st.status === 'active' ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    borderRadius: 'var(--radius-xs)',
                    background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
                    padding: '6px 9px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5 }}>
                    <span style={{ color: `var(--${tone})`, fontWeight: 700 }}>
                      {glyph} {st.title}
                    </span>
                    <span className="re-mono-num" style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 9.5 }}>
                      {st.code}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text)', fontSize: 10.5, lineHeight: 1.42 }}>{st.fact}</div>
                  <div style={{ color: 'var(--faint)', fontSize: 9.5, lineHeight: 1.35 }}>{st.principle}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 2. Compact Executive Summary Bar + Collapsible 4-Pillar Matrix */}
      <div
        className="re-compact-bar"
        style={{
          borderColor: 'color-mix(in srgb, var(--ok) 40%, var(--border-subtle))',
          borderLeft: '3px solid var(--ok)',
          background: 'color-mix(in srgb, var(--ok) 5%, var(--surface-1))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
            ✦ 逆向过程总结语句
          </span>
          <span
            style={{
              flex: '1 1 240px',
              minWidth: 0,
              color: 'var(--text)',
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            {summary.headline}
          </span>
          <button
            type="button"
            className="re-disclosure-btn"
            onClick={() => setMatrixOpen((v) => !v)}
            data-hint="展开/收起「样本契约 · 核心结论 · 证据闭环 · 审计门禁」四维结论矩阵"
          >
            {matrixOpen ? '四维矩阵 ▴' : '四维矩阵 ▾'}
          </button>
          <button
            type="button"
            onClick={() => copyText('summary', summary.narrative.replace(/\*\*|`/g, ''))}
            style={smallBtnStyle}
            data-hint="复制精简的一句话逆向过程总结"
          >
            {copiedKey === 'summary' ? '✓ 已复制' : '⎘ 复制摘要'}
          </button>
          <button
            type="button"
            onClick={() => copyText('matrix', summary.structuredMarkdown)}
            style={{ ...smallBtnStyle, borderColor: 'color-mix(in srgb, var(--ok) 55%, var(--rule))', color: 'var(--ok)' }}
            data-hint="复制 Markdown 四维结构化结论表"
          >
            {copiedKey === 'matrix' ? '✓ 已复制' : '⎘ 结论表'}
          </button>
        </div>

        {matrixOpen && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 7 }}>
              {summary.pillars.map((p) => (
                <div
                  key={p.key}
                  style={{
                    border: `1px solid color-mix(in srgb, var(--${p.tone}) 38%, var(--rule))`,
                    borderLeft: `2px solid var(--${p.tone})`,
                    borderRadius: 'var(--radius-xs)',
                    background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)',
                    padding: '6px 9px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10 }}>
                    <b style={{ color: `var(--${p.tone})` }}>{p.label}</b>
                    <span className="re-mono-num" style={{ color: 'var(--faint)', fontSize: 9.5 }}>{p.refs}</span>
                  </div>
                  <div style={{ color: 'var(--text)', fontSize: 10.5, lineHeight: 1.45 }}>{p.value}</div>
                </div>
              ))}
            </div>
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.55,
                color: 'var(--muted)',
                borderTop: '1px dashed var(--border-subtle)',
                paddingTop: 6,
              }}
            >
              <Markdown remarkPlugins={[remarkGfm]} components={mdPreviewComponents}>
                {summary.narrative}
              </Markdown>
            </div>
          </>
        )}
      </div>

      {/* 2.5 Compact Studio Mode Switcher (档案 / 叙事 / 报告) + Inline 5-Defense & Audit Verdict Telemetry */}
      <div className="re-studio-mode-bar">
        <div className="re-studio-mode-tabs" role="tablist" aria-label="工坊视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={studioMode === 'dossier'}
            className="re-studio-mode-btn"
            data-active={studioMode === 'dossier' ? '1' : undefined}
            onClick={() => setStudioMode('dossier')}
            data-hint="查看 7-State Investigation State 规范任务档案、五道防线、§7.5 指标与 §8.7 完成门禁"
          >
            ◈ 档案 (7-State)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={studioMode === 'narrative'}
            className="re-studio-mode-btn"
            data-active={studioMode === 'narrative' ? '1' : undefined}
            onClick={() => setStudioMode('narrative')}
            data-hint="按时间叙事或逐条假设查看完整因果推演链、可证伪条件与预期/实测对照"
          >
            ◈ 叙事 (Proof)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={studioMode === 'report'}
            className="re-studio-mode-btn"
            data-active={studioMode === 'report' ? '1' : undefined}
            onClick={() => setStudioMode('report')}
            data-hint="预览、编辑并导出证据锚定 Markdown Writeup 与 JSON 取证包"
          >
            ✎ 报告 (Writeup)
          </button>
        </div>

        {/* Always-visible 1-line Dossier telemetry pill strip — click to jump straight into 7-State Dossier */}
        <div
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', cursor: 'pointer' }}
          onClick={() => setStudioMode('dossier')}
          data-hint="点击进入 7-State Investigation State 完整任务档案视图"
        >
          <span className="re-audit-pill re-mono-num" data-verdict={dossier.states.audit.verdict}>
            {dossier.states.audit.verdict === 'accepted'
              ? 'ACCEPTED'
              : dossier.states.audit.verdict === 'rejected'
                ? 'REJECTED'
                : 'NEEDS MORE EVIDENCE'}
          </span>
          <span
            className="re-dossier-gate-badge re-mono-num"
            data-pass={dossier.completionScore.passed === dossier.completionScore.total ? '1' : undefined}
          >
            {dossier.completionScore.passed}/{dossier.completionScore.total} 达标
          </span>
          <div className="re-defense-strip">
            {dossier.defenses.map((d) => {
              const tone = d.status === 'pass' ? 'ok' : d.status === 'warn' ? 'warn' : d.status === 'blocked' ? 'err' : 'accent'
              return (
                <span key={d.id} className="re-defense-chip re-mono-num" data-tone={tone} data-hint={d.hint}>
                  <span className="re-defense-dot" data-tone={tone} aria-hidden="true" />
                  <span>{d.code}</span>
                </span>
              )
            })}
          </div>
        </div>
      </div>

      {/* 3. Active Mode Body (zero stacked vertical clutter) */}
      {studioMode === 'dossier' ? (
        <InvestigationDossierPanel tick={tick} workspace={workspace} />
      ) : studioMode === 'narrative' ? (
        <ProofNarrativePanel tick={tick} />
      ) : (
        <div style={cardBoxStyle}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>✎ Writeup 工坊</span>

          <span
            data-hint={
              summary.writeupGate.unlocked
                ? '验证凭证 (verify_artifact) 与独立审计 (audit_finding) 均已入账，满足 WRI 正式归档门禁'
                : `正式归档前需满足：${summary.writeupGate.reasons.join('；') || '待补齐验证与审计凭证'}`
            }
            style={{
              fontSize: 10,
              padding: '1px 7px',
              borderRadius: 'var(--radius-xs)',
              border: `1px solid color-mix(in srgb, ${summary.writeupGate.unlocked ? 'var(--ok)' : 'var(--warn)'} 50%, var(--rule))`,
              background: summary.writeupGate.unlocked ? 'var(--ok-soft)' : 'var(--warn-soft)',
              color: summary.writeupGate.unlocked ? 'var(--ok)' : 'var(--warn)',
            }}
          >
            {summary.writeupGate.unlocked ? '✓ WRI 就绪' : '🔒 门禁未齐'}
          </span>

          <span style={{ flex: 1 }} />

          <ProSelect<WriteupTemplateId>
            ariaLabel="writeup template"
            size="sm"
            searchable={false}
            align="right"
            popoverMinWidth={290}
            value={template}
            options={WRITEUP_TEMPLATE_OPTIONS}
            onChange={(next) => {
              setTemplate(next)
              setDirty(false)
            }}
          />

          <button
            type="button"
            onClick={() => setViewMode('split')}
            style={tabToggleStyle(viewMode === 'split')}
            data-hint="左右分栏同步编辑与预览 Markdown"
          >
            ◫ 双栏
          </button>
          <button
            type="button"
            onClick={() => setViewMode('preview')}
            style={tabToggleStyle(viewMode === 'preview')}
            data-hint="专注阅读渲染后的 Writeup 报告"
          >
            👁 预览
          </button>
          <button
            type="button"
            onClick={() => setViewMode('edit')}
            style={tabToggleStyle(viewMode === 'edit')}
            data-hint="编辑原始 Markdown 源码"
          >
            ✎ 编辑
          </button>

          {dirty && (
            <button
              type="button"
              onClick={() => {
                setDirty(false)
                setDraft(autoMarkdown)
              }}
              style={smallBtnStyle}
              data-hint="放弃手动改动，按最新证据账本重新同步生成报告"
            >
              ↻ 同步账本
            </button>
          )}

          {onRunAgentWriteup && (
            <button
              type="button"
              onClick={onRunAgentWriteup}
              data-hint="让 Agent 执行 WRI 阶段并归档至工作区 notes/writeup.md"
              style={{
                ...smallBtnStyle,
                borderColor: 'color-mix(in srgb, var(--ok) 55%, var(--rule))',
                color: 'var(--ok)',
                background: 'var(--ok-soft)',
              }}
            >
              ⚡ 落盘 writeup.md
            </button>
          )}

          <button type="button" onClick={() => copyText('md', draft)} style={smallBtnStyle} data-hint="复制当前完整 Markdown 源码">
            {copiedKey === 'md' ? '✓ 已复制' : '⎘ MD'}
          </button>
          <button type="button" onClick={downloadMarkdown} style={smallBtnStyle} data-hint="下载 .md 报告文件到本地">
            ⬇ .md
          </button>
          <button
            type="button"
            onClick={downloadForensicBundle}
            data-hint="导出完整取证归档包 (含 SHA256 账本、假设校准、仲裁日志与 Markdown 报告)"
            style={{ ...smallBtnStyle, borderColor: 'color-mix(in srgb, var(--violet) 48%, var(--rule))', color: 'var(--violet)' }}
          >
            ⬇ .json
          </button>
        </div>

        {/* Report Section Completeness Strip */}
        <div className="re-writeup-sections re-mono-num" style={{ alignItems: 'center' }}>
          <span style={{ color: 'var(--faint)' }}>
            完备度 {sectionChecks.filter((s) => s.ok).length}/{sectionChecks.length}
          </span>
          {sectionChecks.map((s) => (
            <span
              key={s.key}
              className="re-sec-pill"
              data-present={s.ok ? '1' : undefined}
              data-hint={s.ok ? `${s.label} 章节已包含` : `当前草稿缺少 ${s.label} 相关内容`}
            >
              {s.ok ? '✓' : '○'} {s.label}
            </span>
          ))}
        </div>

        {/* Citation quick-insert bar */}
        {(evidence.length > 0 || hypotheses.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 10 }}>
            <span style={{ color: 'var(--faint)' }}>引用</span>
            {hypotheses.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => insertCitation(h.id)}
                style={citeChipStyle(h.status === 'rejected' ? 'err' : 'accent')}
                data-hint={`点击插入 [${h.id}] 引用：${h.claim}`}
              >
                +{h.id}
              </button>
            ))}
            {evidence.slice(-8).map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => insertCitation(ev.id)}
                style={citeChipStyle(ev.kind === 'audit_finding' ? 'violet' : 'ok')}
                data-hint={`点击插入 [${ev.id}] (${ev.source})：${(ev.summary || ev.excerpt).slice(0, 110)}`}
              >
                +{ev.id}
              </button>
            ))}
          </div>
        )}

        {/* Editor & Rendered Preview */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: viewMode === 'split' ? '1fr 1fr' : '1fr',
            gap: 8,
            minHeight: 240,
            maxHeight: 360,
          }}
        >
          {(viewMode === 'split' || viewMode === 'edit') && (
            <textarea
              ref={editorRef}
              aria-label="writeup markdown editor"
              value={draft}
              onChange={(e) => {
                setDirty(true)
                setDraft(e.target.value)
              }}
              style={editorStyle}
            />
          )}
          {(viewMode === 'split' || viewMode === 'preview') && (
            <div style={previewPaneStyle}>
              <Markdown remarkPlugins={[remarkGfm]} components={mdPreviewComponents}>
                {draft}
              </Markdown>
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  )
}

const cardBoxStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'color-mix(in srgb, var(--surface-1) 90%, transparent)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const smallBtnStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  color: 'var(--text)',
  fontSize: 10.5,
  padding: '2px 8px',
  cursor: 'pointer',
}

function tabToggleStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-xs)',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--muted)',
    fontSize: 10.5,
    padding: '2px 7px',
    cursor: 'pointer',
  }
}

function citeChipStyle(tone: 'accent' | 'ok' | 'violet' | 'err'): CSSProperties {
  return {
    border: `1px solid color-mix(in srgb, var(--${tone}) 46%, var(--rule))`,
    borderRadius: 'var(--radius-xs)',
    color: `var(--${tone})`,
    background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
    fontSize: 9.5,
    padding: '0 5px',
    cursor: 'pointer',
  }
}

const editorStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  minHeight: 230,
  resize: 'vertical',
  background: 'var(--surface-0)',
  color: 'var(--text)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  padding: 10,
  font: 'inherit',
  fontSize: 11,
  lineHeight: 1.55,
}

const previewPaneStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  background: 'var(--surface-0)',
  padding: '10px 14px',
  overflowY: 'auto',
  fontSize: 11.5,
  color: 'var(--text)',
}
