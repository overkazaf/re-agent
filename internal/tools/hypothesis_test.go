package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/hypothesis"
	"github.com/overkazaf/re-agent/internal/types"
)

func hypothesisTestContext(t *testing.T) (types.ToolContext, *hypothesis.Tracker) {
	t.Helper()
	tr := hypothesis.New()
	tc := types.ToolContext{
		Workspace:  t.TempDir(),
		SessionDir: t.TempDir(),
		Policy: &types.ExecutionPolicy{
			CommandTimeoutMs: 1000, MaxReadBytes: 1024, MaxToolOutputChars: 4000,
			ApprovalMode: types.ApprovalSafe, Approvals: map[string]string{},
		},
		Ctx:        context.Background(),
		Hypotheses: tr,
	}
	return tc, tr
}

func TestHypothesisCreateToolRecordsClaim(t *testing.T) {
	tc, tr := hypothesisTestContext(t)
	tool := Find(CreateReverseTools(), "hypothesis_create")
	if tool == nil {
		t.Fatal("hypothesis_create not registered")
	}
	result, err := tool.Execute(map[string]any{
		"claim":      "sub_401280 is an AES-128-CBC decrypt function",
		"confidence": 0.7,
		"evidence":   []any{"ev_001", "ev_002"},
	}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("unexpected error result: %s", result.Text())
	}
	stored, ok := tr.Get("H-001")
	if !ok {
		t.Fatal("claim not stored")
	}
	if stored.Confidence != 0.7 || len(stored.Supporting) != 2 {
		t.Fatalf("fields not coerced: %+v", stored)
	}
	if !strings.Contains(result.Text(), "H-001") {
		t.Fatalf("result should echo the assigned id: %s", result.Text())
	}
}

func TestHypothesisUpdateToolActions(t *testing.T) {
	tc, tr := hypothesisTestContext(t)
	create := Find(CreateReverseTools(), "hypothesis_create")
	update := Find(CreateReverseTools(), "hypothesis_update")
	list := Find(CreateReverseTools(), "hypothesis_list")
	if create == nil || update == nil || list == nil {
		t.Fatal("hypothesis tools not all registered")
	}
	if _, err := create.Execute(map[string]any{"claim": "root claim", "confidence": 0.8}, tc); err != nil {
		t.Fatal(err)
	}

	challenged, err := update.Execute(map[string]any{
		"id": "H-001", "action": "challenge", "evidence": []any{"ev_009"}, "note": "runtime is zeros",
	}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if challenged.IsError {
		t.Fatalf("challenge failed: %s", challenged.Text())
	}
	stored, _ := tr.Get("H-001")
	if stored.Confidence != 0.4 || len(stored.Contradicting) != 1 {
		t.Fatalf("challenge not applied: %+v", stored)
	}
	if !strings.Contains(challenged.Text(), "0.40") {
		t.Fatalf("result should report the new confidence: %s", challenged.Text())
	}

	if _, err := update.Execute(map[string]any{"id": "H-001", "action": "reject", "note": "decoy"}, tc); err != nil {
		t.Fatal(err)
	}
	stored, _ = tr.Get("H-001")
	if stored.Status != types.HypRejected {
		t.Fatalf("reject not applied: %+v", stored)
	}

	rendered, err := list.Execute(map[string]any{}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rendered.Text(), "rejected") || !strings.Contains(rendered.Text(), "H-001") {
		t.Fatalf("list should render id and status:\n%s", rendered.Text())
	}
}

func TestHypothesisToolsHandleBadInput(t *testing.T) {
	tc, _ := hypothesisTestContext(t)
	create := Find(CreateReverseTools(), "hypothesis_create")
	update := Find(CreateReverseTools(), "hypothesis_update")

	if result, err := create.Execute(map[string]any{"claim": "x"}, types.ToolContext{Policy: tc.Policy}); err != nil || !result.IsError {
		t.Fatalf("missing store should be an error result, got %+v / %v", result, err)
	}
	if result, err := update.Execute(map[string]any{"id": "H-001", "action": "transmogrify"}, tc); err != nil || !result.IsError {
		t.Fatalf("unknown action should be an error result, got %+v / %v", result, err)
	}
	if result, err := update.Execute(map[string]any{"id": "H-042", "action": "reject"}, tc); err != nil || !result.IsError {
		t.Fatalf("unknown id should be an error result, got %+v / %v", result, err)
	}
	if result, err := create.Execute(map[string]any{}, tc); err != nil || !result.IsError {
		t.Fatalf("missing claim should be an error result, got %+v / %v", result, err)
	}
}
