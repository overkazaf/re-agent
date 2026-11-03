// Panel chrome: square CSS border + ╭╮╰╯ phosphor corner glyphs + glowing
// title, per the TUI box language (internal/ui/hud.go boxTL/TR/BL/BR).
import type { ReactNode } from 'react'
import { PanelCorners, toneColor } from './corners'

export function PanelBox({
  title,
  accent,
  children,
}: {
  title: string
  accent?: 'accent' | 'violet' | 'ok' | 'warn' | 'err'
  children: ReactNode
}) {
  const tone = accent ?? 'muted'
  return (
    <section className={`crt-panel${accent ? ` crt-panel--${accent}` : ''}`}>
      <PanelCorners tone={tone} />
      <header
        className={`crt-panel-title${accent ? ` glow-${accent}` : ''}`}
        style={accent ? undefined : { color: toneColor('muted') }}
      >
        {title.toUpperCase()}
      </header>
      <div className="crt-panel-body">{children}</div>
    </section>
  )
}
