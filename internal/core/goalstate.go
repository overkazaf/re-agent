// The goal state: the accepted task declaration rides the loop like the
// hypothesis stack does — outside the transcript, re-injected into every
// system prompt, and persisted as a session event so a resumed run keeps the
// same definition of done.
package core

import (
	"fmt"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/goal"
)

// goalDeclaration is the loop's task contract, set by the operator via
// /goal accept and cleared by /goal clear. The mutex covers the HUD reading
// it while a command writes it.
type goalState struct {
	mu          sync.Mutex
	declaration *goal.Declaration
}

// SetGoal installs (or, with nil, removes) the accepted declaration and
// records it as a session event — the resume stream for task contracts.
func (l *AgentLoop) SetGoal(declaration *goal.Declaration) {
	l.goal.mu.Lock()
	l.goal.declaration = declaration
	l.goal.mu.Unlock()
	if l.options.Session != nil {
		_ = l.options.Session.AppendEvent(map[string]any{"type": "goal", "declaration": declaration})
	}
}

// Goal returns the current declaration, nil when none is active.
func (l *AgentLoop) Goal() *goal.Declaration {
	l.goal.mu.Lock()
	defer l.goal.mu.Unlock()
	return l.goal.declaration
}

// goalSection renders the declaration the system prompt carries on every
// request: what sample, what done means, and which gates the host will
// check before writeup. The model sees the contract, not a vibe.
func (l *AgentLoop) goalSection() string {
	declaration := l.Goal()
	if declaration == nil {
		return ""
	}
	var lines []string
	lines = append(lines, "## Task declaration", "")
	if declaration.Target.File != "" {
		target := "- target: " + declaration.Target.File
		if declaration.Target.SHA256 != "" {
			target += " (sha256 " + declaration.Target.SHA256[:min(12, len(declaration.Target.SHA256))] + "…"
			if declaration.Target.Format != "" {
				target += ", " + declaration.Target.Format
			}
			target += ")"
		}
		lines = append(lines, target)
	}
	if declaration.Target.Scope != "" {
		lines = append(lines, "- scope: "+declaration.Target.Scope)
	}
	lines = append(lines, "- objective: "+declaration.Objective.Primary)
	if declaration.Objective.Intent != "" {
		lines = append(lines, "- done means: "+declaration.Objective.Intent)
	}
	if len(declaration.Objective.Deliverables) > 0 {
		lines = append(lines, "- deliverables: "+strings.Join(declaration.Objective.Deliverables, ", "))
	}
	for key, value := range declaration.Objective.Constraints {
		lines = append(lines, fmt.Sprintf("- constraint %s: %s", key, value))
	}
	if len(declaration.Objective.Acceptance) > 0 {
		lines = append(lines, "- acceptance (host-checked before writeup):")
		for _, criterion := range declaration.Objective.Acceptance {
			lines = append(lines, "  - "+criterion.Describe())
		}
	}
	lines = append(lines, "",
		"Work toward this contract; the host checks the acceptance list against the",
		"evidence ledger — an unmet gate blocks the writeup phase, and prose does",
		"not move it.")
	return strings.Join(lines, "\n")
}

// GoalReport evaluates the active declaration against the ledger, for the
// HUD and /goal show.
func (l *AgentLoop) GoalReport() goal.Report {
	return goal.Evaluate(l.Goal(), l.Evidence())
}
