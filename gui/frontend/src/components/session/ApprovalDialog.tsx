// WS4 tool approval card: crystal-clear human-in-the-loop risk framing,
// parsed target/cwd/signal highlights, copyable command preview, and four-way
// decision with `deny` focused by default and Esc/N = deny, Y = allow so a
// fat-finger Enter stays safe while deliberate analysts decide fast.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { pushEsc } from '../../lib/escStack'
import type { ApprovalDTO, ApprovalDecision } from '../../lib/types'
import { actions } from '../../store/sessions'
import { GlowText } from '../crt'
import { analyzeApproval, useCopyFeedback } from './usabilityHelpers'
import './usability.css'

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
  const { copiedKey, copy } = useCopyFeedback()

  const forensics = useMemo(() => analyzeApproval(approval), [approval])
  const tone = forensics.meta.tone

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
  // the esc stack so a dialog underneath doesn't also close.
  const decideRef = useRef(decide)
  decideRef.current = decide
  const previewText = approval.argsPreview || ''
  const copyRef = useRef(copy)
  copyRef.current = copy

  useEffect(() => {
    denyRef.current?.focus()
    return pushEsc(() => void decideRef.current('deny'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard accelerators: Y / Ctrl+Enter = allow, N = deny, C = copy preview.
  // Plain Enter intentionally activates whichever button has focus (starts on `deny`).
  useEffect(() => {
    if (inline) return
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void decideRef.current('allow')
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'y') {
        e.preventDefault()
        void decideRef.current('allow')
      } else if (key === 'n') {
        e.preventDefault()
        void decideRef.current('deny')
      } else if (key === 'c' && previewText) {
        e.preventDefault()
        copyRef.current('approval-args', previewText)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [inline, previewText])

  const copied = copiedKey === 'approval-args'

  const card = (
    <div
      role="alertdialog"
      aria-modal={!inline}
      aria-label={`Tool approval for ${approval.toolName}`}
      style={{
        border: `1px solid color-mix(in srgb, var(--${tone}) 55%, var(--rule))`,
        borderLeft: `4px solid var(--${tone})`,
        background: 'var(--surface-3, color-mix(in srgb, var(--bg) 90%, var(--bg-panel) 10%))',
        backdropFilter: 'blur(8px)',
        boxShadow: inline
          ? 'none'
          : `0 0 28px rgba(0, 0, 0, 0.72), 0 0 18px color-mix(in srgb, var(--${tone}) 22%, transparent)`,
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        padding: 14,
        ...style,
      }}
    >
      {/* Top risk framing header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--faint)', fontSize: 10, letterSpacing: '0.12em' }}>╭─ TOOL APPROVAL ─╮</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--faint)', fontSize: 10 }}>#{approval.requestID}</span>
          <span
            style={{
              color: `var(--${tone})`,
              border: `1px solid var(--${tone})`,
              background: `color-mix(in srgb, var(--${tone}) 14%, transparent)`,
              padding: '1px 8px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {approval.risk}
          </span>
        </div>
      </div>

      {/* Tool identity + risk impact summary */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          padding: '7px 9px',
          border: '1px solid var(--rule)',
          background: `color-mix(in srgb, var(--${tone}) 7%, var(--bg))`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>
            <GlowText tone="accent">⚙ {approval.toolName}</GlowText>
          </span>
          <span style={{ color: `var(--${tone})`, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em' }}>
            {forensics.meta.levelLabel} · {forensics.meta.category}
          </span>
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{forensics.meta.guidance}</div>
        {approval.summary && approval.summary !== approval.argsPreview && (
          <div style={{ color: 'var(--text)', fontSize: 11.5, marginTop: 2 }}>{approval.summary}</div>
        )}
      </div>

      {/* Parsed forensic metadata: working dir, targets, signals */}
      {(forensics.workingDir || forensics.targets.length > 0 || forensics.signals.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>
          {forensics.workingDir && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--faint)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                cwd
              </span>
              <code style={{ color: 'var(--accent)', background: 'rgba(5, 8, 12, 0.5)', padding: '1px 6px', border: '1px solid var(--rule)' }}>
                {forensics.workingDir}
              </code>
            </div>
          )}
          {forensics.targets.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--faint)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                targets
              </span>
              {forensics.targets.map((t) => (
                <code
                  key={t}
                  style={{
                    color: 'var(--text)',
                    background: 'rgba(5, 8, 12, 0.5)',
                    border: '1px solid var(--rule)',
                    padding: '0 5px',
                    fontSize: 10.5,
                  }}
                >
                  {t}
                </code>
              ))}
            </div>
          )}
          {forensics.signals.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {forensics.signals.map((sig) => (
                <span
                  key={sig}
                  style={{
                    color: 'var(--warn)',
                    border: '1px solid color-mix(in srgb, var(--warn) 55%, var(--rule))',
                    background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
                    padding: '1px 6px',
                    fontSize: 10,
                  }}
                >
                  ⚑ {sig}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Explicit policy concerns from backend */}
      {approval.concerns && approval.concerns.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            padding: '6px 9px',
            border: '1px solid color-mix(in srgb, var(--warn) 65%, var(--rule))',
            background: 'color-mix(in srgb, var(--warn) 10%, var(--bg))',
            fontSize: 11,
            color: 'var(--warn)',
          }}
        >
          {approval.concerns.map((c, idx) => (
            <div key={idx}>⚠ {c}</div>
          ))}
        </div>
      )}

      {/* Copyable command / arguments preview */}
      <div className="usa-code-block" style={{ margin: 0 }}>
        <div className="usa-code-head">
          <span>Command / Arguments Preview</span>
          {previewText && (
            <button
              type="button"
              className="usa-copy-btn"
              data-copied={copied ? 'true' : undefined}
              onClick={() => copy('approval-args', previewText)}
              title="Copy preview (C)"
            >
              {copied ? '✓ Copied' : '⎘ Copy'}
            </button>
          )}
        </div>
        <pre
          style={{
            margin: 0,
            maxHeight: 140,
            overflow: 'auto',
            padding: 8,
            fontSize: 12,
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            lineHeight: 1.5,
          }}
        >
          {approval.argsPreview || '—'}
        </pre>
      </div>

      {error && <div style={{ color: 'var(--err)', fontSize: 12, whiteSpace: 'pre-wrap' }}>✗ {error}</div>}

      {/* Decision buttons — exact text preserved for E2E & safety contracts */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => decide('deny')}
          ref={denyRef}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="deny"
          title="Deny this request (Esc / N / Enter)"
        >
          {busy === 'deny' ? '…' : 'deny'}
        </button>
        <button
          type="button"
          onClick={() => decide('deny-always')}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="deny-always"
          title="Always deny this tool for the current session"
        >
          {busy === 'deny-always' ? '…' : 'deny-always'}
        </button>
        <button
          type="button"
          onClick={() => decide('allow')}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="allow"
          title="Allow this request once (Y / Ctrl+Enter)"
        >
          {busy === 'allow' ? '…' : 'allow'}
        </button>
        <button
          type="button"
          onClick={() => decide('allow-always')}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="allow-always"
          title="Trust this tool for the rest of the session"
        >
          {busy === 'allow-always' ? '…' : 'allow-always'}
        </button>
      </div>

      {/* Keyboard shortcut legend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          color: 'var(--faint)',
          fontSize: 10,
        }}
      >
        <span>
          <kbd className="usa-kbd">Esc</kbd> / <kbd className="usa-kbd">N</kbd> deny
        </span>
        <span>
          <kbd className="usa-kbd">Y</kbd> / <kbd className="usa-kbd">⌘↵</kbd> allow
        </span>
        <span>
          <kbd className="usa-kbd">C</kbd> copy
        </span>
        <span style={{ marginLeft: 'auto' }}>默认聚焦 deny 防误触</span>
      </div>
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
        background: 'rgba(2, 5, 8, 0.74)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div style={{ width: 520, maxWidth: '94vw' }}>{card}</div>
    </div>
  )
}
