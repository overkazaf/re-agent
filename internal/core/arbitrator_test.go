package core

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/verify"
)

// failingRunTool is a stand-in for run_command: same name, so the loop
// classifies its output as a dynamic observation, but no real execution.
func failingRunTool(output string) types.Tool {
	return types.Tool{
		Name: "run_command", Description: "run", Risk: types.RiskRead,
		Parameters: map[string]any{"type": "object"},
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			return types.ToolResult{Content: []types.ContentBlock{types.TextBlock(output)}, IsError: true}, nil
		},
	}
}

// TestRunArbitratesContradictionsAfterToolResults pins the automatic pass: a
// runtime error that touches a claim's subject challenges that claim without
// waiting for the model to notice, and the challenge persists like any other.
func TestRunArbitratesContradictionsAfterToolResults(t *testing.T) {
	provider := &scriptedProvider{
		config: &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{
			{ToolCalls: []types.ToolCall{{ID: "1", Name: "hypothesis_create", Arguments: map[string]any{
				"claim": "sub_401280 is linked statically", "confidence": 0.8,
			}}}},
			{ToolCalls: []types.ToolCall{{ID: "2", Name: "run_command", Arguments: map[string]any{}}}},
			{Text: "investigating"},
		},
	}
	registry := tools.CreateReverseTools()
	registered := []types.Tool{failingRunTool("./chall: symbol lookup error: sub_401280: undefined symbol")}
	for _, name := range []string{"hypothesis_create"} {
		registered = append(registered, *tools.Find(registry, name))
	}
	loop, _ := newTestLoop(t, provider, registered)

	if _, err := loop.Run("check the linkage", RunOptions{}); err != nil {
		t.Fatal(err)
	}

	hyp := loop.Hypotheses()[0]
	if hyp.Confidence != 0.4 || len(hyp.Contradicting) != 1 {
		t.Fatalf("runtime contradiction did not challenge the claim: %+v", hyp)
	}
	records := loop.Evidence()
	if len(records) != 1 || records[0].Kind != "dynamic" {
		t.Fatalf("run_command output should be dynamic evidence: %+v", records)
	}
	if hyp.Contradicting[0] != records[0].ID {
		t.Fatalf("challenge should cite the contradicting record: %s vs %s", hyp.Contradicting[0], records[0].ID)
	}

	// The auto-challenge snapshots the stack, same as a model-driven one.
	entries, err := readEntries(loop.options.Session.File)
	if err != nil {
		t.Fatal(err)
	}
	snapshots := 0
	for _, entry := range entries {
		if entry.Type == "event" && strings.Contains(string(entry.Data), `"type":"hypotheses"`) {
			snapshots++
		}
	}
	if snapshots < 2 {
		t.Fatalf("auto-challenge did not persist the stack: %d snapshots", snapshots)
	}
}

// TestToolContextCarriesArbitrator checks the wiring and the synthesized
// evidence path: dangling citations get a verification record the model can
// see, and the arbitrator is reachable from tools.
func TestToolContextCarriesArbitrator(t *testing.T) {
	provider := &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{{Text: "ok"}},
	}
	loop, _ := newTestLoop(t, provider, nil)
	tc := *loop.options.ToolContext
	if tc.Arbitrator == nil {
		t.Fatal("ToolContext.Arbitrator not wired")
	}
	if findings := tc.Arbitrator.Review(); len(findings) != 0 {
		t.Fatalf("clean state should have no findings: %+v", findings)
	}

	if _, err := tc.Hypotheses.Create("the flag is at .rodata:0x8000", 0.6, []string{"ev_099"}, nil); err != nil {
		t.Fatal(err)
	}
	findings := tc.Arbitrator.Review()
	if len(findings) != 1 || findings[0].Rule != verify.RuleDanglingCitation || !findings[0].Applied {
		t.Fatalf("dangling citation not arbitrated: %+v", findings)
	}

	hyp := loop.Hypotheses()[0]
	if len(hyp.Contradicting) != 1 {
		t.Fatalf("synthesized challenge missing: %+v", hyp)
	}
	synthesizedID := hyp.Contradicting[0]
	var synthesized *types.EvidenceRecord
	for _, rec := range loop.Evidence() {
		if rec.ID == synthesizedID {
			copy := rec
			synthesized = &copy
		}
	}
	if synthesized == nil || synthesized.Kind != "verification" {
		t.Fatalf("synthesized record not in the ledger: %+v", loop.Evidence())
	}

	// A resumed loop rebuilds the same state and stays idempotent: the second
	// review must not mint another synthesized record.
	loaded, err := LoadSession(loop.options.Session.File)
	if err != nil {
		t.Fatal(err)
	}
	fresh, _ := newTestLoop(t, &scriptedProvider{
		config:    &types.ProviderConfig{Type: types.KindMock, Model: "scripted"},
		responses: []types.ProviderResponse{{Text: "resumed"}},
	}, nil)
	if err := fresh.Restore(loaded); err != nil {
		t.Fatal(err)
	}
	if again := fresh.options.ToolContext.Arbitrator.Review(); len(again) != 0 {
		t.Fatalf("review not idempotent after restore: %+v", again)
	}
	if got := len(fresh.Evidence()); got != 1 {
		t.Fatalf("restore should carry the synthesized record once, got %d records", got)
	}
}
