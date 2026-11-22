// Unified global portal tooltip & contextual hint system.
// Mount <HintOverlay /> once near the app root (inside ThemeProvider) and add
// `data-hint="说明文案"`, optional `data-hint-kbd="⌘K"`, and optional
// `data-hint-side="top|bottom|left|right"` to ANY element in the entire app.
//
// Features:
//   - Zero dependencies, single document-level event delegation
//   - Warm-tooltip timing (~160ms cold hover, instant when moving between hinted
//     controls within 300ms)
//   - Keyboard-accessible (focus-visible) & immediate dismiss on click/Esc/scroll
//   - Viewport-safe position:fixed placement with auto-flip and 8px edge clamp
//   - Temporarily suppresses competing native `title` tooltips only while shown,
//     restoring them immediately on hide/click/leave so E2E getByTitle() stays intact
//   - Exports tiny <InfoHint /> inline contextual help pill
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export type HintSide = 'top' | 'bottom' | 'left' | 'right'

export interface HintRect {
  top: number
  bottom: number
  left: number
  right: number
  width: number
  height: number
}

export interface HintPosition {
  top: number
  left: number
  placement: HintSide
}

export interface HintDescriptor {
  text: string
  kbd?: string
  side: HintSide
}

export const DEFAULT_HINT_DELAY_MS = 160
export const DEFAULT_WARM_WINDOW_MS = 300
export const DEFAULT_VIEWPORT_MARGIN = 8
export const DEFAULT_HINT_GAP = 7

// ---------- pure helpers (exported for unit testing) ----------

export function normalizeHintSide(raw: string | null | undefined): HintSide {
  if (raw === 'top' || raw === 'bottom' || raw === 'left' || raw === 'right') {
    return raw
  }
  return 'bottom'
}

