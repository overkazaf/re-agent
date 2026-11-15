package goal

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/types"
)

func draftJSON() string {
	return "Some preamble the contract forbids.\n" +
		"```json\n" +
		`{
  "target_file": "libshield.so",
  "target_scope": "request signing only; UI layer out",
  "primary": "recover_request_signing_behavior",
  "intent": "python harness reproduces the device signature byte-for-byte",
  "deliverables": ["candidate_algorithm", "reproducible_python_harness"],
  "constraints": {"network": "deny", "filesystem": "workspace-only"},
  "acceptance": [
    {"kind": "build_pass"},
    {"kind": "replay_pass", "op": ">=", "value": 0.95},
    {"kind": "differential_cases", "op": ">=", "value": 2}
  ]
}` + "\n```\nand some trailing words."
}

func TestParseDraftFromFencedBlock(t *testing.T) {
	draft, err := ParseDraft(draftJSON())
	if err != nil {
		t.Fatal(err)
	}
	if draft.TargetFile != "libshield.so" || draft.Primary != "recover_request_signing_behavior" {
		t.Fatalf("fields lost: %+v", draft)
	}
	if len(draft.Acceptance) != 3 || draft.Acceptance[1].Kind != KindReplayPass {
		t.Fatalf("acceptance list wrong: %+v", draft.Acceptance)
	}
}

func TestParseDraftFromBareObject(t *testing.T) {
	draft, err := ParseDraft(`{"target_file":"a.so","primary":"extract_strings","acceptance":[{"kind":"evidence_count","value":5}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(draft.Acceptance) != 1 || draft.Acceptance[0].Value != 5 {
		t.Fatalf("bare object parse wrong: %+v", draft)
	}
}

func TestParseDraftRejectsBadContracts(t *testing.T) {
	cases := map[string]string{
		"no json":            "the model refused politely",
		"missing target":     `{"primary":"x"}`,
		"missing primary":    `{"target_file":"a.so"}`,
		"unknown kind":       `{"target_file":"a.so","primary":"x","acceptance":[{"kind":"vibes"}]}`,
		"duplicate kind":     `{"target_file":"a.so","primary":"x","acceptance":[{"kind":"build_pass"},{"kind":"build_pass"}]}`,
		"bad op":             `{"target_file":"a.so","primary":"x","acceptance":[{"kind":"build_pass","op":"~"}]}`,
		"ratio out of range": `{"target_file":"a.so","primary":"x","acceptance":[{"kind":"replay_pass","value":1.5}]}`,
	}
	for name, raw := range cases {
		if _, err := ParseDraft(raw); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

func verifiableRecord(id string, build bool, passed, total int) types.EvidenceRecord {
	return types.EvidenceRecord{
		ID: id, Kind: string(evidence.KindVerification),
		Verification: &types.VerificationStats{Build: build, Passed: passed, Total: total, ID: id},
	}
}

func declarationWith(criterions ...Criterion) *Declaration {
	return &Declaration{Objective: Objective{Acceptance: criterions}}
}

func TestEvaluateChecksEveryCriterionKind(t *testing.T) {
	records := []types.EvidenceRecord{
		verifiableRecord("ev_001", false, 0, 0),                    // build failed
		verifiableRecord("ev_002", true, 19, 20),                   // build ok, 0.95 replay
		{ID: "ev_003", Kind: string(evidence.KindAuditFinding)},    // one audit finding
		{ID: "ev_004", Kind: string(evidence.KindToolObservation)}, // plain evidence
	}
	report := Evaluate(declarationWith(
		Criterion{Kind: KindBuildPass},
		Criterion{Kind: KindReplayPass, Value: 0.95},
		Criterion{Kind: KindDifferentialCases, Value: 2},
		Criterion{Kind: KindEvidenceCount, Value: 4},
		Criterion{Kind: KindAuditFinding, Value: 1},
	), records)
	if len(report.Statuses) != 5 {
		t.Fatalf("expected 5 statuses, got %d", len(report.Statuses))
	}
	for _, status := range report.Statuses {
		if !status.Pass {
			t.Fatalf("criterion should pass: %s", status.Describe())
		}
	}
	if !report.AllPass() || len(report.Pending()) != 0 {
		t.Fatal("report should be all-pass")
	}
	if !strings.Contains(report.Statuses[1].Detail, "19/20") || !strings.Contains(report.Statuses[1].Detail, "ev_002") {
		t.Fatalf("replay status should cite the best run: %s", report.Statuses[1].Detail)
	}
}

func TestEvaluateFailsOnMissingEvidence(t *testing.T) {
	report := Evaluate(declarationWith(
		Criterion{Kind: KindBuildPass},
		Criterion{Kind: KindReplayPass, Value: 0.9},
	), []types.EvidenceRecord{{ID: "ev_001", Kind: string(evidence.KindToolObservation)}})
	if report.AllPass() {
		t.Fatal("criteria without verification records must fail")
	}
	if len(report.Pending()) != 2 {
		t.Fatalf("both criteria pending, got %d", len(report.Pending()))
	}
}

func TestEvaluateBestReplayWins(t *testing.T) {
	records := []types.EvidenceRecord{
		verifiableRecord("ev_001", true, 1, 4),
		verifiableRecord("ev_002", true, 4, 4),
	}
	report := Evaluate(declarationWith(Criterion{Kind: KindReplayPass, Value: 0.99}), records)
	if !report.AllPass() {
		t.Fatalf("best run should carry the gate: %s", report.Statuses[0].Describe())
	}
}

func TestEvaluateIgnoresNonVerificationStats(t *testing.T) {
	// A plain record claiming kind verification_result without stats must not
	// satisfy replay gates — numbers only come from real runs.
	records := []types.EvidenceRecord{{ID: "ev_001", Kind: string(evidence.KindVerification)}}
	report := Evaluate(declarationWith(Criterion{Kind: KindReplayPass, Value: 0.5}), records)
	if report.AllPass() {
		t.Fatal("record without stats must not pass a replay gate")
	}
}

func TestEvaluateNilDeclaration(t *testing.T) {
	if report := Evaluate(nil, nil); !report.AllPass() || len(report.Statuses) != 0 {
		t.Fatal("nil declaration should be inert")
	}
}

func TestDescribeRendersCriteria(t *testing.T) {
	cases := map[Criterion]string{
		{Kind: KindBuildPass}:                             "build_pass",
		{Kind: KindReplayPass, Op: ">=", Value: 0.95}:     "replay_pass >= 0.95",
		{Kind: KindEvidenceCount, Value: 10, Note: "why"}: "evidence_count >= 10 — why",
	}
	for criterion, want := range cases {
		if got := criterion.Describe(); got != want {
			t.Fatalf("Describe() = %q, want %q", got, want)
		}
	}
}
