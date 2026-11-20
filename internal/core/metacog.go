// The metacognition layer: the evidence ledger and the hypothesis stack the
// loop keeps alongside the transcript. Neither lives inside the message
// history, so both survive compaction — the stack is re-injected into the
// system prompt on every request instead of relying on the model remembering
// a buried transcript line.
package core

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/hypothesis"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
)

const (
	maxStackDigest  = 16
	maxLedgerDigest = 20
)

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

// evidenceLedgerSection renders the recent evidence digest injected into every
// request so tool provenance survives mechanical message compaction.
func (l *AgentLoop) evidenceLedgerSection() string {
	digest := l.evidence.Digest(maxLedgerDigest)
	if digest == "" {
		return ""
	}
	return strings.Join([]string{
		"## Evidence ledger",
		"",
		digest,
	}, "\n")
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
	switch name {
	case "update_plan", "update_re_state", "evidence_review", "list_skills", "read_skill":
		return true
	}
	return strings.HasPrefix(name, "hypothesis_")
}

// dynamicTools are the tools whose output observes the target at runtime, as
// opposed to reading bytes off disk. The arbitrator uses the split to pair
// static claims against dynamic observations, and the phase gates count
// runtime traces separately from static reads.
var dynamicTools = map[string]bool{
	"run_command": true,
	"remote_exec": true,
}

// viewFor classifies a tool's output view: dynamic (runtime) or static
// (on-disk).
func viewFor(tool string) string {
	if dynamicTools[tool] {
		return evidence.ViewDynamic
	}
	return evidence.ViewStatic
}

// kindFor maps a tool to the record class the phase gates count: replay
// verification beats runtime traces beats plain observations.
func kindFor(tool string) evidence.Kind {
	switch tool {
	case "verify_artifact":
		return evidence.KindVerification
	}
	if dynamicTools[tool] {
		return evidence.KindRuntimeTrace
	}
	return evidence.KindToolObservation
}

// recordEvidence files one tool result in the ledger and stamps the id into
// the content the model sees, so later hypothesis calls can cite it. Returns
// the record id ("" when the tool is host-state) and the content to persist.
func (l *AgentLoop) recordEvidence(call types.ToolCall, content []types.ContentBlock, isError bool, details any) (string, []types.ContentBlock) {
	if isHostStateTool(call.Name) {
		return "", content
	}
	artifact, digest := "", ""
	var verification *types.VerificationStats
	if details != nil {
		artifact, digest = provenanceFromResult(details)
		verification = verificationFromDetails(details)
	}
	record := l.evidence.Add(evidence.Input{
		Source:       call.Name,
		Kind:         string(kindFor(call.Name)),
		View:         viewFor(call.Name),
		Text:         types.TextFromBlocks(content),
		IsError:      isError,
		ToolCallID:   call.ID,
		Artifact:     artifact,
		SHA256:       digest,
		Verification: verification,
	})
	// The ledger is a provenance layer; never fail a run over persistence.
	_ = l.options.Session.AppendEvent(map[string]any{"type": "evidence", "record": record})
	return record.ID, stampEvidence(content, record.ID)
}

// verificationFromDetails lifts a verify_artifact run's numbers out of the
// tool details, so acceptance criteria can be checked from the ledger.
func verificationFromDetails(details any) *types.VerificationStats {
	mapped, ok := details.(map[string]any)
	if !ok {
		return nil
	}
	run, ok := mapped["verification"].(tools.VerificationResult)
	if !ok {
		return nil
	}
	return &types.VerificationStats{Build: run.Build, Passed: run.Passed, Total: run.Total}
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

// --- Host-controlled GUI workbench operations ---------------------------------
//
// Hypotheses and experiment designs are mutable reasoning state; EvidenceRecords
// (ev_NNN) are strictly append-only and can ONLY be minted from real execution
// outputs or formal audit reviews citing existing ledger records.

func (l *AgentLoop) GetHypothesis(id string) (types.Hypothesis, bool) {
	return l.hypotheses.Get(id)
}

func (l *AgentLoop) persistHypothesesSnapshot() {
	if l.options.Session != nil {
		_ = l.options.Session.AppendEvent(map[string]any{
			"type":       "hypotheses",
			"hypotheses": l.hypotheses.List(),
		})
	}
}

func (l *AgentLoop) validateEvidenceRefs(ids []string) error {
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := l.evidence.Get(id); !ok {
			return fmt.Errorf("证据账本中不存在 %s（证据不可凭空填写，仅可引用已实跑入账的 ev_NNN）", id)
		}
	}
	return nil
}

