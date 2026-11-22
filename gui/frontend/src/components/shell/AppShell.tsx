// Layout skeleton: resizable + collapsible CRT split workspace with localStorage
// persistence, keyboard pane shortcuts (Cmd/Ctrl+B, J, \, Shift+D, Shift+0, Shift+F),
// focus-tracked panes, keyboard-accessible splitters with live dimension readout,
// and drag-resize text-selection lock.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useNativeFullscreen } from '../../lib/fullscreen'
import { hasPrimaryMod, modGlyph } from './shortcuts'
import { TopBar } from './TopBar'
import './interaction.css'

const LAYOUT_KEY = '0xaf-gui-layout-v1'

export interface LayoutState {
  sidebarWidth: number
  sideWidth: number
  transcriptHeight: number
  sidebarCollapsed: boolean
  sideCollapsed: boolean
  dashboardCollapsed: boolean
  transcriptCollapsed: boolean
}

export interface ShellLayoutController {
  getState: () => LayoutState & { fullscreen: boolean }
  toggleSidebar: () => void
  toggleSide: () => void
  toggleDashboard: () => void
  toggleTranscript: () => void
  resetLayout: () => void
  toggleFullscreen: () => void
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
type FocusPane = 'sidebar' | 'dashboard' | 'side' | 'transcript' | 'prompt' | 'shell'

interface DragReadout {
  axis: DragAxis
  px: number
  x: number
  y: number
}

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
  awaitingApprovalCount = 0,
  onJumpToApproval,
  activeLabel,
  activeModeBadge,
  expandDashboardKey = 0,
  layoutRef: controllerRef,
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
  /** sessions currently blocked on a tool approval gate */
  awaitingApprovalCount?: number
  /** click handler for the TopBar approval alert pill */
  onJumpToApproval?: () => void
  /** active workspace/shell breadcrumb shown in TopBar */
  activeLabel?: string
  /** optional short mode tag next to activeLabel (e.g. SHELL / RE) */
  activeModeBadge?: string
  /** increment to ensure upper dashboard/graph pane is uncollapsed */
  expandDashboardKey?: number
  /** optional imperative bridge so Command Palette can toggle panes & fullscreen */
  layoutRef?: MutableRefObject<ShellLayoutController | null>
}) {
  const [layout, setLayout] = useState<LayoutState>(loadLayout)
  const [dragging, setDragging] = useState<DragAxis | null>(null)
  const [dragReadout, setDragReadout] = useState<DragReadout | null>(null)
  const [focusedPane, setFocusedPane] = useState<FocusPane | null>(null)
  const nativeFs = useNativeFullscreen()
  const shellRef = useRef<HTMLDivElement>(null)
  const layoutStateRef = useRef(layout)
  layoutStateRef.current = layout
  const nativeFsRef = useRef(nativeFs)
  nativeFsRef.current = nativeFs

  const mod = modGlyph()

  useEffect(() => {
    saveLayout(layout)
  }, [layout])

  useEffect(() => {
    if (expandDashboardKey > 0) {
      setLayout((cur) => (cur.dashboardCollapsed ? { ...cur, dashboardCollapsed: false } : cur))
    }
  }, [expandDashboardKey])

  const toggle = useCallback(
    (key: 'sidebarCollapsed' | 'sideCollapsed' | 'dashboardCollapsed' | 'transcriptCollapsed') => {
      setLayout((cur) => ({ ...cur, [key]: !cur[key] }))
    },
    [],
  )

  const resetLayout = useCallback(() => setLayout(DEFAULT_LAYOUT), [])

  // Expose layout controls to Command Palette / parent orchestrator
  useEffect(() => {
    if (!controllerRef) return
    controllerRef.current = {
      getState: () => ({ ...layoutStateRef.current, fullscreen: nativeFsRef.current.active }),
      toggleSidebar: () => toggle('sidebarCollapsed'),
      toggleSide: () => toggle('sideCollapsed'),
      toggleDashboard: () => toggle('dashboardCollapsed'),
      toggleTranscript: () => toggle('transcriptCollapsed'),
      resetLayout,
      toggleFullscreen: () => nativeFsRef.current.toggle(),
    }
    return () => {
      controllerRef.current = null
    }
  }, [controllerRef, toggle, resetLayout])

  const shellMode = main != null

  // Keyboard pane ergonomics: Cmd/Ctrl+B (sidebar), J (transcript), \ (right rail),
  // Shift+D (dashboard), Shift+0 (reset layout), Shift+F (fullscreen)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!hasPrimaryMod(e) || e.altKey) return
      const key = e.key.toLowerCase()

      if (!e.shiftKey && key === 'b') {
        e.preventDefault()
        toggle('sidebarCollapsed')
        return
      }
      if (!e.shiftKey && key === 'j' && !shellMode) {
        e.preventDefault()
        toggle('transcriptCollapsed')
        return
      }
      if (!e.shiftKey && e.key === '\\' && !shellMode) {
        e.preventDefault()
        toggle('sideCollapsed')
        return
      }
      if (e.shiftKey && key === 'd' && !shellMode) {
        e.preventDefault()
        toggle('dashboardCollapsed')
        return
      }
      if (e.shiftKey && (e.key === '0' || e.code === 'Digit0')) {
        e.preventDefault()
        resetLayout()
        return
      }
      if (e.shiftKey && key === 'f') {
        e.preventDefault()
        nativeFsRef.current.toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle, resetLayout, shellMode])

  const startDrag = useCallback((axis: DragAxis, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const initial = layoutStateRef.current
    const rect = shellRef.current?.getBoundingClientRect()
    const maxColW = rect ? Math.max(220, Math.floor(rect.width * 0.42)) : 460
    const maxRowH = rect ? Math.max(160, Math.floor(rect.height * 0.65)) : 560

    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore if capture is unsupported
    }

    const startPx =
      axis === 'sidebar'
        ? initial.sidebarWidth
        : axis === 'side'
          ? initial.sideWidth
          : initial.transcriptHeight

    setDragging(axis)
    setDragReadout({ axis, px: startPx, x: e.clientX, y: e.clientY })
    document.body.classList.add('ix-resizing')
    document.body.style.userSelect = 'none'
    document.body.style.cursor = axis === 'transcript' ? 'row-resize' : 'col-resize'

    const onMove = (ev: PointerEvent) => {
      if (axis === 'sidebar') {
        const next = clamp(initial.sidebarWidth + (ev.clientX - startX), 180, maxColW)
        setLayout((cur) => ({ ...cur, sidebarWidth: next, sidebarCollapsed: false }))
        setDragReadout({ axis, px: Math.round(next), x: ev.clientX, y: ev.clientY })
      } else if (axis === 'side') {
        const next = clamp(initial.sideWidth - (ev.clientX - startX), 180, maxColW)
        setLayout((cur) => ({ ...cur, sideWidth: next, sideCollapsed: false }))
        setDragReadout({ axis, px: Math.round(next), x: ev.clientX, y: ev.clientY })
      } else {
        const next = clamp(initial.transcriptHeight - (ev.clientY - startY), 96, maxRowH)
        setLayout((cur) => ({ ...cur, transcriptHeight: next, transcriptCollapsed: false }))
        setDragReadout({ axis, px: Math.round(next), x: ev.clientX, y: ev.clientY })
      }
    }

    const cleanup = () => {
      setDragging(null)
      setDragReadout(null)
      document.body.classList.remove('ix-resizing')
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('blur', cleanup)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('blur', cleanup)
  }, [])

  const onSplitterKeyDown = useCallback((axis: DragAxis, e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === '0' || e.key === 'Enter') {
      e.preventDefault()
      setLayout((cur) =>
        axis === 'sidebar'
          ? { ...cur, sidebarWidth: DEFAULT_LAYOUT.sidebarWidth }
          : axis === 'side'
            ? { ...cur, sideWidth: DEFAULT_LAYOUT.sideWidth }
            : { ...cur, transcriptHeight: DEFAULT_LAYOUT.transcriptHeight },
      )
      return
    }
    if (axis === 'sidebar' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const delta = e.key === 'ArrowRight' ? step : -step
      setLayout((cur) => ({ ...cur, sidebarWidth: clamp(cur.sidebarWidth + delta, 180, 460) }))
    } else if (axis === 'side' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const delta = e.key === 'ArrowLeft' ? step : -step
      setLayout((cur) => ({ ...cur, sideWidth: clamp(cur.sideWidth + delta, 180, 460) }))
    } else if (axis === 'transcript' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const delta = e.key === 'ArrowUp' ? step : -step
      setLayout((cur) => ({ ...cur, transcriptHeight: clamp(cur.transcriptHeight + delta, 96, 560) }))
    }
  }, [])

  const hasBanner = banner != null
  const isCustom =
    layout.sidebarCollapsed ||
    layout.sideCollapsed ||
    layout.dashboardCollapsed ||
    layout.transcriptCollapsed ||
    layout.sidebarWidth !== DEFAULT_LAYOUT.sidebarWidth ||
    layout.sideWidth !== DEFAULT_LAYOUT.sideWidth ||
    layout.transcriptHeight !== DEFAULT_LAYOUT.transcriptHeight

  const paneFocusClass = (pane: FocusPane) =>
    focusedPane === pane ? ' shell-cell--active-focus' : ''

  return (
    <>
      <div
        ref={shellRef}
        className="app-shell crt-flicker"
        style={outerStyle}
        onBlurCapture={(e) => {
          const next = e.relatedTarget as Node | null
          if (!next || !shellRef.current?.contains(next)) {
            setFocusedPane(null)
          }
        }}
      >
        {/* Top Bar */}
        <div className="shell-bar" style={topBarStyle}>
          <TopBar
            live={live}
            awaitingApprovalCount={awaitingApprovalCount}
            onJumpToApproval={onJumpToApproval}
            activeLabel={activeLabel}
            activeModeBadge={activeModeBadge}
          />
          <div style={topRightWrapStyle}>
            {topRight}
            <span className="ix-top-sep" aria-hidden />
            <div className="ix-seg-group" aria-label="pane visibility">
              <button
                type="button"
                onClick={() => toggle('sidebarCollapsed')}
                aria-label="◧ 侧栏"
                aria-pressed={!layout.sidebarCollapsed}
                data-hint={layout.sidebarCollapsed ? '展开左侧会话栏' : '折叠左侧会话栏'}
                data-hint-kbd={`${mod}B`}
                className={`ix-icon-btn${layout.sidebarCollapsed ? ' ix-icon-btn--off' : ''}`}
              >
                ◧
              </button>
              {!shellMode && (
                <>
                  <button
                    type="button"
                    onClick={() => toggle('dashboardCollapsed')}
                    aria-label="⬒ 仪表"
                    aria-pressed={!layout.dashboardCollapsed}
                    data-hint={layout.dashboardCollapsed ? '展开上方工作区' : '折叠上方工作区（放大转录区）'}
                    data-hint-kbd={`${mod}⇧D`}
                    className={`ix-icon-btn${layout.dashboardCollapsed ? ' ix-icon-btn--off' : ''}`}
                  >
                    ⬒
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle('transcriptCollapsed')}
                    aria-label="⬓ 转录"
                    aria-pressed={!layout.transcriptCollapsed}
                    data-hint={layout.transcriptCollapsed ? '展开转录日志区' : '折叠转录日志区'}
                    data-hint-kbd={`${mod}J`}
                    className={`ix-icon-btn${layout.transcriptCollapsed ? ' ix-icon-btn--off' : ''}`}
                  >
                    ⬓
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle('sideCollapsed')}
                    aria-label="◨ 右栏"
                    aria-pressed={!layout.sideCollapsed}
                    data-hint={layout.sideCollapsed ? '展开右侧 RE / 通知栏' : '折叠右侧 RE / 通知栏'}
                    data-hint-kbd={`${mod}\\`}
                    className={`ix-icon-btn${layout.sideCollapsed ? ' ix-icon-btn--off' : ''}`}
                  >
                    ◨
                  </button>
                </>
              )}
              {isCustom && (
                <button
                  type="button"
                  onClick={resetLayout}
                  title="重置所有窗口尺寸并全部展开"
                  aria-label="重置分屏布局"
                  data-hint="重置所有分屏尺寸并全部展开"
                  data-hint-kbd={`${mod}⇧0`}
                  className="ix-icon-btn"
                >
                  ↺
                </button>
              )}
              <button
                type="button"
                onClick={nativeFs.toggle}
                aria-label={nativeFs.active ? '退出全屏' : '全屏'}
                data-hint={nativeFs.active ? '退出系统真全屏' : '进入系统真全屏'}
                data-hint-kbd={`${mod}⇧F`}
                className={`ix-icon-btn${nativeFs.active ? ' ix-icon-btn--warn' : ''}`}
              >
                {nativeFs.active ? '✕' : '⛶'}
              </button>
            </div>
          </div>
        </div>

        {/* Optional Banner (DemoCoachBar + SuggestionBar) */}
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
              data-hint="展开左侧会话栏"
              data-hint-kbd={`${mod}B`}
              data-hint-side="right"
            >
              <span>▸</span>
              <span className="collapsed-rail-label">SESSIONS</span>
            </button>
          ) : (
            <div
              className={`shell-cell shell-cell--nav${paneFocusClass('sidebar')}`}
              onFocusCapture={() => setFocusedPane('sidebar')}
              style={{ ...cell, flex: `0 0 ${layout.sidebarWidth}px`, width: layout.sidebarWidth }}
            >
              {sidebar}
            </div>
          )}

          {!layout.sidebarCollapsed ? (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="调整左侧会话栏宽度"
              aria-valuemin={180}
              aria-valuemax={460}
              aria-valuenow={Math.round(layout.sidebarWidth)}
              data-hint="拖动调整宽度 · 双击或按 0 重置"
              data-hint-side="right"
              className={`split-handle split-handle--col${dragging === 'sidebar' ? ' split-handle--active' : ''}`}
              onPointerDown={(e) => startDrag('sidebar', e)}
              onKeyDown={(e) => onSplitterKeyDown('sidebar', e)}
              onDoubleClick={() => setLayout((cur) => ({ ...cur, sidebarWidth: DEFAULT_LAYOUT.sidebarWidth }))}
            />
          ) : (
            <div style={{ flex: '0 0 8px' }} />
          )}

          {/* Right Area: Shell OR (Upper[Dashboard | Side] + Transcript + Prompt) */}
          {shellMode ? (
            <div
              className={`shell-cell${paneFocusClass('shell')}`}
              onFocusCapture={() => setFocusedPane('shell')}
              style={{ ...cell, flex: '1 1 0', overflow: 'hidden' }}
            >
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
                  data-hint="展开仪表盘与右侧取证栏"
                  data-hint-kbd={`${mod}⇧D`}
                >
                  <span>▸ DASHBOARD</span>
                  <span style={{ color: 'var(--faint)', fontSize: 10 }}>{mod}⇧D</span>
                </button>
              ) : (
                <div style={{ ...rowFlexStyle, flex: '1 1 0', minHeight: 110 }}>
                  <div
                    className={`shell-cell shell-cell--focus${paneFocusClass('dashboard')}`}
                    onFocusCapture={() => setFocusedPane('dashboard')}
                    style={{ ...cell, flex: '1 1 0', overflow: 'auto' }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: '100%' }}>
                      {dashboard}
                    </div>
                  </div>

                  {!layout.sideCollapsed ? (
                    <div
                      role="separator"
                      tabIndex={0}
                      aria-orientation="vertical"
                      aria-label="调整右侧取证栏宽度"
                      aria-valuemin={180}
                      aria-valuemax={460}
                      aria-valuenow={Math.round(layout.sideWidth)}
                      data-hint="拖动调整宽度 · 双击或按 0 重置"
                      data-hint-side="left"
                      className={`split-handle split-handle--col${dragging === 'side' ? ' split-handle--active' : ''}`}
                      onPointerDown={(e) => startDrag('side', e)}
                      onKeyDown={(e) => onSplitterKeyDown('side', e)}
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
                      data-hint="展开右侧 RE / 队列 / 通知栏"
                      data-hint-kbd={`${mod}\\`}
                      data-hint-side="left"
                    >
                      <span>◂</span>
                      <span className="collapsed-rail-label">RE · NOTICES</span>
                    </button>
                  ) : (
                    <div
                      className={`shell-cell shell-cell--forensic${paneFocusClass('side')}`}
                      onFocusCapture={() => setFocusedPane('side')}
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
                  tabIndex={0}
                  aria-orientation="horizontal"
                  aria-label="调整转录区高度"
                  aria-valuemin={96}
                  aria-valuemax={560}
                  aria-valuenow={Math.round(layout.transcriptHeight)}
                  data-hint="拖动调整转录区高度 · 双击或按 0 重置"
                  data-hint-side="top"
                  className={`split-handle split-handle--row${dragging === 'transcript' ? ' split-handle--active' : ''}`}
                  onPointerDown={(e) => startDrag('transcript', e)}
                  onKeyDown={(e) => onSplitterKeyDown('transcript', e)}
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
                  data-hint="展开实时转录流"
                  data-hint-kbd={`${mod}J`}
                  data-hint-side="top"
                >
                  <span>▸ TRANSCRIPT</span>
                  <span style={{ color: 'var(--faint)', fontSize: 10 }}>{mod}J</span>
                </button>
              ) : (
                <div
                  className={`shell-cell shell-cell--transcript${paneFocusClass('transcript')}`}
                  onFocusCapture={() => setFocusedPane('transcript')}
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
              <div
                className={`shell-cell shell-cell--prompt${paneFocusClass('prompt')}`}
                onFocusCapture={() => setFocusedPane('prompt')}
                style={{ ...cell, flex: '0 0 auto', overflow: 'hidden' }}
              >
                {prompt}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Live pixel readout badge while dragging splitters */}
      {dragReadout && (
        <div
          className="ix-drag-readout"
          style={{ left: dragReadout.x, top: dragReadout.y }}
          aria-live="polite"
        >
          {dragReadout.axis === 'sidebar'
            ? `SIDEBAR ${dragReadout.px}px`
            : dragReadout.axis === 'side'
              ? `RAIL ${dragReadout.px}px`
              : `TRANSCRIPT ${dragReadout.px}px`}
        </div>
      )}

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
  flex: '0 0 38px',
  padding: '0 8px',
  gap: 10,
}

const topRightWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
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
