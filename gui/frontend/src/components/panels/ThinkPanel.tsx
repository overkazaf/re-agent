// THINK — thinking-stream tail window: monospace, bottom-anchored, showing
// the last 3 rows collapsed and 24 expanded. The header toggles (controlled
// via expanded/onToggle, self-managed otherwise) and the newest line fades in
// like a typing tail. Where lines come from is the integration layer's job.
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { PanelBox } from '../crt'
import '../re/re-pro.css'

const ROWS_COLLAPSED = 3
const ROWS_EXPANDED = 24

export function ThinkPanel({ lines, expanded, onToggle }: {
  lines: string[]
  expanded?: boolean
  onToggle?: () => void
}) {
  const [selfOpen, setSelfOpen] = useState(false)
  const controlled = expanded !== undefined
  const open = controlled ? expanded : selfOpen

  const toggle = () => {
    if (!controlled) setSelfOpen(v => !v)
    onToggle?.()
  }

  const rowCount = open ? ROWS_EXPANDED : ROWS_COLLAPSED
  const rows = lines.slice(-rowCount)
  // absolute index of the first visible line, so keys stay stable as the
  // window slides and only the genuinely-new line remounts (replays its fade)
  const start = Math.max(0, lines.length - rows.length)

  return (
    <PanelBox title="think" accent="violet" tier="primary">
      <div className="think-root">
        <button
          type="button"
          className="think-head re-mono-num"
          onClick={toggle}
          data-hint={open ? '点击收起推理流（仅保留最近 3 行）' : '点击展开最近 24 行链式推理内容'}
        >
          <span className="t-muted">{open ? '⌃' : '⌄'}</span>
          <span className="t-faint">{lines.length} lines</span>
          <span className="think-head-hint t-faint">{open ? '收起' : '展开'}</span>
        </button>
        {rows.length === 0 ? (
          <div className="panel-empty t-faint">no thinking yet</div>
        ) : (
          <div
            className="think-body"
            style={{ '--think-rows': String(rowCount) } as CSSProperties}
          >
            {rows.map((line, i) => (
              <div
                key={start + i}
                className={i === rows.length - 1 ? 'think-line think-newest' : 'think-line'}
              >
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </PanelBox>
  )
}
