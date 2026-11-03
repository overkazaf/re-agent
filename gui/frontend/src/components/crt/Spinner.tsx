// Braille spinner, TUI parity (internal/ui/live.go frame set) with an accent
// phosphor halo. Unknown tone names fall back to a bare var() color.
import { useEffect, useState } from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const GLOW_TONES = new Set(['accent', 'violet', 'ok', 'warn', 'err'])

export function Spinner({ ms = 90, tone = 'accent' }: { ms?: number; tone?: string }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % FRAMES.length), ms)
    return () => clearInterval(t)
  }, [ms])

  const className = GLOW_TONES.has(tone) ? `crt-spinner crt-spinner--${tone}` : 'crt-spinner'
  const style = GLOW_TONES.has(tone) ? undefined : { color: `var(--${tone})` }
  return (
    <span className={className} style={style}>
      {FRAMES[i]}
    </span>
  )
}
