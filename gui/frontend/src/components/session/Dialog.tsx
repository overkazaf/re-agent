// WS4 shared dialog chrome: CRT-styled overlay + Esc/click-outside close,
// plus the small form primitives (field, select, button) the dialogs share.
import { useEffect, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 5, 8, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 40,
      }}
    >
      <div
        style={{
          width,
          maxWidth: '92vw',
          border: `1px solid var(--${accent})`,
          background: 'var(--bg-panel)',
          boxShadow: `0 0 22px var(--accent-dim)`,
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
          <span>╭─ {title.toUpperCase()} ─╮</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer', font: 'inherit', fontSize: 12 }}
            title="close (esc)"
          >
            ✕
          </button>
        </header>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
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
  ...rest
}: { tone?: BtnTone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
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
