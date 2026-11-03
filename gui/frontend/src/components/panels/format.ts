// Panel-local formatting helpers, mirroring the TUI's number/duration glyphs
// (internal/ui CompactNumber / FormatDuration) so the GUI reads like the
// terminal it replaces.

/** 999 → "999", 48211 → "48k", 121055 → "121k", 2_400_000 → "2.4M" */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  if (abs < 1_000_000) {
    return value < 10_000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value / 1000)}k`
  }
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** 820 → "820ms", 3200 → "3.2s", 94_000 → "1m34s" */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** HUD clock: 94_200 → "t+1m34s", 12_400 → "t+12s" */
export function fmtClock(ms: number): string {
  if (ms < 60_000) return `t+${Math.max(0, Math.floor(ms / 1000))}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `t+${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** 0.4137 → "$0.4137", 12.5 → "$12.50" */
export function fmtCost(usd: number): string {
  if (usd > 0 && usd < 10) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
