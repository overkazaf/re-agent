package main

import (
	"context"
	"fmt"
	"sort"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/skills"
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
}

// NewApp assembles the backend before the window exists: sessions already work
// (the manager falls back to a dead sink), events start flowing once startup
// attaches the runtime context.
func NewApp() *App {
	approvals := NewApprovalBridge()
	manager := NewSessionManager(nil, approvals.Approver())
	return &App{manager: manager, approvals: approvals}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.events = NewEventBridge(a.manager) // also becomes the manager's sink
	a.events.SetRuntimeContext(ctx)
	a.approvals.SetEmit(func(envelope EventEnvelope) {
		wruntime.EventsEmit(ctx, EventChannel, envelope)
	})
}

func (a *App) shutdownCtx(ctx context.Context) {
	_ = ctx
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
