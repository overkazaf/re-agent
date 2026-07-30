// Package plan tracks the task list a provider is working through. Both
// sources feed it: the CLI event streams (codex `plan_update` / `todo_list`,
// Claude `TaskCreate`/`TaskUpdate`) and the host-side `update_plan` tool used by
// the direct-API providers.
//
// The app decides the lifetime: restored sessions can show the saved list, but
// a new user task resets it before the live HUD starts.
package plan

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

const (
	maxSteps     = 64
	maxStepChars = 200
)

type Tracker struct {
	mu       sync.Mutex
	snapshot *types.PlanSnapshot
}

func (t *Tracker) Current() *types.PlanSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshot
}

// Update replaces the plan wholesale. Returns the new snapshot, or nil when
// nothing changed — callers use that to skip a redraw and a session write.
func (t *Tracker) Update(steps []types.PlanStep, meta types.PlanUpdateMeta) *types.PlanSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()

	var previous []types.PlanStep
	if t.snapshot != nil {
		previous = t.snapshot.Steps
	}
	cleaned := carryTimings(previous, sanitize(steps))
	if len(cleaned) == 0 {
		return nil
	}
	if t.snapshot != nil && sameSteps(t.snapshot.Steps, cleaned) && t.snapshot.Note == meta.Note {
		// Same list from a different source: record who last claimed it so the
		// snapshot never reports a stale origin, but skip the redraw.
		t.snapshot.Source = meta.Source
		return nil
	}
	t.snapshot = &types.PlanSnapshot{
		Steps:     cleaned,
		Source:    meta.Source,
		Note:      meta.Note,
		UpdatedAt: types.NowMs(),
	}
	return t.snapshot
}

func (t *Tracker) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.snapshot = nil
}

func Counts(snapshot *types.PlanSnapshot) (done, total int) {
	if snapshot == nil {
		return 0, 0
	}
	for _, step := range snapshot.Steps {
		if step.Status == types.StepCompleted {
			done++
		}
	}
	return done, len(snapshot.Steps)
}

// Plans arrive from external CLIs, so treat every field as untrusted: drop
// blank steps, clamp runaway lists, and strip control characters that would
// corrupt the in-place terminal redraw.
func sanitize(steps []types.PlanStep) []types.PlanStep {
	out := make([]types.PlanStep, 0, len(steps))
	dropped := 0
	for _, step := range steps {
		text := clean(step.Text)
		if text == "" {
			continue
		}
		if len(out) >= maxSteps {
			dropped++
			continue
		}
		status := step.Status
		if !types.IsPlanStatus(string(status)) {
			status = types.StepPending
		}
		out = append(out, types.PlanStep{Text: text, Status: status, ID: step.ID})
	}
	// Never let the clamp make a truncated plan look complete.
	if dropped > 0 {
		out = append(out, types.PlanStep{Text: fmt.Sprintf("… %d more steps not shown", dropped), Status: types.StepPending})
	}
	return out
}

var (
	ansiRE    = regexp.MustCompile("\x1b\\[[0-9;]*m")
	controlRE = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
	spacesRE  = regexp.MustCompile(`\s+`)
)

func clean(value string) string {
	flat := ansiRE.ReplaceAllString(value, "")
	flat = controlRE.ReplaceAllString(flat, " ")
	flat = strings.TrimSpace(spacesRE.ReplaceAllString(flat, " "))
	return util.Truncate(flat, maxStepChars)
}

// Sources re-send the whole list on every change and carry no timing, so the
// tracker is the only place that knows when a step actually started or ended.
// Steps are matched by provider id when there is one, else by text.
func carryTimings(previous, next []types.PlanStep) []types.PlanStep {
	now := types.NowMs()
	if len(previous) == 0 {
		out := make([]types.PlanStep, len(next))
		for i, step := range next {
			out[i] = stamp(step, nil, now)
		}
		return out
	}
	byID := map[string]*types.PlanStep{}
	byText := map[string]*types.PlanStep{}
	for i := range previous {
		step := &previous[i]
		if step.ID != "" {
			byID[step.ID] = step
		}
		byText[step.Text] = step
	}
	out := make([]types.PlanStep, len(next))
	for i, step := range next {
		var match *types.PlanStep
		if step.ID != "" {
			match = byID[step.ID]
		}
		if match == nil {
			match = byText[step.Text]
		}
		out[i] = stamp(step, match, now)
	}
	return out
}

func stamp(step types.PlanStep, previous *types.PlanStep, now int64) types.PlanStep {
	startedAt := int64(0)
	completedAt := int64(0)
	if previous != nil {
		startedAt = previous.StartedAt
		completedAt = previous.CompletedAt
	}
	if startedAt == 0 && step.Status != types.StepPending {
		startedAt = now
	}
	if completedAt == 0 && step.Status == types.StepCompleted {
		completedAt = now
	}
	step.StartedAt = startedAt
	step.CompletedAt = completedAt
	return step
}

// Timings are derived state, so they are excluded from the change comparison:
// only text and status decide whether the operator sees a redraw.
func sameSteps(a, b []types.PlanStep) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Text != b[i].Text || a[i].Status != b[i].Status || a[i].ID != b[i].ID {
			return false
		}
	}
	return true
}
