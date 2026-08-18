// Package config loads agent.config.json (merged over the built-in defaults)
// and the small UI preference file that keeps /theme and /flow across restarts.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// Defaults mirrors the TypeScript defaults exactly, so both implementations
// route the same way out of the box.
func Defaults() *types.AgentConfig {
	return &types.AgentConfig{
		Name:               "0xAF-Re",
		PlannerProvider:    "codex",
		ExecutorProvider:   "claude",
		ResearcherProvider: "codex",
		DefaultRole:        types.RoleAuto,
		MaxTurns:           8,
		Providers: map[string]*types.ProviderConfig{
			"codex": {
				Type:       types.KindCLITmux,
				Label:      "Codex CLI tmux",
				Model:      "codex-cli",
				CLICommand: "codex",
				CLIArgs: []string{
					"exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
					"--output-last-message", "{output}", "-",
				},
				CLITimeoutMs: 10 * 60_000,
				CLIUnsetEnv:  []string{"OPENAI_API_KEY"},
			},
			"claude": {
				Type:       types.KindCLITmux,
				Label:      "Claude Code tmux",
				Model:      "claude-code-cli",
				CLICommand: "claude",
				CLIArgs: []string{
					"-p", "--output-format", "stream-json", "--verbose",
					"--include-partial-messages", "--permission-mode", "default",
				},
				CLITimeoutMs:     10 * 60_000,
				CLIUnsetEnv:      []string{"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"},
				CLIResumeSession: true,
			},
			"codex-api": {
				Type:            types.KindOpenAIResponses,
				Label:           "Codex API",
				Model:           "gpt-5.3-codex",
				BaseURL:         "https://api.openai.com/v1",
				APIKeyEnv:       []string{"OPENAI_API_KEY", "OPENAI_CODEX_OAUTH_TOKEN"},
				ReasoningEffort: "high",
			},
			"claude-api": {
				Type:      types.KindAnthropic,
				Label:     "Claude API Opus 4.8",
				Model:     "claude-opus-4-8",
				BaseURL:   "https://api.anthropic.com",
				APIKeyEnv: []string{"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"},
				MaxTokens: 8192,
			},
			"grok": {
				Type:            types.KindOpenAIResponses,
				Label:           "Grok Build 4.5",
				Model:           "grok-4.5",
				BaseURL:         "https://api.x.ai/v1",
				APIKeyEnv:       []string{"XAI_API_KEY"},
				ReasoningEffort: "high",
				MaxTokens:       8192,
			},
			"grok-cli": {
				Type:       types.KindCLITmux,
				Label:      "Grok Build CLI tmux",
				Model:      "grok-build-cli",
				CLICommand: "grok",
				CLIArgs: []string{
					"--prompt-file", "{prompt}", "--output-format", "plain",
					"--disable-web-search", "--no-memory", "--permission-mode", "dontAsk",
				},
				CLITimeoutMs:     10 * 60_000,
				CLIPromptMaxChar: 80_000,
				CLIResumeSession: true,
			},
			"deepseek": {
				Type:      types.KindOpenAIChat,
				Label:     "DeepSeek",
				Model:     "deepseek-chat",
				BaseURL:   "https://api.deepseek.com/v1",
				APIKeyEnv: []string{"DEEPSEEK_API_KEY"},
				MaxTokens: 8192,
			},
			"glm": {
				Type:      types.KindOpenAIChat,
				Label:     "GLM / Z.AI",
				Model:     "glm-4.6",
				BaseURL:   "https://open.bigmodel.cn/api/paas/v4",
				APIKeyEnv: []string{"ZAI_API_KEY", "GLM_API_KEY"},
				MaxTokens: 8192,
			},
			"mock": {
				Type:  types.KindMock,
				Label: "Mock Provider",
				Model: "mock-reasoner",
			},
		},
	}
}

// Load merges the first config file that exists over the defaults. The returned
// path is empty when no file was found.
func Load(configPath string) (*types.AgentConfig, string, error) {
	cwd, _ := os.Getwd()
	home, _ := os.UserHomeDir()
	candidates := []string{
		configPath,
		filepath.Join(cwd, "agent.config.json"),
		filepath.Join(home, ".0xaf-re-agent", "config.json"),
	}
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		resolved, err := filepath.Abs(candidate)
		if err != nil || !util.FileExists(resolved) {
			continue
		}
		data, err := os.ReadFile(resolved)
		if err != nil {
			return nil, "", err
		}
		var overlay types.AgentConfig
		if err := json.Unmarshal(data, &overlay); err != nil {
			return nil, "", fmt.Errorf("%s: %w", resolved, err)
		}
		return merge(Defaults(), &overlay), resolved, nil
	}
	return Defaults(), "", nil
}

