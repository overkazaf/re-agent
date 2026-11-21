// WS4 transcript: renders the session loopBuffer as forensic trace lines
// (↻ wire / ◈ plan / ⚙ tool / ✓✗ result / ▸ turn / ✦ reply) with relative
// t+Xs stamps; replies render as markdown with copyable code/command blocks.
// Includes forensic filter pills, in-transcript search, collapsible verbose
// tool outputs, one-click copy feedback, and non-hijacking jump-to-bottom.
import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SessionRuntime } from '../../store/sessions'
import type { LoopEvent } from '../../lib/types'
import {
  countTranscriptEvents,
  filterTranscriptIndices,
  isVerboseToolPayload,
  useCopyFeedback,
  type TranscriptFilter,
} from './usabilityHelpers'
import './usability.css'

const AUTO_SCROLL_PX = 80

const FILTER_TABS: readonly { key: TranscriptFilter; label: string; tone?: 'err' }[] = [
  { key: 'all', label: 'All' },
  { key: 'assistant', label: 'Assistant' },
  { key: 'tools', label: 'Tools' },
  { key: 'system', label: 'System' },
  { key: 'errors', label: 'Errors', tone: 'err' },
]

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function stamp(ts: number | undefined, origin: number | null): string {
  if (ts === undefined) return ''
  const base = origin ?? ts
  return `t+${((ts - base) / 1000).toFixed(1)}s`
}

function trunc(s: string, max = 110): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function summarizeArgs(args: Record<string, unknown> | null): string {
  if (!args) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  return parts.join(' ')
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children)
  return ''
}

// Stable React keys across the ring buffer: once LOOP_LIMIT drops rows from
// the head, index-based keys would reassign every row; event object identity
// survives the slice, so hand out a monotonic seq per object instead.
const keyOf = (() => {
  const seen = new WeakMap<object, number>()
  let next = 1
  return (ev: LoopEvent): number => {
    let k = seen.get(ev)
    if (k === undefined) {
      k = next++
      seen.set(ev, k)
    }
    return k
  }
})()

function CopyableCodeBlock({
  children,
  lang,
  copyKey,
  copiedKey,
  onCopy,
}: {
  children: ReactNode
  lang: string
  copyKey: string
  copiedKey: string | null
  onCopy: (key: string, text: string) => void
}) {
  const raw = extractText(children).replace(/\n$/, '')
  const copied = copiedKey === copyKey
  return (
    <div className="usa-code-block">
      <div className="usa-code-head">
        <span>{lang || 'code / hex'}</span>
        <button
          type="button"
          className="usa-copy-btn"
          data-copied={copied ? 'true' : undefined}
          onClick={() => onCopy(copyKey, raw)}
          title="Copy block"
        >
          {copied ? '✓ Copied' : '⎘ Copy'}
        </button>
      </div>
      <pre className="usa-code-pre">
        <code>{children}</code>
      </pre>
    </div>
  )
}

