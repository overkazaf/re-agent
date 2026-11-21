// Unified True Fullscreen bridge for both Browser (Fullscreen API) and Wails v2
// Desktop (window.runtime.WindowFullscreen / WindowUnfullscreen).
//
// Design notes:
// - Browsers require `requestFullscreen()` to be called synchronously inside a
//   user gesture (click handler). Calling `enterNativeFullscreen()` directly in
//   `onClick` satisfies Chrome, Safari, Firefox, and Edge reliably.
// - Fullscreen targets `document.documentElement` (not a sub-element) so:
//     1) Every CSS custom property on `:root[data-theme]` stays active.
//     2) Global overlays (WizardCard z=44, ApprovalDialog z=50, Toast z=60)
//        remain visible ABOVE edge-to-edge stage portals (z=38).
// - When native Fullscreen API is unavailable or blocked (e.g. headless E2E or
//   sandboxed iframe), `useStageFullscreen` still renders an edge-to-edge
//   100vw × 100vh portal cleanly without throwing unhandled rejections.
import { useCallback, useEffect, useRef, useState } from 'react'
import { pushEsc } from './escStack'

type WailsWindowRuntime = {
  WindowFullscreen?: () => void
  WindowUnfullscreen?: () => void
  WindowIsFullscreen?: () => Promise<boolean>
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

function wailsRuntime(): WailsWindowRuntime | null {
  try {
    const rt = (window as unknown as { runtime?: WailsWindowRuntime }).runtime
    return rt && typeof rt.WindowFullscreen === 'function' ? rt : null
  } catch {
    return null
  }
}

export function isDocumentFullscreen(): boolean {
  if (typeof document === 'undefined') return false
  const doc = document as FullscreenDocument
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement)
}

export function enterNativeFullscreen(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false)
  }
  const rt = wailsRuntime()
  if (rt?.WindowFullscreen) {
    try {
      rt.WindowFullscreen()
      return Promise.resolve(true)
    } catch {
      return Promise.resolve(false)
    }
  }
  if (isDocumentFullscreen()) {
    return Promise.resolve(true)
  }
  const el = document.documentElement as FullscreenElement
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen
  if (typeof req !== 'function') {
    return Promise.resolve(false)
  }
  try {
    const res = req.call(el)
    if (res && typeof (res as Promise<void>).then === 'function') {
      return (res as Promise<void>).then(
        () => true,
        () => false,
      )
    }
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(false)
  }
}

export function exitNativeFullscreen(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve()
  }
  const rt = wailsRuntime()
  if (rt?.WindowUnfullscreen) {
    try {
      rt.WindowUnfullscreen()
    } catch {
      /* ignore */
    }
    return Promise.resolve()
  }
  if (!isDocumentFullscreen()) {
    return Promise.resolve()
  }
  const doc = document as FullscreenDocument
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen
  if (typeof exit !== 'function') {
    return Promise.resolve()
  }
  try {
    const res = exit.call(doc)
    if (res && typeof (res as Promise<void>).then === 'function') {
      return (res as Promise<void>).catch(() => {})
    }
    return Promise.resolve()
  } catch {
    return Promise.resolve()
  }
}

/** Tracks whole-window native fullscreen (browser Fullscreen API or Wails OS window). */
export function useNativeFullscreen() {
  const [active, setActive] = useState<boolean>(() => isDocumentFullscreen())

  useEffect(() => {
    const sync = () => {
      const rt = wailsRuntime()
      if (rt?.WindowIsFullscreen) {
        void rt
          .WindowIsFullscreen()
          .then((v) => setActive(Boolean(v)))
          .catch(() => {})
        return
      }
      setActive(isDocumentFullscreen())
    }

    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    window.addEventListener('resize', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
      window.removeEventListener('resize', sync)
    }
  }, [])

  const enter = useCallback(() => {
    void enterNativeFullscreen().then((ok) => {
      if (ok) setActive(true)
    })
  }, [])

  const exit = useCallback(() => {
    void exitNativeFullscreen().then(() => setActive(false))
  }, [])

  const toggle = useCallback(() => {
    if (active || isDocumentFullscreen()) {
      exit()
    } else {
      enter()
    }
  }, [active, enter, exit])

  return { active, enter, exit, toggle }
}

/**
 * Coordinates an immersive 100vw×100vh stage (graph, binary radar, 3D theater)
 * with native OS/browser fullscreen:
 * - Opening triggers native fullscreen synchronously on click.
 * - Pressing Esc in native fullscreen exits BOTH OS fullscreen AND the stage.
 * - Closing only exits native fullscreen if THIS stage initiated it (so if the
 *   user was already in global app fullscreen, closing a graph keeps app fullscreen).
 */
export function useStageFullscreen() {
  const [open, setOpen] = useState(false)
  const [nativeActive, setNativeActive] = useState<boolean>(() => isDocumentFullscreen())
  const ownedNativeRef = useRef(false)

  const close = useCallback(() => {
    setOpen(false)
    if (ownedNativeRef.current) {
      ownedNativeRef.current = false
      void exitNativeFullscreen()
    }
  }, [])

  const enter = useCallback(() => {
    const alreadyNative = isDocumentFullscreen()
    setOpen(true)
    if (!alreadyNative) {
      ownedNativeRef.current = true
      void enterNativeFullscreen().then((ok) => {
        if (!ok) {
          ownedNativeRef.current = false
        } else {
          setNativeActive(true)
        }
      })
    }
  }, [])

  const toggle = useCallback(() => {
    if (open) close()
    else enter()
  }, [open, close, enter])

  useEffect(() => {
    const onFsChange = () => {
      const now = isDocumentFullscreen()
      setNativeActive(now)
      // User pressed browser/OS Esc to leave native fullscreen → also close the stage
      if (!now && ownedNativeRef.current) {
        ownedNativeRef.current = false
        setOpen(false)
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    return pushEsc(close)
  }, [open, close])

  // Clean up native fullscreen if component unmounts while owning it
  useEffect(() => {
    return () => {
      if (ownedNativeRef.current) {
        ownedNativeRef.current = false
        void exitNativeFullscreen()
      }
    }
  }, [])

  return { open, nativeActive, enter, close, toggle }
}
