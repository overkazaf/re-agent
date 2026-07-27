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
