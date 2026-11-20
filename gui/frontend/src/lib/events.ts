// FROZEN CONTRACT — single event channel from the Go bridge.
// Read-only for all workstream agents.

import type { GuiEvent, GuiEventKind } from './types'

type Handler = (e: GuiEvent) => void

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runtime = { EventsOn(name: string, cb: (...data: any[]) => void): void; EventsOff(name: string, ...names: string[]): void }

function runtime(): Runtime | null {
  try {
    const r = (window as unknown as { runtime?: Runtime }).runtime
    return r && typeof r.EventsOn === 'function' ? r : null
  } catch {
    return null
  }
}

const CHANNEL = 'gui:event'

const handlers = new Set<Handler>()
let subscribed = false
let demoEventsOnly = false

/** When true, window.runtime events are muted so real desktop sessions never
 *  bleed into the in-memory demo sandbox. */
export function setDemoEventsOnly(on: boolean): void {
  demoEventsOnly = on
}

/** Deliver a synthetic gui:event from the in-memory demo backend. */
export function emitDemoGuiEvent(e: GuiEvent): void {
  if (!demoEventsOnly) return
  for (const h of handlers) h(e)
}

function ensureSubscribed() {
  if (subscribed) return
  const rt = runtime()
  if (!rt) return
  subscribed = true
  rt.EventsOn(CHANNEL, (...payload: unknown[]) => {
    if (demoEventsOnly) return
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

/** Deliver a synthetic gui:shell frame from the in-memory demo shell. */
export function emitDemoShellEvent(env: import('./types').ShellEnvelope): void {
  if (!demoEventsOnly) return
  for (const h of shellHandlers) h(env)
}

/** Subscribe to gui:shell. Same join-once + fan-out pattern as onGuiEvent. */
export function onShellEvent(handler: ShellHandler): () => void {
  if (!shellSubscribed) {
    const rt = runtime()
    if (rt) {
      shellSubscribed = true
      rt.EventsOn(SHELL_CHANNEL, (...payload: unknown[]) => {
        if (demoEventsOnly) return
        const env = payload[0] as import('./types').ShellEnvelope
        for (const h of shellHandlers) h(env)
      })
    }
  }
  shellHandlers.add(handler)
  return () => shellHandlers.delete(handler)
}
