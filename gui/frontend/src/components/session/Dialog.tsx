// WS4 shared dialog chrome: CRT-styled overlay + Esc/click-outside close,
// focus trapping, initial focus & focus restoration on unmount, plus the
// small form primitives (field, select, button) the dialogs share.
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { pushEsc } from '../../lib/escStack'
import '../shell/interaction.css'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  )
}

export function Dialog({
  title,
  accent = 'accent',
  width = 440,
  onClose,
  children,
}: {
  title: string
  accent?: 'accent' | 'violet' | 'ok' | 'warn' | 'err'
  width?: number
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => pushEsc(onClose), [onClose])

  // Initial focus + focus restoration on close
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      // Respect child components that already focused a specific element (e.g. autoFocus)
      if (document.activeElement && panel.contains(document.activeElement)) return

      const body = bodyRef.current
      const preferred =
        body?.querySelector<HTMLElement>('[data-autofocus]') ??
        body?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])') ??
        body?.querySelector<HTMLElement>('button:not([disabled])') ??
        panel
      preferred.focus({ preventScroll: true })
    })

    return () => {
      cancelAnimationFrame(raf)
      if (prev && prev.isConnected) {
        prev.focus({ preventScroll: true })
      }
    }
  }, [])

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusables = getFocusable(panel)
    if (focusables.length === 0) {
      e.preventDefault()
      panel.focus()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null

    if (e.shiftKey) {
      if (!active || active === first || !panel.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else if (!active || active === last || !panel.contains(active)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="ix-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 5, 8, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 40,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="ix-dialog-panel"
        style={{
          width,
          maxWidth: '92vw',
          border: `1px solid var(--${accent})`,
          background: 'var(--surface-2, color-mix(in srgb, var(--bg) 94%, var(--accent) 4%))',
          boxShadow: '0 20px 52px rgba(0, 0, 0, 0.86), 0 0 22px var(--accent-dim)',
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            color: `var(--${accent})`,
            fontSize: 11,
            letterSpacing: '0.12em',
            padding: '5px 10px',
            borderBottom: '1px solid var(--rule)',
          }}
        >
          <span id={titleId}>╭─ {title.toUpperCase()} ─╮</span>
          <button
            type="button"
            onClick={onClose}
            className="ix-btn"
            style={{ background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer', font: 'inherit', fontSize: 12 }}
            title="close (esc)"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </header>
        <div ref={bodyRef} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

export const fieldStyle: CSSProperties = {
  width: '100%',
  background: 'transparent',
  border: '1px solid var(--rule)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12,
  padding: '5px 8px',
  outline: 'none',
}

export const labelStyle: CSSProperties = {
  color: 'var(--faint)',
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
}

type BtnTone = 'accent' | 'ok' | 'warn' | 'err' | 'violet' | 'muted'

export function Btn({
  tone = 'muted',
  className,
  ...rest
}: { tone?: BtnTone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={className ? `ix-dialog-btn ${className}` : 'ix-dialog-btn'}
      style={{
        background: 'transparent',
        border: '1px solid var(--rule)',
        color: tone === 'muted' ? 'var(--text)' : `var(--${tone})`,
        font: 'inherit',
        fontSize: 12,
        padding: '4px 12px',
        cursor: rest.disabled ? 'default' : 'pointer',
        opacity: rest.disabled ? 0.4 : 1,
        ...rest.style,
      }}
    />
  )
}
