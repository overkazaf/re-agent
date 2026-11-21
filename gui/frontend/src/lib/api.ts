// FROZEN CONTRACT — typed wrappers over the Wails-bound Go App methods.
// Calls go through window.go (the runtime object Wails injects), so this file
// stays stable regardless of how wailsjs/ bindings get regenerated.
// The freeze served the parallel workstream build; that build is complete and
// amendments now go through normal review: keep this file mirroring gui/app.go.

import type {
  ApprovalDecision,
  BinaryTerrainDTO,
  CommandResultDTO,
  EvidenceRecord,
  Hypothesis,
  HypothesisMutationDTO,
  RESampleType,
  ReviewRequestDTO,
  ReviewResultDTO,
  RunExperimentDTO,
  SessionInfo,
  SessionSummaryDTO,
  SettingsPatch,
  SettingsDTO,
  ShellInfo,
  StartOptions,
  TickDTO,
  VerificationRequestDTO,
  WorkspaceFileDTO,
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
  MutateHypothesis(id: string, req: HypothesisMutationDTO): Promise<Hypothesis>
  RunHypothesisExperiment(id: string, req: RunExperimentDTO): Promise<EvidenceRecord>
  RunVerification(id: string, req: VerificationRequestDTO): Promise<EvidenceRecord>
  SubmitReview(id: string, req: ReviewRequestDTO): Promise<ReviewResultDTO>
  ListWorkspaceFiles(id: string): Promise<WorkspaceFileDTO[]>
  AnalyzeBinaryTerrain(id: string, path: string, comparePath: string): Promise<BinaryTerrainDTO>
  Completions(line: string): Promise<string[]>
  GetThemes(): Promise<string[]>
  RESampleTypes(): Promise<RESampleType[]>
  HomeDir(): Promise<string>
  PickDirectory(): Promise<string>
  ShellStart(cwd: string): Promise<ShellInfo>
  ShellWrite(id: string, data: string): Promise<void>
  ShellResize(id: string, cols: number, rows: number): Promise<void>
  ShellStop(id: string): Promise<void>
  ShellList(): Promise<ShellInfo[]>
}

let demoAppOverride: AppAPI | null = null

/** Install or clear the in-memory demo AppAPI transport. */
export function setDemoAppAPI(impl: AppAPI | null): void {
  demoAppOverride = impl
}

export function isDemoAppActive(): boolean {
  return demoAppOverride !== null
}

/** True only when the real Wails Go bridge (or test shim) is injected on window. */
export function hasRealWailsBackend(): boolean {
  try {
    const w = window as unknown as { go?: { main?: { App?: unknown } } }
    return Boolean(w.go && w.go.main && w.go.main.App)
  } catch {
    return false
  }
}

function app(): AppAPI {
  if (demoAppOverride) return demoAppOverride
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
  mutateHypothesis: (id: string, req: HypothesisMutationDTO) => app().MutateHypothesis(id, req),
  runHypothesisExperiment: (id: string, req: RunExperimentDTO) => app().RunHypothesisExperiment(id, req),
  runVerification: (id: string, req: VerificationRequestDTO) => app().RunVerification(id, req),
  submitReview: (id: string, req: ReviewRequestDTO) => app().SubmitReview(id, req),
  listWorkspaceFiles: (id: string) => app().ListWorkspaceFiles(id),
  analyzeBinaryTerrain: (id: string, path: string, comparePath = '') =>
    app().AnalyzeBinaryTerrain(id, path, comparePath),
  completions: (line: string) => app().Completions(line),
  getThemes: () => app().GetThemes(),
  reSampleTypes: () => app().RESampleTypes(),
  homeDir: () => app().HomeDir(),
  pickDirectory: () => app().PickDirectory(),
  shellStart: (cwd: string) => app().ShellStart(cwd),
  shellWrite: (id: string, data: string) => app().ShellWrite(id, data),
  shellResize: (id: string, cols: number, rows: number) => app().ShellResize(id, cols, rows),
  shellStop: (id: string) => app().ShellStop(id),
  shellList: () => app().ShellList(),
}
