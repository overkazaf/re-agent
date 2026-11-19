package workflow

import (
	"strings"
	"testing"
)

type fakeLedger struct {
	evidence map[string]int
}

func (l fakeLedger) Count(kind any) int { return l.evidence[kind.(string)] }

func TestPhaseGatesRequireEvidenceHypothesesVerificationAndAudit(t *testing.T) {
	state := NewREState("apk")
	ledger := fakeLedger{}
	if err := CheckPhaseGate(state, ledger, 0); err == nil {
		t.Fatal("static gate should require tool observation")
	}
	ledger = fakeLedger{evidence: map[string]int{"tool_observation": 1}}
	if err := CheckPhaseGate(state, ledger, 0); err != nil {
		t.Fatalf("static gate failed: %v", err)
	}

	state.Phase = PhaseStatic
	if err := CheckPhaseGate(state, ledger, 0); err == nil {
		t.Fatal("dynamic gate should require a hypothesis")
	}
	if err := CheckPhaseGate(state, ledger, 1); err != nil {
		t.Fatalf("dynamic gate failed with active hypothesis: %v", err)
	}

	// skip_to cannot leap over unmet verify/audit gates.
	if err := CheckPhaseGatesTo(state, PhaseWriteup, ledger, 1); err == nil {
		t.Fatal("skip_to writeup must be blocked by unmet intermediate gates")
	}

	state.Phase = PhaseVerification
	if err := CheckPhaseGate(state, ledger, 1); err == nil {
		t.Fatal("audit gate should require verification")
	}
	ledger.evidence["verification_result"] = 1
	if err := CheckPhaseGate(state, ledger, 1); err != nil {
		t.Fatalf("audit gate failed: %v", err)
	}

	state.Phase = PhaseAudit
	if err := CheckPhaseGate(state, ledger, 1); err == nil {
		t.Fatal("writeup gate should require audit finding")
	}
}

func TestWriteupGateChecksAcceptanceCriteria(t *testing.T) {
	state := NewREState("elf")
	ledger := fakeLedger{evidence: map[string]int{"audit_finding": 1}}
	state.Phase = PhaseAudit

	if err := CheckPhaseGate(state, ledger, 1); err != nil {
		t.Fatalf("writeup gate failed without a declaration: %v", err)
	}

	state.Acceptance = func() []string { return []string{"replay_pass >= 0.95", "build_pass"} }
	err := CheckPhaseGate(state, ledger, 1)
	if err == nil || !strings.Contains(err.Error(), "replay_pass >= 0.95") {
		t.Fatalf("writeup gate should list unmet criteria, got %v", err)
	}

	state.Acceptance = func() []string { return nil }
	if err := CheckPhaseGate(state, ledger, 1); err != nil {
		t.Fatalf("writeup gate failed with all criteria met: %v", err)
	}
}
