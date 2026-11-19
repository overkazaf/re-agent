package tools

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/workflow"
)

type evidenceListable interface {
	List() []types.EvidenceRecord
}

// UpdateREStateTool manages phase transitions in /workflow reverse mode.
// Hypotheses and evidence live in their unified host stores (hypothesis_*
// tools and the automatic evidence ledger), so this tool focuses strictly on
// phase progression and gate checks.
func UpdateREStateTool(statePtr **workflow.REState) types.Tool {
	return types.Tool{
		Name: "update_re_state",
		Description: "Advance, skip forward (subject to phase gates), or inspect phase status in /workflow reverse mode. " +
			"Record hypotheses via hypothesis_create/hypothesis_update; tool evidence is recorded automatically.",
		Risk: types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"action": map[string]any{
				"type":        "string",
				"enum":        []string{"advance", "skip_to", "status"},
				"description": "advance = move to next phase (gate-checked), skip_to = advance through gates to named phase, status = show current phase and counts.",
			},
			"phase": map[string]any{
				"type":        "string",
				"description": "Target phase name when action=skip_to (static, dynamic, evidence, interface, hypothesis, verify, audit, writeup).",
			},
		}, "action"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			state := *statePtr
			if state == nil {
				return errorResult("no active RE session — enter /workflow reverse first"), nil
			}
			action, _ := args["action"].(string)
			ledger, _ := tc.PhaseLedger.(workflow.PhaseLedger)
			hypCount := activeHypothesisCount(tc.Hypotheses)
			evCount := evidenceRecordCount(tc.PhaseLedger)

			switch action {
			case "advance":
				if err := workflow.CheckPhaseGate(state, ledger, hypCount); err != nil {
					return errorResult(err.Error()), nil
				}
				old := state.Snapshot().Phase
				next := state.AdvancePhase()
				return textResult(fmt.Sprintf("phase: %s → %s", old, next),
					map[string]any{"phase": string(next)}), nil

			case "skip_to":
				target := strings.TrimSpace(fmt.Sprint(args["phase"]))
				if err := workflow.CheckPhaseGatesTo(state, workflow.Phase(target), ledger, hypCount); err != nil {
					return errorResult(err.Error()), nil
				}
				if err := state.SkipTo(workflow.Phase(target)); err != nil {
					return errorResult(err.Error()), nil
				}
				snap := state.Snapshot()
				return textResult("phase → "+string(snap.Phase),
					map[string]any{"phase": string(snap.Phase)}), nil

			case "status":
				snap := state.Snapshot()
				summary := fmt.Sprintf("phase=%s [%d/%d] sample=%s hypotheses=%d evidence=%d",
					snap.Phase, workflow.PhaseIndex(snap.Phase)+1, len(workflow.Phases),
					snap.SampleType, hypCount, evCount)
				return textResult(summary, map[string]any{
					"phase":      string(snap.Phase),
					"hypotheses": hypCount,
					"evidence":   evCount,
				}), nil

			default:
				return errorResult("unknown action: " + action + " (use advance, skip_to, status)"), nil
			}
		},
	}
}

func activeHypothesisCount(store types.HypothesisStore) int {
	if store == nil {
		return 0
	}
	count := 0
	for _, hyp := range store.List() {
		if hyp.Status != types.HypRejected {
			count++
		}
	}
	return count
}

func evidenceRecordCount(raw any) int {
	if lister, ok := raw.(evidenceListable); ok && lister != nil {
		return len(lister.List())
	}
	return 0
}
