// FROZEN CONTRACT — typed wrappers over the Wails-bound Go App methods.
// Calls go through window.go (the runtime object Wails injects), so this file
// stays stable regardless of how wailsjs/ bindings get regenerated.
// Read-only for all workstream agents.

import type {
  ApprovalDecision,
  CommandResultDTO,
  SessionInfo,
  SessionSummaryDTO,
  SettingsPatch,
  SettingsDTO,
  ShellInfo,
  StartOptions,
  TickDTO,
} from './types'

export interface AppAPI {
  StartSession(opts: StartOptions): Promise<SessionInfo>
  ResumeSession(id: string): Promise<SessionInfo>
  ListSessions(): Promise<SessionSummaryDTO[]>
  CloseSession(id: string): Promise<void>
  SendPrompt(id: string, text: string): Promise<void>
  Interrupt(id: string): Promise<boolean>
  SendCommand(id: string, line: string): Promise<CommandResultDTO>
  Approve(id: string, requestID: string, decision: ApprovalDecision): Promise<void>
  GetState(id: string): Promise<TickDTO>
  GetSettings(id: string): Promise<SettingsDTO>
  SetSettings(id: string, patch: SettingsPatch): Promise<void>
  Completions(line: string): Promise<string[]>
  GetThemes(): Promise<string[]>
  HomeDir(): Promise<string>
  PickDirectory(): Promise<string>
  ShellStart(cwd: string): Promise<ShellInfo>
  ShellWrite(id: string, data: string): Promise<void>
  ShellResize(id: string, cols: number, rows: number): Promise<void>
  ShellStop(id: string): Promise<void>
  ShellList(): Promise<ShellInfo[]>
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
  interrupt: (id: string) => app().Interrupt(id),
  sendCommand: (id: string, line: string) => app().SendCommand(id, line),
  approve: (id: string, requestID: string, decision: ApprovalDecision) =>
    app().Approve(id, requestID, decision),
  getState: (id: string) => app().GetState(id),
  getSettings: (id: string) => app().GetSettings(id),
  setSettings: (id: string, patch: SettingsPatch) => app().SetSettings(id, patch),
  completions: (line: string) => app().Completions(line),
  getThemes: () => app().GetThemes(),
  homeDir: () => app().HomeDir(),
  pickDirectory: () => app().PickDirectory(),
  shellStart: (cwd: string) => app().ShellStart(cwd),
  shellWrite: (id: string, data: string) => app().ShellWrite(id, data),
  shellResize: (id: string, cols: number, rows: number) => app().ShellResize(id, cols, rows),
  shellStop: (id: string) => app().ShellStop(id),
  shellList: () => app().ShellList(),
}
