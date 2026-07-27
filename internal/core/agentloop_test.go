package core

import (
	"context"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

// scriptedProvider replays a fixed list of responses, one per turn.
type scriptedProvider struct {
	config    *types.ProviderConfig
	responses []types.ProviderResponse
	turn      int
	seen      [][]types.Message
	systems   []string
}

func (p *scriptedProvider) Name() string                  { return "scripted" }
func (p *scriptedProvider) Config() *types.ProviderConfig { return p.config }

func (p *scriptedProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	p.seen = append(p.seen, input.Messages)
	p.systems = append(p.systems, input.System)
	index := p.turn
	if index > len(p.responses)-1 {
		index = len(p.responses) - 1
	}
	p.turn++
	return p.responses[index], nil
}

func newTestLoop(t *testing.T, provider types.Provider, tools []types.Tool) (*AgentLoop, *types.ExecutionPolicy) {
	t.Helper()
	dir := t.TempDir()
	session := NewSession(dir, "test")
	if err := session.Init(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 5000, MaxReadBytes: 1024, MaxToolOutputChars: 4000,
		ApprovalMode: types.ApprovalSafe, Approvals: map[string]string{},
	}
	toolContext := &types.ToolContext{Workspace: dir, SessionDir: dir, Policy: policy}
	loop := NewAgentLoop(LoopOptions{
		Config: &types.AgentConfig{
			PlannerProvider: "scripted", ExecutorProvider: "scripted",
			ResearcherProvider: "scripted",
			DefaultRole:        types.RoleAuto, MaxTurns: 6,
			Providers: map[string]*types.ProviderConfig{"scripted": provider.Config()},
		},
		Providers:   map[string]types.Provider{"scripted": provider},
		Tools:       tools,
		ToolContext: toolContext,
		Session:     session,
	})
	return loop, policy
}

func echoTool(calls *int) types.Tool {
	return types.Tool{
		Name: "echo", Description: "echo", Risk: types.RiskRead,
		Parameters: map[string]any{"type": "object"},
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			*calls++
			return types.ToolResult{Content: []types.ContentBlock{types.TextBlock("echoed")}}, nil
		},
	}
}

