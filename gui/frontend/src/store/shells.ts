// Shell store — same useSyncExternalStore pattern as sessions.ts, on the
// separate gui:shell channel. The store owns the shell list + which shell the
// main area shows; ShellView registers a byte sink per shell id so PTY data
// routes straight into xterm.js without touching React state per chunk.

import { useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import { onShellEvent } from '../lib/events'
import type { ShellInfo } from '../lib/types'
import { hasBackend } from './sessions'

export interface ShellStoreSnapshot {
  shells: ReadonlyMap<string, ShellInfo>
  /** shell shown in the main area (null = sessions view) */
  activeShellId: string | null
}

// module state — swapped snapshots, exactly like sessions.ts
let shells = new Map<string, ShellInfo>()
let activeShellId: string | null = null
let snapshot: ShellStoreSnapshot = { shells, activeShellId }

const listeners = new Set<() => void>()

function commit(): void {
  snapshot = { shells: new Map(shells), activeShellId }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  ensureChannel()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): ShellStoreSnapshot {
  return snapshot
}

export function useShellStore(): ShellStoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}

// ---------- PTY data sinks ----------

// ShellView registers one sink per mounted terminal; the event dispatch writes
// decoded bytes straight into xterm (bypassing React entirely — a 60fps
// `tail -f` must not trigger renders).
const sinks = new Map<string, (bytes: Uint8Array) => void>()

export function registerShellSink(id: string, sink: (bytes: Uint8Array) => void): () => void {
  sinks.set(id, sink)
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id)
  }
}

// ---------- channel ----------

let channel = false

function ensureChannel(): void {
  if (channel) return
  channel = true
  try {
    onShellEvent((env) => {
      if (env.kind === 'data') {
        const bin = atob(env.b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        sinks.get(env.shellId)?.(bytes)
        return
      }
      // exit — drop the shell; closing the active one falls back to sessions
      shells.delete(env.shellId)
      sinks.delete(env.shellId)
      if (activeShellId === env.shellId) activeShellId = null
      commit()
    })
  } catch {
    // no window.runtime — browser dev; shell UI stays inert
  }
}

// ---------- actions ----------

export const shellActions = {
  /** Spawn a PTY rooted at cwd (null → backend default = $HOME) and show it. */
  async open(cwd: string | null): Promise<void> {
    if (!hasBackend()) return
    try {
      const info = await api.shellStart(cwd ?? '')
      shells.set(info.id, info)
      activeShellId = info.id
      commit()
    } catch (err) {
      console.error('shell start failed', err)
    }
  },

  setActive(id: string | null): void {
    activeShellId = id
    commit()
  },

  /** Kill the PTY; the exit event cleans the rest. */
  async close(id: string): Promise<void> {
    if (!hasBackend()) return
    try {
      await api.shellStop(id)
    } catch (err) {
      console.error('shell stop failed', err)
    }
  },

  /** Called by ShellView once the terminal exists — sizes the PTY to match. */
  async resize(id: string, cols: number, rows: number): Promise<void> {
    if (!hasBackend()) return
    try {
      await api.shellResize(id, cols, rows)
    } catch {
      // shell may have exited mid-resize — harmless
    }
  },

  /** Keystrokes from xterm into the PTY. */
  async write(id: string, data: string): Promise<void> {
    if (!hasBackend()) return
    try {
      await api.shellWrite(id, data)
    } catch {
      // exited mid-keystroke — harmless
    }
  },
}
