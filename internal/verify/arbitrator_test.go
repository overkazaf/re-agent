package verify

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/hypothesis"
	"github.com/overkazaf/re-agent/internal/types"
)

func newArbiter(t *testing.T) (*Arbitrator, *evidence.Ledger, *hypothesis.Tracker) {
	t.Helper()
	ledger := evidence.New()
	tracker := hypothesis.New()
	return New(ledger, tracker, nil), ledger, tracker
}

func TestDanglingCitationChallengesWithSynthesizedRecord(t *testing.T) {
	arbiter, ledger, tracker := newArbiter(t)
	if _, err := tracker.Create("sub_401280 is an AES-128-CBC decrypt", 0.7, []string{"ev_099"}, nil); err != nil {
		t.Fatal(err)
	}

	findings := arbiter.Review()
	if len(findings) != 1 {
		t.Fatalf("expected 1 finding, got %d: %+v", len(findings), findings)
	}
	f := findings[0]
	if f.Rule != RuleDanglingCitation || f.HypothesisID != "H-001" || !f.Applied {
		t.Fatalf("wrong finding: %+v", f)
	}
	hyp, _ := tracker.Get("H-001")
	if hyp.Confidence != 0.35 || len(hyp.Contradicting) != 1 {
		t.Fatalf("dangling citation did not challenge: %+v", hyp)
	}
	synthesized := hyp.Contradicting[0]
	rec, ok := ledger.Get(synthesized)
	if !ok {
		t.Fatalf("synthesized record %s missing from ledger", synthesized)
	}
	if rec.Kind != "verification" || rec.Source != "arbitrator" {
		t.Fatalf("synthesized record not marked as arbitration output: %+v", rec)
	}
	if !strings.Contains(rec.Excerpt, "ev_099") {
		t.Fatalf("synthesized record should name the dangling id: %+v", rec)
	}

	// A second review must not re-challenge: the synthesized record is reused.
	again := arbiter.Review()
	if len(again) != 0 {
		t.Fatalf("review not idempotent: %+v", again)
	}
	hyp, _ = tracker.Get("H-001")
	if hyp.Confidence != 0.35 {
		t.Fatalf("confidence degraded twice: %+v", hyp)
	}
}

func TestErrorFlaggedSupportIsChallenged(t *testing.T) {
	arbiter, ledger, tracker := newArbiter(t)
	ledger.Add(evidence.Input{Source: "run_command", Kind: "dynamic", Text: "Cannot allocate memory", IsError: true})
	if _, err := tracker.Create("the loader path is bionic", 0.6, []string{"ev_001"}, nil); err != nil {
		t.Fatal(err)
	}

	findings := arbiter.Review()
	if len(findings) != 1 || findings[0].Rule != RuleErrorSupport || !findings[0].Applied {
		t.Fatalf("expected an applied error-support finding, got %+v", findings)
	}
	hyp, _ := tracker.Get("H-001")
	if hyp.Confidence != 0.3 || len(hyp.Contradicting) != 1 || hyp.Contradicting[0] != "ev_001" {
		t.Fatalf("error support did not challenge: %+v", hyp)
	}
}

func TestRuntimeErrorTouchingSubjectChallenges(t *testing.T) {
	arbiter, ledger, tracker := newArbiter(t)
	ledger.Add(evidence.Input{
		Source: "run_command", Kind: "dynamic",
		Text:    "./chall: symbol lookup error: sub_401280: undefined symbol",
		IsError: true,
	})
	if _, err := tracker.Create("sub_401280 is linked statically", 0.5, nil, nil); err != nil {
		t.Fatal(err)
	}

	findings := arbiter.Review()
	if len(findings) != 1 || findings[0].Rule != RuleRuntimeContradiction || !findings[0].Applied {
		t.Fatalf("expected an applied runtime-contradiction finding, got %+v", findings)
	}
	if findings[0].EvidenceID != "ev_001" {
		t.Fatalf("finding should carry the contradicting record id: %+v", findings[0])
	}
	hyp, _ := tracker.Get("H-001")
	if hyp.Confidence != 0.25 || hyp.Contradicting[0] != "ev_001" {
		t.Fatalf("runtime contradiction did not challenge: %+v", hyp)
	}
}

func TestSingleViewIsAdvisoryOnly(t *testing.T) {
	arbiter, ledger, tracker := newArbiter(t)
	ledger.Add(evidence.Input{Source: "strings", Kind: "static", Text: "sub_401280 references AES SBOX"})
	ledger.Add(evidence.Input{Source: "run_command", Kind: "dynamic", Text: "run ok: sub_401280 returned 0"})
	if _, err := tracker.Create("sub_401280 is the AES routine", 0.9, []string{"ev_001"}, nil); err != nil {
		t.Fatal(err)
	}

	findings := arbiter.Review()
	if len(findings) != 1 {
		t.Fatalf("expected 1 advisory finding, got %+v", findings)
	}
	f := findings[0]
	if f.Rule != RuleSingleView || f.Applied {
		t.Fatalf("single-view finding must be advisory: %+v", f)
	}
	if !strings.Contains(f.Message, "ev_002") {
		t.Fatalf("advisory should name the unattached dynamic record: %+v", f)
	}
	hyp, _ := tracker.Get("H-001")
	if hyp.Confidence != 0.9 || hyp.Status != types.HypActive {
		t.Fatalf("advisory must not mutate the stack: %+v", hyp)
	}
}

func TestReviewIgnoresUnrelatedAndSettledRows(t *testing.T) {
	arbiter, ledger, tracker := newArbiter(t)
	// A dynamic error record about something else entirely.
	ledger.Add(evidence.Input{Source: "run_command", Kind: "dynamic", Text: "mkdir: cannot create directory", IsError: true})
	if _, err := tracker.Create("the flag is XOR-encoded", 0.8, nil, nil); err != nil {
		t.Fatal(err)
	}
	// Rejected hypotheses are out of scope even with dangling citations.
	if _, err := tracker.Create("settled claim", 0.5, []string{"ev_042"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.Reject("H-002", "decoy"); err != nil {
		t.Fatal(err)
	}

	if findings := arbiter.Review(); len(findings) != 0 {
		t.Fatalf("expected no findings, got %+v", findings)
	}
}
