package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

func TestHandleNewSessionStartsFreshTranscript(t *testing.T) {
	dir := t.TempDir()
	session := core.NewSession(dir, "test")
	if err := session.Init(map[string]any{"agent": "test"}); err != nil {
		t.Fatal(err)
	}
	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 5000, MaxReadBytes: 1024, MaxToolOutputChars: 4000,
		ApprovalMode: types.ApprovalSafe, Approvals: map[string]string{},
	}
	provider := &recordingProvider{
		name:   "mock",
		config: &types.ProviderConfig{Type: types.KindMock, Model: "mock"},
	}
	config := &types.AgentConfig{
		PlannerProvider: "mock", ExecutorProvider: "mock", DefaultRole: types.RoleAuto, MaxTurns: 2,
		Providers: map[string]*types.ProviderConfig{"mock": provider.config},
	}
	toolContext := &types.ToolContext{Workspace: dir, SessionDir: dir, Policy: policy}
	loop := core.NewAgentLoop(core.LoopOptions{
		Config: config, Providers: map[string]types.Provider{"mock": provider},
		ToolContext: toolContext, SystemPrompt: "sys", Session: session,
	})
	if err := loop.AddContext("some prior context"); err != nil {
		t.Fatal(err)
	}
	state := &State{
		Config: config, Loop: loop, Session: session, ToolContext: toolContext,
		Providers: map[string]types.Provider{"mock": provider}, Queue: newTaskQueue(),
		PlanDisplay: ui.PlanDisplayAuto, ThinkDisplay: ui.ThinkDisplayAuto,
		SessionMeta: map[string]any{"agent": "test"},
	}
	state.Queue.Add("queued task")
	old := session.File

	if err := handleNewSession(state); err != nil {
		t.Fatal(err)
	}
	if state.Session.File == old {
		t.Fatal("session file should change after /new")
	}
	if len(state.Loop.History()) != 0 {
		t.Fatalf("history not cleared: %d messages", len(state.Loop.History()))
	}
	if state.Queue.Len() != 0 {
		t.Fatal("queue should be cleared")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if entry.Name() == filepath.Base(state.Session.File) {
			found = true
		}
	}
	if !found {
		t.Fatal("new session file not created")
	}
}
