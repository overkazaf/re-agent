package hypothesis

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

// Render is the one-line view of a hypothesis shared by the tools, the loop's
// prompt digest, and (later) the audit export.
func Render(hyp types.Hypothesis) string {
	flags := map[types.HypothesisStatus]string{
		types.HypRejected:   " [rejected]",
		types.HypRevised:    " [revised]",
		types.HypReevaluate: " [needs re-examination]",
		types.HypWeakened:   " [weakened]",
		types.HypFrozen:     " [frozen]",
	}
	line := fmt.Sprintf("%s (%.2f)%s %s", hyp.ID, hyp.Confidence, flags[hyp.Status], hyp.Claim)
	if hyp.Scope != "" {
		line += fmt.Sprintf(" [scope:%s]", hyp.Scope)
	}
	if len(hyp.Supporting) > 0 {
		line += fmt.Sprintf(" +support:%s", strings.Join(hyp.Supporting, ","))
	}
	if len(hyp.Contradicting) > 0 {
		line += fmt.Sprintf(" -contradicts:%s", strings.Join(hyp.Contradicting, ","))
	}
	if len(hyp.DependsOn) > 0 {
		line += fmt.Sprintf(" derives-from:%s", strings.Join(hyp.DependsOn, ","))
	}
	if hyp.NextTest != "" {
		line += fmt.Sprintf(" next:%s", hyp.NextTest)
	}
	if hyp.Note != "" {
		line += " — " + hyp.Note
	}
	return line
}

// Digest renders at most max hypotheses (the most contested first), noting
// what it dropped so a truncated view never looks complete.
func Digest(hypotheses []types.Hypothesis, max int) string {
	if len(hypotheses) == 0 || max <= 0 {
		return ""
	}
	ordered := prioritize(hypotheses)
	lines := make([]string, 0, len(ordered))
	shown := ordered
	if len(ordered) > max {
		lines = append(lines, fmt.Sprintf("… %d earlier hypotheses not shown", len(ordered)-max))
		shown = ordered[len(ordered)-max:]
	}
	for _, hyp := range shown {
		lines = append(lines, Render(hyp))
	}
	return strings.Join(lines, "\n")
}

// prioritize orders active-and-contested claims before quiet ones: rejected
// history renders last, what needs a decision renders first.
func prioritize(hypotheses []types.Hypothesis) []types.Hypothesis {
	out := append([]types.Hypothesis{}, hypotheses...)
	weight := map[types.HypothesisStatus]int{
		types.HypReevaluate: 0,
		types.HypFrozen:     1,
		types.HypWeakened:   2,
		types.HypActive:     3,
		types.HypRevised:    4,
		types.HypRejected:   5,
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && weight[out[j].Status] < weight[out[j-1].Status]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
