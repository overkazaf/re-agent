package workflow

import "testing"

func TestPhaseOrder(t *testing.T) {
	if len(Phases) != 7 {
		t.Fatalf("expected 7 phases, got %d", len(Phases))
	}
	if Phases[0] != PhaseTriage {
		t.Fatalf("first phase should be triage, got %s", Phases[0])
	}
	if Phases[6] != PhaseWriteup {
		t.Fatalf("last phase should be writeup, got %s", Phases[6])
	}
}

func TestPhaseNext(t *testing.T) {
	s := NewREState("apk")
	if s.Phase != PhaseTriage {
		t.Fatalf("initial phase = %s, want triage", s.Phase)
	}
	s.AdvancePhase()
	if s.Phase != PhaseStatic {
		t.Fatalf("after advance = %s, want static", s.Phase)
	}
}

func TestPhaseAdvanceAtEnd(t *testing.T) {
	s := NewREState("elf")
	for i := 0; i < len(Phases)-1; i++ {
		s.AdvancePhase()
	}
	if s.Phase != PhaseWriteup {
		t.Fatalf("should be at writeup, got %s", s.Phase)
	}
	s.AdvancePhase()
	if s.Phase != PhaseWriteup {
		t.Fatalf("advance past end should stay at writeup, got %s", s.Phase)
	}
}

func TestPhaseSkipTo(t *testing.T) {
	s := NewREState("so")
	if err := s.SkipTo(PhaseEvidence); err != nil {
		t.Fatal(err)
	}
	if s.Phase != PhaseEvidence {
		t.Fatalf("phase = %s, want evidence", s.Phase)
	}
}

func TestPhaseCannotRewind(t *testing.T) {
	s := NewREState("elf")
	s.AdvancePhase() // static
	s.AdvancePhase() // dynamic
	if err := s.SkipTo(PhaseTriage); err == nil {
		t.Fatal("rewind should fail")
	}
}

func TestPhaseSkipToSame(t *testing.T) {
	s := NewREState("apk")
	if err := s.SkipTo(PhaseTriage); err == nil {
		t.Fatal("skip to current phase should fail")
	}
}

func TestPhaseSkipToUnknown(t *testing.T) {
	s := NewREState("apk")
	if err := s.SkipTo(Phase("bogus")); err == nil {
		t.Fatal("skip to unknown phase should fail")
	}
}

func TestHypothesisTracking(t *testing.T) {
	s := NewREState("apk")
	s.AddHypothesis("main activity decrypts assets with AES-CBC")
	s.AddEvidence("strings output shows javax.crypto.Cipher import")
	if len(s.Hypotheses) != 1 || len(s.Evidence) != 1 {
		t.Fatalf("tracking: hyp=%d evi=%d", len(s.Hypotheses), len(s.Evidence))
	}
	s.ReviseHypothesis(0, "AES-ECB, not CBC — IV is zeroed")
	if s.Hypotheses[0].Revised != "AES-ECB, not CBC — IV is zeroed" {
		t.Fatalf("revision not recorded")
	}
}

func TestReviseOutOfBounds(t *testing.T) {
	s := NewREState("apk")
	s.ReviseHypothesis(99, "should not panic")
}

func TestPhaseIndex(t *testing.T) {
	if PhaseIndex(PhaseTriage) != 0 {
		t.Fatal("triage should be index 0")
	}
	if PhaseIndex(PhaseWriteup) != 6 {
		t.Fatal("writeup should be index 6")
	}
	if PhaseIndex(Phase("bogus")) != -1 {
		t.Fatal("unknown phase should be -1")
	}
}