export function parseHintKbd(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function resolveShowDelay(
  currentlyVisible: boolean,
  lastHiddenAt: number | null,
  now: number,
  delayMs = DEFAULT_HINT_DELAY_MS,
  warmWindowMs = DEFAULT_WARM_WINDOW_MS,
): number {
  if (currentlyVisible) return 0
  if (lastHiddenAt !== null && now - lastHiddenAt >= 0 && now - lastHiddenAt <= warmWindowMs) {
    return 0
  }
  return Math.max(0, delayMs)
}

export function computeHintPosition(
  anchor: HintRect,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  preferredSide: HintSide = 'bottom',
  margin = DEFAULT_VIEWPORT_MARGIN,
  gap = DEFAULT_HINT_GAP,
): HintPosition {
  const spaceAbove = Math.max(0, anchor.top - gap - margin)
  const spaceBelow = Math.max(0, viewport.height - anchor.bottom - gap - margin)
  const spaceLeft = Math.max(0, anchor.left - gap - margin)
  const spaceRight = Math.max(0, viewport.width - anchor.right - gap - margin)

  let placement: HintSide = preferredSide
  if (preferredSide === 'bottom' && tip.height > spaceBelow && spaceAbove > spaceBelow) {
    placement = 'top'
  } else if (preferredSide === 'top' && tip.height > spaceAbove && spaceBelow > spaceAbove) {
    placement = 'bottom'
  } else if (preferredSide === 'right' && tip.width > spaceRight && spaceLeft > spaceRight) {
    placement = 'left'
  } else if (preferredSide === 'left' && tip.width > spaceLeft && spaceRight > spaceLeft) {
    placement = 'right'
  }

  let rawTop: number
  let rawLeft: number

  if (placement === 'bottom') {
    rawTop = anchor.bottom + gap
    rawLeft = anchor.left + anchor.width / 2 - tip.width / 2
  } else if (placement === 'top') {
    rawTop = anchor.top - gap - tip.height
    rawLeft = anchor.left + anchor.width / 2 - tip.width / 2
  } else if (placement === 'right') {
    rawTop = anchor.top + anchor.height / 2 - tip.height / 2
    rawLeft = anchor.right + gap
  } else {
    rawTop = anchor.top + anchor.height / 2 - tip.height / 2
    rawLeft = anchor.left - gap - tip.width
  }

  const maxLeft = Math.max(margin, viewport.width - margin - tip.width)
  const maxTop = Math.max(margin, viewport.height - margin - tip.height)
  const left = Math.max(margin, Math.min(rawLeft, maxLeft))
  const top = Math.max(margin, Math.min(rawTop, maxTop))

  return {
    top: Math.round(top),
    left: Math.round(left),
    placement,
  }
}

export function readHintDescriptor(el: Element | null): HintDescriptor | null {
  if (!el) return null
  const text = el.getAttribute('data-hint')?.trim()
  if (!text) return null
  const kbd = el.getAttribute('data-hint-kbd')?.trim() || undefined
  const side = normalizeHintSide(el.getAttribute('data-hint-side'))
  return { text, kbd, side }
}

function findHintTarget(node: EventTarget | null): HTMLElement | null {
  if (!node || typeof Element === 'undefined') return null
  const el = node instanceof Element ? node : null
  if (!el) return null
  const match = el.closest('[data-hint]')
  return match instanceof HTMLElement ? match : null
}

function isFocusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

// ---------- global portal overlay ----------

interface ActiveHint {
  el: HTMLElement
  desc: HintDescriptor
}

export function HintOverlay({
  delayMs = DEFAULT_HINT_DELAY_MS,
  warmWindowMs = DEFAULT_WARM_WINDOW_MS,
}: {
  delayMs?: number
  warmWindowMs?: number
}) {
  const [active, setActive] = useState<ActiveHint | null>(null)
  const [pos, setPos] = useState<HintPosition | null>(null)

  const tipRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<ActiveHint | null>(null)
  const pendingElRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastHiddenAtRef = useRef<number | null>(null)
  const stashedTitleRef = useRef<{ el: HTMLElement; value: string } | null>(null)

  activeRef.current = active

  useEffect(() => {
    if (typeof document === 'undefined') return

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const restoreStashedTitle = () => {
      const stashed = stashedTitleRef.current
      if (!stashed) return
      stashedTitleRef.current = null
      if (stashed.el.isConnected && !stashed.el.hasAttribute('title')) {
        stashed.el.setAttribute('title', stashed.value)
      }
    }

    const suppressNativeTitle = (el: HTMLElement) => {
      if (stashedTitleRef.current?.el === el) return
      restoreStashedTitle()
      const nativeTitle = el.getAttribute('title')
      if (nativeTitle) {
        stashedTitleRef.current = { el, value: nativeTitle }
        el.removeAttribute('title')
      }
    }

    const hideNow = (markWarm: boolean) => {
      clearTimer()
      pendingElRef.current = null
      restoreStashedTitle()
      if (activeRef.current !== null) {
        if (markWarm) lastHiddenAtRef.current = Date.now()
        else lastHiddenAtRef.current = null
        activeRef.current = null
        setActive(null)
        setPos(null)
      }
    }

    const showTarget = (el: HTMLElement, immediate: boolean) => {
      const desc = readHintDescriptor(el)
      if (!desc) {
        hideNow(false)
        return
      }
      if (activeRef.current?.el === el && activeRef.current.desc.text === desc.text && activeRef.current.desc.kbd === desc.kbd) {
        return
      }
      clearTimer()
      pendingElRef.current = el
      const wait = immediate
        ? 0
        : resolveShowDelay(activeRef.current !== null, lastHiddenAtRef.current, Date.now(), delayMs, warmWindowMs)

      const commitShow = () => {
        timerRef.current = null
        if (!el.isConnected || pendingElRef.current !== el) return
        const latest = readHintDescriptor(el)
        if (!latest) return
        suppressNativeTitle(el)
        const next: ActiveHint = { el, desc: latest }
        activeRef.current = next
        setActive(next)
      }

      if (wait === 0) {
        commitShow()
      } else {
        timerRef.current = setTimeout(commitShow, wait)
      }
    }

    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const target = findHintTarget(e.target)
      if (!target) return
      showTarget(target, false)
    }

    const onPointerOut = (e: PointerEvent) => {
      const leaving = findHintTarget(e.target)
      if (!leaving) return
      const entering = findHintTarget(e.relatedTarget)
      if (entering === leaving) return
      if (entering) {
        showTarget(entering, false)
        return
      }
      hideNow(true)
    }

    const onFocusIn = (e: FocusEvent) => {
      const target = findHintTarget(e.target)
      if (!target || !isFocusVisible(target)) return
      showTarget(target, true)
    }

    const onFocusOut = (e: FocusEvent) => {
      const leaving = findHintTarget(e.target)
      if (!leaving) return
      const entering = findHintTarget(e.relatedTarget)
      if (entering === leaving) return
      hideNow(false)
    }

    const onImmediateDismiss = () => hideNow(false)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (!e.metaKey && !e.ctrlKey && !e.altKey && e.key !== 'Shift' && e.key !== 'Tab')) {
        hideNow(false)
      }
    }

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('pointerdown', onImmediateDismiss, true)
    document.addEventListener('scroll', onImmediateDismiss, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onImmediateDismiss)
    window.addEventListener('blur', onImmediateDismiss)

    return () => {
      clearTimer()
      restoreStashedTitle()
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('pointerdown', onImmediateDismiss, true)
      document.removeEventListener('scroll', onImmediateDismiss, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onImmediateDismiss)
      window.removeEventListener('blur', onImmediateDismiss)
    }
  }, [delayMs, warmWindowMs])

  useLayoutEffect(() => {
    if (!active) {
      setPos(null)
      return
    }
    const measure = () => {
      if (!active.el.isConnected) {
        setActive(null)
        return
      }
      const rect = active.el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setActive(null)
        return
      }
      const tipEl = tipRef.current
      const width = tipEl?.offsetWidth || Math.min(280, Math.max(90, active.desc.text.length * 8 + 24))
      const height = tipEl?.offsetHeight || 28
      setPos(
        computeHintPosition(
          {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          },
          { width, height },
          { width: window.innerWidth, height: window.innerHeight },
          active.desc.side,
        ),
      )
    }
    measure()
    const raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [active])

  if (!active || typeof document === 'undefined') return null

  const kbdParts = parseHintKbd(active.desc.kbd)
  const placementClass = pos ? ` ix-hint-popover--${pos.placement}` : ''

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      data-testid="hint-popover"
      className={`ix-hint-popover${placementClass}`}
      style={{
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <span className="ix-hint-text">{active.desc.text}</span>
      {kbdParts.length > 0 && (
        <span className="ix-hint-kbds" aria-hidden="true">
          {kbdParts.map((part, idx) => (
            <kbd key={`${part}-${idx}`} className="ix-hint-kbd">
              {part}
            </kbd>
          ))}
        </span>
      )}
    </div>,
    document.body,
  )
}

// ---------- inline contextual help pill ----------

export function InfoHint({
  text,
  kbd,
  side = 'top',
  className,
  style,
}: {
  text: string
  kbd?: string
  side?: HintSide
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      role="note"
      tabIndex={0}
      aria-label={text}
      data-hint={text}
      data-hint-kbd={kbd}
      data-hint-side={side}
      className={`ix-info-hint${className ? ` ${className}` : ''}`}
      style={style}
    >
      ?
    </span>
  )
}
