// Functional baseline — WS2 upgrades with full CRT corner-glyph treatment.
import type { ReactNode } from 'react'

export function PanelBox({
  title,
  accent,
  children,
}: {
  title: string
  accent?: 'accent' | 'violet' | 'ok' | 'warn' | 'err'
  children: ReactNode
}) {
  const color = accent ? `var(--${accent})` : 'var(--muted)'
  return (
    <section
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <header
        style={{
          color,
          fontSize: 11,
          letterSpacing: '0.12em',
          padding: '4px 10px',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        ╭─ {title.toUpperCase()} ─╮
      </header>
      <div style={{ padding: '6px 10px', overflow: 'auto', minHeight: 0, flex: 1 }}>{children}</div>
    </section>
  )
}
