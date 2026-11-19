package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/goal"
	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

// The /goal accept → sandbox → /cap → /goal clear lifecycle, on a hand-built
// State: the declaration's constraints arm the deny-by-default scope, /cap
// adjusts it, and clearing the task expires every capability.
func TestGoalLifecycleDrivesTheCapabilitySandbox(t *testing.T) {
	state := testStateWithSandbox(t)
	if err := os.WriteFile(filepath.Join(state.ToolContext.Workspace, "chall.elf"), []byte("\x7fELF"), 0o644); err != nil {
		t.Fatal(err)
	}

	state.GoalDraft = &goal.Declaration{
		RawGoal: "recover the license check",
		Target:  goal.Target{File: "chall.elf", Scope: "the shipped binary only"},
		Objective: goal.Objective{
			Primary:      "recover_license_check",
			Intent:       "algorithm extracted and replayed",
			Deliverables: []string{"alg.py"},
			Constraints:  map[string]string{"network": "deny", "device": "none"},
			Acceptance:   []goal.Criterion{{Kind: goal.KindBuildPass}},
		},
	}
	if err := acceptGoal(state); err != nil {
		t.Fatal(err)
	}
	sandbox := state.Sandbox
	if !sandbox.Active() {
		t.Fatal("accepting a declaration must activate the sandbox")
	}
	if len(sandbox.Granted()) != 0 {
		t.Fatal("network:deny / device:none must grant nothing")
	}
	if err := sandbox.Authorize("run_command", "curl https://example.test"); err == nil || !security.IsDenied(err) {
		t.Fatalf("network must stay denied: %v", err)
	}

	// The operator grants device access mid-run; the action log carries both
	// the grant's effects and the earlier denials.
	if err := handleCapCommand("device on pixel-8", state); err != nil {
		t.Fatal(err)
	}
	if sandbox.Device() != "pixel-8" {
		t.Fatalf("operator grant should set the device id: %q", sandbox.Device())
	}
	if err := sandbox.Authorize("run_command", "adb shell pm list packages"); err != nil {
		t.Fatalf("granted device must pass: %v", err)
	}
	rendered := renderSandbox(sandbox)
	if !strings.Contains(rendered, "device (pixel-8)") || !strings.Contains(rendered, "denied") {
		t.Fatalf("sandbox view should show the grant and the denial: %s", rendered)
	}

	// Clearing the task expires the scope entirely.
	if err := clearGoal(state); err != nil {
		t.Fatal(err)
	}
	if sandbox.Active() || len(sandbox.Granted()) != 0 || sandbox.Device() != "" {
		t.Fatal("clearing the goal must expire every capability")
	}
	if err := handleCapCommand("network on", state); err == nil || !strings.Contains(err.Error(), "/goal accept") {
		t.Fatalf("grant without a task must refuse with guidance: %v", err)
	}
}

func TestSandboxReactivatesFromAResumedDeclaration(t *testing.T) {
	state := testStateWithSandbox(t)
	declaration := &goal.Declaration{
		Accepted: true,
		Objective: goal.Objective{
			Constraints: map[string]string{"network": "allow"},
			Acceptance:  []goal.Criterion{{Kind: goal.KindBuildPass}},
		},
	}
	state.Loop.SetGoal(declaration)
	// Mirror the app.Run resume path: an accepted declaration re-arms the
	// sandbox from its constraints.
	state.Sandbox.Activate(declaration.Objective.Constraints)
	if _, granted := state.Sandbox.Granted()[security.CapNetwork]; !granted {
		t.Fatal("resumed declaration should re-grant network")
	}
	if state.Sandbox.Active() != true {
		t.Fatal("resumed declaration should reactivate the sandbox")
	}
}

func TestAcceptGoalRejectsMissingOrOutsideTarget(t *testing.T) {
	state := testStateWithSandbox(t)

	state.GoalDraft = &goal.Declaration{
		RawGoal: "inspect missing target",
		Target:  goal.Target{File: "missing.elf"},
		Objective: goal.Objective{
			Primary:    "inspect_missing",
			Acceptance: []goal.Criterion{{Kind: goal.KindBuildPass}},
		},
	}
	if err := acceptGoal(state); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("expected missing target rejection, got: %v", err)
	}

	state.GoalDraft = &goal.Declaration{
		RawGoal: "inspect outside target",
		Target:  goal.Target{File: "../escape.elf"},
		Objective: goal.Objective{
			Primary:    "inspect_outside",
			Acceptance: []goal.Criterion{{Kind: goal.KindBuildPass}},
		},
	}
	if err := acceptGoal(state); err == nil || !strings.Contains(err.Error(), "outside the workspace") {
		t.Fatalf("expected outside workspace rejection, got: %v", err)
	}
}

func testStateWithSandbox(t *testing.T) *State {
	t.Helper()
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
	sandbox := security.NewSandbox()
	toolContext := &types.ToolContext{
		Workspace: dir, SessionDir: dir, Policy: policy, Sandbox: sandbox,
	}
	loop := core.NewAgentLoop(core.LoopOptions{
		Config: config, Providers: map[string]types.Provider{"mock": provider},
		ToolContext: toolContext, SystemPrompt: "sys", Session: session,
	})
	return &State{
		Config: config, Loop: loop, Session: session, ToolContext: toolContext,
		Providers: map[string]types.Provider{"mock": provider}, Queue: newTaskQueue(),
		PlanDisplay: ui.PlanDisplayAuto, ThinkDisplay: ui.ThinkDisplayAuto,
		SessionMeta: map[string]any{"agent": "test"}, Sandbox: sandbox,
	}
}
