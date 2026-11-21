// [resume] dialog — api.listSessions() + live search, sort toggle, keyboard
// navigation (↑/↓/Enter), relative timestamps, inferred session type badges,
// and clear loading/empty/error states.
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
    <Dialog title="resume session" width={580} onClose={onClose}>
      {/* Search + sort toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: '1px solid var(--rule)',
            padding: '0 8px',
            background: 'color-mix(in srgb, var(--bg) 65%, transparent)',
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
            placeholder="search id / hash / workspace / first prompt…"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="Clear search"
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
          title="Sort by last updated"
        >
          Newest
        </button>
        <button
          type="button"
          className="usa-pill"
          data-active={sortBy === 'messages' ? 'true' : undefined}
          onClick={() => setSortBy('messages')}
          title="Sort by message count"
        >
          Most active
        </button>
      </div>

      {/* Summary bar */}
      {rows !== null && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 10.5,
            color: 'var(--faint)',
          }}
        >
          <span>
            Showing {filtered.length} of {rows.length} saved session{rows.length === 1 ? '' : 's'}
          </span>
          <span>
            <kbd className="usa-kbd">↑</kbd>/<kbd className="usa-kbd">↓</kbd> select ·{' '}
            <kbd className="usa-kbd">Enter</kbd> resume
          </span>
        </div>
      )}

      {/* Session list */}
      <div style={{ maxHeight: 330, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {error && (
          <div
            style={{
              color: 'var(--err)',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              padding: '6px 8px',
              border: '1px solid var(--err)',
              background: 'color-mix(in srgb, var(--err) 10%, var(--bg))',
            }}
          >
            ✗ {error}
          </div>
        )}

        {!error && rows === null && (
          <div style={{ color: 'var(--faint)', fontSize: 12, padding: '8px 2px' }}>⠋ loading saved sessions…</div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="usa-empty-state" style={{ margin: 0 }}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>
              ○ no saved sessions — start one with [+ new]
            </div>
            <div style={{ color: 'var(--faint)', fontSize: 11 }}>
              会话历史会在发送首条 prompt 后自动归档，便于随时恢复转录与 RE 账本状态。
            </div>
          </div>
        )}

        {rows !== null && rows.length > 0 && filtered.length === 0 && (
          <div className="usa-empty-state" style={{ margin: 0 }}>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>○ no match for “{query}”</div>
            <div>
              <button type="button" className="usa-pill" data-active="true" onClick={() => setQuery('')}>
                ↻ Clear search
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
            >
              <span style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                  {busyId === r.id ? '⠋' : '▸'} {r.hash || r.id}
                </span>
                <span
                  style={{
                    fontSize: 9.5,
                    padding: '0 5px',
                    border: `1px solid color-mix(in srgb, var(--${badge.tone}) 55%, var(--rule))`,
                    color: `var(--${badge.tone})`,
                    letterSpacing: '0.06em',
                  }}
                >
                  {badge.label}
                </span>
                <span style={{ color: 'var(--text)', fontWeight: 500 }} title={r.workspace}>
                  {wsName}
                </span>
                <span style={{ color: 'var(--faint)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.workspace !== wsName ? r.workspace : ''}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    color: 'var(--faint)',
                    fontSize: 10,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                  title={fmtExactTime(r.updatedAt)}
                >
                  {r.messages} msgs · {formatRelativeTime(r.updatedAt)}
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
                  “{r.firstPrompt}”
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn type="button" onClick={onClose}>
          close
        </Btn>
      </div>
    </Dialog>
  )
}