func merge(base, next *types.AgentConfig) *types.AgentConfig {
	out := *base
	if next.Name != "" {
		out.Name = next.Name
	}
	if next.PlannerProvider != "" {
		out.PlannerProvider = next.PlannerProvider
	}
	if next.ExecutorProvider != "" {
		out.ExecutorProvider = next.ExecutorProvider
	}
	if next.ResearcherProvider != "" {
		out.ResearcherProvider = next.ResearcherProvider
	}
	if next.KnowledgeProvider != "" {
		out.KnowledgeProvider = next.KnowledgeProvider
	}
	if next.DefaultRole != "" {
		out.DefaultRole = next.DefaultRole
	}
	if next.MaxTurns != 0 {
		out.MaxTurns = next.MaxTurns
	}

	providers := map[string]*types.ProviderConfig{}
	for name, provider := range base.Providers {
		clone := *provider
		providers[name] = &clone
	}
	// A partial provider block overlays the default one field by field, which is
	// what lets a config change only `model` or only `apiKey`.
	for name, provider := range next.Providers {
		if existing, ok := providers[name]; ok {
			providers[name] = mergeProvider(existing, provider)
		} else {
			clone := *provider
			providers[name] = &clone
		}
	}
	out.Providers = providers

	servers := map[string]*types.MCPServerConfig{}
	for name, server := range base.MCPServers {
		servers[name] = server
	}
	for name, server := range next.MCPServers {
		servers[name] = server
	}
	if len(servers) > 0 {
		out.MCPServers = servers
	}
	return &out
}

func mergeProvider(base, next *types.ProviderConfig) *types.ProviderConfig {
	out := *base
	if next.Type != "" {
		out.Type = next.Type
	}
	if next.Label != "" {
		out.Label = next.Label
	}
	if next.Model != "" {
		out.Model = next.Model
	}
	if next.BaseURL != "" {
		out.BaseURL = next.BaseURL
	}
	if next.APIKey != "" {
		out.APIKey = next.APIKey
	}
	if next.APIKeyEnv != nil {
		out.APIKeyEnv = next.APIKeyEnv
	}
	if next.AuthScheme != "" {
		out.AuthScheme = next.AuthScheme
	}
	if next.CLICommand != "" {
		out.CLICommand = next.CLICommand
	}
	if next.CLIArgs != nil {
		out.CLIArgs = next.CLIArgs
	}
	if next.CLITimeoutMs != 0 {
		out.CLITimeoutMs = next.CLITimeoutMs
	}
	if next.CLIPromptMaxChar != 0 {
		out.CLIPromptMaxChar = next.CLIPromptMaxChar
	}
	if next.CLIFallbackDirec != nil {
		out.CLIFallbackDirec = next.CLIFallbackDirec
	}
	if next.CLIUnsetEnv != nil {
		out.CLIUnsetEnv = next.CLIUnsetEnv
	}
	if next.CLIResumeSession {
		out.CLIResumeSession = true
	}
	if next.CLISessionIDArg != "" {
		out.CLISessionIDArg = next.CLISessionIDArg
	}
	if next.CLIResumeArg != "" {
		out.CLIResumeArg = next.CLIResumeArg
	}
	if next.CLIStream != nil {
		out.CLIStream = next.CLIStream
	}
	if next.MaxTokens != 0 {
		out.MaxTokens = next.MaxTokens
	}
	if next.ContextBudgetTokens != 0 {
		out.ContextBudgetTokens = next.ContextBudgetTokens
	}
	if next.MockScript != nil {
		out.MockScript = next.MockScript
	}
	if next.ReasoningEffort != "" {
		out.ReasoningEffort = next.ReasoningEffort
	}
	if next.Headers != nil {
		out.Headers = next.Headers
	}
	return &out
}

// --- UI preferences ----------------------------------------------------------

type UIPrefs struct {
	Theme string `json:"theme,omitempty"`
	// Flow is the visualization mode for a turn: full | flow | trace | off.
	Flow string `json:"flow,omitempty"`
}

func prefsFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".0xaf-re-agent", "ui.json")
}

