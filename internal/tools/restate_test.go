package tools

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/hypothesis"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/workflow"
)

func TestREStateToolAdvanceAndGateEnforcement(t *testing.T) {
	state := workflow.NewREState("apk")
	ledger := evidence.New()
	hyps := hypothesis.New()
	tc := types.ToolContext{PhaseLedger: ledger, Hypotheses: hyps}
	tool := UpdateREStateTool(&state)

	// Without tool observation, static gate blocks advance.
	blocked, err := tool.Execute(map[string]any{"action": "advance"}, tc)
	if err != nil || !blocked.IsError {
		t.Fatalf("expected static gate block, got %+v / %v", blocked, err)
	}

	ledger.Add(evidence.Input{Source: "ctf_triage", Kind: string(evidence.KindToolObservation), Text: "ELF 64-bit"})
	okRes, err := tool.Execute(map[string]any{"action": "advance"}, tc)
	if err != nil || okRes.IsError || state.Phase != workflow.PhaseStatic {
		t.Fatalf("expected advance to static, got %s (%+v / %v)", state.Phase, okRes, err)
	}

	// skip_to writeup must NOT bypass intermediate gates!
	skipBlocked, _ := tool.Execute(map[string]any{"action": "skip_to", "phase": "writeup"}, tc)
	if !skipBlocked.IsError {
		t.Fatal("skip_to writeup should be blocked when dynamic/verify/audit gates are unmet")
	}

	// Creating a hypothesis unlocks dynamic.
	if _, err := hyps.Create("sub_401280 checks XOR key", 0.7, []string{"ev_001"}, nil); err != nil {
		t.Fatal(err)
	}
	dynRes, _ := tool.Execute(map[string]any{"action": "advance"}, tc)
	if dynRes.IsError || state.Phase != workflow.PhaseDynamic {
		t.Fatalf("expected advance to dynamic, got %s (%s)", state.Phase, dynRes.Text())
	}

	statusRes, _ := tool.Execute(map[string]any{"action": "status"}, tc)
	if statusRes.IsError || !strings.Contains(statusRes.Text(), "hypotheses=1 evidence=1") {
		t.Fatalf("unexpected status summary: %s", statusRes.Text())
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
