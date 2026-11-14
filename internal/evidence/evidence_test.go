package evidence

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLedgerRoundTripAndHypothesisTransitions(t *testing.T) {
	dir := t.TempDir()
	ledger, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	record, err := ledger.AddEvidence(EvidenceRecord{Kind: KindToolObservation, Source: "strings", Summary: "AES import"})
	if err != nil {
		t.Fatal(err)
	}
	hypothesis, err := ledger.AddHypothesis("decoder uses AES-256-CBC")
	if err != nil {
		t.Fatal(err)
	}
	updated, err := ledger.UpdateHypothesis(hypothesis.ID, HypothesisSupported, "runtime input confirms CBC", record.ID, "supports")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != HypothesisSupported || len(updated.Supports) != 1 {
		t.Fatalf("unexpected hypothesis: %#v", updated)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.Evidence()) != 1 || len(reopened.Hypotheses()) != 1 {
		t.Fatalf("round trip lost records: %#v", reopened)
	}
	if reopened.Hypotheses()[0].Status != HypothesisSupported || len(reopened.Hypotheses()[0].Revisions) != 2 {
		t.Fatalf("revision history not restored: %#v", reopened.Hypotheses()[0])
	}
	if filepath.Base(reopened.File()) != "evidence-ledger.jsonl" {
		t.Fatalf("unexpected ledger file: %s", reopened.File())
	}
	if _, err := os.Stat(reopened.File()); err != nil {
		t.Fatal(err)
	}
}
