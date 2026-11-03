// ● ok/running (breathing bloom) ◐ pending/awaiting ○ idle/off
const GLYPH = { ok: '●', pending: '◐', off: '○' } as const
const LABEL = { ok: 'running', pending: 'pending', off: 'idle' } as const

export function StatusBadge({ state }: { state: 'ok' | 'pending' | 'off' }) {
  return (
    <span className={`status-badge--${state}`} title={LABEL[state]} aria-label={LABEL[state]}>
      {GLYPH[state]}
    </span>
  )
}
