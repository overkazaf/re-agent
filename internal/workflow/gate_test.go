package workflow

import "testing"

type fakeLedger struct {
	evidence map[string]int
	statuses map[string]bool
}

func (l fakeLedger) Count(kind any) int { return l.evidence[kind.(string)] }
func (l fakeLedger) HasHypothesisStatus(statuses ...any) bool {
	for _, status := range statuses {
		if l.statuses[status.(string)] {
			return true
		}
	}
	return false
}

func TestPhaseGatesRequireEvidenceVerificationAndAudit(t *testing.T) {
	state := NewREState("apk")
	ledger := fakeLedger{}
	if err := CheckPhaseGate(state, ledger); err == nil {
		t.Fatal("static gate should require tool observation")
	}
	ledger = fakeLedger{evidence: map[string]int{"tool_observation": 1}}
	if err := CheckPhaseGate(state, ledger); err != nil {
		t.Fatalf("static gate failed: %v", err)
	}

	state.Phase = PhaseStatic
	if err := CheckPhaseGate(state, ledger); err == nil {
		t.Fatal("dynamic gate should require a hypothesis")
	}
	ledger.statuses = map[string]bool{"open": true}
	if err := CheckPhaseGate(state, ledger); err != nil {
		t.Fatalf("dynamic gate failed: %v", err)
	}

	state.Phase = PhaseVerification
	if err := CheckPhaseGate(state, ledger); err == nil {
		t.Fatal("audit gate should require verification")
	}
	ledger.evidence["verification_result"] = 1
	if err := CheckPhaseGate(state, ledger); err != nil {
		t.Fatalf("audit gate failed: %v", err)
	}

	state.Phase = PhaseAudit
	if err := CheckPhaseGate(state, ledger); err == nil {
		t.Fatal("writeup gate should require audit finding")
	}
}
