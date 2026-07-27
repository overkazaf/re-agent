package app

import (
	"context"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/workflow"
)

type recordingProvider struct {
	name      string
	config    *types.ProviderConfig
	responses []types.ProviderResponse
	turn      int
	seen      []types.ProviderInput
}

func (p *recordingProvider) Name() string                  { return p.name }
func (p *recordingProvider) Config() *types.ProviderConfig { return p.config }

func (p *recordingProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	p.seen = append(p.seen, input)
	index := p.turn
	if index > len(p.responses)-1 {
		index = len(p.responses) - 1
	}
	p.turn++
	return p.responses[index], nil
}

func TestRunWithWorkflowDelegatesCavemanToIsolatedExecutor(t *testing.T) {
	dir := t.TempDir()
	session := core.NewSession(dir, "test")
	if err := session.Init(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 5000, MaxReadBytes: 1024, MaxToolOutputChars: 4000,
		ApprovalMode: types.ApprovalSafe, Approvals: map[string]string{},
	}
	planner := &recordingProvider{
		name:   "planner",
		config: &types.ProviderConfig{Type: types.KindMock, Model: "planner-model"},
		responses: []types.ProviderResponse{{Text: strings.Join([]string{
			"PLAN:",
			"- collect local metadata",
			"",
			"EXECUTOR_PACKET:",
			"```text",
			"Objective: collect local evidence about ./chall.",
			"Return: file type, hashes, and strings.",
			"```",
		}, "\n")}},
	}
	executor := &recordingProvider{
		name:      "executor",
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "executor-model"},
		responses: []types.ProviderResponse{{Text: "evidence collected"}},
	}
	tools := []types.Tool{
		{Name: "update_plan", Risk: types.RiskRead},
		{Name: "file_info", Description: "original", Risk: types.RiskRead},
		{Name: "run_command", Risk: types.RiskExecute},
		{Name: "ctf_triage", Risk: types.RiskRead},
	}
	config := &types.AgentConfig{
		PlannerProvider: "planner", ExecutorProvider: "executor", DefaultRole: types.RoleAuto, MaxTurns: 3,
		Providers: map[string]*types.ProviderConfig{
			"planner":  planner.config,
			"executor": executor.config,
		},
	}
	state := &State{
		Config: config,
		Loop: core.NewAgentLoop(core.LoopOptions{
			Config: config,
			Providers: map[string]types.Provider{
				"planner":  planner,
				"executor": executor,
			},
			Tools: tools,
			ToolContext: &types.ToolContext{
				Workspace: dir, SessionDir: dir, Policy: policy,
			},
			Session: session,
		}),
		Tools:    tools,
		Role:     types.RoleAuto,
		Workflow: workflow.Caveman,
	}

	var phases []string
	result, err := runWithWorkflow(state, "solve this CTF challenge in ./chall", workflowRunOptions{
		Ctx: context.Background(),
		OnPhase: func(provider string, role types.AgentRole) {
			phases = append(phases, provider+":"+string(role))
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Provider != "planner->executor" || result.Turns != 2 {
		t.Fatalf("unexpected delegated result: provider=%s turns=%d", result.Provider, result.Turns)
	}
	if strings.Join(phases, ",") != "planner:planner,executor:executor" {
		t.Fatalf("unexpected phases: %v", phases)
	}
	if len(planner.seen) != 1 || !strings.Contains(planner.seen[0].Messages[0].Text(), "solve this CTF challenge") {
		t.Fatalf("planner did not receive the full task: %#v", planner.seen)
	}
	if len(executor.seen) != 1 {
		t.Fatalf("executor calls: %d", len(executor.seen))
	}
	execInput := executor.seen[0]
	if len(execInput.Messages) != 1 {
		t.Fatalf("executor should receive isolated prompt, got %d messages", len(execInput.Messages))
	}
	if strings.Contains(execInput.Messages[0].Text(), "solve this CTF challenge") {
		t.Fatalf("executor prompt leaked original task: %q", execInput.Messages[0].Text())
	}
	if !execInput.FreshSession {
		t.Fatal("executor should use a fresh provider session")
	}
	names := map[string]bool{}
	for _, tool := range execInput.Tools {
		names[tool.Name] = true
		if tool.Name == "file_info" && tool.Description == "original" {
			t.Fatal("executor tool descriptions should be neutralized")
		}
	}
	if !names["file_info"] {
		t.Fatal("executor did not receive file_info")
	}
	for _, forbidden := range []string{"run_command", "ctf_triage"} {
		if names[forbidden] {
			t.Fatalf("executor received forbidden tool %s", forbidden)
		}
	}
}
