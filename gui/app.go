package main

import (
	"context"
	"fmt"
	"sort"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/skills"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

// App is the Wails binding surface — the ONLY API the frontend may call.
// Contract: docs/plans/2026-11-03-gui-implementation.md §0.2. Every method is a
// thin pass-through: SessionManager owns sessions, EventBridge owns delivery,
// ApprovalBridge owns the pending-approval exchange.
type App struct {
	ctx       context.Context
	manager   *SessionManager
	events    *EventBridge
	approvals *ApprovalBridge
	shells    *ShellManager
}

// NewApp assembles the backend before the window exists: sessions already work
// (the manager falls back to a dead sink), events start flowing once startup
// attaches the runtime context.
func NewApp() *App {
	approvals := NewApprovalBridge()
	manager := NewSessionManager(nil, approvals.Approver())
	return &App{manager: manager, approvals: approvals, shells: NewShellManager()}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.events = NewEventBridge(a.manager) // also becomes the manager's sink
	a.events.SetRuntimeContext(ctx)
	a.approvals.SetEmit(func(envelope EventEnvelope) {
		wruntime.EventsEmit(ctx, EventChannel, envelope)
	})
	a.shells.SetEmit(func(envelope ShellEnvelope) {
		wruntime.EventsEmit(ctx, shellChannel, envelope)
	})
}

func (a *App) shutdownCtx(ctx context.Context) {
	_ = ctx
	a.shells.StopAll()
	a.manager.CloseAll()
	if a.events != nil {
		a.events.Close()
	}
}

// --- contract §0.2 methods ---------------------------------------------------

func (a *App) StartSession(opts StartOptions) (SessionInfo, error) {
	return a.manager.Start(opts)
}

func (a *App) ResumeSession(id string) (SessionInfo, error) {
	return a.manager.Resume(id)
}

func (a *App) ListSessions() ([]SessionSummaryDTO, error) {
	return a.manager.List()
}

func (a *App) CloseSession(id string) error {
	a.approvals.DenyAll(id)
	return a.manager.CloseSession(id)
}

func (a *App) SendPrompt(id, text string) error {
	return a.manager.SendPrompt(id, text)
}

func (a *App) Interrupt(id string) bool {
	return a.manager.Interrupt(id)
}

func (a *App) SendCommand(id, line string) (CommandResultDTO, error) {
	return a.manager.SendCommand(id, line)
}

func (a *App) Approve(id, requestID, decision string) error {
	return a.approvals.Deliver(id, requestID, decision)
}

func (a *App) GetState(id string) (TickDTO, error) {
	tick, ok := a.manager.Snapshot(id)
	if !ok {
		return TickDTO{}, fmt.Errorf("unknown session: %s", id)
	}
	return tick, nil
}

// GetSettings renders the session's live config for the settings dialog.
func (a *App) GetSettings(id string) (SettingsDTO, error) {
	return a.manager.GetSettings(id)
}

// SetSettings applies a settings patch to the session's live config.
func (a *App) SetSettings(id string, patch SettingsPatch) error {
	return a.manager.SetSettings(id, patch)
}

func (a *App) MutateHypothesis(id string, req HypothesisMutationDTO) (types.Hypothesis, error) {
	return a.manager.MutateHypothesis(id, req)
}

func (a *App) RunHypothesisExperiment(id string, req RunExperimentDTO) (types.EvidenceRecord, error) {
	return a.manager.RunHypothesisExperiment(id, req)
}

func (a *App) RunVerification(id string, req VerificationRequestDTO) (types.EvidenceRecord, error) {
	return a.manager.RunVerification(id, req)
}

func (a *App) SubmitReview(id string, req ReviewRequestDTO) (ReviewResultDTO, error) {
	return a.manager.SubmitReview(id, req)
}

func (a *App) ListWorkspaceFiles(id string) ([]tools.WorkspaceFile, error) {
	return a.manager.ListWorkspaceFiles(id)
}

func (a *App) AnalyzeBinaryTerrain(id, path, comparePath string) (tools.BinaryTerrain, error) {
	return a.manager.AnalyzeBinaryTerrain(id, path, comparePath)
}

// Completions bridges ui.SlashCompletions onto the frozen []string contract.
// The frontend replaces the whole line, so each entry is the item's Replacement
// (not its display Value); the rich CompletionItem DTO is a v2 upgrade.
func (a *App) Completions(line string) ([]string, error) {
	providers, skills := a.completionContexts()
	items := ui.SlashCompletions(line, providers, skills)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item.Replacement != "" {
			out = append(out, item.Replacement)
			continue
		}
		out = append(out, item.Value)
	}
	return out, nil
}

// completionContexts gathers provider/skill names for argument completion. A
// live session's config is authoritative; without one, the saved config still
// completes /planner-style arguments (commands always complete).
func (a *App) completionContexts() ([]string, []string) {
	if state := a.manager.anyState(); state != nil {
		return providerNamesOf(state.Config), skillNamesOf(state.Skills)
	}
	agentConfig, _, err := loadConfig()
	if err != nil {
		return nil, nil
	}
	return providerNamesOf(agentConfig), nil
}

func (a *App) GetThemes() ([]string, error) {
	themes := make([]string, len(ui.ThemeNames))
	copy(themes, ui.ThemeNames)
	return themes, nil
}

// RESampleTypes feeds the frontend's reverse-workflow picker dialog: the same
// sample-type + canned-prompt data the terminal picker renders interactively.
func (a *App) RESampleTypes() ([]RESampleTypeDTO, error) {
	return NewRESampleTypesDTO(), nil
}

// HomeDir is the default workspace root for new sessions and shells — the
// manager's own fallback (guiHomeDir) exposed so the dialogs pre-fill the
// same value instead of guessing.
func (a *App) HomeDir() string {
	return guiHomeDir()
}

// GreetWithModel synthesizes a concise startup greeting and actionable next-step
// suggestions using the user's configured LLM provider, with a strict short
// timeout and deterministic local fallback when offline or unconfigured.
func (a *App) GreetWithModel(req GreetingRequest) GreetingResponse {
	return a.greetWithModel(req)
}

// PickDirectory opens the OS directory picker and returns the chosen path
// ("" when cancelled).
func (a *App) PickDirectory() (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("runtime not ready")
	}
	path, err := wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{
		Title:                "选择 workspace / 选择目录",
		CanCreateDirectories: true,
	})
	if err != nil {
		return "", err
	}
	return path, nil
}

// --- shells -------------------------------------------------------------------

// ShellStart spawns an interactive PTY shell rooted at cwd ("" → $HOME).
func (a *App) ShellStart(cwd string) (ShellInfo, error) {
	return a.shells.Start(cwd)
}

func (a *App) ShellWrite(id, data string) error { return a.shells.Write(id, data) }
func (a *App) ShellResize(id string, cols, rows int) error {
	return a.shells.Resize(id, cols, rows)
}
func (a *App) ShellStop(id string) error       { return a.shells.Stop(id) }
func (a *App) ShellList() ([]ShellInfo, error) { return a.shells.List(), nil }

func providerNamesOf(config *types.AgentConfig) []string {
	if config == nil {
		return nil
	}
	names := make([]string, 0, len(config.Providers))
	for name := range config.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func skillNamesOf(list []skills.Skill) []string {
	names := make([]string, 0, len(list))
	for _, skill := range list {
		names = append(names, skill.Name)
	}
	sort.Strings(names)
	return names
}

// loadConfig reads the saved agent config (the sessions' assembly path).
func loadConfig() (*types.AgentConfig, string, error) {
	return config.Load("")
}
