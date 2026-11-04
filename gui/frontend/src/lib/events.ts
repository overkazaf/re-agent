// FROZEN CONTRACT — single event channel from the Go bridge.
// Read-only for all workstream agents.

import type { GuiEvent, GuiEventKind } from './types'

type Handler = (e: GuiEvent) => void

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runtime = { EventsOn(name: string, cb: (...data: any[]) => void): void; EventsOff(name: string, ...names: string[]): void }

function runtime(): Runtime {
  return (window as unknown as { runtime: Runtime }).runtime
}

const CHANNEL = 'gui:event'

const handlers = new Set<Handler>()
let subscribed = false

function ensureSubscribed() {
  if (subscribed) return
  subscribed = true
  runtime().EventsOn(CHANNEL, (...payload: unknown[]) => {
    const e = payload[0] as GuiEvent
    for (const h of handlers) h(e)
  })
}

/** Subscribe to gui:event. Returns an unsubscribe fn. Safe to call many times:
 *  the channel is joined once and fanned out locally. */
export function onGuiEvent(handler: Handler): () => void {
  ensureSubscribed()
  handlers.add(handler)
  return () => handlers.delete(handler)
}

/** Subscribe to a single kind for one session (convenience filter). */
export function onSessionEvent<K extends GuiEventKind>(
  sessionId: string,
  kind: K,
  handler: (data: Extract<GuiEvent, { kind: K }>['data']) => void,
): () => void {
  return onGuiEvent((e) => {
    if (e.sessionId === sessionId && e.kind === kind) {
      handler(e.data as Extract<GuiEvent, { kind: K }>['data'])
    }
  })
}

// ---------- gui:shell (PTY terminal channel) ----------

const SHELL_CHANNEL = 'gui:shell'

type ShellHandler = (env: import('./types').ShellEnvelope) => void

const shellHandlers = new Set<ShellHandler>()
let shellSubscribed = false

/** Subscribe to gui:shell. Same join-once + fan-out pattern as onGuiEvent. */
export function onShellEvent(handler: ShellHandler): () => void {
  if (!shellSubscribed) {
    shellSubscribed = true
    runtime().EventsOn(SHELL_CHANNEL, (...payload: unknown[]) => {
      const env = payload[0] as import('./types').ShellEnvelope
      for (const h of shellHandlers) h(env)
    })
  }
  shellHandlers.add(handler)
  return () => shellHandlers.delete(handler)
}
