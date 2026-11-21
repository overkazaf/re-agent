// Four precision architectural corner brackets — a lighter frame than PanelBox
// for inline groupings, selections, and hover targets.
import type { ReactNode } from 'react'

const POSITIONS = ['tl', 'tr', 'bl', 'br'] as const

export function CornerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="corner-frame">
      {POSITIONS.map((pos) => (
        <span key={pos} aria-hidden className={`corner-frame-tick ${pos}`} />
      ))}
      {children}
    </div>
  )
}
