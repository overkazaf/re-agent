package tools

import (
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/workflow"
)

func TestREStateToolAdvance(t *testing.T) {
	state := workflow.NewREState("apk")
	tool := UpdateREStateTool(&state)
	result, err := tool.Execute(map[string]any{"action": "advance"}, types.ToolContext{})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatal("unexpected error result")
	}
	if state.Phase != workflow.PhaseStatic {
		t.Fatalf("phase = %s, want static", state.Phase)
	}
}

func TestREStateToolHypothesis(t *testing.T) {
	state := workflow.NewREState("so")
	tool := UpdateREStateTool(&state)
	result, _ := tool.Execute(map[string]any{"action": "hypothesis", "text": "uses XOR encryption"}, types.ToolContext{})
	if result.IsError {
		t.Fatal("unexpected error")
	}
	if len(state.Hypotheses) != 1 {
		t.Fatal("hypothesis not added")
	}
}

func TestREStateToolEvidence(t *testing.T) {
	state := workflow.NewREState("elf")
	tool := UpdateREStateTool(&state)
	result, _ := tool.Execute(map[string]any{"action": "evidence", "text": "XOR loop at 0x4000"}, types.ToolContext{})
	if result.IsError {
		t.Fatal("unexpected error")
	}
	if len(state.Evidence) != 1 {
		t.Fatal("evidence not added")
	}
}

func TestREStateToolNilState(t *testing.T) {
	var state *workflow.REState
	tool := UpdateREStateTool(&state)
	result, _ := tool.Execute(map[string]any{"action": "status"}, types.ToolContext{})
	if !result.IsError {
		t.Fatal("should error when no RE session")
	}
}

func TestREStateToolStatus(t *testing.T) {
	state := workflow.NewREState("apk")
	state.AddHypothesis("test hyp")
	state.AddEvidence("test evi")
	tool := UpdateREStateTool(&state)
	result, _ := tool.Execute(map[string]any{"action": "status"}, types.ToolContext{})
	if result.IsError {
		t.Fatal("unexpected error")
	}
}
