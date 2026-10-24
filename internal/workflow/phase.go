package workflow

import (
	"fmt"
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

type REState struct {
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
	idx := PhaseIndex(s.Phase)
	if idx >= 0 && idx < len(Phases)-1 {
		s.Phase = Phases[idx+1]
	}
}

func (s *REState) SkipTo(target Phase) error {
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
	s.Hypotheses = append(s.Hypotheses, Hypothesis{Text: text, At: time.Now()})
}

func (s *REState) AddEvidence(text string) {
	s.Evidence = append(s.Evidence, Evidence{Text: text, At: time.Now()})
}

func (s *REState) ReviseHypothesis(index int, revised string) {
	if index >= 0 && index < len(s.Hypotheses) {
		s.Hypotheses[index].Revised = revised
	}
}
