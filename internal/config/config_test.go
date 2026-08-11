package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestLoadMergesOverDefaults(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "agent.config.json")
	body := `{
	  "plannerProvider": "deepseek",
	  "researcherProvider": "deepseek",
	  "providers": {
	    "deepseek": { "model": "deepseek-reasoner" },
	    "local": { "type": "openai-chat", "model": "llama", "baseUrl": "http://localhost:1234/v1" }
	  }
	}`
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	config, path, err := Load(file)
	if err != nil {
		t.Fatal(err)
	}
	if path != file {
		t.Fatalf("config path wrong: %s", path)
	}
	if config.PlannerProvider != "deepseek" || config.ExecutorProvider != "claude" {
		t.Fatalf("merge wrong: planner=%s executor=%s", config.PlannerProvider, config.ExecutorProvider)
	}
	if config.ResearcherProvider != "deepseek" {
		t.Fatalf("researcher provider not merged: %s", config.ResearcherProvider)
	}
	// A partial provider block overlays the default field by field.
	deepseek := config.Providers["deepseek"]
	if deepseek.Model != "deepseek-reasoner" || deepseek.BaseURL != "https://api.deepseek.com/v1" {
		t.Fatalf("partial provider merge wrong: %+v", deepseek)
	}
	if config.Providers["local"].Model != "llama" {
		t.Fatal("a new provider should be added")
	}
	if config.MaxTurns != 8 {
		t.Fatalf("defaults lost: maxTurns=%d", config.MaxTurns)
	}
}

func TestLoadWithoutAFileUsesDefaults(t *testing.T) {
	config, path, err := Load(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if path != "" || config.Name != "0xAF-Re" {
		t.Fatalf("unexpected fallback: path=%q name=%s", path, config.Name)
	}
}

func TestSetReasoningEffortRewritesCLIArgs(t *testing.T) {
	codex := &types.ProviderConfig{
		Type: types.KindCLITmux, CLICommand: "codex",
		CLIArgs: []string{"exec", "--json", "-"},
	}
	SetReasoningEffort(codex, "high")
	joined := strings.Join(codex.CLIArgs, " ")
	if !strings.Contains(joined, "-c model_reasoning_effort=high") {
		t.Fatalf("codex effort not applied: %v", codex.CLIArgs)
	}
	if codex.CLIArgs[0] != "exec" {
		t.Fatalf("`-c` must follow the exec subcommand: %v", codex.CLIArgs)
	}
	SetReasoningEffort(codex, "low")
	if strings.Count(strings.Join(codex.CLIArgs, " "), "model_reasoning_effort") != 1 {
		t.Fatalf("effort should be replaced, not appended: %v", codex.CLIArgs)
	}

	claude := &types.ProviderConfig{Type: types.KindCLITmux, CLICommand: "claude", CLIArgs: []string{"-p"}}
	SetReasoningEffort(claude, "xhigh")
	if claude.CLIArgs[0] != "--effort" || claude.CLIArgs[1] != "xhigh" {
		t.Fatalf("claude effort not applied: %v", claude.CLIArgs)
	}

	api := &types.ProviderConfig{Type: types.KindOpenAIResponses}
	SetReasoningEffort(api, "high")
	if api.ReasoningEffort != "high" || len(api.CLIArgs) != 0 {
		t.Fatalf("HTTP providers carry effort in the body: %+v", api)
	}
}

func TestSetProviderModelRewritesKnownCLIArgs(t *testing.T) {
	codex := &types.ProviderConfig{
		Type: types.KindCLITmux, CLICommand: "codex",
		CLIArgs: []string{"exec", "--json", "-"},
	}
	change := SetProviderModel(codex, "gpt-5.3-codex-high")
	if !change.PassedToCLI || codex.Model != "gpt-5.3-codex-high" {
		t.Fatalf("codex model not applied: change=%+v provider=%+v", change, codex)
	}
	joined := strings.Join(codex.CLIArgs, " ")
	if !strings.Contains(joined, "exec --model gpt-5.3-codex-high --json") {
		t.Fatalf("codex --model should sit after exec: %v", codex.CLIArgs)
	}

	claude := &types.ProviderConfig{Type: types.KindCLITmux, CLICommand: "claude", CLIArgs: []string{"-p"}}
	change = SetProviderModel(claude, "opus")
	if !change.PassedToCLI || claude.CLIArgs[0] != "--model" || claude.CLIArgs[1] != "opus" {
		t.Fatalf("claude model not applied: change=%+v args=%v", change, claude.CLIArgs)
	}
	SetProviderModel(claude, "sonnet")
	if strings.Count(strings.Join(claude.CLIArgs, " "), "--model") != 1 || claude.CLIArgs[1] != "sonnet" {
		t.Fatalf("existing model flag should be replaced: %v", claude.CLIArgs)
	}
}

func TestSetProviderModelSupportsPlaceholderAndHTTP(t *testing.T) {
	cli := &types.ProviderConfig{
		Type: types.KindCLITmux, CLICommand: "custom",
		CLIArgs: []string{"run", "--model", "{model}"},
	}
	change := SetProviderModel(cli, "local-re")
	if !change.PassedToCLI || cli.Model != "local-re" || cli.CLIArgs[2] != "{model}" {
		t.Fatalf("placeholder CLI should record model without rewriting args: change=%+v args=%v", change, cli.CLIArgs)
	}

	api := &types.ProviderConfig{Type: types.KindOpenAIChat, Model: "old"}
	change = SetProviderModel(api, "new")
	if change.PassedToCLI || change.Detail != "request body" || api.Model != "new" {
		t.Fatalf("HTTP model should only change config: change=%+v provider=%+v", change, api)
	}
}

func TestValidateProviderModelRejectsWrongFamily(t *testing.T) {
	defaults := Defaults()
	if err := ValidateProviderModel("claude", defaults.Providers["claude"], "glm-5.2"); err == nil {
		t.Fatal("GLM model should not be accepted by the Claude CLI provider")
	} else if !strings.Contains(err.Error(), "/executor glm") {
		t.Fatalf("error should point at the matching provider: %v", err)
	}

	if err := ValidateProviderModel("claude", defaults.Providers["claude"], "sonnet"); err != nil {
		t.Fatalf("Claude model alias should be allowed: %v", err)
	}
	if err := ValidateProviderModel("glm", defaults.Providers["glm"], "glm-5.2"); err != nil {
		t.Fatalf("GLM model should be allowed on GLM provider: %v", err)
	}

	local := &types.ProviderConfig{Type: types.KindOpenAIChat, Model: "llama", BaseURL: "http://localhost:1234/v1"}
	if err := ValidateProviderModel("local", local, "qwen-max"); err != nil {
		t.Fatalf("custom OpenAI-compatible providers should not be over-classified: %v", err)
	}
}

func TestResolveAPIKeyPrefersConfigThenEnv(t *testing.T) {
	provider := &types.ProviderConfig{APIKeyEnv: []string{"TEST_0XAF_KEY"}}
	t.Setenv("TEST_0XAF_KEY", "from-env")
	if got := ResolveAPIKey(provider); got != "from-env" {
		t.Fatalf("env key not used: %q", got)
	}
	provider.APIKey = "  from-config  "
	if got := ResolveAPIKey(provider); got != "from-config" {
		t.Fatalf("config key should win and be trimmed: %q", got)
	}
}
