// The metacognition layer: the evidence ledger and the hypothesis stack the
// loop keeps alongside the transcript. Neither lives inside the message
// history, so both survive compaction — the stack is re-injected into the
// system prompt on every request instead of relying on the model remembering
// a buried transcript line.
package core

import (
	"strings"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/hypothesis"
	"github.com/overkazaf/re-agent/internal/types"
)

// maxStackDigest caps the hypothesis digest injected per request.
const maxStackDigest = 16

// persistingHypotheses decorates the tracker so every successful mutation
// snapshots the whole stack into the session event stream, the same bargain
// the plan tracker strikes with publishPlan.
type persistingHypotheses struct {
	store  *hypothesis.Tracker
	onSave func([]types.Hypothesis)
}

func (p *persistingHypotheses) Create(claim string, confidence float64, ev, deps []string) (types.Hypothesis, error) {
	hyp, err := p.store.Create(claim, confidence, ev, deps)
	p.saveOn(err)
	return hyp, err
}

func (p *persistingHypotheses) Support(id, evidenceID string) (types.Hypothesis, error) {
	hyp, err := p.store.Support(id, evidenceID)
	p.saveOn(err)
	return hyp, err
}

func (p *persistingHypotheses) Challenge(id, evidenceID, note string) (types.Hypothesis, error) {
	hyp, err := p.store.Challenge(id, evidenceID, note)
	p.saveOn(err)
	return hyp, err
}

func (p *persistingHypotheses) Revise(id, claim, note string) (types.Hypothesis, error) {
	hyp, err := p.store.Revise(id, claim, note)
	p.saveOn(err)
	return hyp, err
}

func (p *persistingHypotheses) Reject(id, note string) (types.Hypothesis, error) {
	hyp, err := p.store.Reject(id, note)
	p.saveOn(err)
	return hyp, err
}

func (p *persistingHypotheses) Get(id string) (types.Hypothesis, bool) { return p.store.Get(id) }
func (p *persistingHypotheses) List() []types.Hypothesis               { return p.store.List() }

func (p *persistingHypotheses) saveOn(err error) {
	if err == nil {
		p.onSave(p.store.List())
	}
}

// hypothesisStackSection renders the digest injected into every request.
func (l *AgentLoop) hypothesisStackSection() string {
	digest := hypothesis.Digest(l.hypotheses.List(), maxStackDigest)
	if digest == "" {
		return ""
	}
	return strings.Join([]string{
		"## Hypothesis stack",
		"",
		digest,
		"",
		"Record claims via hypothesis_create and update them via hypothesis_update.",
		"Challenge a hypothesis whenever new evidence contradicts it; rejected roots mark their dependents for re-examination.",
		"Run evidence_review after collecting dynamic results: the arbitrator cross-checks static claims against runtime observations.",
	}, "\n")
}

// isHostStateTool reports whether a tool's output is host bookkeeping rather
// than evidence about the target.
func isHostStateTool(name string) bool {
	return name == "update_plan" || strings.HasPrefix(name, "hypothesis_")
}

// dynamicTools are the tools whose output observes the target at runtime, as
// opposed to reading bytes off disk. The arbitrator uses the split to pair
// static claims against dynamic observations.
var dynamicTools = map[string]bool{
	"run_command": true,
	"remote_exec": true,
}

// evidenceKindFor classifies a tool's output view: dynamic (runtime) or
// static (on-disk).
func evidenceKindFor(tool string) string {
	if dynamicTools[tool] {
		return "dynamic"
	}
	return "static"
}

// recordEvidence files one tool result in the ledger and stamps the id into
// the content the model sees, so later hypothesis calls can cite it. Returns
// the record id ("" when the tool is host-state) and the content to persist.
func (l *AgentLoop) recordEvidence(call types.ToolCall, content []types.ContentBlock, isError bool) (string, []types.ContentBlock) {
	if isHostStateTool(call.Name) {
		return "", content
	}
	record := l.evidence.Add(evidence.Input{
		Source:     call.Name,
		Kind:       evidenceKindFor(call.Name),
		Text:       types.TextFromBlocks(content),
		IsError:    isError,
		ToolCallID: call.ID,
	})
	// The ledger is a provenance layer; never fail a run over persistence.
	_ = l.options.Session.AppendEvent(map[string]any{"type": "evidence", "record": record})
	return record.ID, stampEvidence(content, record.ID)
}

// stampEvidence appends the evidence id to the result text: one extra line on
// the last text block, or a new block when a result carries only images.
func stampEvidence(content []types.ContentBlock, id string) []types.ContentBlock {
	note := "[evidence " + id + " saved]"
	out := append([]types.ContentBlock{}, content...)
	for i := len(out) - 1; i >= 0; i-- {
		if out[i].Type == "text" {
			out[i].Text = out[i].Text + "\n" + note
			return out
		}
	}
	return append(out, types.TextBlock(note))
}

// withEvidenceID merges the evidence id into the details that ride the message
// into the JSONL. Non-map details are left alone; the ledger event already
// correlates by ToolCallID.
func withEvidenceID(details any, id string) any {
	if id == "" {
		return details
	}
	if details == nil {
		return map[string]any{"evidence": id}
	}
	if merged, ok := details.(map[string]any); ok {
		next := make(map[string]any, len(merged)+1)
		for key, value := range merged {
			next[key] = value
		}
		next["evidence"] = id
		return next
	}
	return details
}