func TestRunExecutesToolsAndFinishes(t *testing.T) {
	provider := &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{
			{ToolCalls: []types.ToolCall{{ID: "1", Name: "echo", Arguments: map[string]any{}}}},
			{Text: "all done", Usage: types.TokenUsage{Output: 12}},
		},
	}
	calls := 0
	loop, _ := newTestLoop(t, provider, []types.Tool{echoTool(&calls)})

	var kinds []string
	result, err := loop.Run("do the thing", RunOptions{
		OnEvent: func(event LoopEvent) { kinds = append(kinds, event.Type) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("expected the tool to run once, ran %d times", calls)
	}
	if result.Turns != 2 {
		t.Fatalf("expected 2 turns, got %d", result.Turns)
	}
	if result.Usage.Output != 12 {
		t.Fatalf("usage not accumulated: %+v", result.Usage)
	}
	if !strings.Contains(strings.Join(kinds, ","), "tool_start,tool_end") {
		t.Fatalf("tool events missing: %v", kinds)
	}
	// The tool result has to reach the provider on the next turn.
	if len(provider.seen) < 2 {
		t.Fatal("expected a second request")
	}
	second := provider.seen[1]
	if second[len(second)-1].Role != types.MessageToolResult {
		t.Fatalf("tool result not sent back: %+v", second[len(second)-1])
	}
}

func TestRunReportsMissingTool(t *testing.T) {
	provider := &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{
			{ToolCalls: []types.ToolCall{{ID: "1", Name: "nope", Arguments: map[string]any{}}}},
			{Text: "recovered"},
		},
	}
	loop, _ := newTestLoop(t, provider, nil)
	if _, err := loop.Run("go", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, message := range loop.History() {
		if message.Role == types.MessageToolResult && strings.Contains(message.Text(), "Tool not found") {
			found = true
		}
	}
	if !found {
		t.Fatal("missing tool did not produce an error result")
	}
}

func TestRunInterruptedKeepsHistoryValid(t *testing.T) {
	provider := &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{
			{ToolCalls: []types.ToolCall{
				{ID: "1", Name: "echo", Arguments: map[string]any{}},
				{ID: "2", Name: "echo", Arguments: map[string]any{}},
			}},
		},
	}
	calls := 0
	loop, _ := newTestLoop(t, provider, []types.Tool{echoTool(&calls)})

	ctx, cancel := context.WithCancel(context.Background())
	result, err := loop.Run("go", RunOptions{
		Ctx: ctx,
		OnEvent: func(event LoopEvent) {
			if event.Type == "tool_end" {
				cancel() // interrupt between the two calls
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Interrupted {
		t.Fatal("expected the run to report an interrupt")
	}
	// Every issued call must still have a result, or strict chat APIs reject
	// the history on the next turn.
	answered := map[string]bool{}
	for _, message := range result.Messages {
		if message.Role == types.MessageToolResult {
			answered[message.ToolCallID] = true
		}
	}
	for _, message := range result.Messages {
		for _, call := range message.ToolCalls {
			if !answered[call.ID] {
				t.Fatalf("tool call %s dangles after an interrupt", call.ID)
			}
		}
	}
	last := result.Messages[len(result.Messages)-1]
	if last.Role != types.MessageAssistant || !strings.Contains(last.Text(), "interrupted") {
		t.Fatalf("expected an interrupt marker, got %+v", last)
	}
}

func TestRoutingPrefersExecutorForExecutionPrompts(t *testing.T) {
	loop, _ := newTestLoop(t, &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
	}, nil)
	loop.options.Config.PlannerProvider = "planner"
	loop.options.Config.ExecutorProvider = "executor"

	if got := loop.routeProvider(types.RoleAuto, "run ls -la in the workspace"); got != "executor" {
		t.Fatalf("expected executor routing, got %s", got)
	}
	if got := loop.routeProvider(types.RoleAuto, "运行 一下这个二进制"); got != "executor" {
		t.Fatalf("expected executor routing for the Chinese keyword, got %s", got)
	}
	if got := loop.routeProvider(types.RoleAuto, "what is the best approach here"); got != "planner" {
		t.Fatalf("expected planner routing, got %s", got)
	}
	if got := loop.routeProvider(types.RoleExecutor, "anything"); got != "executor" {
		t.Fatalf("explicit role ignored: %s", got)
	}
	loop.options.Config.ResearcherProvider = "researcher"
	if got := loop.routeProvider(types.RoleResearcher, "map prior art"); got != "researcher" {
		t.Fatalf("expected researcher routing, got %s", got)
	}
}

func TestRunAddsEffectiveRolePrompt(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{{Text: "ok"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	loop.options.SystemPrompt = "global system"
	loop.options.RolePrompts = map[types.AgentRole]string{
		types.RolePlanner:    "planner prompt",
		types.RoleExecutor:   "executor prompt",
		types.RoleResearcher: "researcher prompt",
	}

	if _, err := loop.Run("collect background", RunOptions{Role: types.RoleResearcher}); err != nil {
		t.Fatal(err)
	}
	if len(provider.systems) == 0 || !strings.Contains(provider.systems[0], "researcher prompt") {
		t.Fatalf("researcher prompt missing: %#v", provider.systems)
	}
	if strings.Contains(provider.systems[0], "planner prompt") || strings.Contains(provider.systems[0], "executor prompt") {
		t.Fatalf("wrong role prompt included: %q", provider.systems[0])
	}
}

func TestDescribeEndpoint(t *testing.T) {
	cases := []struct {
		config types.ProviderConfig
		want   string
	}{
		{types.ProviderConfig{Type: types.KindAnthropic}, "https://api.anthropic.com/v1/messages"},
		{types.ProviderConfig{Type: types.KindOpenAIChat, BaseURL: "https://api.deepseek.com/v1/"}, "https://api.deepseek.com/v1/chat/completions"},
		{types.ProviderConfig{Type: types.KindOpenAIResponses}, "https://api.openai.com/v1/responses"},
		{types.ProviderConfig{Type: types.KindCLITmux, CLICommand: "codex"}, "tmux:codex"},
	}
	for _, testCase := range cases {
		if got := DescribeEndpoint(&testCase.config); got != testCase.want {
			t.Fatalf("endpoint for %s: got %s want %s", testCase.config.Type, got, testCase.want)
		}
	}
}
