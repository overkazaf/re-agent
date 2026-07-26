// Package auth finds credentials for the HTTP providers (env files, a local
// secret store) and reports whether each provider — including the CLI-backed
// ones — is actually usable right now.
package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

type storedSecrets struct {
	Providers map[string]struct {
		APIKey string `json:"apiKey,omitempty"`
	} `json:"providers,omitempty"`
}

// State is how much the probe actually established. The distinction matters:
// `codex login status` and `claude auth status` verify a login, but some CLIs
// expose no such subcommand, and reporting "ready" for those would claim
// something this program never checked.
type State string

const (
	// StateReady: a credential is present, or the CLI reported a real login.
	StateReady State = "ready"
	// StatePresent: the CLI runs, but it offers no way to verify the login —
	// the first turn is what will find out.
	StatePresent State = "present"
	StateMissing State = "missing"
)

type Status struct {
	Provider string
	Label    string
	// Configured is true for anything that is worth routing to, which includes
	// StatePresent — see State for what was actually verified.
	Configured bool
	State      State
	Source     string
	EnvVars    []string
}

// stateFor maps a credential source onto what it proves.
func stateFor(source string) State {
	switch {
	case source == "missing", strings.HasSuffix(source, ":missing"),
		strings.HasSuffix(source, ":not-logged-in"), strings.Contains(source, ":status-"):
		return StateMissing
	case strings.HasSuffix(source, ":present"):
		return StatePresent
	case source == "mock", strings.HasSuffix(source, ":logged-in"):
		return StateReady
	case strings.HasPrefix(source, "cli:"):
		// A CLI we know nothing about: it is configured, not verified.
		return StatePresent
	}
	return StateReady
}

func authDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".0xaf-re-agent")
}

func SecretsFile() string { return filepath.Join(authDir(), "secrets.json") }

// InitializeSources loads .env files and applies stored secrets, in the order
// documented in the README: process env wins, then env files, then the store.
func InitializeSources(config *types.AgentConfig, workspace string) {
	loadEnvFiles(workspace)
	applyStoredSecrets(config)
}

func Login(config *types.AgentConfig, providerName, apiKey string) error {
	provider, ok := config.Providers[providerName]
	if !ok {
		return fmt.Errorf("unknown provider: %s", providerName)
	}
	trimmed := strings.TrimSpace(apiKey)
	if trimmed == "" {
		return fmt.Errorf("empty credential was not saved")
	}
	secrets := readSecrets()
	if secrets.Providers == nil {
		secrets.Providers = map[string]struct {
			APIKey string `json:"apiKey,omitempty"`
		}{}
	}
	secrets.Providers[providerName] = struct {
		APIKey string `json:"apiKey,omitempty"`
	}{APIKey: trimmed}
	if err := writeSecrets(secrets); err != nil {
		return err
	}
	provider.APIKey = trimmed
	return nil
}

func Logout(config *types.AgentConfig, providerName string) (bool, error) {
	secrets := readSecrets()
	if secrets.Providers == nil {
		return false, nil
	}
	if _, ok := secrets.Providers[providerName]; !ok {
		return false, nil
	}
	delete(secrets.Providers, providerName)
	if err := writeSecrets(secrets); err != nil {
		return false, err
	}
	if provider, ok := config.Providers[providerName]; ok {
		provider.APIKey = ""
	}
	return true, nil
}

// Statuses probes every configured provider. CLI providers are asked their own
// login status; HTTP providers report where their credential came from.
func Statuses(config *types.AgentConfig) []Status {
	secrets := readSecrets()
	names := make([]string, 0, len(config.Providers))
	for name := range config.Providers {
		names = append(names, name)
	}
	sortStrings(names)

	out := make([]Status, 0, len(names))
	for _, name := range names {
		provider := config.Providers[name]
		label := provider.Label
		if label == "" {
			label = string(provider.Type)
		}
		source := "mock"
		var envVars []string
		switch provider.Type {
		case types.KindMock:
		case types.KindCLITmux:
			source = cliCredentialSource(provider)
		default:
			source = credentialSource(name, provider, secrets)
			envVars = provider.APIKeyEnv
		}
		state := stateFor(source)
		out = append(out, Status{
			Provider: name, Label: label, State: state,
			Configured: state != StateMissing, Source: source, EnvVars: envVars,
		})
	}
	return out
}

