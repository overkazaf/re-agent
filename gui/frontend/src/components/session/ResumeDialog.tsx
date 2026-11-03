// [resume] dialog — api.listSessions() + live search filter, with loading /
// empty / browser-dev error states handled inline.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import type { SessionSummaryDTO } from '../../lib/types'
import { actions, errText } from '../../store/sessions'
import { Btn, Dialog, fieldStyle } from './Dialog'

function fmtTime(iso: string): string {
  return iso ? iso.slice(0, 19).replace('T', ' ') : ''
}

export function ResumeDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<SessionSummaryDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
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
    if (!q) return rows
    return rows.filter((r) =>
      [r.id, r.hash, r.workspace, r.firstPrompt].some((v) => v && v.toLowerCase().includes(q)),
    )
  }, [rows, query])

  async function resume(id: string) {
    setBusyId(id)
    const res = await actions.resumeSession(id)
    setBusyId(null)
    if (res.ok) onClose()
    else setError(res.error)
  }

  return (
    <Dialog title="resume session" width={520} onClose={onClose}>
      <input
        style={fieldStyle}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search id / hash / workspace / first prompt…"
        autoFocus
      />

      <div style={{ maxHeight: 300, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {error && <div style={{ color: 'var(--err)', fontSize: 12, whiteSpace: 'pre-wrap' }}>✗ {error}</div>}

        {!error && rows === null && <div style={{ color: 'var(--faint)', fontSize: 12 }}>⠋ loading sessions…</div>}

        {rows !== null && rows.length === 0 && (
          <div style={{ color: 'var(--faint)', fontSize: 12 }}>○ no saved sessions — start one with [+ new]</div>
        )}

        {rows !== null && rows.length > 0 && filtered.length === 0 && (
          <div style={{ color: 'var(--faint)', fontSize: 12 }}>○ no match for “{query}”</div>
        )}

        {filtered.map((r) => (
          <button
            key={r.id}
            onClick={() => resume(r.id)}
            disabled={busyId !== null}
            style={{
              background: 'transparent',
              border: '1px solid var(--rule)',
              color: 'var(--text)',
              font: 'inherit',
              fontSize: 12,
              textAlign: 'left',
              padding: '6px 9px',
              cursor: busyId !== null ? 'default' : 'pointer',
              opacity: busyId === null || busyId === r.id ? 1 : 0.4,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--accent)' }}>{busyId === r.id ? '⠋' : '▸'} {r.hash || r.id}</span>
              <span style={{ color: 'var(--muted)' }}>{r.workspace}</span>
              <span style={{ color: 'var(--faint)', fontSize: 10 }}>
                {r.messages} msgs · {fmtTime(r.updatedAt)}
              </span>
            </span>
            {r.firstPrompt && (
              <span style={{ color: 'var(--faint)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.firstPrompt}
              </span>
            )}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn onClick={onClose}>close</Btn>
      </div>
    </Dialog>
  )
}
