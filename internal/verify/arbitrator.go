// Package verify is the evidence arbitrator: a deterministic host-side pass
// over the evidence ledger and the hypothesis stack. It closes the loop the
// model cannot be trusted to close on its own — when an observation
// contradicts a claim, the contradiction is turned into evidence and attached
// through the tracker, so the confidence downgrade and cascade rules apply
// exactly as if the model had noticed it.
package verify

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/types"
)

// Rule names, stable for renderers and tests.
const (
	RuleDanglingCitation     = "dangling-citation"
	RuleErrorSupport         = "error-support"
	RuleRuntimeContradiction = "runtime-contradiction"
	RuleSingleView           = "single-view"
)

// singleViewConfidence is how confident a claim must be before lacking any
// support from the other view (static vs dynamic) is worth an advisory.
const singleViewConfidence = 0.8

// Arbitrator reviews the ledger against the stack. The stack is taken as the
// types.HypothesisStore decorator (not the raw tracker) so challenges snapshot
// into the session event stream like model-driven ones do; onEvidence, when
// set, persists synthesized records the same way regular tool results are.
type Arbitrator struct {
	ledger     *evidence.Ledger
	stack      types.HypothesisStore
	onEvidence func(types.EvidenceRecord)
}

func New(ledger *evidence.Ledger, stack types.HypothesisStore, onEvidence func(types.EvidenceRecord)) *Arbitrator {
	return &Arbitrator{ledger: ledger, stack: stack, onEvidence: onEvidence}
}

// Review runs every rule over every live hypothesis and returns the findings
// in a deterministic order. Applied rules are idempotent: a pair of
// (hypothesis, evidence) challenges at most once, even across resumes.
func (a *Arbitrator) Review() []types.Finding {
	records := a.ledger.List()
	byID := make(map[string]types.EvidenceRecord, len(records))
	for _, rec := range records {
		byID[rec.ID] = rec
	}

	var findings []types.Finding
	for _, hyp := range a.stack.List() {
		if hyp.Status != types.HypActive && hyp.Status != types.HypReevaluate {
			continue
		}
		used := make(map[string]bool, len(hyp.Contradicting)+len(hyp.Supporting))
		for _, id := range hyp.Contradicting {
			used[id] = true
		}

		// Cited support must exist and must not be an error output.
		for _, cited := range hyp.Supporting {
			if used[cited] {
				continue
			}
			rec, ok := byID[cited]
			switch {
			case !ok:
				if id, ok := a.challengeSynthetic(hyp, cited, used); ok {
					findings = append(findings, types.Finding{
						Rule: RuleDanglingCitation, HypothesisID: hyp.ID, EvidenceID: id, Applied: true,
						Message: fmt.Sprintf("%s cites %s, which is not in the ledger; challenged with synthesized %s", hyp.ID, cited, id),
					})
				}
			case rec.IsError:
				a.challenge(hyp.ID, cited, "arbitrator: cited evidence is error-flagged")
				used[cited] = true
				findings = append(findings, types.Finding{
					Rule: RuleErrorSupport, HypothesisID: hyp.ID, EvidenceID: cited, Applied: true,
					Message: fmt.Sprintf("%s cites %s as support, but that record is an error output", hyp.ID, cited),
				})
			}
		}

		// A failed runtime observation touching the claim's subject is a
		// contradiction, not noise.
		tokens := subjectTokens(hyp.Claim)
		for _, rec := range records {
			if used[rec.ID] || rec.Kind != "dynamic" || !rec.IsError {
				continue
			}
			if !sharesToken(tokens, rec.Excerpt) {
				continue
			}
			a.challenge(hyp.ID, rec.ID, "arbitrator: runtime error touches this claim's subject")
			used[rec.ID] = true
			findings = append(findings, types.Finding{
				Rule: RuleRuntimeContradiction, HypothesisID: hyp.ID, EvidenceID: rec.ID, Applied: true,
				Message: fmt.Sprintf("%s: runtime error in %s shares subject with the claim", hyp.ID, rec.ID),
			})
		}

		// A confident claim with support from only one view, while the other
		// view has unattached evidence on the same subject, is worth naming —
		// but the host does not downgrade for it.
		if hyp.Confidence >= singleViewConfidence {
			if rec, ok := unattachedOtherView(records, byID, used, tokens, hyp); ok {
				findings = append(findings, types.Finding{
					Rule: RuleSingleView, HypothesisID: hyp.ID, EvidenceID: rec.ID, Applied: false,
					Message: fmt.Sprintf("%s is %.2f confident on one view only; unattached %s evidence %s touches the same subject", hyp.ID, hyp.Confidence, rec.Kind, rec.ID),
				})
			}
		}
	}
	return findings
}

