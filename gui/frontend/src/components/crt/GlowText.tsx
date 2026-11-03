// Functional baseline — WS2 upgrades with layered text-shadow glow.
import type { ReactNode } from 'react'

export function GlowText({
  tone = 'text',
  children,
}: {
  tone?: 'accent' | 'violet' | 'ok' | 'warn' | 'err' | 'text' | 'muted'
  children: ReactNode
}) {
  return <span style={{ color: `var(--${tone})` }}>{children}</span>
}
