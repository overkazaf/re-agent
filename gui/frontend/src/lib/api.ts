// FROZEN CONTRACT — typed wrappers over the Wails-bound Go App methods.
// Calls go through window.go (the runtime object Wails injects), so this file
// stays stable regardless of how wailsjs/ bindings get regenerated.
// Read-only for all workstream agents.

import type {
  ApprovalDecision,
  CommandResultDTO,
  SessionInfo,
  SessionSummaryDTO,
  StartOptions,
  TickDTO,
} from './types'

export interface AppAPI {
  StartSession(opts: StartOptions): Promise<SessionInfo>
  ResumeSession(id: string): Promise<SessionInfo>
  ListSessions(): Promise<SessionSummaryDTO[]>
  CloseSession(id: string): Promise<void>
  SendPrompt(id: string, text: string): Promise<void>
  SendCommand(id: string, line: string): Promise<CommandResultDTO>
  Approve(id: string, requestID: string, decision: ApprovalDecision): Promise<void>
  GetState(id: string): Promise<TickDTO>
  Completions(line: string): Promise<string[]>
  GetThemes(): Promise<string[]>
}

function app(): AppAPI {
  return (window as unknown as { go: { main: { App: AppAPI } } }).go.main.App
}

export const api = {
  startSession: (opts: StartOptions) => app().StartSession(opts),
  resumeSession: (id: string) => app().ResumeSession(id),
  listSessions: () => app().ListSessions(),
  closeSession: (id: string) => app().CloseSession(id),
  sendPrompt: (id: string, text: string) => app().SendPrompt(id, text),
  sendCommand: (id: string, line: string) => app().SendCommand(id, line),
  approve: (id: string, requestID: string, decision: ApprovalDecision) =>
    app().Approve(id, requestID, decision),
  getState: (id: string) => app().GetState(id),
  completions: (line: string) => app().Completions(line),
  getThemes: () => app().GetThemes(),
}
