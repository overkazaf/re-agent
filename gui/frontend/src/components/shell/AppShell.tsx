// Functional baseline layout — WS2 upgrades the visual treatment (grid still
// owns the same named areas; keep them stable, WS3/WS4 slot into these areas).
import type { ReactNode } from 'react'
import { TopBar } from './TopBar'

export function AppShell({
  topRight,
  sidebar,
  dashboard,
  side,
  transcript,
  prompt,
}: {
  topRight: ReactNode
  sidebar: ReactNode
  dashboard: ReactNode
  side: ReactNode
  transcript: ReactNode
  prompt: ReactNode
}) {
  return (
    <div
      className="app-shell"
      style={{
        display: 'grid',
        height: '100%',
        gridTemplateColumns: '200px minmax(0, 1fr) 240px',
        gridTemplateRows: '34px minmax(0, 1fr) 180px 64px',
        gap: 6,
        padding: 6,
        gridTemplateAreas: `
          'top top top'
          'sidebar dashboard side'
          'transcript transcript transcript'
          'prompt prompt prompt'
        `,
      }}
    >
      <div style={{ gridArea: 'top', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <TopBar />
        <div>{topRight}</div>
      </div>
      <div style={{ gridArea: 'sidebar', minHeight: 0, overflow: 'auto' }}>{sidebar}</div>
      <div style={{ gridArea: 'dashboard', display: 'flex', flexDirection: 'column', minHeight: 0, gap: 6 }}>
        {dashboard}
      </div>
      <div style={{ gridArea: 'side', minHeight: 0, overflow: 'auto' }}>{side}</div>
      <div style={{ gridArea: 'transcript', minHeight: 0, overflow: 'auto' }}>{transcript}</div>
      <div style={{ gridArea: 'prompt' }}>{prompt}</div>
    </div>
  )
}
