// Package verify is the evidence arbitrator: a deterministic host-side pass
// over the evidence ledger and the hypothesis stack. It closes the loop the
// model cannot be trusted to close on its own — when an observation
// contradicts a claim, the contradiction is turned into evidence and attached
// through the tracker, so the confidence downgrade and cascade rules apply
// exactly as if the model had noticed it.
package verify

import (
	"fmt"
	"hash/fnv"
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

// Canonical 5-check Adversarial Auditor check IDs (§8.6).
const (
	AuditCheckDirectEvidence      = "direct_evidence"
	AuditCheckFailureEdgeCoverage = "failure_edge_coverage"
	AuditCheckSimplerAlternative  = "simpler_alternative"
	AuditCheckScopeOverreach      = "scope_overreach"
	AuditCheckArtifactLineage     = "artifact_lineage"
)

// AuditInput carries the isolated inputs the deterministic 5-check Adversarial
// Auditor evaluates (§8.6): hypotheses, evidence ledger records, sandbox
// overreach / blocked-attempt counts, and any prior arbitrator findings.
type AuditInput struct {
	Hypotheses      []types.Hypothesis
	Evidence        []types.EvidenceRecord
	OverreachCount  int // uncontained / unauthorized out-of-scope accesses
	BlockedAttempts int // out-of-scope attempts cleanly intercepted by Gate 1 Sandbox
	Findings        []types.Finding
}

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
			if used[rec.ID] || rec.View != evidence.ViewDynamic || !rec.IsError {
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
					Message: fmt.Sprintf("%s is %.2f confident on one view only; unattached %s evidence %s touches the same subject", hyp.ID, hyp.Confidence, rec.View, rec.ID),
				})
			}
		}
	}
	return findings
}