function buildMdComponents(
  rowKey: number,
  copiedKey: string | null,
  onCopy: (key: string, text: string) => void,
) {
  let blockSeq = 0
  return {
    p: ({ children }: { children?: ReactNode }) => <p style={{ margin: '0.3em 0' }}>{children}</p>,
    h1: ({ children }: { children?: ReactNode }) => (
      <h1 style={{ fontSize: 14, margin: '0.5em 0 0.2em', color: 'var(--accent)' }}>{children}</h1>
    ),
    h2: ({ children }: { children?: ReactNode }) => (
      <h2 style={{ fontSize: 13, margin: '0.5em 0 0.2em', color: 'var(--accent)' }}>{children}</h2>
    ),
    h3: ({ children }: { children?: ReactNode }) => (
      <h3 style={{ fontSize: 12, margin: '0.4em 0 0.15em', color: 'var(--text)' }}>{children}</h3>
    ),
    ul: ({ children }: { children?: ReactNode }) => <ul style={{ margin: '0.3em 0', paddingLeft: 18 }}>{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol style={{ margin: '0.3em 0', paddingLeft: 18 }}>{children}</ol>,
    li: ({ children }: { children?: ReactNode }) => <li style={{ margin: '0.15em 0' }}>{children}</li>,
    pre: ({ children }: { children?: ReactNode }) => {
      const idx = ++blockSeq
      let lang = ''
      let inner: ReactNode = children
      if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
        const match = /language-([^\s]+)/.exec(children.props.className || '')
        if (match) lang = match[1]
        if (children.props.children !== undefined) inner = children.props.children
      }
      return (
        <CopyableCodeBlock
          lang={lang}
          copyKey={`code-${rowKey}-${idx}`}
          copiedKey={copiedKey}
          onCopy={onCopy}
        >
          {inner}
        </CopyableCodeBlock>
      )
    },
    code: ({ children, className }: { children?: ReactNode; className?: string }) =>
      className ? (
        <code className={className}>{children}</code>
      ) : (
        <code
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid color-mix(in srgb, var(--rule) 65%, transparent)',
            padding: '0 4px',
            fontSize: 12,
          }}
        >
          {children}
        </code>
      ),
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote style={{ margin: '0.3em 0', borderLeft: '2px solid var(--rule)', paddingLeft: 10, color: 'var(--muted)' }}>
        {children}
      </blockquote>
    ),
    table: ({ children }: { children?: ReactNode }) => (
      <table style={{ borderCollapse: 'collapse', fontSize: 12, margin: '0.3em 0' }}>{children}</table>
    ),
    th: ({ children }: { children?: ReactNode }) => (
      <th style={{ border: '1px solid var(--rule)', padding: '2px 8px', textAlign: 'left', color: 'var(--accent)' }}>
        {children}
      </th>
    ),
    td: ({ children }: { children?: ReactNode }) => (
      <td style={{ border: '1px solid var(--rule)', padding: '2px 8px' }}>{children}</td>
    ),
    a: ({ children, href }: { children?: ReactNode; href?: string }) => (
      <a href={href} style={{ color: 'var(--accent)' }} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  }
}

interface RowCtx {
  rowKey: number
  ts: number
  origin: number | null
  expanded: boolean
  onToggleExpand: (rowKey: number) => void
  copiedKey: string | null
  onCopy: (key: string, text: string) => void
}

