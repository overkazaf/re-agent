package auth

import (
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

// The boot screen used to print "● ready" for any CLI whose probe exited 0 —
// including `grok version`, which proves only that the binary exists. Claiming a
// verified login the program never checked is the bug this pins.
func TestStateForDistinguishesVerifiedFromPresent(t *testing.T) {
	cases := map[string]State{
		"cli:claude:logged-in":     StateReady,
		"cli:codex:logged-in":      StateReady,
		"cli:grok:present":         StatePresent,
		"cli:somenewcli":           StatePresent,
		"cli:claude:not-logged-in": StateMissing,
		"cli:codex:missing":        StateMissing,
		"cli:claude:status-1":      StateMissing,
		"missing":                  StateMissing,
		"mock":                     StateReady,
		"env:ANTHROPIC_API_KEY":    StateReady,
		"config/runtime":           StateReady,
		"stored":                   StateReady,
	}
	for source, want := range cases {
		if got := stateFor(source); got != want {
			t.Fatalf("source %q → %s, want %s", source, got, want)
		}
	}
}

// Only the CLIs with a real login subcommand may claim a verified login.
func TestVerifiesLoginOnlyWhereTheProbeChecksALogin(t *testing.T) {
	for command, want := range map[string]bool{
		"claude": true, "codex": true, "grok": false, "unknown": false,
	} {
		if got := verifiesLogin(command); got != want {
			t.Fatalf("verifiesLogin(%q) = %v, want %v", command, got, want)
		}
		if args, ok := CLIAuthStatusArgs(command); ok && len(args) == 0 {
			t.Fatalf("%s claims a probe but supplies no arguments", command)
		}
	}
}

// stateFor being right is not enough — Statuses has to actually set the field.
// It once did not, and every provider silently rendered as "missing".
func TestStatusesPopulatesStateAndConfigured(t *testing.T) {
	t.Setenv("TEST_0XAF_STATUS_KEY", "sk-not-a-real-key")
	config := &types.AgentConfig{Providers: map[string]*types.ProviderConfig{
		"mock":    {Type: types.KindMock, Model: "mock"},
		"withkey": {Type: types.KindOpenAIChat, Model: "m", APIKeyEnv: []string{"TEST_0XAF_STATUS_KEY"}},
		"nokey":   {Type: types.KindAnthropic, Model: "m", APIKeyEnv: []string{"TEST_0XAF_ABSENT_KEY"}},
	}}

	byName := map[string]Status{}
	for _, status := range Statuses(config) {
		if status.State == "" {
			t.Fatalf("%s has no state at all: %+v", status.Provider, status)
		}
		byName[status.Provider] = status
	}
	if len(byName) != 3 {
		t.Fatalf("expected three providers, got %d", len(byName))
	}
	if byName["mock"].State != StateReady || !byName["mock"].Configured {
		t.Fatalf("mock should be ready: %+v", byName["mock"])
	}
	if byName["withkey"].State != StateReady || byName["withkey"].Source != "env:TEST_0XAF_STATUS_KEY" {
		t.Fatalf("an env credential should read as ready: %+v", byName["withkey"])
	}
	if byName["nokey"].State != StateMissing || byName["nokey"].Configured {
		t.Fatalf("no credential should read as missing: %+v", byName["nokey"])
	}
	// The env column is only meaningful for the HTTP providers.
	if len(byName["withkey"].EnvVars) != 1 || byName["mock"].EnvVars != nil {
		t.Fatalf("env vars reported for the wrong providers: %+v / %+v",
			byName["withkey"].EnvVars, byName["mock"].EnvVars)
	}
}

func TestParseEnvHandlesQuotesAndComments(t *testing.T) {
	vars := parseEnv("# comment\nA=1\nB = \"two\"\nC='three'\n\nBAD LINE\nD=\n")
	if vars["A"] != "1" || vars["B"] != "two" || vars["C"] != "three" {
		t.Fatalf("unexpected parse: %+v", vars)
	}
	if _, present := vars["BAD"]; present {
		t.Fatalf("a line with no '=' must be skipped: %+v", vars)
	}
	if vars["D"] != "" {
		t.Fatalf("an empty value should stay empty: %q", vars["D"])
	}
}

// The CLI providers exist so a stale API key cannot override a working CLI
// login; FilteredEnv is what enforces that.
func TestFilteredEnvRemovesTheNamedVariables(t *testing.T) {
	t.Setenv("TEST_0XAF_KEEP", "keep")
	t.Setenv("TEST_0XAF_DROP", "drop")
	env := FilteredEnv([]string{"TEST_0XAF_DROP"})
	var sawKeep, sawDrop bool
	for _, entry := range env {
		if entry == "TEST_0XAF_KEEP=keep" {
			sawKeep = true
		}
		if entry == "TEST_0XAF_DROP=drop" {
			sawDrop = true
		}
	}
	if !sawKeep {
		t.Fatal("unrelated variables must survive")
	}
	if sawDrop {
		t.Fatal("the named variable must be removed")
	}
}
