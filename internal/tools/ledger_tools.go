package tools

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/types"
)

func EvidenceManagerTool() types.Tool {
	return types.Tool{
		Name:        "evidence_manager",
		Description: "Manage structured hypotheses and audit findings. Tool observations are recorded automatically.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"action": map[string]any{
				"type": "string", "enum": []string{"hypothesis", "update_hypothesis", "audit", "status"},
			},
			"text": map[string]any{"type": "string"},
			"id":   map[string]any{"type": "string"},
			"status": map[string]any{
				"type": "string", "enum": []string{"open", "supported", "weakened", "rejected", "retired", "verified"},
			},
			"evidenceId": map[string]any{"type": "string"},
			"relation":   map[string]any{"type": "string", "enum": []string{"supports", "contradicts"}},
			"note":       map[string]any{"type": "string"},
		}, "action"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			ledger, ok := tc.PhaseLedger.(*evidence.Ledger)
			if !ok || ledger == nil {
				return errorResult("evidence ledger is not active"), nil
			}
			action, _ := args["action"].(string)
			switch action {
			case "hypothesis":
				text, _ := args["text"].(string)
				if strings.TrimSpace(text) == "" {
					return errorResult("text is required"), nil
				}
				record, err := ledger.AddHypothesis(text)
				if err != nil {
					return types.ToolResult{}, err
				}
				return textResult(fmt.Sprintf("%s recorded: %s", record.ID, record.Text), nil), nil
			case "update_hypothesis":
				id, _ := args["id"].(string)
				status, _ := args["status"].(string)
				note, _ := args["note"].(string)
				evidenceID, _ := args["evidenceId"].(string)
				relation, _ := args["relation"].(string)
				record, err := ledger.UpdateHypothesis(id, evidence.HypothesisStatus(status), note, evidenceID, relation)
				if err != nil {
					return errorResult(err.Error()), nil
				}
				return textResult(fmt.Sprintf("%s → %s", record.ID, record.Status), nil), nil
			case "audit":
				text, _ := args["text"].(string)
				if strings.TrimSpace(text) == "" {
					return errorResult("text is required"), nil
				}
				record, err := ledger.AddEvidence(evidence.EvidenceRecord{
					Kind: evidence.KindAuditFinding, Source: "auditor", Summary: text,
				})
				if err != nil {
					return types.ToolResult{}, err
				}
				return textResult(record.ID+": "+record.Summary, nil), nil
			case "status":
				var lines []string
				lines = append(lines, fmt.Sprintf("evidence=%d hypotheses=%d", len(ledger.Evidence()), len(ledger.Hypotheses())))
				for _, record := range ledger.Evidence() {
					lines = append(lines, fmt.Sprintf("[%s] %s %s", record.ID, record.Kind, record.Summary))
				}
				for _, record := range ledger.Hypotheses() {
					lines = append(lines, fmt.Sprintf("[%s] %s (%s)", record.ID, record.Text, record.Status))
				}
				return textResult(strings.Join(lines, "\n"), nil), nil
			default:
				return errorResult("unknown action: " + action), nil
			}
		},
	}
}