// challenge runs a stack mutation; failures are swallowed because the
// hypothesis may have been rejected between listing and challenging.
func (a *Arbitrator) challenge(hypID, evidenceID, note string) {
	_, _ = a.stack.Challenge(hypID, evidenceID, note)
}

// challengeSynthetic challenges hyp with a record it synthesizes for a cited
// id that does not exist. The record's ToolCallID is derived from the pair, so
// re-reviews reuse it instead of minting fresh contradictions.
func (a *Arbitrator) challengeSynthetic(hyp types.Hypothesis, danglingID string, used map[string]bool) (string, bool) {
	key := "arbiter:" + hyp.ID + ":" + danglingID
	for _, rec := range a.ledger.List() {
		if rec.ToolCallID == key {
			if used[rec.ID] {
				return "", false
			}
			a.challenge(hyp.ID, rec.ID, "arbitrator: dangling citation")
			used[rec.ID] = true
			return rec.ID, true
		}
	}
	rec := a.ledger.Add(evidence.Input{
		Source:     "arbitrator",
		Kind:       "verification",
		Text:       fmt.Sprintf("hypothesis %s cites %s, which is not in the evidence ledger", hyp.ID, danglingID),
		ToolCallID: key,
	})
	if a.onEvidence != nil {
		a.onEvidence(rec)
	}
	a.challenge(hyp.ID, rec.ID, "arbitrator: dangling citation")
	used[rec.ID] = true
	return rec.ID, true
}

// unattachedOtherView looks for confident-but-one-sided support: every
// resolvable supporting record has the same view while an unattached,
// non-error record of the opposite view shares the subject.
func unattachedOtherView(records []types.EvidenceRecord, byID map[string]types.EvidenceRecord, used map[string]bool, tokens []string, hyp types.Hypothesis) (types.EvidenceRecord, bool) {
	view := ""
	for _, cited := range hyp.Supporting {
		rec, ok := byID[cited]
		if !ok {
			continue
		}
		kind := rec.Kind
		if kind == "" {
			kind = "static"
		}
		if view == "" {
			view = kind
		} else if view != kind {
			return types.EvidenceRecord{}, false
		}
	}
	if view == "" {
		return types.EvidenceRecord{}, false
	}
	other := "dynamic"
	if view == "dynamic" {
		other = "static"
	}
	supporting := make(map[string]bool, len(hyp.Supporting))
	for _, id := range hyp.Supporting {
		supporting[id] = true
	}
	for _, rec := range records {
		if used[rec.ID] || supporting[rec.ID] || rec.IsError || rec.Kind != other {
			continue
		}
		if sharesToken(tokens, rec.Excerpt) {
			return rec, true
		}
	}
	return types.EvidenceRecord{}, false
}

var tokenPattern = regexp.MustCompile(`sub_[0-9a-fA-F]+|0x[0-9a-fA-F]+|[A-Za-z_][A-Za-z0-9_]{4,}`)

// genericWords are common prose/error-text words that say nothing about a
// subject; they never count as a token match.
var genericWords = map[string]bool{
	"about": true, "address": true, "after": true, "before": true, "buffer": true,
	"check": true, "could": true, "data": true, "error": true, "failed": true,
	"file": true, "found": true, "function": true, "memory": true, "offset": true,
	"output": true, "path": true, "result": true, "return": true, "should": true,
	"string": true, "there": true, "these": true, "those": true, "using": true,
	"value": true, "which": true, "would": true,
}

// subjectTokens pulls the specific identifiers out of a claim: sub_* labels,
// hex addresses, and non-generic words of five-plus characters.
func subjectTokens(claim string) []string {
	seen := make(map[string]bool)
	var tokens []string
	for _, match := range tokenPattern.FindAllString(claim, -1) {
		token := strings.ToLower(match)
		if genericWords[token] || seen[token] {
			continue
		}
		seen[token] = true
		tokens = append(tokens, token)
	}
	return tokens
}

func sharesToken(tokens []string, text string) bool {
	if len(tokens) == 0 {
		return false
	}
	lower := strings.ToLower(text)
	for _, token := range tokens {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return false
}
