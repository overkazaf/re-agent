// Four corner brackets (⌜⌝⌞⌟) — a lighter frame than PanelBox for inline
// groupings, selections, and hover targets.
import type { ReactNode } from 'react'

const TICKS = [
  { corner: '⌜', pos: 'tl' },
  { corner: '⌝', pos: 'tr' },
  { corner: '⌞', pos: 'bl' },
  { corner: '⌟', pos: 'br' },
] as const

export function CornerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="corner-frame">
      {TICKS.map((t) => (
        <span key={t.pos} aria-hidden className={`corner-frame-tick ${t.pos}`}>
          {t.corner}
        </span>
      ))}
      {children}
    </div>
  )
}
