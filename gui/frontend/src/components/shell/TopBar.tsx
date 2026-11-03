// Functional baseline — WS2 upgrades logo glow + live-count badge treatment.
export function TopBar() {
  return (
    <span style={{ color: 'var(--accent)', fontSize: 13, letterSpacing: '0.08em' }}>
      ▓▒░ <strong>0xAF·RE</strong>
      <span style={{ color: 'var(--faint)' }}> :: </span>
      <span style={{ color: 'var(--muted)' }}>COMMAND CENTER</span>
    </span>
  )
}
