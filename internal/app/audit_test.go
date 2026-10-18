package app

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

// TestAuditCommandChallengesStack pins the /audit slash command: it runs the
// loop's adversarial audit on the second seat and the verdict lands on the
// stack the operator can see.
func TestAuditCommandChallengesStack(t *testing.T) {
	dir := t.TempDir()
	session := core.NewSession(dir, "test")
	if err := session.Init(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 5000, MaxReadBytes: 1024, MaxToolOutputChars: 4000,
		ApprovalMode: types.ApprovalSafe, Approvals: map[string]string{},
	}
	auditor := &recordingProvider{
		name:      "auditor",
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "audit-model"},
		responses: []types.ProviderResponse{{Text: "AUDIT H-001 CHALLENGE - the claim overreads one static string"}},
	}
	main := &recordingProvider{
		name:      "main",
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "main-model"},
		responses: []types.ProviderResponse{{Text: "unused"}},
	}
	config := &types.AgentConfig{
		PlannerProvider: "main", ExecutorProvider: "main", DefaultRole: types.RoleAuto, MaxTurns: 3,
		AuditProvider: "auditor",
		Providers: map[string]*types.ProviderConfig{
			"main":    main.config,
			"auditor": auditor.config,
		},
	}
	toolContext := &types.ToolContext{Workspace: dir, SessionDir: dir, Policy: policy}
	state := &State{
		Config:      config,
		ToolContext: toolContext,
		Loop: core.NewAgentLoop(core.LoopOptions{
			Config: config,
			Providers: map[string]types.Provider{
				"main":    main,
				"auditor": auditor,
			},
			ToolContext: toolContext,
			Session:     session,
		}),
	}

	if _, err := state.ToolContext.Hypotheses.Create("sub_401280 is linked statically", 0.8, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := handleCommand("/audit", state); err != nil {
		t.Fatal(err)
	}
	hyps := state.Loop.Hypotheses()
	if hyps[0].Confidence != 0.4 {
		t.Fatalf("/audit should have challenged the claim, confidence %v", hyps[0].Confidence)
	}
	if len(auditor.seen) == 0 || len(main.seen) != 0 {
		t.Fatalf("audit must run on the auditor seat only")
	}
	if !strings.Contains(auditor.seen[0].System, "adversarial") {
		t.Fatalf("audit system prompt missing: %q", auditor.seen[0].System)
	}
}
