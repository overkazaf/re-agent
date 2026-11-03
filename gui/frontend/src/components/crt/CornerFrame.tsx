// Functional baseline — WS2 upgrades with bracket-corner pseudo-elements.
import type { ReactNode } from 'react'

export function CornerFrame({ children }: { children: ReactNode }) {
  return <div style={{ border: '1px solid var(--rule)', padding: 4 }}>{children}</div>
}
