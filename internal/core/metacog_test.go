package core

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// TestRunTagsToolResultsWithEvidence pins the evidence pipeline: every real
// tool output becomes an ev_NNN record, the result the model sees cites the
// id, and the record lands in the session event stream.
func TestRunTagsToolResultsWithEvidence(t *testing.T) {
	provider := &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{
			{ToolCalls: []types.ToolCall{{ID: "1", Name: "echo", Arguments: map[string]any{}}}},
			{Text: "all done"},
		},
	}
	calls := 0
	loop, _ := newTestLoop(t, provider, []types.Tool{echoTool(&calls)})

	if _, err := loop.Run("collect evidence", RunOptions{}); err != nil {
		t.Fatal(err)
	}

	records := loop.Evidence()
	if len(records) != 1 {
		t.Fatalf("expected 1 evidence record, got %d", len(records))
	}
	record := records[0]
	if record.ID != "ev_001" || record.Source != "echo" || record.ToolCallID != "1" {
		t.Fatalf("provenance not recorded: %+v", record)
	}
	if !strings.Contains(record.Excerpt, "echoed") {
		t.Fatalf("excerpt should carry the output: %+v", record)
	}

	// The model sees the id, so later hypothesis calls can cite it.
	if len(provider.seen) < 2 {
		t.Fatal("expected a second request")
	}
	last := provider.seen[1][len(provider.seen[1])-1]
	if last.Role != types.MessageToolResult || !strings.Contains(last.Text(), "ev_001") {
		t.Fatalf("tool result not stamped with the evidence id: %+v", last)
	}
	if details, ok := last.Details.(map[string]any); !ok || details["evidence"] != "ev_001" {
		t.Fatalf("details should carry the evidence id: %#v", last.Details)
	}
}

// Host-state tools are not evidence about the target.
func TestRunSkipsEvidenceForHostStateTools(t *testing.T) {
	provider := &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{
			{ToolCalls: []types.ToolCall{{ID: "1", Name: "update_plan", Arguments: map[string]any{
				"plan": []any{map[string]any{"step": "triage", "status": "in_progress"}},
			}}}},
			{Text: "planned"},
		},
	}
	loop, _ := newTestLoop(t, provider, planTools())
	if _, err := loop.Run("plan it", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := len(loop.Evidence()); got != 0 {
		t.Fatalf("host-state tool output should not become evidence, got %d records", got)
	}
}

