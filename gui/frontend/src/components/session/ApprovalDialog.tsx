// ApprovalDialog — crisp human-in-the-loop tool approval card with safe `deny`
// default focus, risk pill (`data-hint`), collapsible risk details, copyable
// command preview, and keyboard shortcuts (Esc/N=deny, Y/⌘↵=allow, C=copy).
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
  const [detailsOpen, setDetailsOpen] = useState(false)
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
  const concerns = approval.concerns ?? []
  const extraSummary = approval.summary && approval.summary !== approval.argsPreview ? approval.summary : ''
  const flagCount = concerns.length + forensics.signals.length
  const hasDetails =
    flagCount > 0 || Boolean(extraSummary) || forensics.targets.length > 0 || Boolean(forensics.workingDir)

  const riskTooltip = `${forensics.meta.levelLabel} · ${forensics.meta.category} — ${forensics.meta.guidance}`
  const detailsHint =
    concerns.length > 0
      ? concerns.join('；')
      : forensics.signals.length > 0
        ? forensics.signals.join(' · ')
        : extraSummary || forensics.meta.guidance

  const card = (
    <div
      role="alertdialog"
      aria-modal={!inline}
      aria-label={`Tool approval for ${approval.toolName}`}
      style={{
        border: `1px solid color-mix(in srgb, var(--${tone}) 50%, var(--rule))`,
        borderLeft: `3px solid var(--${tone})`,
        borderRadius: 'var(--radius-sm, 3px)',
        background: 'var(--surface-3, color-mix(in srgb, var(--bg) 90%, var(--bg-panel) 10%))',
        backdropFilter: 'blur(8px)',
        boxShadow: inline ? 'none' : 'var(--shadow-popover, 0 14px 40px rgba(0, 0, 0, 0.56))',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        ...style,
      }}
    >
      {/* Header: title + request id + risk pill */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--faint)', fontSize: 10, letterSpacing: '0.12em' }}>╭─ TOOL APPROVAL ─╮</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--faint)', fontSize: 10 }}>#{approval.requestID}</span>
          <span
            style={{
              color: `var(--${tone})`,
              border: `1px solid color-mix(in srgb, var(--${tone}) 65%, var(--rule))`,
              borderRadius: 'var(--radius-xs, 2px)',
              background: `color-mix(in srgb, var(--${tone}) 12%, transparent)`,
              padding: '1px 7px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'help',
            }}
            data-hint={riskTooltip}
          >
            {approval.risk}
          </span>
          <span
            className="usa-hint-dot"
            tabIndex={0}
            data-hint="默认聚焦 deny 防误触；按 Esc/N 拒绝，Y/⌘↵ 放行，C 复制命令"
          >
            ?
          </span>
        </div>
      </div>

      {/* Tool identity + compact disclosure trigger */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>
          <GlowText tone="accent">⚙ {approval.toolName}</GlowText>
        </span>
        {forensics.workingDir && (
          <code
            style={{
              color: 'var(--muted)',
              background: 'var(--surface-2, color-mix(in srgb, var(--bg) 60%, transparent))',
              border: '1px solid var(--border-subtle, var(--rule))',
              borderRadius: 'var(--radius-xs, 2px)',
              padding: '0 5px',
              fontSize: 10.5,
            }}
            data-hint="命令执行的工作目录"
          >
            {forensics.workingDir}
          </code>
        )}
        <span style={{ flex: 1 }} />
        {hasDetails && (
          <button
            type="button"
            className="usa-disclosure-btn"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            data-hint={detailsHint}
            style={{
              borderColor: flagCount > 0 ? 'color-mix(in srgb, var(--warn) 55%, var(--rule))' : undefined,
              color: flagCount > 0 ? 'var(--warn)' : 'var(--muted)',
            }}
          >
            <span>{flagCount > 0 ? `风险说明 (${flagCount})` : '风险说明'}</span>
            <span>{detailsOpen ? '▴' : '▾'}</span>
          </button>
        )}
      </div>

      {/* Collapsible heuristic & policy details (collapsed by default) */}
      {detailsOpen && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            padding: '7px 9px',
            border: '1px solid var(--border-subtle, var(--rule))',
            borderRadius: 'var(--radius-xs, 2px)',
            background: 'var(--surface-1, color-mix(in srgb, var(--bg) 60%, var(--bg-panel) 40%))',
            fontSize: 11,
          }}
        >
          <div style={{ color: 'var(--muted)' }}>
            <strong style={{ color: `var(--${tone})` }}>{forensics.meta.levelLabel}</strong> · {forensics.meta.guidance}
          </div>
          {extraSummary && <div style={{ color: 'var(--text)' }}>{extraSummary}</div>}
          {forensics.targets.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--faint)', fontSize: 10 }}>TARGETS</span>
              {forensics.targets.map((t) => (
                <code
                  key={t}
                  style={{
                    color: 'var(--text)',
                    background: 'var(--surface-2, transparent)',
                    border: '1px solid var(--border-subtle, var(--rule))',
                    borderRadius: 'var(--radius-xs, 2px)',
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
                    border: '1px solid color-mix(in srgb, var(--warn) 50%, var(--rule))',
                    borderRadius: 'var(--radius-xs, 2px)',
                    background: 'var(--warn-soft, color-mix(in srgb, var(--warn) 10%, transparent))',
                    padding: '1px 6px',
                    fontSize: 10,
                  }}
                >
                  ⚑ {sig}
                </span>
              ))}
            </div>
          )}
          {concerns.map((c, idx) => (
            <div key={idx} style={{ color: 'var(--warn)' }}>
              ⚠ {c}
            </div>
          ))}
        </div>
      )}

      {/* Clean copyable command block */}
      <div className="usa-code-block" style={{ margin: 0 }}>
        <div className="usa-code-head">
          <span>Command</span>
          {previewText && (
            <button
              type="button"
              className="usa-copy-btn"
              data-copied={copied ? 'true' : undefined}
              onClick={() => copy('approval-args', previewText)}
              data-hint="复制命令内容"
              data-hint-kbd="C"
            >
              {copied ? '✓ 已复制' : '⎘ 复制'}
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

      {/* Compact decision bar — exact button text preserved for E2E & safety contracts */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => decide('deny')}
          ref={denyRef}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="deny"
          data-hint="拒绝本次执行（默认安全焦点）"
          data-hint-kbd="N / Esc"
        >
          {busy === 'deny' ? '…' : 'deny'}
        </button>
        <button
          type="button"
          onClick={() => decide('deny-always')}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="deny-always"
          data-hint="本会话内始终拒绝该工具"
        >
          {busy === 'deny-always' ? '…' : 'deny-always'}
        </button>
        <button
          type="button"
          onClick={() => decide('allow')}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="allow"
          data-hint="仅本次放行执行"
          data-hint-kbd="Y"
        >
          {busy === 'allow' ? '…' : 'allow'}
        </button>
        <button
          type="button"
          onClick={() => decide('allow-always')}
          disabled={busy !== null}
          className="usa-approval-btn"
          data-variant="allow-always"
          data-hint="本会话内信任并自动放行该工具"
        >
          {busy === 'allow-always' ? '…' : 'allow-always'}
        </button>
      </div>

      {/* Quiet shortcut legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--faint)', fontSize: 10 }}>
        <span>
          <kbd className="usa-kbd">N</kbd> / <kbd className="usa-kbd">Esc</kbd> deny
        </span>
        <span>
          <kbd className="usa-kbd">Y</kbd> allow
        </span>
        <span>
          <kbd className="usa-kbd">C</kbd> copy
        </span>
      </div>
    </div>
  )

  if (inline) return card

  return (
    <div
      onClick={(e) => {
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
      <div style={{ width: 500, maxWidth: '94vw' }}>{card}</div>
    </div>
  )
}
