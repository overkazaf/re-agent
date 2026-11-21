// ▰▱ 8-cell progress chip, TUI parity with crisp lit/unlit separation and
// tabular-nums fraction + percentage readout.
export function ProgressChip({ done, total }: { done: number; total: number }) {
  const cells = Math.min(8, Math.max(1, total))
  const filled = total > 0 ? Math.min(cells, Math.max(0, Math.round((done / total) * cells))) : 0
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0
  const lit = '▰'.repeat(filled)
  const unlit = '▱'.repeat(cells - filled)

  return (
    <span className="crt-progress-chip">
      <span className="crt-progress-chip__bar" aria-hidden>
        {lit && <span className="glow-accent">{lit}</span>}
        {unlit && <span className="crt-progress-chip__off">{unlit}</span>}
      </span>
      <span className="crt-progress-chip__count">
        {done}/{total}
      </span>
      <span className="crt-progress-chip__pct">{pct}%</span>
    </span>
  )
}
