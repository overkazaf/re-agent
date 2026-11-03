// Phosphor glow text — consumes the .glow-* utilities from crt.css, which
// derive their halos from the active theme's palette and --glow-strength.
import type { ReactNode } from 'react'

export function GlowText({
  tone = 'text',
  children,
}: {
  tone?: 'accent' | 'violet' | 'ok' | 'warn' | 'err' | 'text' | 'muted'
  children: ReactNode
}) {
  return <span className={`glow-${tone}`}>{children}</span>
}
