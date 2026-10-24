package tools

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/workflow"
)

// UpdateREStateTool manages the RE workflow session. statePtr points at the
// app's REState field so the tool always sees the current session.
func UpdateREStateTool(statePtr **workflow.REState) types.Tool {
	return types.Tool{
		Name: "update_re_state",
		Description: "Manage the RE workflow session: advance phases, record hypotheses and evidence, " +
			"revise hypotheses, or check status. Only available in /workflow reverse mode.",
		Risk: types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"action": map[string]any{
				"type":        "string",
				"enum":        []string{"advance", "skip_to", "hypothesis", "revise", "evidence", "status"},
				"description": "advance = next phase, skip_to = jump to named phase, hypothesis = add, revise = update, evidence = add, status = show current state.",
			},
			"phase": map[string]any{
				"type":        "string",
				"description": "Target phase name (only for skip_to).",
			},
			"text": map[string]any{
				"type":        "string",
				"description": "Hypothesis or evidence text (for hypothesis, revise, evidence actions).",
			},
			"index": map[string]any{
				"type":        "integer",
				"description": "Hypothesis index to revise (for revise action).",
			},
		}, "action"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			state := *statePtr
			if state == nil {
				return errorResult("no active RE session — enter /workflow reverse first"), nil
			}
			action, _ := args["action"].(string)
			switch action {
			case "advance":
				old := state.Phase
				state.AdvancePhase()
				return textResult(fmt.Sprintf("phase: %s → %s", old, state.Phase),
					map[string]any{"phase": string(state.Phase)}), nil

			case "skip_to":
				target, _ := args["phase"].(string)
				if err := state.SkipTo(workflow.Phase(target)); err != nil {
					return errorResult(err.Error()), nil
				}
				return textResult("phase → "+target,
					map[string]any{"phase": string(state.Phase)}), nil

			case "hypothesis":
				text, _ := args["text"].(string)
				if text == "" {
					return errorResult("text is required for hypothesis"), nil
				}
				state.AddHypothesis(text)
				return textResult(fmt.Sprintf("[H%d] recorded: %s", len(state.Hypotheses)-1, text),
					map[string]any{"phase": string(state.Phase), "hypotheses": len(state.Hypotheses)}), nil

			case "revise":
				idx := intFromArgs(args, "index")
				text, _ := args["text"].(string)
				if text == "" {
					return errorResult("text is required for revise"), nil
				}
				if idx < 0 || idx >= len(state.Hypotheses) {
					return errorResult(fmt.Sprintf("hypothesis index %d out of range (0..%d)", idx, len(state.Hypotheses)-1)), nil
				}
				state.ReviseHypothesis(idx, text)
				return textResult(fmt.Sprintf("[H%d] revised: %s", idx, text),
					map[string]any{"phase": string(state.Phase)}), nil

			case "evidence":
				text, _ := args["text"].(string)
				if text == "" {
					return errorResult("text is required for evidence"), nil
				}
				state.AddEvidence(text)
				return textResult(fmt.Sprintf("[E%d] recorded: %s", len(state.Evidence)-1, text),
					map[string]any{"phase": string(state.Phase), "evidence": len(state.Evidence)}), nil

			case "status":
				return textResult(reStatusSummary(state),
					map[string]any{"phase": string(state.Phase), "hypotheses": len(state.Hypotheses), "evidence": len(state.Evidence)}), nil

			default:
				return errorResult("unknown action: " + action + " (use advance, skip_to, hypothesis, revise, evidence, status)"), nil
			}
		},
	}
}

func intFromArgs(args map[string]any, key string) int {
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	default:
		return 0
	}
}

func reStatusSummary(state *workflow.REState) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("phase=%s [%d/%d] sample=%s",
		state.Phase, workflow.PhaseIndex(state.Phase)+1, len(workflow.Phases), state.SampleType))
	if len(state.Hypotheses) > 0 {
		lines = append(lines, fmt.Sprintf("hypotheses: %d", len(state.Hypotheses)))
		for i, h := range state.Hypotheses {
			tag := "active"
			if h.Revised != "" {
				tag = "revised"
			}
			lines = append(lines, fmt.Sprintf("  [H%d] %s (%s)", i, h.Text, tag))
		}
	}
	if len(state.Evidence) > 0 {
		lines = append(lines, fmt.Sprintf("evidence: %d", len(state.Evidence)))
		for i, e := range state.Evidence {
			lines = append(lines, fmt.Sprintf("  [E%d] %s", i, e.Text))
		}
	}
	return strings.Join(lines, "\n")
}
