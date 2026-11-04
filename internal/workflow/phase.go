package workflow

import (
	"fmt"
	"sync"
	"time"
)

type Phase string

const (
	PhaseTriage     Phase = "triage"
	PhaseStatic     Phase = "static"
	PhaseDynamic    Phase = "dynamic"
	PhaseEvidence   Phase = "evidence"
	PhaseInterface  Phase = "interface"
	PhaseHypothesis Phase = "hypothesis"
	PhaseWriteup    Phase = "writeup"
)

var Phases = []Phase{
	PhaseTriage, PhaseStatic, PhaseDynamic,
	PhaseEvidence, PhaseInterface, PhaseHypothesis, PhaseWriteup,
}

func PhaseIndex(p Phase) int {
	for i, v := range Phases {
		if v == p {
			return i
		}
	}
	return -1
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
