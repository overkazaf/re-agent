package workflow

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestEffectiveFallsBackToCavemanWithoutSpecialistProvider(t *testing.T) {
	config := &types.AgentConfig{
		PlannerProvider:  "codex",
		ExecutorProvider: "claude",
		Providers: map[string]*types.ProviderConfig{
			"codex":  {Model: "codex-cli", Label: "Codex CLI"},
			"claude": {Model: "claude-code-cli", Label: "Claude Code"},
		},
	}
	if got := Effective(Auto, config, ""); got != Caveman {
		t.Fatalf("auto should fall back to caveman, got %s", got)
	}
}

func TestEffectiveDefaultsToOff(t *testing.T) {
	config := &types.AgentConfig{
		PlannerProvider: "gpt-cyber",
		Providers: map[string]*types.ProviderConfig{
			"gpt-cyber": {Model: "gpt-cyber-reasoner", Label: "GPT Cyber"},
		},
	}
	if got := Effective("", config, ""); got != Off {
		t.Fatalf("empty workflow should be off, got %s", got)
	}
	if got := WrapPrompt("reverse ./chall", "", config, ""); got != "reverse ./chall" {
		t.Fatalf("empty workflow should not wrap prompt:\n%s", got)
	}
}

func TestEffectiveSelectsSpecialistForCyberOrCVPProvider(t *testing.T) {
	config := &types.AgentConfig{
		PlannerProvider:  "gpt-cyber",
		ExecutorProvider: "cc",
		Providers: map[string]*types.ProviderConfig{
			"gpt-cyber": {Model: "gpt-cyber-reasoner", Label: "GPT Cyber"},
			"cc":        {Model: "claude-code-cvp", Label: "CC CVP"},
		},
	}
	if got := Effective(Auto, config, ""); got != Specialist {
		t.Fatalf("auto should select specialist, got %s", got)
	}
	if got := Effective(Auto, config, "cc"); got != Specialist {
		t.Fatalf("pinned CVP provider should select specialist, got %s", got)
	}
}

func TestWrapCavemanForbidsPromptLaundering(t *testing.T) {
	wrapped := WrapPrompt("reverse ./chall", Caveman, nil, "")
	for _, want := range []string{"workflow mode: caveman", "Do not use translation", "prompt laundering", "Original user task:"} {
		if !strings.Contains(wrapped, want) {
			t.Fatalf("wrapped prompt missing %q:\n%s", want, wrapped)
		}
	}
}

func TestWrapSpecialistPlansThenExecutes(t *testing.T) {
	wrapped := WrapPrompt("analyze app.apk", Specialist, nil, "")
	for _, want := range []string{"workflow mode: specialist", "Publish a 3-7 step plan", "reverse_toolkit", "Original user task:"} {
		if !strings.Contains(wrapped, want) {
			t.Fatalf("wrapped prompt missing %q:\n%s", want, wrapped)
		}
	}
}

func TestNewWorkflowModesWrapPrompt(t *testing.T) {
	cases := []struct {
		mode   Mode
		marker string
	}{
		{Research, "workflow mode: research"},
		{Writeup, "workflow mode: writeup"},
		{CTF, "workflow mode: ctf"},
		{Reverse, "workflow mode: reverse"},
		{Engineering, "workflow mode: engineering"},
	}
	for _, tc := range cases {
		wrapped := WrapPrompt("task", tc.mode, nil, "")
		if !strings.Contains(wrapped, tc.marker) || !strings.Contains(wrapped, "Original user task:") {
			t.Fatalf("mode %s missing %q:\n%s", tc.mode, tc.marker, wrapped)
		}
	}
}

func TestNewWorkflowModesPassThroughAndList(t *testing.T) {
	for _, mode := range []Mode{Research, Writeup, CTF, Reverse, Engineering} {
		if !IsMode(string(mode)) {
			t.Fatalf("mode %s missing from IsMode", mode)
		}
		if got := Effective(mode, nil, ""); got != mode {
			t.Fatalf("effective %s should pass through, got %s", mode, got)
		}
	}
	list := List()
	for _, mode := range []Mode{Research, Writeup, CTF, Reverse, Engineering} {
		if !strings.Contains(list, string(mode)) {
			t.Fatalf("List missing %s: %s", mode, list)
		}
	}
}

func TestShouldDelegateOnlyForImplicitCavemanRoute(t *testing.T) {
	config := &types.AgentConfig{
		PlannerProvider:  "codex",
		ExecutorProvider: "claude",
		Providers: map[string]*types.ProviderConfig{
			"codex":  {Model: "codex-cli"},
			"claude": {Model: "claude-code-cli"},
		},
	}
	if !ShouldDelegate(Caveman, config, "", types.RoleAuto) {
		t.Fatal("caveman auto route should delegate")
	}
	if !ShouldDelegate(Auto, config, "", types.RoleAuto) {
		t.Fatal("auto without specialist should delegate through caveman")
	}
	if ShouldDelegate(Caveman, config, "claude", types.RoleAuto) {
		t.Fatal("pinned provider should bypass delegation")
	}
	if ShouldDelegate(Caveman, config, "", types.RolePlanner) {
		t.Fatal("explicit role should bypass delegation")
	}
	config.Providers["codex"].Model = "gpt-cyber-reasoner"
	if ShouldDelegate(Auto, config, "", types.RoleAuto) {
		t.Fatal("specialist route should not use caveman delegation")
	}
}

func TestExtractExecutorPacketReadsFencedSection(t *testing.T) {
	text := strings.Join([]string{
		"PLAN:",
		"- inspect locally",
		"",
		"EXECUTOR_PACKET:",
		"```text",
		"Objective: collect local evidence about ./chall.",
		"Return: hashes and strings.",
		"```",
		"",
		"NOTES:",
		"- private planner notes",
	}, "\n")
	packet := ExtractExecutorPacket(text)
	if !strings.Contains(packet, "Objective: collect local evidence") {
		t.Fatalf("packet objective missing: %q", packet)
	}
	if strings.Contains(packet, "private planner notes") {
		t.Fatalf("packet extraction included following section: %q", packet)
	}
}

func TestDelegatedExecutorToolsAreReadOnlyLocalEvidenceTools(t *testing.T) {
	available := []types.Tool{
		{Name: "run_command", Risk: types.RiskExecute},
		{Name: "ctf_triage", Risk: types.RiskRead},
		{Name: "file_info", Description: "old", Risk: types.RiskRead},
		{Name: "strings", Risk: types.RiskRead},
		{Name: "reverse_toolkit", Risk: types.RiskExecute},
		{Name: "update_plan", Risk: types.RiskRead},
	}
	selected := DelegatedExecutorTools(available)
	names := map[string]bool{}
	for _, tool := range selected {
		names[tool.Name] = true
		if tool.Name == "file_info" && tool.Description == "old" {
			t.Fatal("selected tool description should be neutralized")
		}
	}
	for _, forbidden := range []string{"run_command", "ctf_triage", "reverse_toolkit"} {
		if names[forbidden] {
			t.Fatalf("delegated executor exposed %s", forbidden)
		}
	}
	for _, want := range []string{"file_info", "strings", "update_plan"} {
		if !names[want] {
			t.Fatalf("delegated executor did not expose %s", want)
		}
	}
}
