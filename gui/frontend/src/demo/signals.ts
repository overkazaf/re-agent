// Lightweight signal bus connecting the demo backend / UI components to the
// interactive Demo Coach without tangling production stores with demo logic.
import type { ApprovalDecision } from '../lib/types'
import type { ThemeName } from '../theme/ThemeContext'

export type DemoSignal =
  | { type: 'session_started'; sessionId: string; workspace: string }
  | { type: 'session_switched'; sessionId: string; workspace: string }
  | { type: 'session_resumed'; sessionId: string; workspace: string }
  | { type: 'prompt_sent'; sessionId: string; text: string; queued: boolean }
  | { type: 'turn_completed'; sessionId: string; kind: string; approved?: boolean }
  | { type: 'approval_requested'; sessionId: string; toolName: string }
  | { type: 'approval_decided'; sessionId: string; decision: ApprovalDecision }
  | { type: 'command_sent'; sessionId: string; line: string }
  | { type: 're_picker_opened' }
  | { type: 're_workflow_started'; sessionId: string; sampleType: string }
  | { type: 're_phase_changed'; sessionId: string; phase: string; phaseIndex: number }
  | { type: 'audit_completed'; sessionId: string }
  | { type: 'writeup_completed'; sessionId: string }
  | { type: 'interrupted'; sessionId: string }
  | { type: 'theme_changed'; theme: ThemeName }
  | { type: 'settings_saved'; sessionId: string }
  | { type: 'shell_opened'; shellId: string; cwd: string }
  | { type: 'shell_command'; shellId: string; command: string; output: string }
  | { type: 'returned_to_session'; sessionId: string }

type SignalListener = (s: DemoSignal) => void
const signalListeners = new Set<SignalListener>()

export function emitDemoSignal(s: DemoSignal): void {
  for (const fn of signalListeners) fn(s)
}

export function onDemoSignal(fn: SignalListener): () => void {
  signalListeners.add(fn)
  return () => signalListeners.delete(fn)
}

// ---------- prompt fill channel (Coach Bar → PromptInput) ----------

export interface PromptFillRequest {
  text: string
  autoSend?: boolean
}

type PromptFillListener = (req: PromptFillRequest) => void
const promptFillListeners = new Set<PromptFillListener>()

export function requestPromptFill(req: PromptFillRequest): void {
  for (const fn of promptFillListeners) fn(req)
}

export function onPromptFill(fn: PromptFillListener): () => void {
  promptFillListeners.add(fn)
  return () => promptFillListeners.delete(fn)
}

// ---------- sidebar dialog triggers (Coach Bar → SessionSidebar) ----------

export type SidebarDialogTrigger = 'new' | 'resume' | 'settings'
type DialogTriggerListener = (kind: SidebarDialogTrigger) => void
const dialogTriggerListeners = new Set<DialogTriggerListener>()

export function requestSidebarDialog(kind: SidebarDialogTrigger): void {
  for (const fn of dialogTriggerListeners) fn(kind)
}

export function onSidebarDialogRequest(fn: DialogTriggerListener): () => void {
  dialogTriggerListeners.add(fn)
  return () => dialogTriggerListeners.delete(fn)
}

// ---------- live theme setter bridge (/theme command → ThemeContext) ----------

let liveThemeSetter: ((name: ThemeName) => void) | null = null

export function registerLiveThemeSetter(fn: ((name: ThemeName) => void) | null): void {
  liveThemeSetter = fn
}

export function applyLiveTheme(name: ThemeName): boolean {
  if (!liveThemeSetter) return false
  liveThemeSetter(name)
  return true
}
