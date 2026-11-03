// WS4 session store — useSyncExternalStore over the single gui:event channel.
// One global subscription fans events out per sessionId; every mutation swaps
// the snapshot object so React re-renders exactly once per event batch.
//
// Browser-dev note: window.go / window.runtime only exist inside Wails. All
// API calls are guarded — failures become store toasts and Result{ok:false}
// values that dialogs render inline instead of throwing uncaught.

import { useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import { onGuiEvent } from '../lib/events'
import type {
  ApprovalDecision,
  ApprovalDTO,
  CommandResultDTO,
  GuiEvent,
  LifecycleState,
  LoopEvent,
  NoticeDTO,
  SessionInfo,
  StartOptions,
  TickDTO,
} from '../lib/types'

// ---------- limits (ring buffers) ----------

export const LOOP_LIMIT = 500
export const THINK_LIMIT = 200
export const NOTICE_LIMIT = 50
const TOAST_MS = 6000

// ---------- shapes ----------

export interface SessionRuntime {
  info: SessionInfo
  lifecycle: LifecycleState
  latestTick: TickDTO | null
  /** thinking progress lines (progress.kind === 'thinking'), capped THINK_LIMIT */
  thinkLines: string[]
  /** transcript loop events, ring-capped at LOOP_LIMIT (oldest dropped) */
  loopBuffer: LoopEvent[]
  /** envelope ts per loopBuffer entry — parallel array, same length/index */
  loopTs: number[]
  /** ts of the first loop event seen — origin for t+Xs stamps */
  firstLoopTs: number | null
  pendingApproval: ApprovalDTO | null
  notices: NoticeDTO[]
}

export interface StoreToast {
  id: number
  tone: 'err' | 'ok' | 'info'
  text: string
}

export interface SessionStoreSnapshot {
  sessions: ReadonlyMap<string, SessionRuntime>
  activeId: string | null
  toast: StoreToast | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

// ---------- snapshot plumbing ----------

let sessions = new Map<string, SessionRuntime>()
let activeId: string | null = null
let toast: StoreToast | null = null
let snapshot: SessionStoreSnapshot = { sessions, activeId, toast }

const listeners = new Set<() => void>()
let toastTimer: ReturnType<typeof setTimeout> | null = null

function commit(): void {
  snapshot = { sessions: new Map(sessions), activeId, toast }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  ensureChannel()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): SessionStoreSnapshot {
  return snapshot
}

/** Read-only hook: the whole store. Prefer useSessionRuntime for one session. */
export function useSessionStore(): SessionStoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Read-only hook: one session's runtime (null when absent). */
export function useSessionRuntime(id: string | null | undefined): SessionRuntime | null {
  const snap = useSessionStore()
  return (id && snap.sessions.get(id)) || null
}

// ---------- event channel ----------

let channel = false

/** Join gui:event once; fan-out to dispatch. Inert when the Wails runtime is
 *  absent (plain `vite dev` in a browser) so demo pages keep working. */
function ensureChannel(): void {
  if (channel) return
  channel = true
  try {
    onGuiEvent(dispatch)
  } catch {
    // no window.runtime — browser dev environment; mock injection still works
  }
}

function dispatch(e: GuiEvent): void {
  const rt = sessions.get(e.sessionId)
  if (!rt) return
  const next = applyEvent(rt, e)
  if (!next) return
  sessions.set(e.sessionId, next)
  commit()
}

function applyEvent(rt: SessionRuntime, e: GuiEvent): SessionRuntime | null {
  switch (e.kind) {
    case 'tick':
      return { ...rt, latestTick: e.data as TickDTO }

    case 'approval':
      return { ...rt, pendingApproval: e.data as ApprovalDTO }

    case 'notice': {
      const n = e.data as NoticeDTO
      const notices = appendCapped(rt.notices, [n], NOTICE_LIMIT)
      return { ...rt, notices }
    }

    case 'lifecycle': {
      const state = (e.data as { state: LifecycleState }).state
      return { ...rt, lifecycle: state }
    }

    case 'loop': {
      const batch = e.data as LoopEvent[]
      if (!Array.isArray(batch) || batch.length === 0) return null

      // thinking progress feeds the think tail; everything else is transcript
      let thinkLines = rt.thinkLines
      for (const ev of batch) {
        if (ev.type === 'progress' && ev.progress && ev.progress.kind === 'thinking' && ev.progress.text) {
          thinkLines = thinkLines.concat(ev.progress.text)
        }
      }
      if (thinkLines !== rt.thinkLines && thinkLines.length > THINK_LIMIT) {
        thinkLines = thinkLines.slice(-THINK_LIMIT)
      }

      const loopBuffer = appendCapped(rt.loopBuffer, batch, LOOP_LIMIT)
      const tsOverflow = batch.length + rt.loopTs.length - LOOP_LIMIT
      const loopTs = tsOverflow > 0 ? rt.loopTs.slice(tsOverflow).concat(batch.map(() => e.ts)) : rt.loopTs.concat(batch.map(() => e.ts))

      return {
        ...rt,
        loopBuffer,
        loopTs,
        thinkLines,
        firstLoopTs: rt.firstLoopTs ?? e.ts,
      }
    }

    default:
      return null
  }
}

function appendCapped<T>(arr: readonly T[], add: readonly T[], cap: number): T[] {
  const merged = arr.concat(add)
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

// ---------- helpers ----------

export function hasBackend(): boolean {
  try {
    const w = window as unknown as { go?: { main?: { App?: unknown } } }
    return Boolean(w.go && w.go.main && w.go.main.App)
  } catch {
    return false
  }
}

function errText(err: unknown): string {
  if (!hasBackend()) return 'Wails runtime 不可用（浏览器 dev 环境）'
  if (err instanceof Error) return err.message
  return String(err)
}

function pushToast(tone: StoreToast['tone'], text: string): void {
  if (toastTimer) clearTimeout(toastTimer)
  toast = { id: Date.now(), tone, text }
  commit()
  toastTimer = setTimeout(() => {
    toast = null
    toastTimer = null
    commit()
  }, TOAST_MS)
}

function freshRuntime(info: SessionInfo): SessionRuntime {
  return {
    info,
    lifecycle: info.lifecycle,
    latestTick: null,
    thinkLines: [],
    loopBuffer: [],
    loopTs: [],
    firstLoopTs: null,
    pendingApproval: null,
    notices: [],
  }
}

/** Upsert: keep any buffers already collected (e.g. stub from early events). */
function putRuntime(info: SessionInfo): void {
  const existing = sessions.get(info.id)
  sessions.set(info.id, existing ? { ...existing, info, lifecycle: info.lifecycle } : freshRuntime(info))
}

function reseatActive(afterRemove: string): void {
  if (activeId !== afterRemove) return
  activeId = null
  for (const id of sessions.keys()) {
    activeId = id
    break
  }
}

// ---------- actions ----------

export const actions = {
  setActive(id: string): void {
    if (!sessions.has(id)) return
    activeId = id
    commit()
  },

  async createSession(opts: StartOptions): Promise<Result<SessionInfo>> {
    ensureChannel()
    try {
      const info = await api.startSession(opts)
      putRuntime(info)
      activeId = info.id
      commit()
      pushToast('ok', `session ${info.id} started · ${info.workflow || 'no workflow'}`)
      return { ok: true, value: info }
    } catch (err) {
      const error = errText(err)
      pushToast('err', error)
      return { ok: false, error }
    }
  },

  async resumeSession(id: string): Promise<Result<SessionInfo>> {
    ensureChannel()
    try {
      const info = await api.resumeSession(id)
      putRuntime(info)
      activeId = info.id
      commit()
      pushToast('ok', `resumed ${info.id}`)
      return { ok: true, value: info }
    } catch (err) {
      const error = errText(err)
      pushToast('err', error)
      return { ok: false, error }
    }
  },

  async closeSession(id: string): Promise<Result<null>> {
    try {
      await api.closeSession(id)
      sessions.delete(id)
      reseatActive(id)
      commit()
      pushToast('info', `session ${id} closed`)
      return { ok: true, value: null }
    } catch (err) {
      const error = errText(err)
      pushToast('err', error)
      return { ok: false, error }
    }
  },

  /** Returns the tick so callers can resync; also refreshes the runtime. */
  async getState(id: string): Promise<Result<TickDTO>> {
    try {
      const t = await api.getState(id)
      const rt = sessions.get(id)
      if (rt) sessions.set(id, { ...rt, latestTick: t })
      commit()
      return { ok: true, value: t }
    } catch (err) {
      const error = errText(err)
      pushToast('err', error)
      return { ok: false, error }
    }
  },

  /** Plain prompt; the backend queues it automatically mid-turn. */
  async sendPrompt(id: string, text: string): Promise<Result<null>> {
    try {
      await api.sendPrompt(id, text)
      return { ok: true, value: null }
    } catch (err) {
      const error = errText(err)
      pushToast('err', error)
      return { ok: false, error }
    }
  },

  /** Slash command; collected notices land in the session notice buffer. */
  async sendCommand(id: string, line: string): Promise<Result<CommandResultDTO>> {
    try {
      const res = await api.sendCommand(id, line)
      const rt = sessions.get(id)
      if (rt && res.notices.length > 0) {
        sessions.set(id, { ...rt, notices: appendCapped(rt.notices, res.notices, NOTICE_LIMIT) })
        commit()
      }
      return { ok: true, value: res }
    } catch (err) {
      const error = errText(err)
      pushToast('err', error)
      return { ok: false, error }
    }
  },

  /** Approval round-trip; clears pendingApproval on success only. */
  async approve(id: string, requestID: string, decision: ApprovalDecision): Promise<Result<null>> {
    try {
      await api.approve(id, requestID, decision)
      const rt = sessions.get(id)
      if (rt && rt.pendingApproval && rt.pendingApproval.requestID === requestID) {
        sessions.set(id, { ...rt, pendingApproval: null })
      }
      commit()
      return { ok: true, value: null }
    } catch (err) {
      const error = errText(err)
      pushToast('err', error)
      return { ok: false, error }
    }
  },

  dismissToast(): void {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (!toast) return
    toast = null
    commit()
  },
}

// ---------- demo / test injection points ----------

/** Feed a synthetic gui:event through the exact dispatch path (demo pages). */
export function __injectMockEvent(e: GuiEvent): void {
  if (!sessions.has(e.sessionId)) {
    // auto-stub so demo pages can stream events before "creating" a session
    sessions.set(e.sessionId, freshRuntime({
      id: e.sessionId,
      workspace: '(mock)',
      role: 'auto',
      workflow: '',
      planner: '',
      executor: '',
      lifecycle: 'idle',
    }))
  }
  dispatch(e)
}

/** Register a fully-formed fake session (demo pages). */
export function __injectMockSession(info: SessionInfo, active = false): void {
  sessions.set(info.id, freshRuntime(info))
  if (active) activeId = info.id
  commit()
}
