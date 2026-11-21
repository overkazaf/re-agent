// Braille spinner, TUI parity (internal/ui/live.go frame set) with fixed-width
// alignment and prefers-reduced-motion respect.
import { useEffect, useState } from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const GLOW_TONES = new Set(['accent', 'violet', 'ok', 'warn', 'err'])

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function Spinner({ ms = 90, tone = 'accent' }: { ms?: number; tone?: string }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (prefersReducedMotion()) return
    const t = setInterval(() => setI((v) => (v + 1) % FRAMES.length), ms)
    return () => clearInterval(t)
  }, [ms])

  const className = GLOW_TONES.has(tone) ? `crt-spinner crt-spinner--${tone}` : 'crt-spinner'
  const style = GLOW_TONES.has(tone) ? undefined : { color: `var(--${tone})` }
  return (
    <span className={className} style={style} aria-hidden>
      {FRAMES[i]}
    </span>
  )
}
