// The adversarial auditor: a second provider re-reads the hypothesis stack
// and the evidence ledger from scratch — no transcript, no tools — and its
// verdict lines become real mutations on the stack. Where the arbitrator's
// rules are deterministic, this pass brings a fresh model's judgment; both
// funnel through the same Challenge/Support transitions, so the audit can
// never keep a claim alive by argument alone.
package core

import (
	"context"
	"fmt"
	"hash/fnv"
	"regexp"
	"sort"
	"strings"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/hypothesis"
	"github.com/overkazaf/re-agent/internal/types"
)

// AuditReport is what one audit pass concluded.
type AuditReport struct {
	Provider string
	Findings []types.Finding
	Turns    int
}

// auditVerdictPattern parses one verdict line:
//
//	AUDIT H-001 CHALLENGE ev_003 the cited run actually errored
//	AUDIT H-001 SUPPORT - the claim is consistent with the packet
const auditVerdictPattern = `(?im)^AUDIT\s+(H-\d+)\s+(CHALLENGE|SUPPORT)\s+(\S+)\s+(.+)$`

var auditVerdictRe = regexp.MustCompile(auditVerdictPattern)

// auditSystemPrompt tells the auditor seat what it is for. It is deliberately
// format-strict: verdict lines are the only channel back into the stack.
const auditSystemPrompt = `You are an adversarial auditor. Another AI agent is reverse-engineering a ` +
	`target and maintains a hypothesis stack backed by an evidence ledger. You receive both, out of ` +
	`context, with no tools: judge the packet you are given and nothing else.

Attack the stack: claims resting on a single static view, claims citing error-flagged evidence, ` +
	`runtime observations that contradict a static claim, overgeneralization from one artifact, ` +
	`confidence that outruns the evidence. Also confirm claims the packet genuinely supports.

End your reply with one verdict line per judgment, exactly:
AUDIT H-001 CHALLENGE ev_003 <one-line reason>
AUDIT H-001 SUPPORT ev_001 <one-line reason>
Use - instead of an evidence id when no single record carries the point. If the stack is sound, ` +
	`say so in prose and emit no verdict lines. Never invent ids that are not in the packet.`

// auditProviderName picks the audit seat: the configured override, else a
// provider outside the main seats and whoever answered last, else the last
// provider, else the executor. A single-provider setup still audits — fresh
// context is worth something even without a second model.
func (l *AgentLoop) auditProviderName() string {
	if name := l.options.Config.AuditProvider; name != "" {
		if _, ok := l.options.Providers[name]; ok {
			return name
		}
	}
	exclude := map[string]bool{
		l.options.Config.PlannerProvider:  true,
		l.options.Config.ExecutorProvider: true,
		l.lastProviderName:                true,
	}
	names := make([]string, 0, len(l.options.Providers))
	for name := range l.options.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !exclude[name] {
			return name
		}
	}
	if l.lastProviderName != "" {
		if _, ok := l.options.Providers[l.lastProviderName]; ok {
			return l.lastProviderName
		}
	}
	return l.options.Config.ExecutorProvider
}

// auditPacket is what the auditor sees: the whole metacognition state, out of
// context, plus the verdict format it must answer in.
func (l *AgentLoop) auditPacket() string {
	active := 0
	for _, hyp := range l.hypotheses.List() {
		if hyp.Status == types.HypActive || hyp.Status == types.HypReevaluate {
			active++
		}
	}
	if active == 0 {
		return ""
	}
	return strings.Join([]string{
		"## Hypothesis stack under audit",
		"",
		hypothesis.Digest(l.hypotheses.List(), maxStackDigest),
		"",
		"## Evidence ledger",
		"",
		l.evidence.Digest(24),
	}, "\n")
}

