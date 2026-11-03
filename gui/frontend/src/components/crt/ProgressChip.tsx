// Functional baseline — ▰▱ 8-cell chip, TUI parity.
export function ProgressChip({ done, total }: { done: number; total: number }) {
  const cells = Math.min(8, Math.max(1, total))
  const filled = total > 0 ? Math.round((done / total) * cells) : 0
  const bar = '▰'.repeat(filled) + '▱'.repeat(cells - filled)
  return (
    <span style={{ whiteSpace: 'pre' }}>
      <span style={{ color: 'var(--accent)' }}>{bar}</span>{' '}
      <span style={{ color: 'var(--muted)' }}>
        {done}/{total}
      </span>
    </span>
  )
}
