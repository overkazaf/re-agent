// Boot narrative, ported from internal/ui/splash.go: the 0xAF block-letter
// logo arrives inside a framed forensic instrument card, followed by
// crisp self-check probes. Respects prefers-reduced-motion.
import { useEffect, useState } from 'react'
import { PanelCorners } from './corners'

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
    const t = setTimeout(() => setChars((v) => v + 1), 12)
    return () => clearTimeout(t)
  }, [chars, typed])

  return (
    <div className="boot-probe">
      <span className="boot-probe-label">{probe.label.slice(0, chars)}</span>
      <span className={probe.ok ? '' : 'boot-probe-fail'}>
        {typed ? (probe.ok ? '✓' : '✗') : ''}
      </span>
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
        const t = setTimeout(onDone, 360)
        return () => clearTimeout(t)
      }
      return
    }
    const t = setTimeout(() => setLit((v) => v + 1), 160)
    return () => clearTimeout(t)
  }, [lit, probes.length, onDone])

  const allLit = lit >= probes.length

  return (
    <div className="boot-splash-stage">
      <div className="boot-splash-card crt-power-on">
        <PanelCorners tone="accent" />
        <pre className="boot-logo" aria-label="0xAF">
          {LOGO}
        </pre>
        <div className="boot-tagline">reverse ops deck · forensic instrument</div>
        <div className="boot-probes">
          {probes.slice(0, lit).map((p) => (
            <ProbeLine key={p.label} probe={p} />
          ))}
        </div>
        {allLit ? <span className="boot-cursor" aria-hidden>▌</span> : null}
      </div>
    </div>
  )
}