// Audit runs one adversarial pass and applies its verdicts. The run is
// isolated and tool-free: the auditor cannot act on the target, only judge.
func (l *AgentLoop) Audit(ctx context.Context, onEvent func(LoopEvent)) (AuditReport, error) {
	packet := l.auditPacket()
	if packet == "" {
		return AuditReport{}, nil
	}
	providerName := l.auditProviderName()
	if _, ok := l.options.Providers[providerName]; !ok {
		return AuditReport{}, fmt.Errorf("provider not configured: %s", providerName)
	}

	// The audit is a guest run: whoever answered last for the main loop keeps
	// that role once the audit is over.
	last := l.lastProviderName
	result, err := l.Run(packet, RunOptions{
		ProviderName: providerName,
		Ctx:          ctx,
		OnEvent:      onEvent,
		Isolated:     true,
		FreshSession: true,
		SystemPrompt: auditSystemPrompt,
		Tools:        []types.Tool{},
	})
	l.lastProviderName = last
	if err != nil {
		return AuditReport{Provider: providerName}, err
	}

	report := AuditReport{Provider: providerName, Turns: result.Turns}
	verdict := types.TextFromBlocks(lastTextBlocks(result.Messages))
	for _, match := range auditVerdictRe.FindAllStringSubmatch(verdict, -1) {
		hypID, verb, cited, reason := match[1], match[2], match[3], strings.TrimSpace(match[4])
		finding := l.applyVerdict(hypID, verb, cited, reason)
		if finding != nil {
			report.Findings = append(report.Findings, *finding)
		}
	}
	// The audit report is an event, not transcript lore: replay shows what the
	// second model concluded and what it changed.
	_ = l.options.Session.AppendEvent(map[string]any{
		"type": "audit", "provider": providerName, "findings": report.Findings,
	})
	return report, nil
}

// applyVerdict turns one parsed line into a stack mutation. Unknown
// hypotheses, unsupported states, and cited-but-absent records fail closed:
// the finding is dropped rather than guessed into the stack.
func (l *AgentLoop) applyVerdict(hypID, verb, cited, reason string) *types.Finding {
	hyp, ok := l.hypotheses.Get(hypID)
	if !ok || (hyp.Status != types.HypActive && hyp.Status != types.HypReevaluate) {
		return nil
	}
	finding := &types.Finding{
		Rule:         "adversarial-audit",
		HypothesisID: hypID,
		Action:       strings.ToLower(verb),
		Message:      reason,
	}
	if evidenceID := l.auditEvidenceID(hypID, cited, reason); evidenceID != "" {
		finding.EvidenceID = evidenceID
	}
	var err error
	switch verb {
	case "CHALLENGE":
		if finding.EvidenceID == "" {
			return nil
		}
		_, err = l.hypotheses.Challenge(hypID, finding.EvidenceID, reason)
	case "SUPPORT":
		if finding.EvidenceID == "" {
			return nil
		}
		_, err = l.hypotheses.Support(hypID, finding.EvidenceID)
	default:
		return nil
	}
	if err != nil {
		return nil
	}
	finding.Applied = true
	return finding
}

// auditEvidenceID resolves the record a verdict cites: a real ledger id as
// -is; otherwise the objection itself is synthesized into the ledger, keyed by
// the reason hash so a repeat audit reuses the record instead of re-minting
// it (and the tracker's per-record idempotency then absorbs the repeat).
func (l *AgentLoop) auditEvidenceID(hypID, cited, reason string) string {
	if cited != "-" && cited != "" {
		if _, ok := l.evidence.Get(cited); ok {
			return cited
		}
	}
	key := "audit:" + hypID + ":" + reasonHash(reason)
	for _, record := range l.evidence.List() {
		if record.ToolCallID == key {
			return record.ID
		}
	}
	record := l.evidence.Add(evidence.Input{
		Source:     "audit",
		Kind:       "verification",
		Text:       reason,
		ToolCallID: key,
	})
	_ = l.options.Session.AppendEvent(map[string]any{"type": "evidence", "record": record})
	return record.ID
}

// reasonHash is a short stable key for one objection, stable across restarts.
func reasonHash(reason string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(reason))
	return fmt.Sprintf("%08x", h.Sum32())
}

// lastTextBlocks is the final assistant text of a run: where verdict lines live.
func lastTextBlocks(messages []types.Message) []types.ContentBlock {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "assistant" {
			return messages[i].Blocks
		}
	}
	return nil
}