// TestSystemPromptCarriesHypothesisStack makes the stack visible to every
// seat: the next turn's request includes the digest, so a downgrade cannot go
// unnoticed the way a buried transcript line can.
func TestSystemPromptCarriesHypothesisStack(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{{Text: "noted"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	tc := *loop.options.ToolContext

	if _, err := loop.Run("first look", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(provider.systems[0], "Hypothesis stack") {
		t.Fatalf("empty stack should not inject a section:\n%s", provider.systems[0])
	}

	if _, err := tc.Hypotheses.Create("sub_401280 is AES decrypt", 0.8, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := loop.Run("second look", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(provider.systems[1], "Hypothesis stack") {
		t.Fatalf("stack digest missing from the system prompt:\n%s", provider.systems[1])
	}
	if !strings.Contains(provider.systems[1], "H-001") || !strings.Contains(provider.systems[1], "sub_401280 is AES decrypt") {
		t.Fatalf("digest should name the claim:\n%s", provider.systems[1])
	}
}

// TestLoopExposesHypothesisStore checks the ToolContext wiring: the tools the
// registry provides mutate the loop's own tracker.
func TestLoopExposesHypothesisStore(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{{Text: "ok"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	tc := *loop.options.ToolContext
	if tc.Hypotheses == nil {
		t.Fatal("ToolContext.Hypotheses not wired")
	}
	created, err := tc.Hypotheses.Create("claim", 0.5, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(loop.Hypotheses()) != 1 || loop.Hypotheses()[0].ID != created.ID {
		t.Fatalf("loop does not expose the tracker state: %+v", loop.Hypotheses())
	}

	loop.NewSession(newTestSession(t))
	if len(loop.Hypotheses()) != 0 || len(loop.Evidence()) != 0 {
		t.Fatal("NewSession should clear the hypothesis stack and evidence ledger")
	}
}

// TestHypothesisMutationsPersist pins the event stream: whole-stack snapshots
// after each mutation, so a resumed session rebuilds the stack.
func TestHypothesisMutationsPersist(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{{Text: "ok"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	tc := *loop.options.ToolContext
	if _, err := tc.Hypotheses.Create("root claim", 0.9, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := tc.Hypotheses.Reject("H-001", "decoy path"); err != nil {
		t.Fatal(err)
	}

	snapshots := 0
	entries, err := readEntries(loop.options.Session.File)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Type == "event" && strings.Contains(string(entry.Data), `"type":"hypotheses"`) {
			snapshots++
		}
	}
	if snapshots != 2 {
		t.Fatalf("expected a snapshot per mutation, got %d", snapshots)
	}
}

// TestLoadSessionRestoresEvidenceAndHypotheses pins the round trip: events
// recorded by the loop come back through LoadSession and seed a fresh loop
// via Restore, so a resumed session keeps its provenance and its stack.
func TestLoadSessionRestoresEvidenceAndHypotheses(t *testing.T) {
	provider := &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{
			{ToolCalls: []types.ToolCall{{ID: "1", Name: "echo", Arguments: map[string]any{}}}},
			{Text: "done"},
		},
	}
	calls := 0
	loop, _ := newTestLoop(t, provider, []types.Tool{echoTool(&calls)})
	tc := *loop.options.ToolContext
	if _, err := tc.Hypotheses.Create("root claim", 0.9, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := loop.Run("collect", RunOptions{}); err != nil {
		t.Fatal(err)
	}

	loaded, err := LoadSession(loop.options.Session.File)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Evidence) != 1 || loaded.Evidence[0].ID != "ev_001" {
		t.Fatalf("evidence not loaded: %+v", loaded.Evidence)
	}
	if len(loaded.Hypotheses) != 1 || loaded.Hypotheses[0].Claim != "root claim" {
		t.Fatalf("hypotheses not loaded: %+v", loaded.Hypotheses)
	}

	fresh, _ := newTestLoop(t, &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{{Text: "resumed"}},
	}, nil)
	if err := fresh.Restore(loaded); err != nil {
		t.Fatal(err)
	}
	if len(fresh.Evidence()) != 1 || len(fresh.Hypotheses()) != 1 {
		t.Fatalf("restore did not seed the metacognition state: %d evidence, %d hypotheses",
			len(fresh.Evidence()), len(fresh.Hypotheses()))
	}
	// Numbering continues past the restored records.
	next, err := (*fresh.options.ToolContext.Hypotheses.(*persistingHypotheses)).store.Create("next", 0.5, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if next.ID != "H-002" {
		t.Fatalf("numbering did not continue after restore: %s", next.ID)
	}
}

func planTools() []types.Tool {
	return []types.Tool{{
		Name: "update_plan", Description: "publish plan", Risk: types.RiskRead,
		Parameters: map[string]any{"type": "object"},
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			steps, _ := args["plan"].([]any)
			parsed := make([]types.PlanStep, 0, len(steps))
			for _, item := range steps {
				record, ok := item.(map[string]any)
				if !ok {
					continue
				}
				parsed = append(parsed, types.PlanStep{Text: util.AsString(record["step"]), Status: types.StepInProgress})
			}
			if tc.OnPlan != nil {
				tc.OnPlan(parsed, types.PlanUpdateMeta{Source: "update_plan"})
			}
			return types.ToolResult{Content: []types.ContentBlock{types.TextBlock("planned")}}, nil
		},
	}}
}

func newTestSession(t *testing.T) *Session {
	t.Helper()
	session := NewSession(t.TempDir(), "fresh")
	if err := session.Init(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	return session
}
