// Layout skeleton: the grid named areas and slot props are frozen (WS3/WS4
// slot into them). WS2 owns the tube: inset instrument cells, the bar rule,
// flicker, and the fixed scanline/vignette overlays mounted exactly once.
import type { CSSProperties, ReactNode } from 'react'
import { TopBar } from './TopBar'

const GRID: CSSProperties = {
  display: 'grid',
  height: '100%',
  gridTemplateColumns: '200px minmax(0, 1fr) 240px',
  // prompt row grows with its content (auto-grow textarea up to 6 lines +
  // queue hint) instead of clipping at a fixed 64px
  gridTemplateRows: '34px minmax(0, 1fr) 180px minmax(64px, auto)',
  gap: 8,
  padding: 8,
  gridTemplateAreas: `
    'top top top'
    'sidebar dashboard side'
    'transcript transcript transcript'
    'prompt prompt prompt'
  `,
}

const cell: CSSProperties = { minHeight: 0, minWidth: 0, overflow: 'auto' }

export function AppShell({
  topRight,
  sidebar,
  dashboard,
  side,
  transcript,
  prompt,
  live = 0,
}: {
  topRight: ReactNode
  sidebar: ReactNode
  dashboard: ReactNode
  side: ReactNode
  transcript: ReactNode
  prompt: ReactNode
  /** live session count — drives the breathing ● LIVE indicator (integration) */
  live?: number
}) {
  return (
    <>
      <div className="app-shell crt-flicker" style={GRID}>
        <div className="shell-bar" style={{ gridArea: 'top', padding: '0 4px' }}>
          <TopBar live={live} />
          <div>{topRight}</div>
        </div>
        <div className="shell-cell" style={{ ...cell, gridArea: 'sidebar' }}>{sidebar}</div>
        <div className="shell-cell" style={{ ...cell, gridArea: 'dashboard', overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
            {dashboard}
          </div>
        </div>
        <div className="shell-cell" style={{ ...cell, gridArea: 'side' }}>{side}</div>
        <div className="shell-cell" style={{ ...cell, gridArea: 'transcript' }}>{transcript}</div>
        <div className="shell-cell" style={{ ...cell, gridArea: 'prompt', overflow: 'hidden' }}>{prompt}</div>
      </div>
      <div className="crt-vignette" aria-hidden />
      <div className="crt-scanlines" aria-hidden />
    </>
  )
}