// RecordAudit files a formal audit_finding record in the ledger so the audit
// phase gate and /goal acceptance checks can verify that an audit review ran.
// Keyed by summary hash so repeated reviews with the same conclusion stay idempotent.
func (a *Arbitrator) RecordAudit(summary string) types.EvidenceRecord {
	cleaned := strings.TrimSpace(summary)
	if cleaned == "" {
		cleaned = "evidence_review completed: ledger and hypothesis stack cross-checked"
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(cleaned))
	key := fmt.Sprintf("arbiter:audit:%08x", h.Sum32())
	for _, rec := range a.ledger.List() {
		if rec.ToolCallID == key {
			return rec
		}
	}
	rec := a.ledger.Add(evidence.Input{
		Source:     "arbitrator",
		Kind:       string(evidence.KindAuditFinding),
		Text:       cleaned,
		ToolCallID: key,
	})
	if a.onEvidence != nil {
		a.onEvidence(rec)
	}
	return rec
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
		Kind:       string(evidence.KindAuditFinding),
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
		candidate := rec.View
		if candidate == "" {
			candidate = evidence.ViewStatic
		}
		if view == "" {
			view = candidate
		} else if view != candidate {
			return types.EvidenceRecord{}, false
		}
	}
	if view == "" {
		return types.EvidenceRecord{}, false
	}
	other := evidence.ViewDynamic
	if view == evidence.ViewDynamic {
		other = evidence.ViewStatic
	}
	supporting := make(map[string]bool, len(hyp.Supporting))
	for _, id := range hyp.Supporting {
		supporting[id] = true
	}
	for _, rec := range records {
		if used[rec.ID] || supporting[rec.ID] || rec.IsError || rec.View != other {
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

// AdversarialAudit runs the deterministic 5-check Adversarial Auditor (§8.6)
// over the current ledger and hypothesis stack without mutating either.
func (a *Arbitrator) AdversarialAudit(overreachCount, blockedAttempts int) types.AuditEvaluation {
	return EvaluateAdversarialAudit(AuditInput{
		Hypotheses:      a.stack.List(),
		Evidence:        a.ledger.List(),
		OverreachCount:  overreachCount,
		BlockedAttempts: blockedAttempts,
	})
}

// EvaluateAdversarialAudit implements the canonical 5-item Adversarial Auditor
// checklist (§6 Defense ⑤ & §8.6) and outputs the 3-state AuditVerdict:
//
//  1. direct_evidence       — every active conclusion cites valid, non-error ledger evidence
//  2. failure_edge_coverage — verification passed >= 2 cases with boundary/failure/diff coverage
//     (a single-sample hit with total < 2 or missing boundary/failure test downgrades to needs_more_evidence)
//  3. simpler_alternative   — no unresolved reevaluate/weakened/frozen hypotheses or unchecked single-view bias
//  4. scope_overreach       — zero unauthorized out-of-scope file/network/device/credential accesses
//  5. artifact_lineage      — deliverable/verification records carry provenance and do not rely solely on untrusted raw strings
func EvaluateAdversarialAudit(in AuditInput) types.AuditEvaluation {
	byID := make(map[string]types.EvidenceRecord, len(in.Evidence))
	for _, rec := range in.Evidence {
		byID[rec.ID] = rec
	}

	var activeHyps []types.Hypothesis
	var unresolvedHyps []string
	for _, hyp := range in.Hypotheses {
		switch hyp.Status {
		case types.HypActive, types.HypRevised:
			activeHyps = append(activeHyps, hyp)
		case types.HypReevaluate, types.HypWeakened, types.HypFrozen:
			unresolvedHyps = append(unresolvedHyps, hyp.ID)
		}
	}

	hardReject := false

	// Check 1: direct_evidence
	check1 := types.AuditCheck{
		ID:    AuditCheckDirectEvidence,
		Label: "结论有直接账本证据支撑",
	}
	var dangling, errorCited, unsupported []string
	for _, hyp := range activeHyps {
		if len(hyp.Supporting) == 0 {
			unsupported = append(unsupported, hyp.ID)
			continue
		}
		validCount := 0
		for _, eid := range hyp.Supporting {
			rec, ok := byID[eid]
			if !ok {
				dangling = append(dangling, hyp.ID+":"+eid)
				continue
			}
			if rec.IsError {
				errorCited = append(errorCited, hyp.ID+":"+eid)
				continue
			}
			validCount++
		}
		if validCount == 0 && len(dangling) == 0 && len(errorCited) == 0 {
			unsupported = append(unsupported, hyp.ID)
		}
	}
	for _, f := range in.Findings {
		if f.Rule == RuleRuntimeContradiction && f.Applied {
			for _, hyp := range activeHyps {
				if hyp.ID == f.HypothesisID {
					errorCited = append(errorCited, hyp.ID+":"+f.EvidenceID)
				}
			}
		}
	}
	switch {
	case len(dangling) > 0:
		hardReject = true
		check1.Detail = "dangling citations: " + strings.Join(dangling, ", ")
	case len(errorCited) > 0:
		hardReject = true
		check1.Detail = "error/contradicted evidence cited: " + strings.Join(errorCited, ", ")
	case len(activeHyps) == 0:
		check1.Detail = "no active hypotheses recorded"
	case len(unsupported) > 0:
		check1.Detail = "hypotheses lack direct evidence: " + strings.Join(unsupported, ", ")
	default:
		check1.Pass = true
		check1.Detail = fmt.Sprintf("%d active conclusion(s) backed by valid ledger records", len(activeHyps))
	}

	// Check 2: failure_edge_coverage (guards against single-sample hits)
	check2 := types.AuditCheck{
		ID:    AuditCheckFailureEdgeCoverage,
		Label: "证据覆盖边界与失败输入（非单样本命中）",
	}
	var verRecords []types.EvidenceRecord
	var bestPass *types.VerificationStats
	var bestPassRec types.EvidenceRecord
	anyRun := false
	anyNonZeroPass := false
	for _, rec := range in.Evidence {
		if rec.Kind == string(evidence.KindVerification) && rec.Verification != nil {
			verRecords = append(verRecords, rec)
			anyRun = true
			if rec.Verification.Passed > 0 {
				anyNonZeroPass = true
			}
			if rec.Verification.Total > 0 && rec.Verification.Passed == rec.Verification.Total {
				if bestPass == nil || rec.Verification.Total > bestPass.Total ||
					(rec.Verification.Total == bestPass.Total && rec.Verification.BoundaryPassed > bestPass.BoundaryPassed) {
					copied := *rec.Verification
					bestPass = &copied
					bestPassRec = rec
				}
			}
		}
	}
	switch {
	case !anyRun:
		check2.Detail = "no verification_result recorded yet"
	case !anyNonZeroPass:
		hardReject = true
		check2.Detail = "all verification replay runs failed (0 passed)"
	case bestPass == nil:
		check2.Detail = "no verification run passed all replay cases"
	case bestPass.Total < 2:
		check2.Detail = fmt.Sprintf("single-sample hit only (%d/%d in %s); need >= 2 cases with failure/boundary coverage", bestPass.Passed, bestPass.Total, bestPassRec.ID)
	case bestPass.Status == types.VerificationCandidate:
		check2.Detail = fmt.Sprintf("verification %s still in candidate status; promote to verified after differential/boundary check", bestPassRec.ID)
	case bestPass.BoundaryPassed == 0 && bestPass.DifferentialCases == 0:
		check2.Detail = fmt.Sprintf("verification %s (%d/%d) missing failure/boundary or differential test coverage", bestPassRec.ID, bestPass.Passed, bestPass.Total)
	default:
		check2.Pass = true
		check2.Detail = fmt.Sprintf("%d/%d replay passed (boundary=%d, diff=%d) in %s",
			bestPass.Passed, bestPass.Total, bestPass.BoundaryPassed, bestPass.DifferentialCases, bestPassRec.ID)
	}

	// Check 3: simpler_alternative
	check3 := types.AuditCheck{
		ID:    AuditCheckSimplerAlternative,
		Label: "已排查更简单替代解释与单视角偏差",
	}
	var singleViewHigh []string
	for _, hyp := range activeHyps {
		if hyp.Confidence < singleViewConfidence {
			continue
		}
		hasStatic, hasDynamic := false, false
		for _, eid := range hyp.Supporting {
			rec, ok := byID[eid]
			if !ok || rec.IsError {
				continue
			}
			if rec.View == evidence.ViewDynamic || rec.Kind == string(evidence.KindVerification) || rec.Kind == string(evidence.KindRuntimeTrace) {
				hasDynamic = true
			} else {
				hasStatic = true
			}
		}
		if hasStatic && !hasDynamic && len(hyp.Falsifiers) == 0 {
			singleViewHigh = append(singleViewHigh, hyp.ID)
		}
	}
	switch {
	case len(unresolvedHyps) > 0:
		check3.Detail = "unresolved hypotheses awaiting re-examination: " + strings.Join(unresolvedHyps, ", ")
	case len(singleViewHigh) > 0:
		check3.Detail = "high-confidence static-only claim(s) without falsifiers or dynamic check: " + strings.Join(singleViewHigh, ", ")
	case len(activeHyps) == 0:
		check3.Detail = "no settled hypotheses to compare alternatives against"
	default:
		check3.Pass = true
		check3.Detail = "no unresolved cascade; active conclusions cross-checked across views/falsifiers"
	}

	// Check 4: scope_overreach
	check4 := types.AuditCheck{
		ID:    AuditCheckScopeOverreach,
		Label: "无任务范围外文件/网络/设备/凭据越权访问",
	}
	if in.OverreachCount > 0 {
		hardReject = true
		check4.Detail = fmt.Sprintf("%d unauthorized out-of-scope access(es) detected", in.OverreachCount)
	} else if in.BlockedAttempts > 0 {
		check4.Pass = true
		check4.Detail = fmt.Sprintf("0 unauthorized accesses (%d out-of-scope attempt(s) intercepted by Capability Sandbox)", in.BlockedAttempts)
	} else {
		check4.Pass = true
		check4.Detail = "0 out-of-scope accesses recorded"
	}

	// Check 5: artifact_lineage
	check5 := types.AuditCheck{
		ID:    AuditCheckArtifactLineage,
		Label: "交付产物与记录步骤血缘一致（且非仅依赖不可信原始文本）",
	}
	var untrustedOnly []string
	for _, hyp := range activeHyps {
		if len(hyp.Supporting) == 0 {
			continue
		}
		allUntrusted := true
		for _, eid := range hyp.Supporting {
			rec, ok := byID[eid]
			if !ok {
				continue
			}
			if !rec.UntrustedInput {
				allUntrusted = false
				break
			}
		}
		if allUntrusted {
			untrustedOnly = append(untrustedOnly, hyp.ID)
		}
	}
	hasLineage := false
	for _, rec := range verRecords {
		if rec.SHA256 != "" || rec.Artifact != "" || (rec.Verification != nil && rec.Verification.ID != "") || strings.TrimSpace(rec.Excerpt) != "" {
			hasLineage = true
			break
		}
	}
	switch {
	case len(untrustedOnly) > 0:
		check5.Detail = "conclusions rely solely on untrusted raw input without verified derivation: " + strings.Join(untrustedOnly, ", ")
	case len(verRecords) == 0:
		check5.Detail = "no verified artifact or replay lineage recorded yet"
	case !hasLineage:
		hardReject = true
		check5.Detail = "verification record lacks provenance (sha256/artifact/excerpt)"
	default:
		check5.Pass = true
		check5.Detail = fmt.Sprintf("%d verification record(s) linked to append-only ledger provenance", len(verRecords))
	}

	checks := []types.AuditCheck{check1, check2, check3, check4, check5}
	passedCount := 0
	for _, c := range checks {
		if c.Pass {
			passedCount++
		}
	}

	verdict := types.AuditNeedsMoreEvidence
	summary := fmt.Sprintf("needs_more_evidence (%d/5 audit checks passed)", passedCount)
	if hardReject {
		verdict = types.AuditRejected
		summary = fmt.Sprintf("rejected (%d/5 checks passed; hard integrity/scope violation)", passedCount)
	} else if passedCount == len(checks) {
		verdict = types.AuditAccepted
		summary = "accepted (5/5 adversarial audit checks passed)"
	}

	return types.AuditEvaluation{
		Verdict: verdict,
		Checks:  checks,
		Summary: summary,
	}
}