function traceRow(ev: LoopEvent, ctx: RowCtx): ReactNode {
  const { rowKey, ts, origin, expanded, onToggleExpand, copiedKey, onCopy } = ctx
  const t = stamp(ts, origin)
  const time = <span className="usa-trace-time">{t}</span>

  switch (ev.type) {
    case 'user': {
      const ck = `msg-${rowKey}`
      const copied = copiedKey === ck
      return (
        <div className="usa-trace-row" style={{ alignItems: 'flex-start' }}>
          {time}
          <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>› you </span>
            <span style={{ color: 'var(--text)' }}>{ev.text}</span>
          </div>
          {ev.text && (
            <span className="usa-row-actions" data-visible={copied ? 'true' : undefined}>
              <button
                type="button"
                className="usa-copy-btn"
                data-copied={copied ? 'true' : undefined}
                onClick={() => onCopy(ck, ev.text)}
                title="Copy prompt"
              >
                {copied ? '✓ Copied' : '⎘ Copy'}
              </button>
            </span>
          )}
        </div>
      )
    }

    case 'turn':
      return (
        <div className="usa-trace-row" style={{ whiteSpace: 'nowrap' }}>
          {time}
          <span style={{ color: 'var(--muted)' }}>
            ▸ turn {ev.turn}
            {ev.tools > 0 ? ` · tools ${ev.tools}` : ''}
            {ev.messages > 0 ? ` · msgs ${ev.messages}` : ''}
          </span>
        </div>
      )

    case 'wire':
      return (
        <div className="usa-trace-row" style={{ whiteSpace: 'nowrap' }}>
          {time}
          <span style={{ color: 'var(--accent)' }}>↻ wire {ev.phase}</span>
          <span style={{ color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {ev.model || ev.endpoint}
            {ev.tokens > 0 ? ` · ${fmtTok(ev.tokens)} tok` : ''}
            {ev.ms > 0 ? ` · ${ev.ms}ms` : ''}
          </span>
        </div>
      )

    case 'plan': {
      const badge = ev.snapshot
        ? ` ${ev.snapshot.steps.filter((s) => s.status === 'completed').length}/${ev.snapshot.steps.length} ${ev.snapshot.source}`
        : ''
      return (
        <div className="usa-trace-row" style={{ whiteSpace: 'nowrap' }}>
          {time}
          <span style={{ color: 'var(--violet)' }}>◈ plan</span>
          <span style={{ color: 'var(--faint)' }}>{badge}</span>
        </div>
      )
    }

    case 'tool_start': {
      const rawSummary = ev.preview || ev.text || summarizeArgs(ev.args)
      const fullPayload = ev.args
        ? JSON.stringify(ev.args, null, 2)
        : rawSummary
      const verbose = isVerboseToolPayload(rawSummary, ev.args)
      const ck = `tool-s-${rowKey}`
      const copied = copiedKey === ck
      return (
        <div className="usa-trace-row" style={{ alignItems: 'flex-start' }}>
          {time}
          <div className="usa-tool-card">
            <div className="usa-tool-head">
              <span style={{ color: 'var(--warn)', flexShrink: 0, fontWeight: 600 }}>⚙ {ev.name}</span>
              <span
                style={{
                  color: 'var(--muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {trunc(rawSummary, 90)}
              </span>
              {verbose && (
                <button
                  type="button"
                  className="usa-tool-toggle"
                  onClick={() => onToggleExpand(rowKey)}
                  aria-expanded={expanded}
                >
                  {expanded ? '▾ hide' : '▸ args'}
                </button>
              )}
              {fullPayload && (
                <span className="usa-row-actions" data-visible={copied ? 'true' : undefined}>
                  <button
                    type="button"
                    className="usa-copy-btn"
                    data-copied={copied ? 'true' : undefined}
                    onClick={() => onCopy(ck, fullPayload)}
                    title="Copy tool arguments"
                  >
                    {copied ? '✓ Copied' : '⎘'}
                  </button>
                </span>
              )}
            </div>
            {verbose && expanded && <pre className="usa-tool-detail">{fullPayload}</pre>}
          </div>
        </div>
      )
    }

    case 'tool_end': {
      const fullText = ev.error || ev.preview || ''
      const verbose = isVerboseToolPayload(fullText, null)
      const ck = `tool-e-${rowKey}`
      const copied = copiedKey === ck
      return (
        <div className="usa-trace-row" style={{ alignItems: 'flex-start' }}>
          {time}
          <div className="usa-tool-card">
            <div className="usa-tool-head">
              <span style={{ color: ev.ok ? 'var(--ok)' : 'var(--err)', flexShrink: 0, fontWeight: 600 }}>
                {ev.ok ? '✓' : '✗'} {ev.name}
              </span>
              <span
                style={{
                  color: ev.ok ? 'var(--muted)' : 'var(--err)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {trunc(fullText, 90)}
                {ev.ms > 0 ? ` · ${ev.ms}ms` : ''}
              </span>
              {verbose && (
                <button
                  type="button"
                  className="usa-tool-toggle"
                  onClick={() => onToggleExpand(rowKey)}
                  aria-expanded={expanded}
                >
                  {expanded ? '▾ hide' : '▸ output'}
                </button>
              )}
              {fullText && (
                <span className="usa-row-actions" data-visible={copied ? 'true' : undefined}>
                  <button
                    type="button"
                    className="usa-copy-btn"
                    data-copied={copied ? 'true' : undefined}
                    onClick={() => onCopy(ck, fullText)}
                    title="Copy tool output"
                  >
                    {copied ? '✓ Copied' : '⎘'}
                  </button>
                </span>
              )}
            </div>
            {verbose && expanded && (
              <pre className="usa-tool-detail" data-error={!ev.ok ? 'true' : undefined}>
                {fullText}
              </pre>
            )}
          </div>
        </div>
      )
    }

    case 'compaction':
      return (
        <div className="usa-trace-row" style={{ whiteSpace: 'nowrap' }}>
          {time}
          <span style={{ color: 'var(--warn)' }}>⌢ compact</span>
          <span style={{ color: 'var(--faint)' }}>
            {ev.reason || 'summary'}
            {ev.droppedMessages > 0 ? ` · -${ev.droppedMessages} msgs` : ''}
            {ev.tokensBefore > 0 ? ` · ${fmtTok(ev.tokensBefore)}→${fmtTok(ev.tokensAfter)} tok` : ''}
          </span>
        </div>
      )

    case 'progress':
      return (
        <div className="usa-trace-row" style={{ whiteSpace: 'nowrap' }}>
          {time}
          <span style={{ color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            · {ev.progress?.kind || 'progress'}
            {ev.progress?.text ? `: ${trunc(ev.progress.text, 80)}` : ''}
            {ev.progress?.tool ? `: ${ev.progress.tool}` : ''}
          </span>
        </div>
      )

    case 'reply': {
      const ck = `reply-${rowKey}`
      const copied = copiedKey === ck
      const mdComponents = buildMdComponents(rowKey, copiedKey, onCopy)
      return (
        <div className="usa-trace-row" style={{ alignItems: 'flex-start', paddingTop: 4, paddingBottom: 4 }}>
          {time}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ color: 'var(--ok)', fontWeight: 600 }}>
                ✦ reply{ev.textChars > 0 ? ` · ${fmtTok(ev.textChars)} chars` : ''}
                {/* core's TokenUsage tags are omitempty: a zero usage crosses the
                    wire as {} and costUsd is undefined here */}
                {ev.usage ? ` · $${(ev.usage.costUsd ?? 0).toFixed(4)}` : ''}
              </span>
              <span className="usa-row-actions" data-visible={copied ? 'true' : undefined} style={{ marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="usa-copy-btn"
                  data-copied={copied ? 'true' : undefined}
                  onClick={() => onCopy(ck, ev.text)}
                  title="Copy full reply markdown"
                >
                  {copied ? '✓ Copied' : '⎘ Copy reply'}
                </button>
              </span>
            </div>
            <div
              style={{
                color: 'var(--text)',
                fontSize: 13,
                lineHeight: 1.5,
                borderLeft: '2px solid var(--rule)',
                paddingLeft: 10,
                whiteSpace: 'normal',
              }}
            >
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {ev.text}
              </Markdown>
            </div>
          </div>
        </div>
      )
    }

    default:
      return null
  }
}

export function TranscriptStream({
  runtime,
  style,
}: {
  runtime: SessionRuntime
  style?: CSSProperties
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const prevTailRef = useRef<LoopEvent | undefined>(undefined)

  const [pinned, setPinned] = useState(true)
  const [unseenCount, setUnseenCount] = useState(0)
  const [filter, setFilter] = useState<TranscriptFilter>('all')
  const [query, setQuery] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<number>>(() => new Set())

  const { copiedKey, copy } = useCopyFeedback()

  const count = runtime.loopBuffer.length
  // ring buffer: length stops growing at LOOP_LIMIT, so also key the effect on
  // the tail event's identity — a fresh tail means new content to scroll to
  const tailEvent = count > 0 ? runtime.loopBuffer[count - 1] : undefined

  // Reset per-session view state when switching active sessions
  useEffect(() => {
    setFilter('all')
    setQuery('')
    setExpandedKeys(new Set())
    setUnseenCount(0)
    pinnedRef.current = true
    setPinned(true)
    prevTailRef.current = undefined
  }, [runtime.info.id])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight
      setUnseenCount(0)
    } else if (tailEvent && prevTailRef.current && tailEvent !== prevTailRef.current) {
      // User is scrolled up reviewing history — never hijack scroll; badge new arrivals
      setUnseenCount((n) => n + 1)
    }
    prevTailRef.current = tailEvent
  }, [count, tailEvent])

  const counts = useMemo(() => countTranscriptEvents(runtime.loopBuffer), [runtime.loopBuffer])

  const visibleIndices = useMemo(
    () => filterTranscriptIndices(runtime.loopBuffer, filter, query),
    [runtime.loopBuffer, filter, query],
  )

  function toggleExpand(k: number) {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  function jumpToBottom() {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setPinned(true)
    setUnseenCount(0)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const isFiltered = filter !== 'all' || query.trim().length > 0

  return (
    <div className="usa-transcript-root" style={style}>
      {/* Compact forensic filter & search toolbar */}
      {count > 0 && (
        <div className="usa-transcript-toolbar" role="toolbar" aria-label="Transcript filters">
          <div className="usa-transcript-pills">
            {FILTER_TABS.map((tab) => {
              const c = counts[tab.key]
              const active = filter === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  className="usa-pill"
                  data-active={active ? 'true' : undefined}
                  data-tone={tab.tone}
                  data-has-count={tab.tone === 'err' && c > 0 ? 'true' : undefined}
                  onClick={() => setFilter(tab.key)}
                  aria-pressed={active}
                >
                  <span>{tab.label}</span>
                  <span className="usa-pill-count">{c}</span>
                </button>
              )
            })}
          </div>

          <div className="usa-transcript-search">
            <span style={{ color: 'var(--faint)', fontSize: 10 }}>⌕</span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation()
                  setQuery('')
                }
              }}
              placeholder="Search hex / tool / reply…"
              aria-label="Search transcript"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Clear search"
                style={{ color: 'var(--faint)', fontSize: 10, padding: '0 2px', cursor: 'pointer' }}
              >
                ✕
              </button>
            )}
          </div>

          {isFiltered && (
            <span style={{ color: 'var(--faint)', fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {visibleIndices.length}/{count}
            </span>
          )}
        </div>
      )}

      {/* Scrollable forensic stream */}
      <div
        ref={scrollRef}
        className="usa-transcript-body"
        onScroll={() => {
          const el = scrollRef.current
          if (!el) return
          const dist = el.scrollHeight - el.scrollTop - el.clientHeight
          const nowPinned = dist < AUTO_SCROLL_PX
          pinnedRef.current = nowPinned
          setPinned(nowPinned)
          if (nowPinned) setUnseenCount(0)
        }}
      >
        {count === 0 && (
          <div className="usa-empty-state">
            <div style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>
              ⌁ transcript empty — send a prompt to start the loop
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.55 }}>
              当前工作区 <code style={{ color: 'var(--text)' }}>{runtime.info.workspace}</code>
              {runtime.info.workflow ? ` · workflow=${runtime.info.workflow}` : ''}。输入分析目标开始取证，或使用直调斜杠命令：
            </div>
            <div className="usa-empty-chips">
              <span className="usa-empty-chip">/workflow reverse · 启动 9 阶段逆向主线</span>
              <span className="usa-empty-chip">/scan &lt;bin&gt; · 快速静态指纹</span>
              <span className="usa-empty-chip">/decode base64 … · 纯本地解码</span>
              <span className="usa-empty-chip">/help · 查看全部命令</span>
            </div>
          </div>
        )}

        {count > 0 && visibleIndices.length === 0 && (
          <div className="usa-empty-state">
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>
              ○ No matching transcript events for filter{' '}
              <b style={{ color: 'var(--accent)' }}>{filter}</b>
              {query.trim() ? ` matching “${query.trim()}”` : ''}.
            </div>
            <div>
              <button
                type="button"
                className="usa-pill"
                data-active="true"
                onClick={() => {
                  setFilter('all')
                  setQuery('')
                }}
              >
                ↻ Reset filters
              </button>
            </div>
          </div>
        )}

        {visibleIndices.map((idx) => {
          const ev = runtime.loopBuffer[idx]
          const rk = keyOf(ev)
          const node = traceRow(ev, {
            rowKey: rk,
            ts: runtime.loopTs[idx],
            origin: runtime.firstLoopTs,
            expanded: expandedKeys.has(rk),
            onToggleExpand: toggleExpand,
            copiedKey,
            onCopy: copy,
          })
          return node ? <div key={rk}>{node}</div> : null
        })}

        {!pinned && visibleIndices.length > 0 && (
          <div className="usa-jump-wrap">
            <button
              type="button"
              className="usa-jump-btn"
              onClick={jumpToBottom}
              title="Resume live auto-scroll"
            >
              <span>↓</span>
              <span>
                {unseenCount > 0 ? `${unseenCount} new · Jump to latest` : 'Jump to latest'}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
