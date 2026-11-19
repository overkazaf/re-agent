// WS4 tool approval card: risk-colored left bar + label (read=ok write=warn
// network=err exec=violet), monospace args preview, four-way decision with
// deny focused by default and Esc = deny so a fat-finger Enter stays safe.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { pushEsc } from '../../lib/escStack'
import type { ApprovalDTO, ApprovalDecision } from '../../lib/types'
import { actions } from '../../store/sessions'
import { GlowText } from '../crt'

const RISK_TONE: Record<ApprovalDTO['risk'], 'ok' | 'warn' | 'err' | 'violet'> = {
  read: 'ok',
  write: 'warn',
  network: 'err',
  exec: 'violet',
}

export function ApprovalDialog({
  approval,
  sessionId,
  inline = false,
  onClose,
  style,
}: {
  approval: ApprovalDTO
  sessionId: string
  /** render as an embedded card (dev pages) instead of a fixed overlay */
  inline?: boolean
  onClose?: () => void
  style?: CSSProperties
}) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const denyRef = useRef<HTMLButtonElement>(null)
  const tone = RISK_TONE[approval.risk]

  async function decide(decision: ApprovalDecision) {
    if (busy) return
    setBusy(decision)
    setError(null)
    const res = await actions.approve(sessionId, approval.requestID, decision)
    if (res.ok) {
      onClose?.()
    } else {
      setBusy(null)
      setError(res.error)
    }
  }

  // Esc = deny (safe default), deny button focused on mount; routed through
  // the esc stack so a dialog underneath doesn't also close
  const decideRef = useRef(decide)
  decideRef.current = decide
  useEffect(() => {
    denyRef.current?.focus()
    return pushEsc(() => void decideRef.current('deny'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const card = (
    <div
      style={{
        border: '1px solid var(--rule)',
        borderLeft: `3px solid var(--${tone})`,
        background: 'var(--bg-panel)',
        boxShadow: inline ? 'none' : '0 0 24px rgba(0, 0, 0, 0.65)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        ...style,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, letterSpacing: '0.12em' }}>
        <span style={{ color: 'var(--faint)' }}>╭─ TOOL APPROVAL ─╮</span>
        <span
          style={{
            color: `var(--${tone})`,
            border: `1px solid var(--${tone})`,
            padding: '1px 8px',
            textTransform: 'uppercase',
          }}
        >
          {approval.risk}
        </span>
      </div>

      <div style={{ fontSize: 14 }}>
        <GlowText tone="accent">⚙ {approval.toolName}</GlowText>
      </div>

      {approval.summary && approval.summary !== approval.argsPreview && (
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>{approval.summary}</div>
      )}

      {approval.concerns && approval.concerns.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--warn)' }}>
          {approval.concerns.map((c, idx) => (
            <div key={idx}>⚠ {c}</div>
          ))}
        </div>
      )}

      <pre
        style={{
          margin: 0,
          maxHeight: 120,
          overflow: 'auto',
          background: 'rgba(5, 8, 12, 0.5)',
          border: '1px solid var(--rule)',
          padding: 8,
          fontSize: 12,
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {approval.argsPreview || '—'}
      </pre>

      {error && <div style={{ color: 'var(--err)', fontSize: 12, whiteSpace: 'pre-wrap' }}>✗ {error}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => decide('deny')}
          ref={denyRef}
          disabled={busy !== null}
          style={btnStyle('err')}
        >
          {busy === 'deny' ? '…' : 'deny'}
        </button>
        <button onClick={() => decide('deny-always')} disabled={busy !== null} style={btnStyle('err')}>
          {busy === 'deny-always' ? '…' : 'deny-always'}
        </button>
        <button onClick={() => decide('allow')} disabled={busy !== null} style={btnStyle('ok')}>
          {busy === 'allow' ? '…' : 'allow'}
        </button>
        <button onClick={() => decide('allow-always')} disabled={busy !== null} style={btnStyle('ok')}>
          {busy === 'allow-always' ? '…' : 'allow-always'}
        </button>
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 10 }}>esc = deny · 默认聚焦 deny 防手滑</div>
    </div>
  )

  if (inline) return card

  return (
    <div
      onClick={(e) => {
        // backdrop click does NOT decide — approvals should be explicit
        void e
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 5, 8, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div style={{ width: 460, maxWidth: '92vw' }}>{card}</div>
    </div>
  )
}

function btnStyle(tone: 'ok' | 'err'): CSSProperties {
  return {
    flex: 1,
    background: 'transparent',
    border: `1px solid var(--${tone})`,
    color: `var(--${tone})`,
    font: 'inherit',
    fontSize: 12,
    padding: '5px 10px',
    cursor: 'pointer',
  }
}
