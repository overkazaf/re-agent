import { AppShell } from './components/shell/AppShell'

// Scaffold stub — Phase 3 integration replaces this with the real composition:
// BootSplash + SessionSidebar + Dashboard + REHud + Transcript + PromptInput.
export default function App() {
  return (
    <AppShell
      topRight={<span className="placeholder">scaffold · WS1-WS4 pending</span>}
      sidebar={<div className="placeholder">sessions</div>}
      dashboard={<div className="placeholder">dashboard</div>}
      side={<div className="placeholder">re hud / queue</div>}
      transcript={<div className="placeholder">transcript</div>}
      prompt={<div className="placeholder">prompt</div>}
    />
  )
}
