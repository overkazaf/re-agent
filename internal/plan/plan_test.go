package plan

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func steps(pairs ...string) []types.PlanStep {
	var out []types.PlanStep
	for index := 0; index+1 < len(pairs); index += 2 {
		out = append(out, types.PlanStep{Text: pairs[index], Status: types.PlanStepStatus(pairs[index+1])})
	}
	return out
}

func TestUpdateReportsOnlyRealChanges(t *testing.T) {
	tracker := &Tracker{}
	first := tracker.Update(steps("triage", "in_progress", "solve", "pending"),
		types.PlanUpdateMeta{Source: "codex"})
	if first == nil {
		t.Fatal("first update should produce a snapshot")
	}
	if again := tracker.Update(steps("triage", "in_progress", "solve", "pending"),
		types.PlanUpdateMeta{Source: "update_plan"}); again != nil {
		t.Fatal("an unchanged list should not redraw")
	}
	// The source is still recorded so the snapshot never reports a stale origin.
	if tracker.Current().Source != "update_plan" {
		t.Fatalf("source not updated: %s", tracker.Current().Source)
	}
	changed := tracker.Update(steps("triage", "completed", "solve", "in_progress"),
		types.PlanUpdateMeta{Source: "codex"})
	if changed == nil {
		t.Fatal("a status change should produce a snapshot")
	}
}

func TestUpdateCarriesTimingsAcrossUpdates(t *testing.T) {
	tracker := &Tracker{}
	tracker.Update(steps("triage", "in_progress"), types.PlanUpdateMeta{Source: "x"})
	started := tracker.Current().Steps[0].StartedAt
	if started == 0 {
		t.Fatal("an in_progress step should be stamped with a start")
	}
	snapshot := tracker.Update(steps("triage", "completed"), types.PlanUpdateMeta{Source: "x"})
	if snapshot.Steps[0].StartedAt != started {
		t.Fatal("start time was not carried across the update")
	}
	if snapshot.Steps[0].CompletedAt == 0 {
		t.Fatal("completion was not stamped")
	}
}

func TestSanitizeDropsJunkAndClamps(t *testing.T) {
	tracker := &Tracker{}
	var many []types.PlanStep
	for i := 0; i < 80; i++ {
		many = append(many, types.PlanStep{Text: "step", Status: types.StepPending})
	}
	many = append(many, types.PlanStep{Text: "   ", Status: types.StepPending})
	snapshot := tracker.Update(many, types.PlanUpdateMeta{Source: "x"})
	if len(snapshot.Steps) != maxSteps+1 {
		t.Fatalf("expected the list to be clamped with a marker, got %d", len(snapshot.Steps))
	}
	if !strings.Contains(snapshot.Steps[len(snapshot.Steps)-1].Text, "more steps not shown") {
		t.Fatal("a truncated plan must not look complete")
	}
}

func TestSanitizeStripsControlCharacters(t *testing.T) {
	tracker := &Tracker{}
	snapshot := tracker.Update(
		[]types.PlanStep{{Text: "\x1b[31mred\x1b[0m\tstep\nwith breaks", Status: "bogus"}},
		types.PlanUpdateMeta{Source: "x"})
	step := snapshot.Steps[0]
	if strings.ContainsAny(step.Text, "\x1b\n\t") {
		t.Fatalf("control characters survived: %q", step.Text)
	}
	if step.Status != types.StepPending {
		t.Fatalf("unknown status should fall back to pending, got %s", step.Status)
	}
}

func TestCounts(t *testing.T) {
	done, total := Counts(&types.PlanSnapshot{Steps: steps("a", "completed", "b", "pending", "c", "completed")})
	if done != 2 || total != 3 {
		t.Fatalf("counts wrong: %d/%d", done, total)
	}
	if done, total := Counts(nil); done != 0 || total != 0 {
		t.Fatalf("nil snapshot should count as empty, got %d/%d", done, total)
	}
}
