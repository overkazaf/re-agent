package main

import (
	"context"
)

// App is the Wails binding surface — the ONLY API the frontend may call.
// Contract: docs/plans/2026-11-03-gui-implementation.md §0.2.
// Stubs below are the scaffold baseline; WS1 fills in real implementations
// backed by the SessionManager. Signatures and names are frozen.
type App struct {
	ctx context.Context
	// WS1 wires these: Manager *SessionManager, events *EventBridge
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }
func (a *App) shutdownCtx(ctx context.Context) {
	_ = ctx
}

// --- contract §0.2 methods (WS1 implements; stubs keep bindings generated) ---

func (a *App) StartSession(opts StartOptions) (SessionInfo, error) {
	return SessionInfo{}, errNotImplemented("StartSession")
}

func (a *App) ResumeSession(id string) (SessionInfo, error) {
	return SessionInfo{}, errNotImplemented("ResumeSession")
}

func (a *App) ListSessions() ([]SessionSummaryDTO, error) {
	return nil, errNotImplemented("ListSessions")
}

func (a *App) CloseSession(id string) error {
	return errNotImplemented("CloseSession")
}

func (a *App) SendPrompt(id, text string) error {
	return errNotImplemented("SendPrompt")
}

func (a *App) SendCommand(id, line string) (CommandResultDTO, error) {
	return CommandResultDTO{}, errNotImplemented("SendCommand")
}

func (a *App) Approve(id, requestID, decision string) error {
	return errNotImplemented("Approve")
}

func (a *App) GetState(id string) (TickDTO, error) {
	return TickDTO{}, errNotImplemented("GetState")
}

func (a *App) Completions(line string) ([]string, error) {
	return nil, errNotImplemented("Completions")
}

func (a *App) GetThemes() ([]string, error) {
	return []string{"deck", "amber", "matrix", "mono"}, nil
}

func errNotImplemented(what string) error {
	return &notImplemented{what}
}

type notImplemented struct{ what string }

func (e *notImplemented) Error() string { return e.what + ": not implemented yet (WS1 pending)" }