func LoadUIPrefs() UIPrefs {
	data, err := os.ReadFile(prefsFile())
	if err != nil {
		return UIPrefs{}
	}
	var prefs UIPrefs
	if err := json.Unmarshal(data, &prefs); err != nil {
		return UIPrefs{}
	}
	return prefs
}

// SaveUIPrefs merges into whatever is already stored, so saving one preference
// keeps the rest. Persistence is best-effort; never break a session over it.
func SaveUIPrefs(next UIPrefs) {
	merged := LoadUIPrefs()
	if next.Theme != "" {
		merged.Theme = next.Theme
	}
	if next.Flow != "" {
		merged.Flow = next.Flow
	}
	file := prefsFile()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(file, append(data, '\n'), 0o644)
}

// SetReasoningEffort applies an effort level to a provider. HTTP providers carry
// it in the request body; CLI providers take it through their own argv, which
// differs per tool, so the stored args are rewritten in place.
func SetReasoningEffort(provider *types.ProviderConfig, effort types.ReasoningEffort) {
	provider.ReasoningEffort = effort
	if provider.Type != types.KindCLITmux {
		return
	}
	args := append([]string{}, provider.CLIArgs...)

	if provider.CLICommand == "claude" {
		index := indexOf(args, "--effort")
		if index >= 0 && index+1 < len(args) {
			args[index+1] = string(effort)
		} else {
			args = append([]string{"--effort", string(effort)}, args...)
		}
		provider.CLIArgs = args
		return
	}

	if provider.CLICommand == "codex" {
		setting := "model_reasoning_effort=" + string(effort)
		index := -1
		for i, arg := range args {
			if strings.HasPrefix(arg, "model_reasoning_effort=") {
				index = i
				break
			}
		}
		if index >= 0 {
			args[index] = setting
		} else {
			// `-c key=value` must precede the `exec` subcommand's operands.
			at := 0
			if anchor := indexOf(args, "exec"); anchor >= 0 {
				at = anchor + 1
			}
			args = append(args[:at], append([]string{"-c", setting}, args[at:]...)...)
		}
		provider.CLIArgs = args
	}
}

type ModelChange struct {
	PassedToCLI bool
	Detail      string
}

// ValidateProviderModel catches the common mistake of assigning a model from
// one backend family to another provider, e.g. `/model executor glm-5.2` while
// the executor is still `claude`.
func ValidateProviderModel(providerName string, provider *types.ProviderConfig, model string) error {
	if provider == nil {
		return nil
	}
	model = strings.TrimSpace(model)
	modelFamily := knownModelFamily(model)
	if modelFamily == "" {
		return nil
	}
	providerFamily := providerModelFamily(providerName, provider)
	if providerFamily == "" || providerFamily == modelFamily {
		return nil
	}
	return fmt.Errorf(
		"model %q looks like a %s model, but provider %q is %s; switch to %s or choose a %s-compatible model",
		model, familyLabel(modelFamily), providerName, familyLabel(providerFamily),
		familyRouteHint(modelFamily), familyLabel(providerFamily),
	)
}

// SetProviderModel applies a session-local model override. HTTP providers carry
// the model in their request body. CLI providers need argv help: custom CLI
// configs can use {model}, and the built-in codex/claude routes get a --model
// flag inserted when the operator explicitly switches model.
func SetProviderModel(provider *types.ProviderConfig, model string) ModelChange {
	model = strings.TrimSpace(model)
	provider.Model = model
	if provider.Type != types.KindCLITmux {
		return ModelChange{Detail: "request body"}
	}
	args := append([]string{}, provider.CLIArgs...)
	if hasModelPlaceholder(args) {
		provider.CLIArgs = args
		return ModelChange{PassedToCLI: true, Detail: "via {model} placeholder"}
	}
	if updated, ok := updatedModelFlag(args, model); ok {
		provider.CLIArgs = updated
		return ModelChange{PassedToCLI: true, Detail: "via existing --model flag"}
	}
	switch provider.CLICommand {
	case "claude":
		provider.CLIArgs = append([]string{"--model", model}, args...)
		return ModelChange{PassedToCLI: true, Detail: "via claude --model"}
	case "codex":
		at := 0
		if anchor := indexOf(args, "exec"); anchor >= 0 {
			at = anchor + 1
		}
		provider.CLIArgs = append(args[:at], append([]string{"--model", model}, args[at:]...)...)
		return ModelChange{PassedToCLI: true, Detail: "via codex exec --model"}
	default:
		provider.CLIArgs = args
		return ModelChange{Detail: "model recorded; add {model} or --model to cliArgs to pass it to this CLI"}
	}
}

