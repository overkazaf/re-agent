// WS4 transcript: renders the session loopBuffer as trace-style lines
// (↻ wire / ◈ plan / ⚙ tool / ✓✗ result / ▸ turn / ✦ reply) with relative
// t+Xs stamps; replies render as markdown. Auto-scrolls while pinned to
// bottom; pauses when the user scrolls up >80px.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SessionRuntime } from '../../store/sessions'
import type { LoopEvent } from '../../lib/types'

const AUTO_SCROLL_PX = 80

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
  return s.length > max ? `${s.slice(0, max)}…` : s
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

/** Compact markdown overrides — keeps trace density inside the stream. */
const mdComponents = {
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
  code: ({ children, className }: { children?: ReactNode; className?: string }) =>
    className ? (
      <code style={{ display: 'block', background: 'var(--bg-panel)', border: '1px solid var(--rule)', padding: 8, overflowX: 'auto', fontSize: 12 }}>
        {children}
      </code>
    ) : (
      <code style={{ background: 'var(--bg-panel)', padding: '0 4px', fontSize: 12 }}>{children}</code>
    ),
  pre: ({ children }: { children?: ReactNode }) => <pre style={{ margin: '0.3em 0' }}>{children}</pre>,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote style={{ margin: '0.3em 0', borderLeft: '2px solid var(--rule)', paddingLeft: 10, color: 'var(--muted)' }}>
      {children}
    </blockquote>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <table style={{ borderCollapse: 'collapse', fontSize: 12, margin: '0.3em 0' }}>{children}</table>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th style={{ border: '1px solid var(--rule)', padding: '2px 8px', textAlign: 'left', color: 'var(--accent)' }}>{children}</th>
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

function traceRow(ev: LoopEvent, ts: number, origin: number | null): ReactNode {
  const t = stamp(ts, origin)
  const time = <span style={{ color: 'var(--faint)', flex: '0 0 62px', fontSize: 10, paddingTop: 1 }}>{t}</span>

  switch (ev.type) {
    case 'user':
      return (
        <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
          {time}
          <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>› you </span>
            <span style={{ color: 'var(--text)' }}>{ev.text}</span>
          </div>
        </div>
      )

    case 'turn':
      return (
        <div style={rowStyle}>
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
        <div style={rowStyle}>
          {time}
          <span style={{ color: 'var(--accent)' }}>↻ wire {ev.phase}</span>
          <span style={{ color: 'var(--faint)' }}>
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
        <div style={rowStyle}>
          {time}
          <span style={{ color: 'var(--violet)' }}>◈ plan</span>
          <span style={{ color: 'var(--faint)' }}>{badge}</span>
        </div>
      )
    }

    case 'tool_start':
      return (
        <div style={rowStyle}>
          {time}
          <span style={{ color: 'var(--warn)' }}>⚙ {ev.name}</span>
          <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {trunc(ev.preview || ev.text || summarizeArgs(ev.args), 90)}
          </span>
        </div>
      )

    case 'tool_end':
      return (
        <div style={rowStyle}>
          {time}
          <span style={{ color: ev.ok ? 'var(--ok)' : 'var(--err)' }}>{ev.ok ? '✓' : '✗'} {ev.name}</span>
          <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {trunc(ev.error || ev.preview, 90)}
            {ev.ms > 0 ? ` · ${ev.ms}ms` : ''}
          </span>
        </div>
      )

    case 'compaction':
      return (
        <div style={rowStyle}>
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
        <div style={rowStyle}>
          {time}
          <span style={{ color: 'var(--faint)' }}>
            · {ev.progress?.kind || 'progress'}
            {ev.progress?.text ? `: ${trunc(ev.progress.text, 80)}` : ''}
            {ev.progress?.tool ? `: ${ev.progress.tool}` : ''}
          </span>
        </div>
      )

    case 'reply':
      return (
        <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
          {time}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: 'var(--ok)', marginBottom: 2 }}>
              ✦ reply{ev.textChars > 0 ? ` · ${fmtTok(ev.textChars)} chars` : ''}
              {/* core's TokenUsage tags are omitempty: a zero usage crosses the
                  wire as {} and costUsd is undefined here */}
              {ev.usage ? ` · $${(ev.usage.costUsd ?? 0).toFixed(4)}` : ''}
            </div>
            <div style={{ color: 'var(--text)', fontSize: 13, lineHeight: 1.5, borderLeft: '2px solid var(--rule)', paddingLeft: 10, whiteSpace: 'normal' }}>
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {ev.text}
              </Markdown>
            </div>
          </div>
        </div>
      )

    default:
      return null
  }
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  fontSize: 12,
  lineHeight: 1.6,
  minHeight: 18,
  whiteSpace: 'nowrap',
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
  const [pinned, setPinned] = useState(true)
  const count = runtime.loopBuffer.length
  // ring buffer: length stops growing at LOOP_LIMIT, so also key the effect on
  // the tail event's identity — a fresh tail means new content to scroll to
  const tailEvent = count > 0 ? runtime.loopBuffer[count - 1] : undefined

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [count, tailEvent])

  const rows: ReactNode[] = []
  for (let i = 0; i < count; i++) {
    const node = traceRow(runtime.loopBuffer[i], runtime.loopTs[i], runtime.firstLoopTs)
    if (node) rows.push(<div key={keyOf(runtime.loopBuffer[i])}>{node}</div>)
  }

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current
        if (!el) return
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight
        const nowPinned = dist < AUTO_SCROLL_PX
        pinnedRef.current = nowPinned
        setPinned(nowPinned)
      }}
      style={{
        overflow: 'auto',
        minHeight: 0,
        flex: 1,
        padding: '6px 10px',
        ...style,
      }}
    >
      {rows.length === 0 && (
        <div style={{ color: 'var(--faint)', fontSize: 12, padding: 10 }}>
          ⌁ transcript empty — send a prompt to start the loop
        </div>
      )}
      {rows}
      {!pinned && rows.length > 0 && (
        <div style={{ color: 'var(--faint)', fontSize: 10, textAlign: 'center', padding: '2px 0', position: 'sticky', bottom: 0 }}>
          ⋮ paused — scroll to bottom to resume
        </div>
      )}
    </div>
  )
}
