// Minimal command center header: crisp brand mark, subtle live status dot,
// and clickable awaiting-approval alert pill when a gate needs operator action.
// Optional activeLabel / activeModeBadge props are retained for API compatibility.
import './interaction.css'

export function TopBar({
  live = 0,
  awaitingApprovalCount = 0,
  onJumpToApproval,
}: {
  live?: number
  awaitingApprovalCount?: number
  onJumpToApproval?: () => void
  activeLabel?: string
  activeModeBadge?: string
}) {
  return (
    <span className="topbar-logo">
      <span className="topbar-brand">
        <span className="topbar-brand-glyph glow-accent" aria-hidden>
          ◈
        </span>
        <span>0xAF-Re</span>
      </span>

      {live > 0 ? (
        <span
          className="topbar-status-dot topbar-status-dot--live"
          data-hint={`${live} 个会话正在执行中`}
          data-hint-side="bottom"
        >
          <span className="topbar-live-dot" aria-hidden>
            ●
          </span>
          <span>{live}</span>
        </span>
      ) : (
        <span
          className="topbar-status-dot"
          data-hint="所有会话待命中"
          data-hint-side="bottom"
          aria-label="Standby"
        >
          <span aria-hidden>●</span>
        </span>
      )}

      {awaitingApprovalCount > 0 && (
        <button
          type="button"
          className="ix-approval-pill"
          onClick={onJumpToApproval}
          data-hint="点击立即跳转至等待审批的会话"
          data-hint-side="bottom"
        >
          <span aria-hidden>◐</span>
          <span>{awaitingApprovalCount} 审批</span>
        </button>
      )}
    </span>
  )
}