func hasModelPlaceholder(args []string) bool {
	for _, arg := range args {
		if strings.Contains(arg, "{model}") {
			return true
		}
	}
	return false
}

func updatedModelFlag(args []string, model string) ([]string, bool) {
	for i, arg := range args {
		switch {
		case arg == "--model" || arg == "-m":
			if i+1 < len(args) {
				args[i+1] = model
			} else {
				args = append(args, model)
			}
			return args, true
		case strings.HasPrefix(arg, "--model="):
			args[i] = "--model=" + model
			return args, true
		case strings.HasPrefix(arg, "-m="):
			args[i] = "-m=" + model
			return args, true
		}
	}
	return args, false
}

func providerModelFamily(providerName string, provider *types.ProviderConfig) string {
	name := strings.ToLower(strings.TrimSpace(providerName))
	switch {
	case name == "claude" || strings.HasPrefix(name, "claude-"):
		return "claude"
	case name == "codex" || strings.HasPrefix(name, "codex-"):
		return "openai"
	case name == "glm" || strings.HasPrefix(name, "glm-"):
		return "glm"
	case name == "deepseek" || strings.HasPrefix(name, "deepseek-"):
		return "deepseek"
	case name == "grok" || strings.HasPrefix(name, "grok-"):
		return "grok"
	}
	switch strings.ToLower(strings.TrimSpace(provider.CLICommand)) {
	case "claude":
		return "claude"
	case "codex":
		return "openai"
	case "grok":
		return "grok"
	}
	switch provider.Type {
	case types.KindAnthropic:
		return "claude"
	}
	base := strings.ToLower(provider.BaseURL)
	switch {
	case strings.Contains(base, "anthropic"):
		return "claude"
	case strings.Contains(base, "bigmodel") || strings.Contains(base, "z.ai"):
		return "glm"
	case strings.Contains(base, "deepseek"):
		return "deepseek"
	case strings.Contains(base, "x.ai"):
		return "grok"
	case strings.Contains(base, "openai"):
		return "openai"
	}
	return ""
}

func knownModelFamily(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	switch {
	case model == "":
		return ""
	case strings.HasPrefix(model, "claude") || strings.Contains(model, "sonnet") ||
		strings.Contains(model, "opus") || strings.Contains(model, "haiku"):
		return "claude"
	case strings.HasPrefix(model, "glm-") || strings.HasPrefix(model, "glm_"):
		return "glm"
	case strings.HasPrefix(model, "deepseek"):
		return "deepseek"
	case strings.HasPrefix(model, "grok"):
		return "grok"
	case strings.HasPrefix(model, "gpt-") || strings.HasPrefix(model, "o1") ||
		strings.HasPrefix(model, "o3") || strings.HasPrefix(model, "o4") ||
		strings.HasPrefix(model, "o5") || strings.Contains(model, "codex"):
		return "openai"
	case strings.HasPrefix(model, "gemini"):
		return "gemini"
	case strings.HasPrefix(model, "qwen"):
		return "qwen"
	case strings.HasPrefix(model, "llama"):
		return "llama"
	case strings.HasPrefix(model, "mistral"):
		return "mistral"
	}
	return ""
}

func familyLabel(family string) string {
	switch family {
	case "openai":
		return "OpenAI/Codex"
	case "claude":
		return "Claude"
	case "glm":
		return "GLM"
	case "deepseek":
		return "DeepSeek"
	case "grok":
		return "Grok"
	case "gemini":
		return "Gemini"
	case "qwen":
		return "Qwen"
	case "llama":
		return "Llama"
	case "mistral":
		return "Mistral"
	default:
		return family
	}
}

func familyRouteHint(family string) string {
	switch family {
	case "openai":
		return "a Codex/OpenAI provider such as codex or codex-api"
	case "claude":
		return "a Claude provider such as claude or claude-api"
	case "glm":
		return "/executor glm"
	case "deepseek":
		return "/executor deepseek"
	case "grok":
		return "/executor grok"
	default:
		return "a matching provider"
	}
}

func indexOf(list []string, value string) int {
	for i, item := range list {
		if item == value {
			return i
		}
	}
	return -1
}

// ResolveAPIKey checks the config first, then the provider's env var list.
func ResolveAPIKey(provider *types.ProviderConfig) string {
	if key := strings.TrimSpace(provider.APIKey); key != "" {
		return key
	}
	for _, name := range provider.APIKeyEnv {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}