func (l *AgentLoop) CreateHypothesis(claim string, confidence float64, supporting, dependsOn []string, note string) (types.Hypothesis, []types.Finding, error) {
	if err := l.validateEvidenceRefs(supporting); err != nil {
		return types.Hypothesis{}, nil, err
	}
	created, err := l.hypotheses.Create(claim, confidence, supporting, dependsOn)
	if err != nil {
		return types.Hypothesis{}, nil, err
	}
	if strings.TrimSpace(note) != "" {
		trimmed := strings.TrimSpace(note)
		created, _ = l.hypotheses.UpdateMeta(created.ID, nil, nil, &trimmed)
	}
	l.persistHypothesesSnapshot()
	var findings []types.Finding
	if l.arbiter != nil {
		findings = l.arbiter.Review()
	}
	if refreshed, ok := l.hypotheses.Get(created.ID); ok {
		created = refreshed
	}
	return created, findings, nil
}

func (l *AgentLoop) UpdateHypothesis(id, action, claim, note string, confidence *float64, evidenceIDs, dependsOn []string) (types.Hypothesis, []types.Finding, error) {
	act := strings.ToLower(strings.TrimSpace(action))
	var updated types.Hypothesis
	var err error
	switch act {
	case "revise":
		if strings.TrimSpace(claim) != "" {
			updated, err = l.hypotheses.Revise(id, claim, note)
			if err != nil {
				return types.Hypothesis{}, nil, err
			}
		}
		if confidence != nil || dependsOn != nil || (strings.TrimSpace(claim) == "" && note != "") {
			var notePtr *string
			if note != "" {
				notePtr = &note
			}
			updated, err = l.hypotheses.UpdateMeta(id, confidence, dependsOn, notePtr)
		}
	case "reject":
		updated, err = l.hypotheses.Reject(id, note)
	case "support":
		if err = l.validateEvidenceRefs(evidenceIDs); err != nil {
			return types.Hypothesis{}, nil, err
		}
		for _, evID := range evidenceIDs {
			updated, err = l.hypotheses.Support(id, evID)
			if err != nil {
				return types.Hypothesis{}, nil, err
			}
		}
		if note != "" || confidence != nil {
			var notePtr *string
			if note != "" {
				notePtr = &note
			}
			updated, err = l.hypotheses.UpdateMeta(id, confidence, nil, notePtr)
		}
	case "challenge":
		if err = l.validateEvidenceRefs(evidenceIDs); err != nil {
			return types.Hypothesis{}, nil, err
		}
		for _, evID := range evidenceIDs {
			updated, err = l.hypotheses.Challenge(id, evID, note)
			if err != nil {
				return types.Hypothesis{}, nil, err
			}
		}
	case "meta":
		var notePtr *string
		if note != "" {
			notePtr = &note
		}
		updated, err = l.hypotheses.UpdateMeta(id, confidence, dependsOn, notePtr)
	default:
		return types.Hypothesis{}, nil, fmt.Errorf("unknown hypothesis action: %s", action)
	}
	if err != nil {
		return types.Hypothesis{}, nil, err
	}
	l.persistHypothesesSnapshot()
	var findings []types.Finding
	if l.arbiter != nil {
		findings = l.arbiter.Review()
	}
	if refreshed, ok := l.hypotheses.Get(id); ok {
		updated = refreshed
	}
	return updated, findings, nil
}

func (l *AgentLoop) AddExperiment(hypID, title, command, expected string) (types.Hypothesis, types.HypothesisExperiment, error) {
	hyp, exp, err := l.hypotheses.AddExperiment(hypID, title, command, expected)
	if err != nil {
		return types.Hypothesis{}, types.HypothesisExperiment{}, err
	}
	l.persistHypothesesSnapshot()
	return hyp, exp, nil
}

func (l *AgentLoop) CompleteExperiment(hypID, expID, command, output, expected string, runErr error) (types.EvidenceRecord, types.Hypothesis, []types.Finding, error) {
	text := strings.TrimSpace(output)
	if runErr != nil && text == "" {
		text = runErr.Error()
	} else if runErr != nil {
		text = text + "\nerror: " + runErr.Error()
	}
	rec := l.evidence.Add(evidence.Input{
		Source:  "experiment:run_command",
		Kind:    string(evidence.KindRuntimeTrace),
		View:    evidence.ViewDynamic,
		Text:    fmt.Sprintf("$ %s\n%s", command, text),
		IsError: runErr != nil,
	})
	if l.options.Session != nil {
		_ = l.options.Session.AppendEvent(map[string]any{"type": "evidence", "record": rec})
	}

	status := "passed"
	want := strings.TrimSpace(expected)
	if runErr != nil {
		if want != "" {
			status = "falsified"
		} else {
			status = "error"
		}
	} else if want != "" && !strings.Contains(strings.ToLower(output), strings.ToLower(want)) {
		status = "falsified"
	}

	if status == "passed" {
		_, _ = l.hypotheses.Support(hypID, rec.ID)
	} else if status == "falsified" {
		reason := fmt.Sprintf("实验 %s 实跑结果 (%s) 未命中预期 %q", expID, rec.ID, want)
		_, _ = l.hypotheses.Challenge(hypID, rec.ID, reason)
	}
	updated, err := l.hypotheses.RecordExperimentResult(hypID, expID, status, rec.ID, text)
	if err != nil {
		return rec, types.Hypothesis{}, nil, err
	}
	l.persistHypothesesSnapshot()
	var findings []types.Finding
	if l.arbiter != nil {
		findings = l.arbiter.Review()
	}
	if refreshed, ok := l.hypotheses.Get(hypID); ok {
		updated = refreshed
	}
	return rec, updated, findings, nil
}

