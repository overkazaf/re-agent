package core

import (
	"context"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/types"
)

// namedProvider tags a scripted provider so one loop can carry two seats.
type namedProvider struct {
	scriptedProvider
	name string
}

func (p *namedProvider) Name() string { return p.name }

func newAuditLoop(t *testing.T, main, auditor *namedProvider) *AgentLoop {
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
	loop := NewAgentLoop(LoopOptions{
		Config: &types.AgentConfig{
			PlannerProvider: main.name, ExecutorProvider: main.name,
			ResearcherProvider: main.name,
			DefaultRole:        types.RoleAuto, MaxTurns: 6,
			Providers: map[string]*types.ProviderConfig{
				main.name:    main.Config(),
				auditor.name: auditor.Config(),
			},
		},
		Providers:   map[string]types.Provider{main.name: main, auditor.name: auditor},
		ToolContext: &types.ToolContext{Workspace: dir, SessionDir: dir, Policy: policy},
		Session:     session,
	})
	return loop
}

// TestAuditChallengesFromCrossModelReport pins the core bargain: a second
// provider sees only the stack and ledger packet, and its verdict lines
// become real challenges on the stack.
func TestAuditChallengesFromCrossModelReport(t *testing.T) {
	main := &namedProvider{scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "main"},
	}, "main"}
	auditor := &namedProvider{scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "auditor"},
		responses: []types.ProviderResponse{{Text: "AUDIT H-001 CHALLENGE ev_001 the cited run actually errored\n" +
			"AUDIT H-002 SUPPORT ev_001 dynamic run confirms the offset"}},
	}, "auditor"}
	loop := newAuditLoop(t, main, auditor)

	if _, err := loop.options.ToolContext.Hypotheses.Create("sub_401280 is linked statically", 0.8, []string{"ev_001"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := loop.options.ToolContext.Hypotheses.Create("the flag sits at offset 0x40", 0.5, []string{"ev_001"}, nil); err != nil {
		t.Fatal(err)
	}
	loop.evidence.Add(evidence.Input{Source: "run_command", Kind: "dynamic", Text: "run output", ToolCallID: "t1"})

	report, err := loop.Audit(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}

	if report.Provider != "auditor" {
		t.Fatalf("audit should run on the second seat, got %q", report.Provider)
	}
	if len(main.seen) != 0 {
		t.Fatalf("main provider must not be called by the audit")
	}
	if !auditor.fresh[0] || len(auditor.tools[0]) != 0 {
		t.Fatalf("audit run must be isolated and tool-free: fresh=%v tools=%d", auditor.fresh[0], len(auditor.tools[0]))
	}
	if !strings.Contains(auditor.systems[0], "adversarial") {
		t.Fatalf("audit system prompt missing: %q", auditor.systems[0])
	}

	hyps := loop.Hypotheses()
	if hyps[0].Confidence != 0.4 {
		t.Fatalf("challenge should halve confidence, got %v", hyps[0].Confidence)
	}
	if len(hyps[0].Contradicting) != 1 || hyps[0].Contradicting[0] != "ev_001" {
		t.Fatalf("challenge should cite the named record: %+v", hyps[0].Contradicting)
	}
	if hyps[1].Confidence != 0.5 || len(hyps[1].Supporting) != 1 {
		t.Fatalf("support should attach evidence without touching confidence: %+v", hyps[1])
	}
	if len(report.Findings) != 2 || !report.Findings[0].Applied || !report.Findings[1].Applied {
		t.Fatalf("report should carry both applied findings: %+v", report.Findings)
	}
	if report.Findings[0].Rule != "adversarial-audit" {
		t.Fatalf("findings should be tagged adversarial-audit: %+v", report.Findings[0])
	}
}

// TestAuditSynthesizesRecordAndStaysIdempotent: an objection without a named
// record becomes a synthesized verification record keyed by the reason hash,
// so a repeat audit with the same objection neither re-mints nor re-halves.
func TestAuditSynthesizesRecordAndStaysIdempotent(t *testing.T) {
	verdict := "AUDIT H-001 CHALLENGE - a single string view overreads the section"
	auditor := &namedProvider{scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "auditor"},
		responses: []types.ProviderResponse{{Text: verdict}, {Text: verdict}},
	}, "auditor"}
	main := &namedProvider{scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "main"},
	}, "main"}
	loop := newAuditLoop(t, main, auditor)
	if _, err := loop.options.ToolContext.Hypotheses.Create("sub_401280 is linked statically", 0.8, nil, nil); err != nil {
		t.Fatal(err)
	}

	if _, err := loop.Audit(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	records := loop.evidence.List()
	if len(records) != 1 || records[0].Source != "audit" || records[0].Kind != "verification" {
		t.Fatalf("objection should be synthesized as audit evidence: %+v", records)
	}
	if !strings.HasPrefix(records[0].ToolCallID, "audit:H-001:") {
		t.Fatalf("synthesized record should be keyed for reuse: %q", records[0].ToolCallID)
	}
	if loop.Hypotheses()[0].Confidence != 0.4 {
		t.Fatalf("first audit should halve once, got %v", loop.Hypotheses()[0].Confidence)
	}

	// Same objection again: reuse the record, no second downgrade.
	if _, err := loop.Audit(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if got := len(loop.evidence.List()); got != 1 {
		t.Fatalf("repeat audit must not mint another record, got %d", got)
	}
	if loop.Hypotheses()[0].Confidence != 0.4 {
		t.Fatalf("repeat objection must not halve again, got %v", loop.Hypotheses()[0].Confidence)
	}
}

// TestAuditProviderSelection pins the seat ladder: config override first,
// then any provider outside the main seats and whoever answered last, then
// the last provider, then the executor.
func TestAuditProviderSelection(t *testing.T) {
	main := &namedProvider{scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "m"},
	}, "main"}
	auditor := &namedProvider{scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "a"},
	}, "auditor"}
	loop := newAuditLoop(t, main, auditor)

	loop.lastProviderName = "main"
	if got := loop.auditProviderName(); got != "auditor" {
		t.Fatalf("audit should avoid the main seats and the last provider, got %q", got)
	}
	loop.options.Config.AuditProvider = "main"
	if got := loop.auditProviderName(); got != "main" {
		t.Fatalf("config override should win, got %q", got)
	}

	solo, _ := newTestLoop(t, &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "s"},
	}, nil)
	if got := solo.auditProviderName(); got != "scripted" {
		t.Fatalf("single-provider setup should still audit, got %q", got)
	}
}

