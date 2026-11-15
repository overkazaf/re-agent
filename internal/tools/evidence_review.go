package tools

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

// evidence_review lets the model ask for an explicit arbitration pass. The
// loop already runs the same review automatically after every tool result;
// this tool is the on-demand window into it.
func evidenceReviewTool() types.Tool {
	return types.Tool{
		Name: "evidence_review",
		Description: "Cross-check the evidence ledger against the hypothesis stack. Applied findings " +
			"already challenged claims (confidence downgraded, dependents cascaded); advisory ones " +
			"point at unattached evidence worth citing. Run it after collecting dynamic results.",
		Risk:       types.RiskRead,
		Parameters: objectSchema(map[string]any{}),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			if tc.Arbitrator == nil {
				return errorResult("Arbitration is not available in this session."), nil
			}
			findings := tc.Arbitrator.Review()
			if len(findings) == 0 {
				return textResult("No findings: ledger and hypothesis stack agree.", map[string]any{"total": 0, "applied": 0}), nil
			}
			lines := make([]string, 0, len(findings))
			applied := 0
			for _, finding := range findings {
				verdict := "advisory"
				if finding.Applied {
					verdict = "challenged"
					applied++
				}
				lines = append(lines, fmt.Sprintf("%s %s [%s] %s", finding.HypothesisID, finding.Rule, verdict, finding.Message))
			}
			return textResult(strings.Join(lines, "\n"), map[string]any{
				"total": len(findings), "applied": applied,
			}), nil
		},
	}
}
