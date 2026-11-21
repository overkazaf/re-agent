// Command center header: phosphor-blooming logo, live-session indicator,
// active workspace/mode breadcrumb, and clickable awaiting-approval alert pill.
// All new props are optional so existing call sites stay 100% compatible.
import './interaction.css'

export function TopBar({
  live = 0,
  awaitingApprovalCount = 0,
  onJumpToApproval,
  activeLabel,
  activeModeBadge,
}: {
  live?: number
  awaitingApprovalCount?: number
  onJumpToApproval?: () => void
  activeLabel?: string
  activeModeBadge?: string
}) {
  return (
    <span className="topbar-logo">
      <span className="glow-accent" style={{ fontWeight: 700 }}>
        ▓▒░ 0xAF·RE
      </span>
      <span style={{ color: 'var(--faint)' }}>::</span>
      <span style={{ color: 'var(--muted)' }}>COMMAND CENTER</span>
      {live > 0 ? (
        <span className="topbar-live" title={`${live} 个会话正在执行中`}>
          <span className="topbar-live-dot" aria-hidden>
            ●
          </span>{' '}
          {live} live
        </span>
      ) : (
        <span style={{ color: 'var(--faint)', fontSize: 12 }}>○ standby</span>
      )}
      {awaitingApprovalCount > 0 && (
        <button
          type="button"
          className="ix-approval-pill"
          onClick={onJumpToApproval}
          title="点击立即跳转至等待审批的会话"
        >
          <span aria-hidden>◐</span>
          <span>{awaitingApprovalCount} approval</span>
        </button>
      )}
      {activeLabel && (
        <span className="ix-top-crumb" title={`当前上下文: ${activeLabel}`}>
          {activeModeBadge && (
            <span style={{ color: 'var(--violet)', fontSize: 10, letterSpacing: '0.06em' }}>
              {activeModeBadge}
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {`▸ ${activeLabel}`}
          </span>
        </span>
      )}
    </span>
  )
}
