package workflow

import "testing"

func TestPhaseOrderAndCodes(t *testing.T) {
	if len(Phases) != 9 || len(PhaseCodes) != len(Phases) {
		t.Fatalf("expected 9 phases and matching codes, got %d / %d", len(Phases), len(PhaseCodes))
	}
	if Phases[0] != PhaseTriage || PhaseCodes[0] != "TRI" {
		t.Fatalf("first phase mismatch: %s / %s", Phases[0], PhaseCodes[0])
	}
	if Phases[8] != PhaseWriteup || PhaseCodes[8] != "WRI" {
		t.Fatalf("last phase mismatch: %s / %s", Phases[8], PhaseCodes[8])
	}
}

func TestPhaseNextAndEndClamp(t *testing.T) {
	s := NewREState("apk")
	if s.Phase != PhaseTriage {
		t.Fatalf("initial phase = %s, want triage", s.Phase)
	}
	s.AdvancePhase()
	if s.Phase != PhaseStatic {
		t.Fatalf("after advance = %s, want static", s.Phase)
	}
	for i := 0; i < len(Phases)+2; i++ {
		s.AdvancePhase()
	}
	if s.Phase != PhaseWriteup {
		t.Fatalf("advance past end should clamp at writeup, got %s", s.Phase)
	}
}

func TestPhaseSkipToAndRewindRejection(t *testing.T) {
	s := NewREState("so")
	if err := s.SkipTo(PhaseEvidence); err != nil {
		t.Fatal(err)
	}
	if s.Phase != PhaseEvidence {
		t.Fatalf("phase = %s, want evidence", s.Phase)
	}
	if err := s.SkipTo(PhaseTriage); err == nil {
		t.Fatal("rewind should fail")
	}
	if err := s.SkipTo(PhaseEvidence); err == nil {
		t.Fatal("skip to current phase should fail")
	}
	if err := s.SkipTo(Phase("bogus")); err == nil {
		t.Fatal("skip to unknown phase should fail")
	}
}

func TestPhaseIndex(t *testing.T) {
	if PhaseIndex(PhaseTriage) != 0 {
		t.Fatal("triage should be index 0")
	}
	if PhaseIndex(PhaseVerification) != 6 {
		t.Fatal("verify should be index 6")
	}
	if PhaseIndex(PhaseAudit) != 7 {
		t.Fatal("audit should be index 7")
	}
	if PhaseIndex(PhaseWriteup) != 8 {
		t.Fatal("writeup should be index 8")
	}
	if PhaseIndex(Phase("bogus")) != -1 {
		t.Fatal("unknown phase should be -1")
	}
}
