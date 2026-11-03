// Command center header: phosphor-blooming logo + the live-session indicator
// spot. `live` is optional (defaults to 0) so existing call sites keep working;
// the integration layer passes the running-session count.
export function TopBar({ live = 0 }: { live?: number }) {
  return (
    <span className="topbar-logo">
      <span className="glow-accent" style={{ fontWeight: 700 }}>
        ▓▒░ 0xAF·RE
      </span>
      <span style={{ color: 'var(--faint)' }}>::</span>
      <span style={{ color: 'var(--muted)' }}>COMMAND CENTER</span>
      {live > 0 ? (
        <span className="topbar-live">
          <span className="topbar-live-dot" aria-hidden>
            ●
          </span>{' '}
          {live} live
        </span>
      ) : (
        <span style={{ color: 'var(--faint)', fontSize: 12 }}>○ standby</span>
      )}
    </span>
  )
}
