// ▰▱ 8-cell progress chip, TUI parity (internal/ui/hud.go barOn/barOff) with a
// trailing percent readout. Lit cells carry the accent glow.
export function ProgressChip({ done, total }: { done: number; total: number }) {
  const cells = Math.min(8, Math.max(1, total))
  const filled = total > 0 ? Math.round((done / total) * cells) : 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const bar = '▰'.repeat(filled) + '▱'.repeat(cells - filled)
  return (
    <span style={{ whiteSpace: 'pre' }}>
      <span className="glow-accent">{bar}</span>{' '}
      <span style={{ color: 'var(--muted)' }}>
        {done}/{total}
      </span>{' '}
      <span style={{ color: 'var(--faint)' }}>{pct}%</span>
    </span>
  )
}
