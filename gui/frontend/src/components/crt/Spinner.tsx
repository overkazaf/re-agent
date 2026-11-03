// Braille spinner, TUI parity (internal/ui/live.go frame set).
import { useEffect, useState } from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function Spinner({ ms = 90, tone = 'accent' }: { ms?: number; tone?: string }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % FRAMES.length), ms)
    return () => clearInterval(t)
  }, [ms])
  return <span style={{ color: `var(--${tone})` }}>{FRAMES[i]}</span>
}