func MissingCredentialHint(providerName string, provider *types.ProviderConfig) string {
	envs := strings.Join(provider.APIKeyEnv, ", ")
	if envs == "" {
		envs = "(none configured)"
	}
	lines := []string{
		fmt.Sprintf("Missing API key for provider '%s'.", providerName),
		"Set one of: " + envs,
		fmt.Sprintf("or run: 0xaf auth login %s", providerName),
		"Credential store: " + SecretsFile(),
	}
	if provider.Type == types.KindAnthropic || strings.Contains(strings.ToLower(providerName), "claude") {
		lines = append(lines,
			"For standalone Claude Code, run: claude auth login; verify with: claude auth status.",
			"Note: Claude Code app login is not automatically the same as an Anthropic API key unless it exports ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN.",
		)
	}
	return strings.Join(lines, " ")
}

func InvalidCredentialHint(providerName string, provider *types.ProviderConfig) string {
	envs := strings.Join(provider.APIKeyEnv, ", ")
	if envs == "" {
		envs = "(none configured)"
	}
	lines := []string{
		fmt.Sprintf("Invalid API key/token for provider '%s'.", providerName),
		"Current credential came from config/env/store; expected one of: " + envs,
		"Run: 0xaf auth status",
		fmt.Sprintf("If source=stored, run: 0xaf auth logout %s && 0xaf auth login %s", providerName, providerName),
		"Credential store: " + SecretsFile(),
	}
	if provider.Type == types.KindAnthropic || strings.Contains(strings.ToLower(providerName), "claude") {
		lines = append(lines,
			`If you are using an Anthropic OAuth/WIF token, set authScheme to "bearer" in agent.config.json.`,
			"For Claude Code subscription login, run: claude auth login; verify with: claude auth status.",
			"For this Anthropic API adapter, use ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN or auth login claude.",
		)
	}
	return strings.Join(lines, " ")
}

// --- internals ---------------------------------------------------------------

func loadEnvFiles(workspace string) {
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	candidates := []string{
		filepath.Join(workspace, ".env"),
		filepath.Join(cwd, ".env"),
		filepath.Join(authDir(), ".env"),
		filepath.Join(home, ".omp", "agent", ".env"),
		filepath.Join(home, ".env"),
	}
	for _, file := range candidates {
		data, ok := util.ReadTextIfExists(file)
		if !ok {
			continue
		}
		for key, value := range parseEnv(data) {
			if _, present := os.LookupEnv(key); !present {
				_ = os.Setenv(key, value)
			}
		}
	}
}

func applyStoredSecrets(config *types.AgentConfig) {
	secrets := readSecrets()
	for name, entry := range secrets.Providers {
		if strings.TrimSpace(entry.APIKey) == "" {
			continue
		}
		provider, ok := config.Providers[name]
		if !ok || strings.TrimSpace(provider.APIKey) != "" {
			continue
		}
		hasEnv := false
		for _, key := range provider.APIKeyEnv {
			if strings.TrimSpace(os.Getenv(key)) != "" {
				hasEnv = true
				break
			}
		}
		if !hasEnv {
			provider.APIKey = strings.TrimSpace(entry.APIKey)
		}
	}
}

func readSecrets() storedSecrets {
	data, err := os.ReadFile(SecretsFile())
	if err != nil {
		return storedSecrets{}
	}
	var secrets storedSecrets
	if err := json.Unmarshal(data, &secrets); err != nil {
		return storedSecrets{}
	}
	return secrets
}

