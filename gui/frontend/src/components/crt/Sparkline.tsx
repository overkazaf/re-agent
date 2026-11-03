// Sparkline as SVG bars (same ▁▂▃▄▅▆▇█ silhouette, now with phosphor bloom).
// Latest bar burns at full brightness; history sits one step dimmer.
export function Sparkline({ data, w, h = 28 }: { data: number[]; w?: number; h?: number }) {
  const empty = data.length === 0
  const points = empty ? Array<number>(16).fill(0) : data
  const max = Math.max(1e-9, ...points)

  const gap = 2
  const step = w !== undefined && points.length > 0 ? w / points.length : 6
  const barW = Math.max(1, Math.floor(step - gap))
  const width = w ?? points.length * step
  const usable = h - 2

  const glow =
    'drop-shadow(0 0 calc(3px * var(--glow-strength)) color-mix(in srgb, var(--accent) 55%, transparent))'

  return (
    <svg
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      role="img"
      aria-label="sparkline"
      style={{ display: 'block', overflow: 'visible', filter: glow }}
    >
      {points.map((v, i) => {
        const barH = Math.max(1, (v / max) * usable)
        return (
          <rect
            key={i}
            x={i * step}
            y={h - barH}
            width={barW}
            height={barH}
            fill={empty ? 'var(--faint)' : 'var(--accent)'}
            opacity={empty ? 0.5 : i === points.length - 1 ? 1 : 0.78}
          />
        )
      })}
    </svg>
  )
}
