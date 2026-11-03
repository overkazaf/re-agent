// Functional baseline — WS2 upgrades with ASCII logo + power-on animation.
import { useEffect, useState } from 'react'

export interface BootProbe {
  label: string
  ok: boolean
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

  return (
    <div style={{ padding: 24, fontFamily: 'inherit' }}>
      <pre style={{ color: 'var(--accent)', fontSize: 10, lineHeight: 1.1 }}>
        {` ██████╗  ██╗ █████╗ ███████╗
██╔═══██╗███║██╔══██╗╚══███╔╝
██║   ██║╚██║███████║  ███╔╝
██║   ██║ ██║██╔══██║ ███╔╝
╚██████╔╝ ██║██║  ██║███████╗
 ╚═════╝  ╚═╝╚═╝  ╚═╝╚══════╝`}
      </pre>
      {probes.slice(0, lit).map((p) => (
        <div key={p.label} style={{ fontSize: 12, color: p.ok ? 'var(--ok)' : 'var(--err)' }}>
          {p.ok ? '✓' : '✗'} {p.label}
        </div>
      ))}
    </div>
  )
}