func writeSecrets(secrets storedSecrets) error {
	if err := os.MkdirAll(authDir(), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(secrets, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(SecretsFile(), append(data, '\n'), 0o600)
}

func credentialSource(providerName string, provider *types.ProviderConfig, secrets storedSecrets) string {
	if strings.TrimSpace(provider.APIKey) != "" {
		return "config/runtime"
	}
	for _, key := range provider.APIKeyEnv {
		if strings.TrimSpace(os.Getenv(key)) != "" {
			return "env:" + key
		}
	}
	if entry, ok := secrets.Providers[providerName]; ok && strings.TrimSpace(entry.APIKey) != "" {
		return "stored"
	}
	return "missing"
}

func cliCredentialSource(provider *types.ProviderConfig) string {
	command := provider.CLICommand
	if command == "" {
		return "cli:missing-command"
	}
	args, ok := CLIAuthStatusArgs(command)
	if !ok {
		return "cli:" + command
	}
	result := RunCLIStatus(command, args, provider.CLIUnsetEnv)
	if result.OK {
		if !verifiesLogin(command) {
			// All this proved is that the binary runs.
			return fmt.Sprintf("cli:%s:present", command)
		}
		return fmt.Sprintf("cli:%s:logged-in", command)
	}
	if result.MissingCommand {
		return fmt.Sprintf("cli:%s:missing", command)
	}
	text := strings.ToLower(result.Stdout + "\n" + result.Stderr)
	if strings.Contains(text, "not logged in") || strings.Contains(text, "not authenticated") || strings.Contains(text, "login") {
		return fmt.Sprintf("cli:%s:not-logged-in", command)
	}
	return fmt.Sprintf("cli:%s:status-%d", command, result.Status)
}

// CLIAuthStatusArgs is the cheapest invocation that says something useful about
// a known CLI. For claude and codex that is a real login check; for grok there
// is no such subcommand, so the best available probe only proves the binary
// runs — see verifiesLogin.
func CLIAuthStatusArgs(command string) ([]string, bool) {
	switch command {
	case "claude":
		return []string{"auth", "status", "--text"}, true
	case "codex":
		return []string{"login", "status"}, true
	case "grok":
		return []string{"version"}, true
	}
	return nil, false
}

// verifiesLogin reports whether CLIAuthStatusArgs actually checks a login for
// this CLI, rather than merely proving the binary exists.
func verifiesLogin(command string) bool {
	return command == "claude" || command == "codex"
}

type CLIStatusResult struct {
	OK             bool
	Status         int
	Stdout         string
	Stderr         string
	MissingCommand bool
}

func RunCLIStatus(command string, args []string, unsetEnv []string) CLIStatusResult {
	binary, err := exec.LookPath(command)
	if err != nil {
		return CLIStatusResult{Status: 127, Stderr: err.Error(), MissingCommand: true}
	}
	cmd := exec.Command(binary, args...)
	cmd.Env = FilteredEnv(unsetEnv)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return CLIStatusResult{Status: 127, Stderr: err.Error()}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		status := 0
		if err != nil {
			status = 1
			var exitErr *exec.ExitError
			if ok := asExit(err, &exitErr); ok {
				status = exitErr.ExitCode()
			}
		}
		return CLIStatusResult{OK: status == 0, Status: status, Stdout: stdout.String(), Stderr: stderr.String()}
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		return CLIStatusResult{Status: 124, Stdout: stdout.String(), Stderr: stderr.String()}
	}
}

func asExit(err error, target **exec.ExitError) bool {
	for err != nil {
		if typed, ok := err.(*exec.ExitError); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

// FilteredEnv is the process environment with the named variables removed, so a
// stale API key cannot override a CLI's own login.
func FilteredEnv(unset []string) []string {
	skip := map[string]bool{}
	for _, key := range unset {
		skip[key] = true
	}
	var out []string
	for _, entry := range os.Environ() {
		name := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			name = entry[:index]
		}
		if skip[name] {
			continue
		}
		out = append(out, entry)
	}
	return out
}

var envLineRE = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$`)

func parseEnv(text string) map[string]string {
	out := map[string]string{}
	for _, rawLine := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		match := envLineRE.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		value := strings.TrimSpace(match[2])
		if len(value) >= 2 {
			if (strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) ||
				(strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'")) {
				value = value[1 : len(value)-1]
			}
		}
		if !strings.ContainsRune(value, 0) {
			out[match[1]] = value
		}
	}
	return out
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
