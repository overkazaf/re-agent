// Panel chrome: square CSS border + ╭╮╰╯ phosphor corner glyphs + glowing
// title, per the TUI box language (internal/ui/hud.go boxTL/TR/BL/BR).
// Supports per-panel folding via the header toggle so operators can collapse
// busy panels (e.g. FLOW / TOOLS / NOTICES) when working on smaller windows.
import { useState, type ReactNode } from 'react'
import { PanelCorners, toneColor } from './corners'

export function PanelBox({
  title,
  accent,
  tier = 'primary',
  badge,
  collapsible = true,
  defaultCollapsed = false,
  children,
}: {
  title: string
  accent?: 'accent' | 'violet' | 'ok' | 'warn' | 'err'
  tier?: 'spotlight' | 'primary' | 'secondary'
  badge?: ReactNode
  collapsible?: boolean
  defaultCollapsed?: boolean
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const tone = accent ?? 'muted'
  return (
    <section
      className={`crt-panel crt-panel--tier-${tier}${accent ? ` crt-panel--${accent}` : ''}${collapsed ? ' crt-panel--collapsed' : ''}`}
    >
      <PanelCorners tone={tone} />
      <header
        className={`crt-panel-title${accent ? ` glow-${accent}` : ''}${collapsible ? ' crt-panel-title--toggle' : ''}`}
        style={accent ? undefined : { color: toneColor('muted') }}
        onClick={collapsible ? () => setCollapsed((v) => !v) : undefined}
        title={collapsible ? (collapsed ? `展开 ${title}` : `折叠 ${title}`) : undefined}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title.toUpperCase()}</span>
          {badge && <span className="crt-panel-badge">{badge}</span>}
        </span>
        {collapsible && (
          <button
            type="button"
            className="crt-panel-fold-btn"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `expand ${title}` : `collapse ${title}`}
            onClick={(e) => {
              e.stopPropagation()
              setCollapsed((v) => !v)
            }}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
      </header>
      {!collapsed && <div className="crt-panel-body">{children}</div>}
    </section>
  )
}
