// TranscriptStream — minimalist forensic trace log with compact filter pills,
// expandable search toggle, collapsible tool rows, and contextual `data-hint` tips.
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

const FILTER_TABS: readonly { key: TranscriptFilter; label: string; hint: string; tone?: 'err' }[] = [
  { key: 'all', label: '全部', hint: '显示所有转录事件（含系统与连线轨迹）' },
  { key: 'assistant', label: '回复', hint: '仅显示你的提问与 Agent 回复' },
  { key: 'tools', label: '工具', hint: '仅显示工具调用与执行结果' },
  { key: 'errors', label: '错误', hint: '仅显示失败的工具调用或错误信息', tone: 'err' },
]

const QUICK_CMDS: readonly { cmd: string; hint: string }[] = [
  { cmd: '/workflow reverse', hint: '启动 9 阶段逆向主线（分诊 → 取证 → 假设账本 → 审计 → Writeup）' },
  { cmd: '/scan <bin>', hint: '快速静态指纹分析（文件头、段熵、缓解措施）' },
  { cmd: '/decode base64 …', hint: '纯本地解码（不消耗 LLM 额度）' },
  { cmd: '/help', hint: '查看全部内置斜杠命令' },
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

function trunc(s: string, max = 100): string {
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

// Stable React keys across the ring buffer: event object identity survives slicing.
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
        <span>{lang || 'code'}</span>
        <button
          type="button"
          className="usa-copy-btn"
          data-copied={copied ? 'true' : undefined}
          onClick={() => onCopy(copyKey, raw)}
          data-hint="复制代码块内容"
        >
          {copied ? '✓ 已复制' : '⎘ 复制'}
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
            background: 'var(--surface-2, var(--bg-panel))',
            border: '1px solid var(--border-subtle, var(--rule))',
            borderRadius: 'var(--radius-xs, 2px)',
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
      if (ev.phase === 'command') {
        return (
          <div className="usa-trace-row" style={{ alignItems: 'flex-start', paddingTop: 3 }}>
            {time}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 9.5,
                  letterSpacing: '0.08em',
                  padding: '0 4px',
                  border: '1px solid var(--border-accent, var(--accent-dim))',
                  borderRadius: 'var(--radius-xs, 2px)',
                  background: 'var(--accent-soft, color-mix(in srgb, var(--accent) 10%, transparent))',
                  color: 'var(--accent)',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                CMD
              </span>
              <span style={{ color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>$</span>
              <span style={{ color: 'var(--text)', fontWeight: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {ev.text}
              </span>
            </div>
            {ev.text && (
              <span className="usa-row-actions" data-visible={copied ? 'true' : undefined}>
                <button
                  type="button"
                  className="usa-copy-btn"
                  data-copied={copied ? 'true' : undefined}
                  onClick={() => onCopy(ck, ev.text)}
                  data-hint="复制该条命令"
                >
                  {copied ? '✓' : '⎘'}
                </button>
              </span>
            )}
          </div>
        )
      }
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
                data-hint="复制该条指令"
              >
                {copied ? '✓' : '⎘'}
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
      const fullPayload = ev.args ? JSON.stringify(ev.args, null, 2) : rawSummary
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
                {trunc(rawSummary, 88)}
              </span>
              {verbose && (
                <button
                  type="button"
                  className="usa-tool-toggle"
                  onClick={() => onToggleExpand(rowKey)}
                  aria-expanded={expanded}
                  data-hint={expanded ? '收起参数详情' : '展开完整调用参数'}
                >
                  {expanded ? '▾' : '▸'}
                </button>
              )}
              {fullPayload && (
                <span className="usa-row-actions" data-visible={copied ? 'true' : undefined}>
                  <button
                    type="button"
                    className="usa-copy-btn"
                    data-copied={copied ? 'true' : undefined}
                    onClick={() => onCopy(ck, fullPayload)}
                    data-hint="复制调用参数"
                  >
                    {copied ? '✓' : '⎘'}
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
                {trunc(fullText, 88)}
                {ev.ms > 0 ? ` · ${ev.ms}ms` : ''}
              </span>
              {verbose && (
                <button
                  type="button"
                  className="usa-tool-toggle"
                  onClick={() => onToggleExpand(rowKey)}
                  aria-expanded={expanded}
                  data-hint={expanded ? '收起输出详情' : '展开完整工具输出'}
                >
                  {expanded ? '▾' : '▸'}
                </button>
              )}
              {fullText && (
                <span className="usa-row-actions" data-visible={copied ? 'true' : undefined}>
                  <button
                    type="button"
                    className="usa-copy-btn"
                    data-copied={copied ? 'true' : undefined}
                    onClick={() => onCopy(ck, fullText)}
                    data-hint="复制工具输出"
                  >
                    {copied ? '✓' : '⎘'}
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
      if (ev.phase === 'command') {
        const isErr = !ev.ok
        const tone = isErr ? 'var(--err)' : 'var(--ok)'
        const borderColor = isErr
          ? 'color-mix(in srgb, var(--err) 55%, var(--border-subtle, var(--rule)))'
          : 'color-mix(in srgb, var(--accent) 40%, var(--border-subtle, var(--rule)))'
        const bgColor = isErr
          ? 'var(--err-soft, color-mix(in srgb, var(--err) 8%, var(--bg)))'
          : 'var(--surface-2, color-mix(in srgb, var(--bg) 72%, var(--bg-panel) 28%))'
        return (
          <div className="usa-trace-row" style={{ alignItems: 'flex-start', paddingTop: 2, paddingBottom: 5 }}>
            {time}
            <div
              data-command-result={isErr ? 'error' : 'ok'}
              style={{
                flex: 1,
                minWidth: 0,
                border: `1px solid ${borderColor}`,
                borderLeft: `2px solid ${tone}`,
                borderRadius: 'var(--radius-xs, 2px)',
                background: bgColor,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px',
                  borderBottom: '1px solid var(--border-subtle, var(--rule))',
                  background: 'var(--surface-1, color-mix(in srgb, var(--bg-panel) 85%, transparent))',
                  fontSize: 10.5,
                }}
              >
                <span style={{ color: tone, fontWeight: 700 }}>{isErr ? '✗' : '✓'}</span>
                <span style={{ color: isErr ? 'var(--err)' : 'var(--muted)', fontWeight: 600 }}>
                  {ev.name || 'command'}
                </span>
                <span style={{ color: 'var(--faint)', fontSize: 10 }}>
                  {isErr ? 'error' : 'output'}
                </span>
                <span className="usa-row-actions" data-visible={copied ? 'true' : undefined} style={{ marginLeft: 'auto' }}>
                  <button
                    type="button"
                    className="usa-copy-btn"
                    data-copied={copied ? 'true' : undefined}
                    onClick={() => onCopy(ck, ev.text)}
                    data-hint="复制命令输出"
                  >
                    {copied ? '✓ 已复制' : '⎘ 复制'}
                  </button>
                </span>
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: '6px 9px',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: isErr ? 'var(--err)' : 'var(--text)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflowX: 'auto',
                }}
              >
                {ev.text}
              </pre>
            </div>
          </div>
        )
      }
      const mdComponents = buildMdComponents(rowKey, copiedKey, onCopy)
      return (
        <div className="usa-trace-row" style={{ alignItems: 'flex-start', paddingTop: 4, paddingBottom: 4 }}>
          {time}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ color: 'var(--ok)', fontWeight: 600 }}>
                ✦ reply{ev.textChars > 0 ? ` · ${fmtTok(ev.textChars)}` : ''}
                {ev.usage ? ` · $${(ev.usage.costUsd ?? 0).toFixed(4)}` : ''}
              </span>
              <span className="usa-row-actions" data-visible={copied ? 'true' : undefined} style={{ marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="usa-copy-btn"
                  data-copied={copied ? 'true' : undefined}
                  onClick={() => onCopy(ck, ev.text)}
                  data-hint="复制完整 Markdown 回复"
                >
                  {copied ? '✓ 已复制' : '⎘ 复制'}
                </button>
              </span>
            </div>
            <div
              style={{
                color: 'var(--text)',
                fontSize: 13,
                lineHeight: 1.5,
                borderLeft: '2px solid var(--border-subtle, var(--rule))',
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
  greetingNode,
  hasGreeting = false,
  greetingDismissed = false,
  onRevealGreeting,
}: {
  runtime: SessionRuntime
  style?: CSSProperties
  /** Optional non-blocking startup greeting card rendered on fresh transcripts
   *  (and toggleable via a subtle ✦ toolbar pill once messages arrive). */
  greetingNode?: ReactNode
  hasGreeting?: boolean
  greetingDismissed?: boolean
  onRevealGreeting?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pinnedRef = useRef(true)
  const prevTailRef = useRef<LoopEvent | undefined>(undefined)

  const [pinned, setPinned] = useState(true)
  const [unseenCount, setUnseenCount] = useState(0)
  const [filter, setFilter] = useState<TranscriptFilter>('all')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<number>>(() => new Set())
  const [peekGreeting, setPeekGreeting] = useState(false)

  const { copiedKey, copy } = useCopyFeedback()

  const count = runtime.loopBuffer.length
  const tailEvent = count > 0 ? runtime.loopBuffer[count - 1] : undefined

  // Reset per-session view state when switching active sessions
  useEffect(() => {
    setFilter('all')
    setQuery('')
    setSearchOpen(false)
    setExpandedKeys(new Set())
    setUnseenCount(0)
    setPeekGreeting(false)
    pinnedRef.current = true
    setPinned(true)
    prevTailRef.current = undefined
  }, [runtime.info.id])

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight
      setUnseenCount(0)
    } else if (tailEvent && prevTailRef.current && tailEvent !== prevTailRef.current) {
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
  const showSearchBox = searchOpen || query.length > 0

  return (
    <div className="usa-transcript-root" style={style}>
      {/* Minimalist filter pills + expandable search toggle */}
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
                  data-hint={tab.hint}
                  data-hint-side="bottom"
                >
                  <span>{tab.label}</span>
                  {c > 0 && <span className="usa-pill-count">{c}</span>}
                </button>
              )
            })}
          </div>

          {showSearchBox ? (
            <div className="usa-transcript-search">
              <span style={{ color: 'var(--faint)', fontSize: 10 }}>⌕</span>
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => {
                  if (!query.trim()) setSearchOpen(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setQuery('')
                    setSearchOpen(false)
                  }
                }}
                placeholder="筛选关键字…"
                aria-label="Search transcript"
              />
              {query && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery('')
                    setSearchOpen(false)
                  }}
                  aria-label="清空搜索"
                  data-hint="清空并收起搜索"
                  data-hint-kbd="Esc"
                  style={{ color: 'var(--faint)', fontSize: 10, padding: '0 2px', cursor: 'pointer' }}
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="usa-search-trigger"
              onClick={() => setSearchOpen(true)}
              aria-label="搜索转录流"
              data-hint="搜索转录记录（地址 / 工具 / 回复）"
              data-hint-side="bottom"
            >
              ⌕
            </button>
          )}

          {isFiltered && (
            <span
              style={{ color: 'var(--faint)', fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
              data-hint="当前匹配条数 / 总记录数"
              data-hint-side="bottom"
            >
              {visibleIndices.length}/{count}
            </span>
          )}

          {hasGreeting && greetingNode && (
            <button
              type="button"
              className="wgc-toolbar-pill"
              data-active={peekGreeting && !greetingDismissed ? 'true' : undefined}
              onClick={() => {
                if (peekGreeting && !greetingDismissed) {
                  setPeekGreeting(false)
                } else {
                  onRevealGreeting?.()
                  setPeekGreeting(true)
                }
              }}
              aria-pressed={peekGreeting && !greetingDismissed}
              aria-label="切换智能问候与下一步建议"
              data-hint={peekGreeting && !greetingDismissed ? '收起智能问候与建议' : '查看智能问候与下一步任务建议'}
              data-hint-side="bottom"
            >
              ✦
            </button>
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
        {greetingNode && (count === 0 || (peekGreeting && !greetingDismissed)) && greetingNode}

        {count === 0 && (
          <div className="usa-empty-state">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>
                ⌁ 就绪 · 发送指令开始取证
              </span>
              <span
                style={{ color: 'var(--faint)', fontSize: 11 }}
                data-hint={`当前工作区：${runtime.info.workspace}${runtime.info.workflow ? ` · workflow=${runtime.info.workflow}` : ''}`}
              >
                {runtime.info.workspace.split('/').filter(Boolean).pop() || runtime.info.workspace}
              </span>
            </div>
            <div className="usa-empty-chips">
              {QUICK_CMDS.map((item) => (
                <span key={item.cmd} className="usa-empty-chip" data-hint={item.hint}>
                  {item.cmd}
                </span>
              ))}
            </div>
          </div>
        )}

        {count > 0 && visibleIndices.length === 0 && (
          <div className="usa-empty-state">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                ○ 无匹配记录{query.trim() ? `（“${query.trim()}”）` : ''}
              </span>
              <button
                type="button"
                className="usa-pill"
                data-active="true"
                onClick={() => {
                  setFilter('all')
                  setQuery('')
                  setSearchOpen(false)
                }}
              >
                ↻ 重置筛选
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
              data-hint="回到底部并恢复实时跟随"
            >
              <span>↓</span>
              <span>{unseenCount > 0 ? `${unseenCount} 条新消息` : '回到底部'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
