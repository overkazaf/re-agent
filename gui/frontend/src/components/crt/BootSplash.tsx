// Boot narrative, ported from internal/ui/splash.go: the 0xAF block-letter
// logo blooms in (fade + brightness settle), then the self-check probes light
// up line by line, typewriter style. The whole screen arrives via the power-on
// keyframe — tube collapse, overbright, settle.
import { useEffect, useState } from 'react'

export interface BootProbe {
  label: string
  ok: boolean
}

const LOGO = ` ██████╗  ██╗ █████╗ ███████╗
██╔═══██╗███║██╔══██╗╚══███╔╝
██║   ██║╚██║███████║  ███╔╝
██║   ██║ ██║██╔══██║ ███╔╝
╚██████╔╝ ██║██║  ██║███████╗
 ╚═════╝  ╚═╝╚═╝  ╚═╝╚══════╝`

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Reveals its label a character at a time; instant under reduced motion. */
function ProbeLine({ probe }: { probe: BootProbe }) {
  const [chars, setChars] = useState(() => (prefersReducedMotion() ? probe.label.length : 1))
  const typed = chars >= probe.label.length

  useEffect(() => {
    if (typed) return
    const t = setTimeout(() => setChars((v) => v + 1), 14)
    return () => clearTimeout(t)
  }, [chars, typed])

  return (
    <div className="boot-probe">
      <span className="boot-probe-label">{probe.label.slice(0, chars)}</span>{' '}
      <span className={probe.ok ? '' : 'boot-probe-fail'}>{typed ? (probe.ok ? '✓' : '✗') : ''}</span>
    </div>
  )
}

export function BootSplash({
  probes,
  onDone,
}: {
  probes: BootProbe[]
  onDone?: () => void
}) {
  const [lit, setLit] = useState(0)
  useEffect(() => {
    if (lit >= probes.length) {
      if (onDone) {
        const t = setTimeout(onDone, 400)
        return () => clearTimeout(t)
      }
      return
    }
    const t = setTimeout(() => setLit((v) => v + 1), 180)
    return () => clearTimeout(t)
  }, [lit, probes.length, onDone])

  const allLit = lit >= probes.length

  return (
    <div className="crt-power-on" style={{ padding: 24 }}>
      <pre className="boot-logo" aria-label="0xAF">
        {LOGO}
      </pre>
      <div className="boot-tagline" style={{ fontSize: 11, marginBottom: 12 }}>
        reverse ops deck
      </div>
      {probes.slice(0, lit).map((p) => (
        <ProbeLine key={p.label} probe={p} />
      ))}
      {allLit ? <span className="boot-cursor" aria-hidden>▌</span> : null}
    </div>
  )
}
