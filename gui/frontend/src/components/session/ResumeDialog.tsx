// ResumeDialog — clean saved-session picker with instant search, sort pills,
// keyboard navigation (↑/↓/Enter), and contextual `data-hint` tooltips.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import type { SessionSummaryDTO } from '../../lib/types'
import { actions, errText } from '../../store/sessions'
import { Btn, Dialog, fieldStyle } from './Dialog'
import { formatRelativeTime, inferSessionBadge } from './usabilityHelpers'
import './usability.css'

type SortKey = 'recent' | 'messages'

function fmtExactTime(iso: string): string {
  return iso ? iso.slice(0, 19).replace('T', ' ') : ''
}

export function ResumeDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<SessionSummaryDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('recent')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listSessions()
      .then((r) => {
        if (!cancelled) setRows(r)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    if (!rows) return []
    const q = query.trim().toLowerCase()
    const matched = !q
      ? [...rows]
      : rows.filter((r) =>
          [r.id, r.hash, r.workspace, r.firstPrompt].some((v) => v && v.toLowerCase().includes(q)),
        )
    if (sortBy === 'messages') {
      matched.sort((a, b) => b.messages - a.messages)
    } else {
      matched.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    }
    return matched
  }, [rows, query, sortBy])

  useEffect(() => {
    setSelectedIdx((idx) => (filtered.length === 0 ? 0 : Math.min(idx, filtered.length - 1)))
  }, [filtered.length])

  async function resume(id: string) {
    if (busyId !== null) return
    setBusyId(id)
    setError(null)
    const res = await actions.resumeSession(id)
    setBusyId(null)
    if (res.ok) onClose()
    else setError(res.error)
  }

  return (
    <Dialog title="resume session" width={540} onClose={onClose}>
      {/* Search + sort toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: '1px solid var(--border-subtle, var(--rule))',
            borderRadius: 'var(--radius-xs, 2px)',
            padding: '0 8px',
            background: 'var(--surface-1, color-mix(in srgb, var(--bg) 65%, transparent))',
          }}
        >
          <span style={{ color: 'var(--faint)', fontSize: 11 }}>⌕</span>
          <input
            style={{ ...fieldStyle, border: 'none', padding: '5px 0' }}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && filtered.length > 0) {
                e.preventDefault()
                setSelectedIdx((i) => (i + 1) % filtered.length)
              } else if (e.key === 'ArrowUp' && filtered.length > 0) {
                e.preventDefault()
                setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length)
              } else if (e.key === 'Enter' && filtered[selectedIdx]) {
                e.preventDefault()
                void resume(filtered[selectedIdx].id)
              } else if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
            placeholder="搜索 hash / 工作区 / 首条指令…"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              data-hint="清空搜索词"
              data-hint-kbd="Esc"
              style={{ color: 'var(--faint)', fontSize: 11, cursor: 'pointer' }}
            >
              ✕
            </button>
          )}
        </div>

        <button
          type="button"
          className="usa-pill"
          data-active={sortBy === 'recent' ? 'true' : undefined}
          onClick={() => setSortBy('recent')}
          data-hint="按最近更新时间排序"
        >
          最新
        </button>
        <button
          type="button"
          className="usa-pill"
          data-active={sortBy === 'messages' ? 'true' : undefined}
          onClick={() => setSortBy('messages')}
          data-hint="按消息轮次数量排序"
        >
          最活跃
        </button>
        {rows !== null && (
          <span
            style={{ color: 'var(--faint)', fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            data-hint="↑↓ 选择会话 · Enter 立即恢复"
          >
            {filtered.length}/{rows.length}
          </span>
        )}
      </div>

      {/* Session list */}
      <div style={{ maxHeight: 330, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {error && (
          <div
            style={{
              color: 'var(--err)',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              padding: '6px 8px',
              border: '1px solid var(--err)',
              borderRadius: 'var(--radius-xs, 2px)',
              background: 'var(--err-soft, color-mix(in srgb, var(--err) 10%, var(--bg)))',
            }}
          >
            ✗ {error}
          </div>
        )}

        {!error && rows === null && (
          <div style={{ color: 'var(--faint)', fontSize: 12, padding: '8px 2px' }}>⠋ 加载历史会话…</div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="usa-empty-state" style={{ margin: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
              <span>○ 暂无历史会话</span>
              <span className="usa-hint-dot" data-hint="发送首条 prompt 后会自动归档会话转录与 RE 账本状态">
                ?
              </span>
            </div>
          </div>
        )}

        {rows !== null && rows.length > 0 && filtered.length === 0 && (
          <div className="usa-empty-state" style={{ margin: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>○ 无匹配会话（“{query}”）</span>
              <button type="button" className="usa-pill" data-active="true" onClick={() => setQuery('')}>
                ↻ 清空
              </button>
            </div>
          </div>
        )}

        {filtered.map((r, idx) => {
          const badge = inferSessionBadge(r)
          const wsName = r.workspace.split('/').filter(Boolean).pop() || r.workspace
          const selected = idx === selectedIdx
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => void resume(r.id)}
              onMouseEnter={() => setSelectedIdx(idx)}
              disabled={busyId !== null}
              className="usa-resume-row"
              data-selected={selected ? 'true' : undefined}
              style={{ opacity: busyId === null || busyId === r.id ? 1 : 0.4 }}
              data-hint={`${r.workspace} · ${fmtExactTime(r.updatedAt)}`}
            >
              <span style={{ display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>
                  {busyId === r.id ? '⠋' : '▸'} {r.hash || r.id}
                </span>
                <span
                  style={{
                    fontSize: 9.5,
                    padding: '0 5px',
                    border: `1px solid color-mix(in srgb, var(--${badge.tone}) 50%, var(--rule))`,
                    borderRadius: 'var(--radius-xs, 2px)',
                    color: `var(--${badge.tone})`,
                    letterSpacing: '0.05em',
                    flexShrink: 0,
                  }}
                >
                  {badge.label}
                </span>
                <span
                  style={{
                    color: 'var(--text)',
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {wsName}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    color: 'var(--faint)',
                    fontSize: 10,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {r.messages} · {formatRelativeTime(r.updatedAt)}
                </span>
              </span>
              {r.firstPrompt && (
                <span
                  style={{
                    color: 'var(--muted)',
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.firstPrompt}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'var(--faint)', fontSize: 10 }}>
          <kbd className="usa-kbd">↑↓</kbd> 选择 · <kbd className="usa-kbd">Enter</kbd> 恢复
        </span>
        <Btn type="button" onClick={onClose}>
          close
        </Btn>
      </div>
    </Dialog>
  )
}
