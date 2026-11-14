package workflow

import (
	"fmt"
	"sync"
	"time"
)

type Phase string

const (
	PhaseTriage       Phase = "triage"
	PhaseStatic       Phase = "static"
	PhaseDynamic      Phase = "dynamic"
	PhaseEvidence     Phase = "evidence"
	PhaseInterface    Phase = "interface"
	PhaseHypothesis   Phase = "hypothesis"
	PhaseVerification Phase = "verify"
	PhaseAudit        Phase = "audit"
	PhaseWriteup      Phase = "writeup"
)

var Phases = []Phase{
	PhaseTriage, PhaseStatic, PhaseDynamic,
	PhaseEvidence, PhaseInterface, PhaseHypothesis, PhaseVerification,
	PhaseAudit, PhaseWriteup,
}

func PhaseIndex(p Phase) int {
	for i, v := range Phases {
		if v == p {
			return i
		}
	}
	return -1
}

type PhaseLedger interface {
	Count(kind any) int
	HasHypothesisStatus(statuses ...any) bool
}

func CheckPhaseGate(state *REState, ledger PhaseLedger) error {
	if ledger == nil {
		return nil
	}
	index := PhaseIndex(state.Phase)
	if index < 0 || index >= len(Phases)-1 {
		return nil
	}
	target := Phases[index+1]
	switch target {
	case PhaseStatic:
		if ledger.Count("tool_observation") == 0 {
			return fmt.Errorf("cannot enter static: collect at least one tool observation and record the sample hash/type")
		}
	case PhaseDynamic:
		if !ledger.HasHypothesisStatus("open", "supported", "weakened", "rejected", "verified") {
			return fmt.Errorf("cannot enter dynamic: record at least one hypothesis with its minimal test")
		}
	case PhaseVerification:
		if ledger.Count("runtime_trace") == 0 && ledger.Count("tool_observation") < 3 {
			return fmt.Errorf("cannot enter verify: collect runtime observations or a sufficient static evidence set")
		}
	case PhaseAudit:
		if ledger.Count("verification_result") == 0 {
			return fmt.Errorf("cannot enter audit: run verify_artifact and record at least one verification result")
		}
	case PhaseWriteup:
		if ledger.Count("audit_finding") == 0 {
			return fmt.Errorf("cannot enter writeup: record an audit finding before delivery")
		}
	}
	return nil
}

type Hypothesis struct {
	Text    string
	Revised string
	At      time.Time
}

type Evidence struct {
	Text string
	At   time.Time
}

// REState is the reverse-mode progress tracker. Methods lock because the tool
// goroutine writes during a turn while observers (the GUI's 90ms tick) read
// concurrently; Snapshot is the sanctioned read path.
type REState struct {
	mu         sync.Mutex
	SampleType string
	Phase      Phase
	Hypotheses []Hypothesis
	Evidence   []Evidence
	StartedAt  time.Time
}

func NewREState(sampleType string) *REState {
	return &REState{
		SampleType: sampleType,
		Phase:      PhaseTriage,
		StartedAt:  time.Now(),
	}
}

func (s *REState) AdvancePhase() {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := PhaseIndex(s.Phase)
	if idx >= 0 && idx < len(Phases)-1 {
		s.Phase = Phases[idx+1]
	}
}

func (s *REState) SkipTo(target Phase) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := PhaseIndex(s.Phase)
	tgt := PhaseIndex(target)
	if tgt < 0 {
		return fmt.Errorf("unknown phase: %s", target)
	}
	if tgt <= cur {
		return fmt.Errorf("cannot rewind from %s to %s", s.Phase, target)
	}
	s.Phase = target
	return nil
}

func (s *REState) AddHypothesis(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Hypotheses = append(s.Hypotheses, Hypothesis{Text: text, At: time.Now()})
}

func (s *REState) AddEvidence(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Evidence = append(s.Evidence, Evidence{Text: text, At: time.Now()})
}

func (s *REState) ReviseHypothesis(index int, revised string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if index >= 0 && index < len(s.Hypotheses) {
		s.Hypotheses[index].Revised = revised
	}
}

// Snapshot returns a locked copy for concurrent readers. Hypotheses/Evidence
// ride as slice headers — observers only take len(), never index, so the copy
// stays valid even if the writer appends afterwards.
func (s *REState) Snapshot() REState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return REState{
		SampleType: s.SampleType,
		Phase:      s.Phase,
		Hypotheses: s.Hypotheses[:len(s.Hypotheses):len(s.Hypotheses)],
		Evidence:   s.Evidence[:len(s.Evidence):len(s.Evidence)],
		StartedAt:  s.StartedAt,
	}
}
