package tools

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// Hypothesis tools: the model's only path into the assumption stack. The
// tracker owns the mutation rules (confidence downgrade, cascade); these
// wrappers just coerce arguments and render outcomes.

func hypothesisCreateTool() types.Tool {
	return types.Tool{
		Name: "hypothesis_create",
		Description: "Record an explicit assumption about the target (what a function does, where a key lives, " +
			"which path is real). Cite evidence ids from tool outputs. Call it as soon as you commit to a claim, " +
			"so contradicting evidence can be attached to it later instead of rewriting the narrative.",
		Risk: types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"claim":      map[string]any{"type": "string", "description": "One falsifiable claim, e.g. 'sub_401280 is an AES-128-CBC decrypt function'."},
			"confidence": map[string]any{"type": "number", "description": "0.0-1.0. Clamped by the host."},
			"evidence":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Evidence ids (ev_NNN) supporting the claim."},
			"depends_on": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Hypothesis ids this claim is derived from; if a parent falls, this one is marked for re-examination."},
		}, "claim"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			store := tc.Hypotheses
			if store == nil {
				return errorResult("Hypothesis tracking is not available in this session."), nil
			}
			claim := util.AsString(args["claim"])
			if strings.TrimSpace(claim) == "" {
				return errorResult("hypothesis_create requires a non-empty claim."), nil
			}
			confidence := asFloat(args["confidence"], 0.5)
			created, err := store.Create(claim, confidence, asStringSlice(args["evidence"]), asStringSlice(args["depends_on"]))
			if err != nil {
				return errorResult(err.Error()), nil
			}
			return textResult(fmt.Sprintf("Recorded %s (%.2f): %s", created.ID, created.Confidence, created.Claim),
				map[string]any{"id": created.ID, "confidence": created.Confidence}), nil
		},
	}
}

func hypothesisUpdateTool() types.Tool {
	return types.Tool{
		Name: "hypothesis_update",
		Description: "Update a hypothesis: attach supporting or contradicting evidence, revise the claim, or reject it. " +
			"Challenge with evidence whenever an observation contradicts a claim — the host downgrades confidence " +
			"and re-marks dependent hypotheses automatically.",
		Risk: types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"id":       map[string]any{"type": "string", "description": "Hypothesis id (H-NNN)."},
			"action":   map[string]any{"type": "string", "enum": []string{"support", "challenge", "revise", "reject"}},
			"evidence": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Evidence ids for support/challenge."},
			"claim":    map[string]any{"type": "string", "description": "Replacement claim text for revise."},
			"note":     map[string]any{"type": "string", "description": "One-line reason for this update."},
		}, "id", "action"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			store := tc.Hypotheses
			if store == nil {
				return errorResult("Hypothesis tracking is not available in this session."), nil
			}
			id := util.AsString(args["id"])
			action := strings.ToLower(strings.TrimSpace(util.AsString(args["action"])))
			note := util.AsString(args["note"])
			evidence := asStringSlice(args["evidence"])

			var updated types.Hypothesis
			var err error
			switch action {
			case "support", "challenge":
				if len(evidence) == 0 {
					return errorResult(action + " requires at least one evidence id."), nil
				}
				for _, evidenceID := range evidence {
					if action == "support" {
						updated, err = store.Support(id, evidenceID)
					} else {
						updated, err = store.Challenge(id, evidenceID, note)
					}
					if err != nil {
						return errorResult(err.Error()), nil
					}
				}
			case "revise":
				updated, err = store.Revise(id, util.AsString(args["claim"]), note)
			case "reject":
				updated, err = store.Reject(id, note)
			default:
				return errorResult(fmt.Sprintf("unknown action %q (want support, challenge, revise, reject)", action)), nil
			}
			if err != nil {
				return errorResult(err.Error()), nil
			}
			return textResult(renderHypothesis(updated), map[string]any{
				"id": updated.ID, "status": updated.Status, "confidence": updated.Confidence,
			}), nil
		},
	}
}

func hypothesisListTool() types.Tool {
	return types.Tool{
		Name:        "hypothesis_list",
		Description: "Show the current assumption stack with status and confidence. Consult it before committing to a conclusion.",
		Risk:        types.RiskRead,
		Parameters:  objectSchema(map[string]any{}),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			store := tc.Hypotheses
			if store == nil {
				return errorResult("Hypothesis tracking is not available in this session."), nil
			}
			hypotheses := store.List()
			if len(hypotheses) == 0 {
				return textResult("No hypotheses recorded yet.", nil), nil
			}
			lines := make([]string, 0, len(hypotheses))
			for _, hyp := range hypotheses {
				lines = append(lines, renderHypothesis(hyp))
			}
			return textResult(strings.Join(lines, "\n"), map[string]any{"total": len(hypotheses)}), nil
		},
	}
}

func renderHypothesis(hyp types.Hypothesis) string {
	flags := map[types.HypothesisStatus]string{
		types.HypRejected:   " [rejected]",
		types.HypRevised:    " [revised]",
		types.HypReevaluate: " [needs re-examination]",
	}
	line := fmt.Sprintf("%s (%.2f)%s %s", hyp.ID, hyp.Confidence, flags[hyp.Status], hyp.Claim)
	if len(hyp.Supporting) > 0 {
		line += fmt.Sprintf(" +support:%s", strings.Join(hyp.Supporting, ","))
	}
	if len(hyp.Contradicting) > 0 {
		line += fmt.Sprintf(" -contradicts:%s", strings.Join(hyp.Contradicting, ","))
	}
	if len(hyp.DependsOn) > 0 {
		line += fmt.Sprintf(" derives-from:%s", strings.Join(hyp.DependsOn, ","))
	}
	if hyp.Note != "" {
		line += " — " + hyp.Note
	}
	return line
}

// asFloat coerces a JSON argument to a float64; providers send numbers as
// float64 but occasionally as strings.
func asFloat(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case string:
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil {
			return parsed
		}
	}
	return fallback
}

func asStringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text := strings.TrimSpace(util.AsString(item)); text != "" {
			out = append(out, text)
		}
	}
	return out
}
