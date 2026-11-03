// ● ok/running ◐ pending/awaiting ○ idle/off
export function StatusBadge({
  state,
}: {
  state: 'ok' | 'pending' | 'off'
}) {
  const glyph = state === 'ok' ? '●' : state === 'pending' ? '◐' : '○'
  const tone = state === 'ok' ? 'var(--ok)' : state === 'pending' ? 'var(--warn)' : 'var(--faint)'
  return <span style={{ color: tone }}>{glyph}</span>
}
