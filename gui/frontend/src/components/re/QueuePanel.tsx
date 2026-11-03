// WS4 queue panel: the backend exposes only hud.queueCount (queue contents
// are not pushed), so v1 shows the count and a hint — no per-prompt list.
import type { CSSProperties } from 'react'
import { GlowText, PanelBox } from '../crt'

export function QueuePanel({ count, style }: { count: number; style?: CSSProperties }) {
  return (
    <div style={style}>
      <PanelBox title="queue" accent={count > 0 ? 'accent' : undefined}>
        {count > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
            <GlowText tone="accent">
              <span style={{ fontSize: 14 }}>⠿ {count} pending</span>
            </GlowText>
            <div style={{ color: 'var(--faint)', fontSize: 11, lineHeight: 1.6 }}>
              运行中提交的 prompt 自动排队，按序注入后续 turn。
              <br />
              队列内容管理见 TUI <span style={{ color: 'var(--muted)' }}>/queue list</span>（GUI v1 只读计数）。
            </div>
            <div style={{ color: 'var(--faint)', fontSize: 11 }}>
              {Array.from({ length: Math.min(count, 5) }, (_, i) => (
                <div key={i}>… #{i + 1}</div>
              ))}
              {count > 5 && <div>… +{count - 5} more</div>}
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--faint)', fontSize: 12, padding: '4px 0' }}>
            ○ empty — 运行中提交的 prompt 自动排队
          </div>
        )}
      </PanelBox>
    </div>
  )
}
