// ZoomableSvgViewport — interactive zoom (60%..300%), drag-to-pan, reset, and
// ⛶ full-viewport modal magnifier for CRT SVG graphs. Preserves crisp vector
// rendering at arbitrary magnification and never hijacks click events on nodes.
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Dialog } from '../session/Dialog'

const MIN_ZOOM = 0.65
const MAX_ZOOM = 3.0
const STEP = 0.25

function clampZoom(z: number): number {
  return Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) * 100) / 100
}

export function ZoomableSvgViewport({
  title,
  children,
  fullscreenFooter,
  maxInlineHeight = 310,
}: {
  title: string
  /** Render callback receives whether it is inside the fullscreen modal so SVG max-height adapts cleanly */
  children: (inFullscreen: boolean) => ReactNode
  /** Optional inspector / replay controls also shown inside the fullscreen modal */
  fullscreenFooter?: ReactNode
  maxInlineHeight?: number
}) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  const [fsZoom, setFsZoom] = useState(1.25)
  const [fsPan, setFsPan] = useState({ x: 0, y: 0 })
  const [fsDragging, setFsDragging] = useState(false)

  const dragOrigin = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)

  const resetInline = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const resetFs = () => {
    setFsZoom(1.25)
    setFsPan({ x: 0, y: 0 })
  }

  function bindPanHandlers(
    curPan: { x: number; y: number },
    setCurPan: (p: { x: number; y: number }) => void,
    setCurDrag: (d: boolean) => void,
  ) {
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        // Do not capture pointer immediately so child SVG node onClick still fires when not dragging!
        dragOrigin.current = {
          startX: e.clientX,
          startY: e.clientY,
          baseX: curPan.x,
          baseY: curPan.y,
          moved: false,
        }
        const onMove = (ev: PointerEvent) => {
          const orig = dragOrigin.current
          if (!orig) return
          const dx = ev.clientX - orig.startX
          const dy = ev.clientY - orig.startY
          if (!orig.moved && Math.hypot(dx, dy) > 4) {
            orig.moved = true
            setCurDrag(true)
          }
          if (orig.moved) {
            setCurPan({ x: orig.baseX + dx, y: orig.baseY + dy })
          }
        }
        const onUp = () => {
          dragOrigin.current = null
          setCurDrag(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      },
    }
  }

  const inlineHandlers = bindPanHandlers(pan, setPan, setDragging)
  const fsHandlers = bindPanHandlers(fsPan, setFsPan, setFsDragging)

  return (
    <>
      <div style={{ ...wrapStyle, maxHeight: zoom === 1 && pan.x === 0 && pan.y === 0 ? undefined : maxInlineHeight + 90 }}>
        {/* Floating Zoom & Fullscreen HUD */}
        <div style={hudBarStyle}>
          <span style={{ color: 'var(--faint)', fontSize: 10 }}>
            {zoom > 1 || pan.x !== 0 || pan.y !== 0 ? '✥ 按住空白处可拖拽平移 · Ctrl/⌘+滚轮缩放' : '🔍 支持缩放 / 拖拽平移 / 全屏检视'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z - STEP))}
            title="缩小图谱"
            aria-label="缩小图谱"
            style={zoomBtnStyle}
          >
            −
          </button>
          <button
            type="button"
            onClick={resetInline}
            title="重置缩放与位置 (100%)"
            style={{ ...zoomBtnStyle, minWidth: 46, color: zoom !== 1 ? 'var(--accent)' : 'var(--muted)' }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z + STEP))}
            title="放大图谱"
            aria-label="放大图谱"
            style={zoomBtnStyle}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            title="全屏放大检视完整图谱与节点细节"
            style={{ ...zoomBtnStyle, color: 'var(--accent)', borderColor: 'var(--accent-dim)', padding: '1px 8px' }}
          >
            ⛶ 全屏放大
          </button>
        </div>

        <div
          {...inlineHandlers}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey || zoom !== 1) {
              e.preventDefault()
              const delta = e.deltaY < 0 ? 0.15 : -0.15
              setZoom((z) => clampZoom(z + delta))
            }
          }}
          style={{
            overflow: 'hidden',
            cursor: dragging ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
            padding: '2px 4px 4px',
          }}
        >
          <div
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: dragging ? 'none' : 'transform 0.12s ease-out',
            }}
          >
            {children(false)}
          </div>
        </div>
      </div>

      {fullscreen && (
        <Dialog
          title={`fullscreen graph — ${title}`}
          accent="accent"
          width={1260}
          onClose={() => setFullscreen(false)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              ✥ 滚轮直接无级缩放 · 按住画布任意位置拖拽平移 · 点击图中节点切换下方实时遥测与详情 · 按 Esc 退出全屏
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => setFsZoom((z) => clampZoom(z - STEP))} style={zoomBtnStyle}>
              −
            </button>
            <button type="button" onClick={resetFs} style={{ ...zoomBtnStyle, minWidth: 52, color: 'var(--accent)' }}>
              {Math.round(fsZoom * 100)}%
            </button>
            <button type="button" onClick={() => setFsZoom((z) => clampZoom(z + STEP))} style={zoomBtnStyle}>
              +
            </button>
            <button
              type="button"
              onClick={() => {
                setFsZoom(1.8)
                setFsPan({ x: 0, y: 0 })
              }}
              style={zoomBtnStyle}
            >
              180% 细节
            </button>
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              style={{ ...zoomBtnStyle, borderColor: 'var(--warn)', color: 'var(--warn)', padding: '1px 9px' }}
            >
              ✕ 退出全屏
            </button>
          </div>

          <div
            {...fsHandlers}
            onWheel={(e) => {
              e.preventDefault()
              const delta = e.deltaY < 0 ? 0.15 : -0.15
              setFsZoom((z) => clampZoom(z + delta))
            }}
            style={{
              border: '1px solid var(--rule)',
              background: 'rgba(2, 5, 9, 0.85)',
              height: '56vh',
              minHeight: 380,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: fsDragging ? 'grabbing' : 'grab',
            }}
          >
            <div
              style={{
                width: '100%',
                transform: `translate(${fsPan.x}px, ${fsPan.y}px) scale(${fsZoom})`,
                transformOrigin: 'center center',
                transition: fsDragging ? 'none' : 'transform 0.1s ease-out',
              }}
            >
              {children(true)}
            </div>
          </div>

          {fullscreenFooter && <div style={{ maxHeight: '22vh', overflowY: 'auto' }}>{fullscreenFooter}</div>}
        </Dialog>
      )}
    </>
  )
}

const wrapStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(3, 6, 10, 0.65)',
  display: 'flex',
  flexDirection: 'column',
}

const hudBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 8px',
  borderBottom: '1px solid rgba(30, 41, 59, 0.7)',
  background: 'rgba(5, 10, 16, 0.75)',
}

const zoomBtnStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(8, 14, 22, 0.9)',
  color: 'var(--text)',
  fontSize: 10.5,
  padding: '1px 7px',
  cursor: 'pointer',
  lineHeight: 1.35,
}
