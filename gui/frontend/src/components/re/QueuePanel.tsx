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
          <div className="re-mono-num" style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '3px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <GlowText tone="accent">
                <span style={{ fontSize: 13 }}>⠿ {count} pending</span>
              </GlowText>
              <span
                className="re-hint-dot"
                data-hint="运行中提交的指令按 FIFO 顺序排队，当前轮结束后自动注入；可用 /queue list 或 /queue clear 管理"
              >
                ?
              </span>
            </div>
            <div style={{ color: 'var(--faint)', fontSize: 10.5, lineHeight: 1.5 }}>
              {Array.from({ length: Math.min(count, 4) }, (_, i) => (
                <div key={i}>├─ slot #{i + 1} · queued</div>
              ))}
              {count > 4 && <div>└─ +{count - 4} more</div>}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--faint)', fontSize: 11.5, padding: '3px 0' }}>
            <span>○ empty</span>
            <span
              className="re-hint-dot"
              data-hint="Agent 运行中继续输入会自动排入 FIFO 队列，当前 turn 结束后顺次执行"
            >
              ?
            </span>
          </div>
        )}
      </PanelBox>
    </div>
  )
}
