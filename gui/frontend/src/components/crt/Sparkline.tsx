// Precision telemetry Sparkline as crisp rounded-top SVG bars with subtle
// baseline rule, progressive history fade, and highlighted latest sample.
export function Sparkline({ data, w, h = 28 }: { data: number[]; w?: number; h?: number }) {
  const empty = data.length === 0
  const points = empty ? Array<number>(16).fill(0) : data
  const max = Math.max(1e-9, ...points)

  const gap = 2
  const step = w !== undefined && points.length > 0 ? w / points.length : 6
  const barW = Math.max(1.5, Math.floor(step - gap))
  const width = w ?? points.length * step
  const usable = Math.max(2, h - 3)
  const lastIdx = points.length - 1

  const glow =
    'drop-shadow(0 0 calc(2.5px * var(--glow-strength)) color-mix(in srgb, var(--accent) 42%, transparent))'

  return (
    <svg
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      role="img"
      aria-label="sparkline"
      style={{ display: 'block', overflow: 'visible', filter: empty ? undefined : glow }}
    >
      {/* Subtle instrument baseline */}
      <line
        x1={0}
        y1={h - 0.5}
        x2={width}
        y2={h - 0.5}
        stroke="var(--border-subtle)"
        strokeWidth={1}
      />
      {points.map((v, i) => {
        const ratio = v / max
        const barH = empty ? 1.5 : Math.max(1.5, ratio * usable)
        const isLast = !empty && i === lastIdx
        const recency = points.length > 1 ? 0.36 + (i / lastIdx) * 0.48 : 0.85
        return (
          <rect
            key={i}
            x={i * step}
            y={h - barH - 1}
            width={barW}
            height={barH}
            rx={barW >= 3 ? 1 : 0.5}
            fill={empty ? 'var(--faint)' : 'var(--accent)'}
            opacity={empty ? 0.32 : isLast ? 1 : recency}
          />
        )
      })}
    </svg>
  )
}
