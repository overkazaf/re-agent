package evidence

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLedgerFileRoundTripAndSummaryFallback(t *testing.T) {
	dir := t.TempDir()
	ledger, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	record, err := ledger.AddEvidence(EvidenceRecord{
		Kind:    string(KindAuditFinding),
		Source:  "auditor",
		Summary: "AES-256-CBC key schedule verified against runtime dump",
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.ID != "ev_001" || !strings.Contains(record.Excerpt, "AES-256-CBC") {
		t.Fatalf("unexpected record: %#v", record)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.Evidence()) != 1 {
		t.Fatalf("round trip lost records: %#v", reopened.Evidence())
	}
	if !strings.Contains(reopened.Digest(4), "AES-256-CBC") {
		t.Fatalf("digest did not preserve summary: %s", reopened.Digest(4))
	}
	if filepath.Base(reopened.File()) != "evidence-ledger.jsonl" {
		t.Fatalf("unexpected ledger file: %s", reopened.File())
	}
	if _, err := os.Stat(reopened.File()); err != nil {
		t.Fatal(err)
	}
	next := reopened.Add(Input{Source: "strings", Text: "second"})
	if next.ID != "ev_002" {
		t.Fatalf("expected numbering to continue after reopen, got %s", next.ID)
	}
}
