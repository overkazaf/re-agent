// Dashboard — the five-panel real-time grid over one TickDTO: FLOW and TOOLS
// full-width, PLAN + THINK side by side, TELE closing the box. When the
// container narrows (<720px container query) PLAN/THINK stack vertically.
// Pure composition: every panel is props-in/DOM-out, no business state.
import './panels.css'
import { FlowPanel } from './FlowPanel'
import { ToolsPanel } from './ToolsPanel'
import { PlanPanel } from './PlanPanel'
import { ThinkPanel } from './ThinkPanel'
import { TelePanel } from './TelePanel'
import type { TickDTO } from '../../lib/types'

export function Dashboard({ tick, thinkLines, onThinkToggle }: {
  tick: TickDTO
  thinkLines: string[]
  onThinkToggle?: () => void
}) {
  return (
    <div className="dash-root">
      <div className="dash-grid">
        <div className="dash-cell dash-flow">
          <FlowPanel flow={tick.flow} />
        </div>
        <div className="dash-cell dash-tools">
          <ToolsPanel flow={tick.flow} />
        </div>
        <div className="dash-cell dash-plan">
          <PlanPanel plan={tick.plan} badge={tick.flow.plan} planKind={tick.flow.planKind} />
        </div>
        <div className="dash-cell dash-think">
          <ThinkPanel lines={thinkLines} onToggle={onThinkToggle} />
        </div>
        <div className="dash-cell dash-tele">
          <TelePanel hud={tick.hud} flow={tick.flow} />
        </div>
      </div>
    </div>
  )
}
