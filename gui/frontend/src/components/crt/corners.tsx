// Internal corner-glyph chrome shared by PanelBox and CornerFrame. Not part of
// the public barrel (index.ts) — WS3/WS4 never need this directly.

type Tone = 'accent' | 'violet' | 'ok' | 'warn' | 'err' | 'muted'

/** Tinted var reference for a tone name; muted falls back to --muted. */
export function toneColor(tone: Tone): string {
  return `var(--${tone})`
}

const CORNER_GLYPHS = ['╭', '╮', '╰', '╯'] as const
const CORNER_CLASSES = ['tl', 'tr', 'bl', 'br'] as const

/**
 * Rounded box-drawing corners (╭╮╰╯) overlaid on the panel's square CSS
 * border — the TUI box hybrid: crisp 1px edges, phosphor-rounded corners.
 * Spans are absolutely positioned by .crt-panel-corner / .corner-frame-tick.
 */
export function PanelCorners({ tone = 'muted', className }: { tone?: Tone; className?: string }) {
  const color = toneColor(tone)
  return (
    <>
      {CORNER_GLYPHS.map((glyph, i) => (
        <span
          key={CORNER_CLASSES[i]}
          aria-hidden
          className={`${className ?? 'crt-panel-corner'} ${CORNER_CLASSES[i]}`}
          style={{ color: `color-mix(in srgb, ${color} 60%, var(--rule))` }}
        >
          {glyph}
        </span>
      ))}
    </>
  )
}
