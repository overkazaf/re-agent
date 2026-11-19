package workflow

import (
	"fmt"
	"strings"
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

// PhaseCodes are the 3-letter HUD chips paired 1:1 with Phases.
var PhaseCodes = []string{
	"TRI", "STA", "DYN", "EVI", "IFC", "HYP", "VER", "AUD", "WRI",
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
}

// CheckPhaseGate validates the transition from state.Phase to the next phase
// against the evidence ledger and the live hypothesis stack count.
func CheckPhaseGate(state *REState, ledger PhaseLedger, hypothesisCount int) error {
	snap := state.Snapshot()
	index := PhaseIndex(snap.Phase)
	if index < 0 || index >= len(Phases)-1 {
		return nil
	}
	return checkTargetGate(state, Phases[index+1], ledger, hypothesisCount)
}

// CheckPhaseGatesTo validates every intermediate gate between state.Phase and
// target so skip_to cannot bypass verification, audit, or acceptance criteria.
func CheckPhaseGatesTo(state *REState, target Phase, ledger PhaseLedger, hypothesisCount int) error {
	snap := state.Snapshot()
	cur := PhaseIndex(snap.Phase)
	tgt := PhaseIndex(target)
	if tgt < 0 {
		return fmt.Errorf("unknown phase: %s", target)
	}
	if tgt <= cur {
		return fmt.Errorf("cannot rewind from %s to %s", snap.Phase, target)
	}
	for i := cur + 1; i <= tgt; i++ {
		if err := checkTargetGate(state, Phases[i], ledger, hypothesisCount); err != nil {
			return err
		}
	}
	return nil
}

func checkTargetGate(state *REState, target Phase, ledger PhaseLedger, hypothesisCount int) error {
	if ledger == nil {
		return nil
	}
	switch target {
	case PhaseStatic:
		if ledger.Count("tool_observation") == 0 {
			return fmt.Errorf("cannot enter static: collect at least one tool observation and record the sample hash/type")
		}
	case PhaseDynamic:
		if hypothesisCount == 0 {
			return fmt.Errorf("cannot enter dynamic: record at least one falsifiable claim via hypothesis_create first")
		}
	case PhaseVerification:
		if ledger.Count("runtime_trace") == 0 && ledger.Count("tool_observation") < 3 {
			return fmt.Errorf("cannot enter verify: collect runtime observations or at least 3 static observations")
		}
	case PhaseAudit:
		if ledger.Count("verification_result") == 0 {
			return fmt.Errorf("cannot enter audit: run verify_artifact and record at least one verification result")
		}
	case PhaseWriteup:
		if ledger.Count("audit_finding") == 0 {
			return fmt.Errorf("cannot enter writeup: record an audit_finding via evidence_review(summary=...) or /audit before delivery")
		}
		if pending := state.PendingAcceptance(); len(pending) > 0 {
			return fmt.Errorf("cannot enter writeup: acceptance criteria not met: %s", strings.Join(pending, "; "))
		}
	}
	return nil
}

// REState tracks the reverse-mode phase and sample type. Hypotheses and
// evidence live in their single canonical stores (hypothesis.Tracker and
// evidence.Ledger), never duplicated here.
type REState struct {
	mu         sync.Mutex
	SampleType string
	Phase      Phase
	StartedAt  time.Time
	// Acceptance, when set, returns the unmet acceptance criteria of the
	// active task declaration (empty = all hold or none armed).
	Acceptance func() []string
}

func (s *REState) PendingAcceptance() []string {
	s.mu.Lock()
	callback := s.Acceptance
	s.mu.Unlock()
	if callback == nil {
		return nil
	}
	return callback()
}

func NewREState(sampleType string) *REState {
	return &REState{
		SampleType: sampleType,
		Phase:      PhaseTriage,
		StartedAt:  time.Now(),
	}
}

func (s *REState) AdvancePhase() Phase {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := PhaseIndex(s.Phase)
	if idx >= 0 && idx < len(Phases)-1 {
		s.Phase = Phases[idx+1]
	}
	return s.Phase
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

// Snapshot returns a locked value copy for concurrent readers (TUI/GUI ticks).
func (s *REState) Snapshot() REState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return REState{
		SampleType: s.SampleType,
		Phase:      s.Phase,
		StartedAt:  s.StartedAt,
	}
}
