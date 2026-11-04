// Top-of-stack exclusivity for the Escape key. Overlays (dialogs, the approval
// card, the slash palette) each register a handler while mounted; only the
// most recently registered one fires. Without the stack, two open overlays
// both had window keydown listeners and one Esc closed the dialog AND denied
// the approval underneath it.
type EscHandler = () => void

const stack: EscHandler[] = []
let installed = false

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || stack.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      stack[stack.length - 1]()
    },
    // capture so the dispatch wins over any stray local handler
    { capture: true },
  )
}

/** Register an Esc handler; returns its unregister function. LIFO dispatch. */
export function pushEsc(handler: EscHandler): () => void {
  install()
  stack.push(handler)
  return () => {
    const i = stack.indexOf(handler)
    if (i >= 0) stack.splice(i, 1)
  }
}