// TestAuditSkipsEmptyStackAndGarbage: nothing to audit, no run; verdict lines
// that name unknown hypotheses or unsupported verbs are ignored, and the
// stack is untouched.
func TestAuditSkipsEmptyStackAndGarbage(t *testing.T) {
	auditor := &namedProvider{scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "auditor"},
	}, "auditor"}
	main := &namedProvider{scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "main"},
	}, "main"}
	loop := newAuditLoop(t, main, auditor)

	report, err := loop.Audit(context.Background(), nil)
	if err != nil || len(report.Findings) != 0 {
		t.Fatalf("empty stack should short-circuit: %+v / %v", report, err)
	}
	if len(auditor.seen) != 0 {
		t.Fatalf("empty stack must not spend an audit run")
	}

	if _, err := loop.options.ToolContext.Hypotheses.Create("sub_401280 is linked statically", 0.8, nil, nil); err != nil {
		t.Fatal(err)
	}
	auditor.responses = []types.ProviderResponse{{Text: strings.Join([]string{
		"AUDIT H-999 CHALLENGE ev_001 unknown hypothesis",
		"AUDIT H-001 WHATEVER ev_001 not a verb",
		"this line is not a verdict at all",
	}, "\n")}}
	report, err = loop.Audit(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Findings) != 0 {
		t.Fatalf("garbage verdicts should be ignored: %+v", report.Findings)
	}
	if loop.Hypotheses()[0].Confidence != 0.8 {
		t.Fatalf("stack must be untouched by garbage, got %v", loop.Hypotheses()[0].Confidence)
	}
}
