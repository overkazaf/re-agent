// Layout skeleton: resizable + collapsible CRT split workspace with localStorage
// persistence. Left SESSIONS sidebar spans full height; right workspace splits
// vertically between [Dashboard | Right Rail], [Transcript], and [Prompt].
// Every pane can be folded with 1 click and resized by dragging glowing handles
// (double-click any handle to reset). A non-null `main` swaps the right side
// for the embedded xterm.js shell terminal.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { TopBar } from './TopBar'

const LAYOUT_KEY = '0xaf-gui-layout-v1'

interface LayoutState {
  sidebarWidth: number
  sideWidth: number
  transcriptHeight: number
  sidebarCollapsed: boolean
  sideCollapsed: boolean
  dashboardCollapsed: boolean
  transcriptCollapsed: boolean
}

const DEFAULT_LAYOUT: LayoutState = {
  sidebarWidth: 244,
  sideWidth: 240,
  transcriptHeight: 196,
  sidebarCollapsed: false,
  sideCollapsed: false,
  dashboardCollapsed: false,
  transcriptCollapsed: false,
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    return {
      sidebarWidth: clamp(Number(parsed.sidebarWidth) || DEFAULT_LAYOUT.sidebarWidth, 180, 460),
      sideWidth: clamp(Number(parsed.sideWidth) || DEFAULT_LAYOUT.sideWidth, 180, 460),
      transcriptHeight: clamp(Number(parsed.transcriptHeight) || DEFAULT_LAYOUT.transcriptHeight, 96, 560),
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      sideCollapsed: Boolean(parsed.sideCollapsed),
      dashboardCollapsed: Boolean(parsed.dashboardCollapsed),
      transcriptCollapsed: Boolean(parsed.transcriptCollapsed),
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function saveLayout(state: LayoutState): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(state))
  } catch {
    // storage unavailable — layout still works in-memory
  }
}

type DragAxis = 'sidebar' | 'side' | 'transcript'

