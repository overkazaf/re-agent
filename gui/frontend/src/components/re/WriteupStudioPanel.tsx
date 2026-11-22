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
import {
  generateWriteupMarkdown,
  synthesizeProcessSummary,
  type WriteupTemplateId,
} from './cognitiveSynthesis'
import { buildForensicJsonBundle } from './forensics'
import { ProofNarrativePanel } from './ProofNarrativePanel'
import './re-pro.css'

const mdPreviewComponents = {
  p: ({ children }: { children?: ReactNode }) => <p style={{ margin: '0.35em 0', lineHeight: 1.55 }}>{children}</p>,
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 style={{ fontSize: 15, margin: '0.4em 0 0.3em', color: 'var(--accent)', borderBottom: '1px solid var(--rule)', paddingBottom: 4 }}>
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
      <code style={{ display: 'block', background: 'rgba(3, 6, 10, 0.85)', border: '1px solid var(--rule)', padding: 8, overflowX: 'auto', fontSize: 11.5 }}>
        {children}
      </code>
    ) : (
      <code style={{ background: 'rgba(34, 211, 238, 0.08)', color: 'var(--accent)', padding: '0 4px', fontSize: 11.5 }}>
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
    <th style={{ border: '1px solid var(--rule)', padding: '3px 7px', textAlign: 'left', color: 'var(--accent)', background: 'rgba(15, 23, 42, 0.5)' }}>
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td style={{ border: '1px solid var(--rule)', padding: '3px 7px', verticalAlign: 'top' }}>{children}</td>
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
  const [viewMode, setViewMode] = useState<'split' | 'preview' | 'edit'>('preview')
  const [dirty, setDirty] = useState(false)
  const [draft, setDraft] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const summary = useMemo(() => synthesizeProcessSummary(tick), [tick])
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 1. Article 6-Stage Cognitive Alignment Strip */}
      <div style={cardBoxStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--violet)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em' }}>
            ◈ 文章六大核心环节认知对齐 (模型负责叙述 · 宿主负责记账)
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 10 }}>
            已完成 {summary.stages.filter((s) => s.status === 'done').length} / 6 环节
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))', gap: 6 }}>
          {summary.stages.map((st) => {
            const tone = st.status === 'done' ? 'ok' : st.status === 'active' ? 'accent' : 'muted'
            const glyph = st.status === 'done' ? '✓' : st.status === 'active' ? '▸' : '○'
            return (
              <div
                key={st.stageNo}
                style={{
                  border: `1px solid ${st.status === 'done' ? 'color-mix(in srgb, var(--ok) 45%, var(--rule))' : st.status === 'active' ? 'var(--accent)' : 'var(--rule)'}`,
                  background: 'rgba(3, 6, 10, 0.6)',
                  padding: '5px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5 }}>
                  <span style={{ color: `var(--${tone})`, fontWeight: 700 }}>
                    {glyph} {st.title}
                  </span>
                  <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 9.5 }}>{st.code}</span>
                </div>
                <div style={{ color: 'var(--text)', fontSize: 10, lineHeight: 1.38 }}>{st.fact}</div>
                <div style={{ color: 'var(--faint)', fontSize: 9.5, lineHeight: 1.32 }}>{st.principle}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 2. Structured Executive Conclusion Matrix + Narrative Summary */}
      <div
        style={{
          ...cardBoxStyle,
          borderColor: 'color-mix(in srgb, var(--ok) 52%, var(--rule))',
          borderLeft: '3px solid var(--ok)',
          background: 'linear-gradient(90deg, rgba(16, 42, 28, 0.36) 0%, rgba(5, 8, 12, 0.65) 55%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
            ✦ 逆向过程总结语句 · 四维结构化结论矩阵 (Structured Conclusion)
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => copyText('matrix', summary.structuredMarkdown)}
            style={{ ...smallBtnStyle, borderColor: 'var(--ok)', color: 'var(--ok)' }}
          >
            {copiedKey === 'matrix' ? '✓ 已复制结论表' : '⎘ 复制结构化结论表'}
          </button>
          <button
            type="button"
            onClick={() => copyText('summary', summary.narrative.replace(/\*\*|`/g, ''))}
            style={smallBtnStyle}
          >
            {copiedKey === 'summary' ? '✓ 已复制摘要' : '⎘ 复制一句话总结'}
          </button>
        </div>

        {/* 4-Pillar Structured Conclusion Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 6 }}>
          {summary.pillars.map((p) => (
            <div
              key={p.key}
              style={{
                border: `1px solid color-mix(in srgb, var(--${p.tone}) 45%, var(--rule))`,
                borderLeft: `2px solid var(--${p.tone})`,
                background: 'rgba(3, 6, 10, 0.72)',
                padding: '5px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10 }}>
                <b style={{ color: `var(--${p.tone})` }}>{p.label}</b>
                <span style={{ color: 'var(--faint)', fontSize: 9.5 }}>{p.refs}</span>
              </div>
              <div style={{ color: 'var(--text)', fontSize: 10.5, lineHeight: 1.4 }}>{p.value}</div>
            </div>
          ))}
        </div>

        {/* Concise Narrative Line */}
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--muted)',
            borderTop: '1px dashed var(--rule)',
            paddingTop: 5,
          }}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={mdPreviewComponents}>
            {summary.narrative}
          </Markdown>
        </div>
      </div>

      {/* 2.5 Full Deductive Proof Narrative (Hypothesis -> Experiment -> Contradiction/Pivot -> Proof) */}
      <ProofNarrativePanel tick={tick} />

      {/* 3. Writeup Document Studio */}
      <div style={cardBoxStyle}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>✎ Writeup 分析文档工坊</span>

          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              border: `1px solid ${summary.writeupGate.unlocked ? 'var(--ok)' : 'var(--warn)'}`,
              color: summary.writeupGate.unlocked ? 'var(--ok)' : 'var(--warn)',
            }}
          >
            {summary.writeupGate.unlocked
              ? '✓ WRI 硬闸门已通过（验证 + 审计齐备）'
              : `🔒 正式落盘门禁未满足：${summary.writeupGate.reasons[0] ?? ''}`}
          </span>

          <span style={{ flex: 1 }} />

          <select
            aria-label="writeup template"
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value as WriteupTemplateId)
              setDirty(false)
            }}
            style={selectStyle}
          >
            <option value="article-standard">模板：0xAF 证据闭环标准报告</option>
            <option value="ctf-writeup">模板：CTF 解题标准 Writeup</option>
            <option value="algo-report">模板：算法与接口工程还原报告</option>
          </select>

          <button
            type="button"
            onClick={() => setViewMode('split')}
            style={tabToggleStyle(viewMode === 'split')}
          >
            ◫ 双栏
          </button>
          <button
            type="button"
            onClick={() => setViewMode('preview')}
            style={tabToggleStyle(viewMode === 'preview')}
          >
            👁 预览
          </button>
          <button
            type="button"
            onClick={() => setViewMode('edit')}
            style={tabToggleStyle(viewMode === 'edit')}
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
              title="按最新账本重新同步生成报告"
            >
              ↻ 同步账本
            </button>
          )}

          {onRunAgentWriteup && (
            <button
              type="button"
              onClick={onRunAgentWriteup}
              title="让 Agent 执行 WRI 阶段并归档至 notes/writeup.md"
              style={{
                ...smallBtnStyle,
                borderColor: 'var(--ok)',
                color: 'var(--ok)',
                background: 'rgba(74, 222, 128, 0.1)',
              }}
            >
              ⚡ Agent 落盘 writeup.md
            </button>
          )}

          <button type="button" onClick={() => copyText('md', draft)} style={smallBtnStyle}>
            {copiedKey === 'md' ? '✓ 已复制 Markdown' : '⎘ 复制 Markdown'}
          </button>
          <button type="button" onClick={downloadMarkdown} style={smallBtnStyle}>
            ⬇ 导出 .md
          </button>
          <button
            type="button"
            onClick={downloadForensicBundle}
            title="导出完整取证归档包 (含 SHA256 账本、假设校准、仲裁日志与 Markdown 报告)"
            style={{ ...smallBtnStyle, borderColor: 'var(--violet-dim)', color: 'var(--violet)' }}
          >
            ⬇ 导出 .json 取证包
          </button>
        </div>

        {/* Report Section Completeness Strip */}
        <div className="re-writeup-sections re-mono-num">
          <span style={{ color: 'var(--faint)' }}>
            报告结构完备度 ({sectionChecks.filter((s) => s.ok).length}/{sectionChecks.length}):
          </span>
          {sectionChecks.map((s) => (
            <span key={s.key} className="re-sec-pill" data-present={s.ok ? '1' : undefined}>
              {s.ok ? '✓' : '○'} {s.label}
            </span>
          ))}
        </div>

        {/* Citation quick-insert bar */}
        {(evidence.length > 0 || hypotheses.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 10 }}>
            <span style={{ color: 'var(--faint)' }}>点击插入溯源引用：</span>
            {hypotheses.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => insertCitation(h.id)}
                style={citeChipStyle(h.status === 'rejected' ? 'err' : 'accent')}
                title={h.claim}
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
                title={`${ev.source}: ${ev.summary || ev.excerpt}`}
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
            maxHeight: 340,
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
    </div>
  )
}

const cardBoxStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(5, 8, 12, 0.52)',
  padding: '7px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const selectStyle: CSSProperties = {
  background: 'var(--bg-panel)',
  color: 'var(--accent)',
  border: '1px solid var(--rule)',
  font: 'inherit',
  fontSize: 10.5,
  padding: '2px 6px',
  cursor: 'pointer',
}

const smallBtnStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(8, 14, 22, 0.85)',
  color: 'var(--text)',
  fontSize: 10.5,
  padding: '2px 8px',
  cursor: 'pointer',
}

function tabToggleStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? 'var(--accent)' : 'var(--rule)'}`,
    background: active ? 'rgba(34, 211, 238, 0.12)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--muted)',
    fontSize: 10.5,
    padding: '2px 7px',
    cursor: 'pointer',
  }
}

function citeChipStyle(tone: 'accent' | 'ok' | 'violet' | 'err'): CSSProperties {
  return {
    border: `1px solid color-mix(in srgb, var(--${tone}) 50%, var(--rule))`,
    color: `var(--${tone})`,
    background: 'rgba(5, 8, 12, 0.65)',
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
  background: 'rgba(2, 5, 9, 0.88)',
  color: 'var(--text)',
  border: '1px solid var(--rule)',
  padding: 8,
  font: 'inherit',
  fontSize: 11,
  lineHeight: 1.5,
}

const previewPaneStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(2, 5, 9, 0.78)',
  padding: '8px 12px',
  overflowY: 'auto',
  fontSize: 11.5,
  color: 'var(--text)',
}