func (l *AgentLoop) RecordVerificationToolResult(result types.ToolResult, isError bool, linkHypID string) (types.EvidenceRecord, []types.Finding, error) {
	artifact, digest := provenanceFromResult(result.Details)
	verification := verificationFromDetails(result.Details)
	rec := l.evidence.Add(evidence.Input{
		Source:       "verify_artifact",
		Kind:         string(evidence.KindVerification),
		View:         evidence.ViewDynamic,
		Text:         types.TextFromBlocks(result.Content),
		IsError:      isError || (verification != nil && (!verification.Build || verification.Passed < verification.Total)),
		Artifact:     artifact,
		SHA256:       digest,
		Verification: verification,
	})
	if l.options.Session != nil {
		_ = l.options.Session.AppendEvent(map[string]any{"type": "evidence", "record": rec})
	}
	if strings.TrimSpace(linkHypID) != "" {
		if !rec.IsError && verification != nil && verification.Total > 0 && verification.Passed == verification.Total {
			_, _ = l.hypotheses.Support(linkHypID, rec.ID)
		} else {
			_, _ = l.hypotheses.Challenge(linkHypID, rec.ID, fmt.Sprintf("verify_artifact (%s) 未全部通过", rec.ID))
		}
		l.persistHypothesesSnapshot()
	}
	var findings []types.Finding
	if l.arbiter != nil {
		findings = l.arbiter.Review()
	}
	return rec, findings, nil
}

func (l *AgentLoop) SubmitAuditReview(summary, targetHypID, verdict string, citedEvidence []string) (*types.EvidenceRecord, []types.Finding, error) {
	if err := l.validateEvidenceRefs(citedEvidence); err != nil {
		return nil, nil, err
	}
	var findings []types.Finding
	if l.arbiter != nil {
		findings = l.arbiter.Review()
	}
	cleanSummary := strings.TrimSpace(summary)
	if cleanSummary == "" {
		return nil, findings, nil
	}
	if len(l.evidence.List()) == 0 {
		return nil, findings, fmt.Errorf("当前账本尚无任何实跑证据（ev_NNN），禁止在无客观数据支撑下签发审查结论")
	}
	if len(citedEvidence) == 0 {
		return nil, findings, fmt.Errorf("签发审查结论必须至少引用一条账本中真实存在的 ev_NNN 证据")
	}

	target := strings.TrimSpace(targetHypID)
	act := strings.ToLower(strings.TrimSpace(verdict))
	if target != "" && act != "" {
		switch act {
		case "support":
			for _, evID := range citedEvidence {
				_, _ = l.hypotheses.Support(target, evID)
			}
		case "challenge":
			for _, evID := range citedEvidence {
				_, _ = l.hypotheses.Challenge(target, evID, cleanSummary)
			}
		case "reject":
			_, _ = l.hypotheses.Reject(target, cleanSummary)
		}
		l.persistHypothesesSnapshot()
	}

	excerpt := fmt.Sprintf("[operator-review] cites=%s", strings.Join(citedEvidence, ","))
	if target != "" && act != "" {
		excerpt += fmt.Sprintf(" target=%s verdict=%s", target, strings.ToUpper(act))
	}
	excerpt += " — " + cleanSummary

	rec, err := l.evidence.AddEvidence(types.EvidenceRecord{
		Source:   "review:operator",
		Kind:     string(evidence.KindAuditFinding),
		View:     evidence.ViewStatic,
		Summary:  cleanSummary,
		Excerpt:  excerpt,
		Supports: citedEvidence,
		Bytes:    len(excerpt),
	})
	if err != nil {
		return nil, findings, err
	}
	if l.options.Session != nil {
		_ = l.options.Session.AppendEvent(map[string]any{"type": "evidence", "record": rec})
	}
	findings = append(findings, types.Finding{
		Rule:         "operator-review",
		HypothesisID: target,
		EvidenceID:   rec.ID,
		Action:       act,
		Applied:      target != "" && act != "",
		Message:      cleanSummary,
	})
	return &rec, findings, nil
}