export function AppShell({
  topRight,
  banner,
  sidebar,
  dashboard,
  side,
  transcript,
  prompt,
  main,
  live = 0,
  expandDashboardKey = 0,
}: {
  topRight: ReactNode
  /** optional full-width strip beneath TopBar (e.g. DemoCoachBar) */
  banner?: ReactNode
  sidebar: ReactNode
  dashboard?: ReactNode
  side?: ReactNode
  transcript?: ReactNode
  prompt?: ReactNode
  /** full-area slot (shell terminal); when set, the session slots are ignored */
  main?: ReactNode
  /** live session count — drives the breathing ● LIVE indicator (integration) */
  live?: number
  /** increment to ensure upper dashboard/graph pane is uncollapsed */
  expandDashboardKey?: number
}) {
  const [layout, setLayout] = useState<LayoutState>(loadLayout)
  const [dragging, setDragging] = useState<DragAxis | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    saveLayout(layout)
  }, [layout])

  useEffect(() => {
    if (expandDashboardKey > 0) {
      setLayout((cur) => (cur.dashboardCollapsed ? { ...cur, dashboardCollapsed: false } : cur))
    }
  }, [expandDashboardKey])

  const startDrag = useCallback((axis: DragAxis, e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const initial = layoutRef.current
    const rect = shellRef.current?.getBoundingClientRect()
    const maxColW = rect ? Math.max(220, Math.floor(rect.width * 0.42)) : 460
    const maxRowH = rect ? Math.max(160, Math.floor(rect.height * 0.65)) : 560

    setDragging(axis)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = axis === 'transcript' ? 'row-resize' : 'col-resize'

    const onMove = (ev: PointerEvent) => {
      if (axis === 'sidebar') {
        const next = clamp(initial.sidebarWidth + (ev.clientX - startX), 180, maxColW)
        setLayout((cur) => ({ ...cur, sidebarWidth: next, sidebarCollapsed: false }))
      } else if (axis === 'side') {
        const next = clamp(initial.sideWidth - (ev.clientX - startX), 180, maxColW)
        setLayout((cur) => ({ ...cur, sideWidth: next, sideCollapsed: false }))
      } else {
        const next = clamp(initial.transcriptHeight - (ev.clientY - startY), 96, maxRowH)
        setLayout((cur) => ({ ...cur, transcriptHeight: next, transcriptCollapsed: false }))
      }
    }

    const onUp = () => {
      setDragging(null)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const toggle = (key: 'sidebarCollapsed' | 'sideCollapsed' | 'dashboardCollapsed' | 'transcriptCollapsed') => {
    setLayout((cur) => ({ ...cur, [key]: !cur[key] }))
  }

  const resetLayout = () => setLayout(DEFAULT_LAYOUT)

  const shellMode = main != null
  const hasBanner = banner != null
  const isCustom =
    layout.sidebarCollapsed ||
    layout.sideCollapsed ||
    layout.dashboardCollapsed ||
    layout.transcriptCollapsed ||
    layout.sidebarWidth !== DEFAULT_LAYOUT.sidebarWidth ||
    layout.sideWidth !== DEFAULT_LAYOUT.sideWidth ||
    layout.transcriptHeight !== DEFAULT_LAYOUT.transcriptHeight

  return (
    <>
      <div ref={shellRef} className="app-shell crt-flicker" style={outerStyle}>
        {/* Top Bar */}
        <div className="shell-bar" style={topBarStyle}>
          <TopBar live={live} />
          <div style={topRightWrapStyle}>
            <div style={layoutBarStyle} aria-label="pane visibility">
              <button
                type="button"
                onClick={() => toggle('sidebarCollapsed')}
                title={layout.sidebarCollapsed ? '展开左侧会话栏' : '折叠左侧会话栏'}
                className={`layout-toggle-btn${layout.sidebarCollapsed ? ' layout-toggle-btn--off' : ''}`}
              >
                ◧ 侧栏
              </button>
              {!shellMode && (
                <>
                  <button
                    type="button"
                    onClick={() => toggle('dashboardCollapsed')}
                    title={layout.dashboardCollapsed ? '展开仪表盘' : '折叠仪表盘（放大转录区）'}
                    className={`layout-toggle-btn${layout.dashboardCollapsed ? ' layout-toggle-btn--off' : ''}`}
                  >
                    ⬒ 仪表
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle('transcriptCollapsed')}
                    title={layout.transcriptCollapsed ? '展开转录日志' : '折叠转录日志'}
                    className={`layout-toggle-btn${layout.transcriptCollapsed ? ' layout-toggle-btn--off' : ''}`}
                  >
                    ⬓ 转录
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle('sideCollapsed')}
                    title={layout.sideCollapsed ? '展开右侧 RE/通知栏' : '折叠右侧 RE/通知栏'}
                    className={`layout-toggle-btn${layout.sideCollapsed ? ' layout-toggle-btn--off' : ''}`}
                  >
                    ◨ 右栏
                  </button>
                </>
              )}
              {isCustom && (
                <button
                  type="button"
                  onClick={resetLayout}
                  title="重置所有窗口尺寸并全部展开"
                  className="layout-toggle-btn"
                >
                  ↺
                </button>
              )}
            </div>
            {topRight}
          </div>
        </div>

        {/* Optional Banner (DemoCoachBar) */}
        {hasBanner && <div style={{ flex: '0 0 auto', minWidth: 0 }}>{banner}</div>}

        {/* Main Horizontal Split: Full-Height Sidebar | Workspace (or Shell) */}
        <div style={rowFlexStyle}>
          {/* Left Sidebar */}
          {layout.sidebarCollapsed ? (
            <button
              type="button"
              className="collapsed-rail-btn"
              onClick={() => toggle('sidebarCollapsed')}
              title="展开左侧会话栏"
            >
              <span>▸</span>
              <span className="collapsed-rail-label">SESSIONS</span>
            </button>
          ) : (
            <div
              className="shell-cell shell-cell--nav"
              style={{ ...cell, flex: `0 0 ${layout.sidebarWidth}px`, width: layout.sidebarWidth }}
            >
              {sidebar}
            </div>
          )}

          {!layout.sidebarCollapsed ? (
            <div
              role="separator"
              aria-orientation="vertical"
              title="拖动调整左侧栏宽度（双击重置）"
              className={`split-handle split-handle--col${dragging === 'sidebar' ? ' split-handle--active' : ''}`}
              onPointerDown={(e) => startDrag('sidebar', e)}
              onDoubleClick={() => setLayout((cur) => ({ ...cur, sidebarWidth: DEFAULT_LAYOUT.sidebarWidth }))}
            />
          ) : (
            <div style={{ flex: '0 0 8px' }} />
          )}

          {/* Right Area: Shell OR (Upper[Dashboard | Side] + Transcript + Prompt) */}
          {shellMode ? (
            <div className="shell-cell" style={{ ...cell, flex: '1 1 0', overflow: 'hidden' }}>
              {main}
            </div>
          ) : (
            <div style={colFlexStyle}>
              {/* Upper Pane: Dashboard | Right Rail */}
              {layout.dashboardCollapsed ? (
                <button
                  type="button"
                  className="collapsed-bar-btn"
                  onClick={() => toggle('dashboardCollapsed')}
                  title="展开五面板仪表盘与右侧 RE/通知栏"
                >
                  <span>▸ DASHBOARD · FLOW / TOOLS / PLAN / THINK / TELE</span>
                  <span style={{ color: 'var(--faint)', fontSize: 10 }}>点击展开</span>
                </button>
              ) : (
                <div style={{ ...rowFlexStyle, flex: '1 1 0', minHeight: 110 }}>
                  <div className="shell-cell shell-cell--focus" style={{ ...cell, flex: '1 1 0', overflow: 'auto' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: '100%' }}>
                      {dashboard}
                    </div>
                  </div>

                  {!layout.sideCollapsed ? (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      title="拖动调整右侧栏宽度（双击重置）"
                      className={`split-handle split-handle--col${dragging === 'side' ? ' split-handle--active' : ''}`}
                      onPointerDown={(e) => startDrag('side', e)}
                      onDoubleClick={() => setLayout((cur) => ({ ...cur, sideWidth: DEFAULT_LAYOUT.sideWidth }))}
                    />
                  ) : (
                    <div style={{ flex: '0 0 8px' }} />
                  )}

                  {layout.sideCollapsed ? (
                    <button
                      type="button"
                      className="collapsed-rail-btn"
                      onClick={() => toggle('sideCollapsed')}
                      title="展开右侧 RE / 队列 / 通知栏"
                    >
                      <span>◂</span>
                      <span className="collapsed-rail-label">RE · NOTICES</span>
                    </button>
                  ) : (
                    <div
                      className="shell-cell shell-cell--forensic"
                      style={{ ...cell, flex: `0 0 ${layout.sideWidth}px`, width: layout.sideWidth }}
                    >
                      {side}
                    </div>
                  )}
                </div>
              )}

              {/* Horizontal Splitter above Transcript */}
              {!layout.transcriptCollapsed && !layout.dashboardCollapsed ? (
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  title="拖动调整转录区高度（双击重置）"
                  className={`split-handle split-handle--row${dragging === 'transcript' ? ' split-handle--active' : ''}`}
                  onPointerDown={(e) => startDrag('transcript', e)}
                  onDoubleClick={() =>
                    setLayout((cur) => ({ ...cur, transcriptHeight: DEFAULT_LAYOUT.transcriptHeight }))
                  }
                />
              ) : (
                <div style={{ flex: '0 0 8px' }} />
              )}

              {/* Transcript */}
              {layout.transcriptCollapsed ? (
                <button
                  type="button"
                  className="collapsed-bar-btn"
                  onClick={() => toggle('transcriptCollapsed')}
                  title="展开转录流"
                >
                  <span>▸ TRANSCRIPT</span>
                  <span style={{ color: 'var(--faint)', fontSize: 10 }}>点击展开</span>
                </button>
              ) : (
                <div
                  className="shell-cell shell-cell--transcript"
                  style={{
                    ...cell,
                    flex: layout.dashboardCollapsed ? '1 1 0' : `0 0 ${layout.transcriptHeight}px`,
                    height: layout.dashboardCollapsed ? undefined : layout.transcriptHeight,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {transcript}
                </div>
              )}

              <div style={{ flex: '0 0 8px' }} />

              {/* Prompt Input */}
              <div className="shell-cell shell-cell--prompt" style={{ ...cell, flex: '0 0 auto', overflow: 'hidden' }}>
                {prompt}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="crt-vignette" aria-hidden />
      <div className="crt-scanlines" aria-hidden />
    </>
  )
}

const outerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  height: '100%',
  padding: 8,
  minHeight: 0,
  minWidth: 0,
}

const topBarStyle: CSSProperties = {
  flex: '0 0 34px',
  padding: '0 4px',
  gap: 8,
}

const topRightWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
}

const layoutBarStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
}

const rowFlexStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flex: '1 1 0',
  minHeight: 0,
  minWidth: 0,
}

const colFlexStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 0',
  minHeight: 0,
  minWidth: 0,
}

const cell: CSSProperties = { minHeight: 0, minWidth: 0, overflow: 'auto' }
