package core

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/goal"
	"github.com/overkazaf/re-agent/internal/types"
)

func acceptedDeclaration() *goal.Declaration {
	return &goal.Declaration{
		RawGoal: "逆向 libshield.so 的请求签名",
		Target: goal.Target{
			File: "libshield.so", SHA256: "abcdef0123456789", Format: "ELF", Arch: "aarch64-64bit",
			Scope: "request signing only",
		},
		Objective: goal.Objective{
			Primary:      "recover_request_signing_behavior",
			Intent:       "harness reproduces the signature",
			Deliverables: []string{"candidate_algorithm", "reproducible_python_harness"},
			Constraints:  map[string]string{"network": "deny"},
			Acceptance: []goal.Criterion{
				{Kind: goal.KindBuildPass},
				{Kind: goal.KindReplayPass, Op: ">=", Value: 0.95},
			},
		},
		Accepted: true,
	}
}

func TestGoalSectionRidesTheSystemPrompt(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "m"},
		responses: []types.ProviderResponse{{Text: "ok"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	if section := loop.goalSection(); section != "" {
		t.Fatal("no declaration should mean no section")
	}
	loop.SetGoal(acceptedDeclaration())
	prompt := loop.systemPrompt(types.RoleAuto)
	for _, want := range []string{
		"## Task declaration",
		"recover_request_signing_behavior",
		"libshield.so",
		"sha256 abcdef012345…",
		"replay_pass >= 0.95",
		"host-checked",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestGoalSurvivesSessionRoundTrip(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "m"},
		responses: []types.ProviderResponse{{Text: "ok"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	loop.SetGoal(acceptedDeclaration())

	loaded, err := LoadSession(loop.options.Session.File)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Goal == nil || loaded.Goal.Objective.Primary != "recover_request_signing_behavior" {
		t.Fatalf("goal event did not persist: %+v", loaded.Goal)
	}

	fresh, _ := newTestLoop(t, &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "m"},
		responses: []types.ProviderResponse{{Text: "resumed"}},
	}, nil)
	if err := fresh.Restore(loaded); err != nil {
		t.Fatal(err)
	}
	if fresh.Goal() == nil || !fresh.Goal().Accepted {
		t.Fatal("restored loop lost the declaration")
	}
	if !strings.Contains(fresh.systemPrompt(types.RoleAuto), "## Task declaration") {
		t.Fatal("restored loop should carry the declaration in its prompt")
	}

	// Clearing records a null declaration, and a session loaded from that
	// point carries no goal.
	fresh.SetGoal(nil)
	reloaded, err := LoadSession(fresh.options.Session.File)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Goal != nil {
		t.Fatalf("clear should win on reload: %+v", reloaded.Goal)
	}
}

func TestGoalReportReadsTheLedger(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "m"},
		responses: []types.ProviderResponse{{Text: "ok"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	loop.SetGoal(acceptedDeclaration())
	if loop.GoalReport().AllPass() {
		t.Fatal("empty ledger should not satisfy replay_pass")
	}
	loop.evidence.Add(evidence.Input{
		Source: "verify_artifact", Kind: "verification_result", View: "dynamic", Text: "verification: PASS",
		Verification: &types.VerificationStats{Build: true, Passed: 20, Total: 20},
	})
	report := loop.GoalReport()
	if !report.AllPass() {
		for _, status := range report.Statuses {
			t.Log(status.Describe())
		}
		t.Fatal("a passing verification run should satisfy both criteria")
	}
}
