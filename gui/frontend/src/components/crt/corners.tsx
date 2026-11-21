// Precision architectural corner brackets shared by PanelBox and BootSplash.
// Uses crisp 1px CSS border L-brackets aligned flush to panel corners instead
// of floating glyph offsets, eliminating clipping and font-metric drift.

type Tone = 'accent' | 'violet' | 'ok' | 'warn' | 'err' | 'muted'

/** Tinted var reference for a tone name; muted falls back to --muted. */
export function toneColor(tone: Tone): string {
  return `var(--${tone})`
}

const CORNER_CLASSES = ['tl', 'tr', 'bl', 'br'] as const

/**
 * Flush 1.5px architectural L-brackets positioned at the four panel corners.
 * Spans are positioned by `.crt-panel-corner.{tl,tr,bl,br}` in crt.css.
 */
export function PanelCorners({ tone = 'muted', className }: { tone?: Tone; className?: string }) {
  const color = toneColor(tone)
  const bracketColor =
    tone === 'muted'
      ? 'color-mix(in srgb, var(--muted) 42%, var(--rule))'
      : `color-mix(in srgb, ${color} 72%, var(--rule))`
  return (
    <>
      {CORNER_CLASSES.map((pos) => (
        <span
          key={pos}
          aria-hidden
          className={`${className ?? 'crt-panel-corner'} ${pos}`}
          style={{ color: bracketColor }}
        />
      ))}
    </>
  )
}
