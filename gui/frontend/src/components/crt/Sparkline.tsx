// Functional baseline — WS2 may restyle; keep the props contract.
export function Sparkline({ data, h = 28 }: { data: number[]; w?: number; h?: number }) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  const max = Math.max(1e-9, ...data)
  const glyphs = data.length
    ? data.map((v) => blocks[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
    : '▁'.repeat(16)
  return (
    <span style={{ color: 'var(--accent)', fontSize: h, lineHeight: 1, whiteSpace: 'pre' }}>
      {glyphs}
    </span>
  )
}
