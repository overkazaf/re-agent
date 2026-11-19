package tools

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// evidence_review lets the model ask for an explicit arbitration pass and, when
// auditing conclusions before writeup, record a formal audit_finding entry.
func evidenceReviewTool() types.Tool {
	return types.Tool{
		Name: "evidence_review",
		Description: "Cross-check the evidence ledger against the hypothesis stack and optionally record " +
			"an audit finding summary. Applied findings already challenged claims (confidence downgraded, " +
			"dependents cascaded); advisory ones point at unattached evidence worth citing. Pass summary " +
			"during the audit phase to file a formal audit_finding record.",
		Risk: types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"summary": map[string]any{
				"type":        "string",
				"description": "Optional one-line audit conclusion to file as an audit_finding record in the evidence ledger.",
			},
		}),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			if tc.Arbitrator == nil {
				return errorResult("Arbitration is not available in this session."), nil
			}
			findings := tc.Arbitrator.Review()
			summary := strings.TrimSpace(util.AsString(args["summary"]))
			auditID := ""
			if summary != "" {
				rec := tc.Arbitrator.RecordAudit(summary)
				auditID = rec.ID
			}

			var lines []string
			applied := 0
			if len(findings) == 0 {
				lines = append(lines, "No findings: ledger and hypothesis stack agree.")
			} else {
				for _, finding := range findings {
					verdict := "advisory"
					if finding.Applied {
						verdict = "challenged"
						applied++
					}
					lines = append(lines, fmt.Sprintf("%s %s [%s] %s", finding.HypothesisID, finding.Rule, verdict, finding.Message))
				}
			}
			details := map[string]any{"total": len(findings), "applied": applied}
			if auditID != "" {
				lines = append(lines, fmt.Sprintf("[audit finding %s recorded] %s", auditID, summary))
				details["auditEvidence"] = auditID
			}
			return textResult(strings.Join(lines, "\n"), details), nil
		},
	}
}
