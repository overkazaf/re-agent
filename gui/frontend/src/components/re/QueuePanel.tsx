// WS4 queue panel: the backend exposes only hud.queueCount (queue contents
// are not pushed), so v1 shows the count and a hint — no per-prompt list.
import type { CSSProperties } from 'react'
import { GlowText, PanelBox } from '../crt'
import './re-pro.css'

export function QueuePanel({ count, style }: { count: number; style?: CSSProperties }) {
  return (
    <div style={style}>
      <PanelBox title="queue" accent={count > 0 ? 'warn' : undefined} tier="secondary" badge={count > 0 ? `FIFO·${count}` : undefined}>
        {count > 0 ? (
          <div className="re-mono-num" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
            <GlowText tone="accent">
              <span style={{ fontSize: 14 }}>⠿ {count} pending</span>
            </GlowText>
            <div style={{ color: 'var(--faint)', fontSize: 11, lineHeight: 1.6 }}>
              运行中提交的 prompt 按 FIFO 队列挂起，当前 turn 结束自动顺序注入。
              <br />
              管理命令：<span style={{ color: 'var(--muted)' }}>/queue list</span> · <span style={{ color: 'var(--muted)' }}>/queue clear</span>
            </div>
            <div style={{ color: 'var(--faint)', fontSize: 11 }}>
              {Array.from({ length: Math.min(count, 5) }, (_, i) => (
                <div key={i}>├─ slot #{i + 1} · queued</div>
              ))}
              {count > 5 && <div>└─ +{count - 5} more queued</div>}
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
