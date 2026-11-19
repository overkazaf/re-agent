package main

// ApprovalBridge: types.ToolContext.Confirm is synchronous — a tool call blocks
// until someone answers. The GUI turns that inside out: register the pending
// approval, push kind=approval to the WebView, and block on a reply channel (or
// the session ctx, so a closing session denies instead of hanging the tool).
// App.Approve delivers the frontend's decision.
//
// allow-always / deny-always need no memory table here: security.applyMemory
// writes the override into the session's cloned ExecutionPolicy.Approvals, so
// the next request for the same tool auto-resolves inside RequestApproval.

import (
	"context"
	"fmt"
	"sync"

	"github.com/overkazaf/re-agent/internal/types"
)

// pendingApproval is one unresolved approval request.
type pendingApproval struct {
	sessionID string
	dto       ApprovalDTO
	reply     chan types.ApprovalDecision
	resolved  bool
}

// ApprovalBridge owns the pending-approval table and the push/block exchange.
// emit is injectable so tests capture envelopes without a WebView.
type ApprovalBridge struct {
	mu      sync.Mutex
	emit    func(envelope EventEnvelope)
	nextID  int
	pending map[string]*pendingApproval // requestID → request
}

func NewApprovalBridge() *ApprovalBridge {
	return &ApprovalBridge{
		nextID:  1,
		pending: map[string]*pendingApproval{},
	}
}

// SetEmit retargets envelope delivery (wired at app startup, swapped in tests).
func (b *ApprovalBridge) SetEmit(emit func(envelope EventEnvelope)) {
	b.mu.Lock()
	b.emit = emit
	b.mu.Unlock()
}

func (b *ApprovalBridge) emitLocked(envelope EventEnvelope) {
	if b.emit != nil {
		b.emit(envelope)
	}
}

// Approver adapts the bridge to the SessionManager approver slot.
func (b *ApprovalBridge) Approver() Approver {
	return func(sessionID string, request types.ApprovalRequest, ctx context.Context) types.ApprovalDecision {
		return b.Confirm(sessionID, ctx, request)
	}
}

// Confirm registers the request, pushes it, and blocks for the decision.
// A cancelled ctx (session closing) resolves to deny — the safe default.
func (b *ApprovalBridge) Confirm(sessionID string, ctx context.Context, request types.ApprovalRequest) types.ApprovalDecision {
	b.mu.Lock()
	id := fmt.Sprintf("apr-%04d", b.nextID)
	b.nextID++
	concerns := make([]string, len(request.Concerns))
	copy(concerns, request.Concerns)
	pending := &pendingApproval{
		sessionID: sessionID,
		dto: ApprovalDTO{
			RequestID: id,
			ToolName:  request.Tool,
			Risk:      riskLabel(request.Tier),
			// ApprovalRequest carries one human-readable line (the command or
			// path for exec/write tools); it feeds both dialog fields.
			Summary:     request.Summary,
			ArgsPreview: request.Summary,
			Concerns:    concerns,
		},
		reply: make(chan types.ApprovalDecision, 1),
	}
	b.pending[id] = pending
	b.emitLocked(EventEnvelope{
		SessionID: sessionID, Kind: "approval", Ts: types.NowMs(), Data: pending.dto,
	})
	b.mu.Unlock()

	select {
	case decision := <-pending.reply:
		b.remove(id)
		return decision
	case <-ctx.Done():
		b.remove(id)
		return types.DecisionDeny
	}
}

// Deliver resolves one pending approval from the frontend. Unknown ids, wrong
// sessions, and double deliveries are errors, not silent no-ops.
func (b *ApprovalBridge) Deliver(sessionID, requestID, decision string) error {
	parsed, ok := parseDecision(decision)
	if !ok {
		return fmt.Errorf("unknown decision: %s (want allow | allow-always | deny | deny-always)", decision)
	}
	b.mu.Lock()
	pending, ok := b.pending[requestID]
	if !ok {
		b.mu.Unlock()
		return fmt.Errorf("no pending approval %s", requestID)
	}
	if pending.sessionID != sessionID {
		b.mu.Unlock()
		return fmt.Errorf("approval %s belongs to session %s", requestID, pending.sessionID)
	}
	if pending.resolved {
		b.mu.Unlock()
		return fmt.Errorf("approval %s already resolved", requestID)
	}
	pending.resolved = true
	b.mu.Unlock()

	pending.reply <- parsed
	return nil
}

// Pending lists the open approvals for one session (GetState / reconnect).
func (b *ApprovalBridge) Pending(sessionID string) []ApprovalDTO {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []ApprovalDTO
	for _, pending := range b.pending {
		if pending.sessionID == sessionID {
			out = append(out, pending.dto)
		}
	}
	return out
}

// DenyAll resolves every open approval for a session with deny — the close-path
// backstop alongside the ctx cancellation.
func (b *ApprovalBridge) DenyAll(sessionID string) {
	b.mu.Lock()
	ids := make([]string, 0)
	for id, pending := range b.pending {
		if pending.sessionID == sessionID && !pending.resolved {
			pending.resolved = true
			ids = append(ids, id)
		}
	}
	b.mu.Unlock()
	for _, id := range ids {
		b.mu.Lock()
		pending := b.pending[id]
		b.mu.Unlock()
		if pending != nil {
			pending.reply <- types.DecisionDeny
		}
	}
}

func (b *ApprovalBridge) remove(id string) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

// parseDecision maps the frontend decision strings onto ApprovalDecision.
func parseDecision(value string) (types.ApprovalDecision, bool) {
	switch types.ApprovalDecision(value) {
	case types.DecisionAllow, types.DecisionAllowAlways, types.DecisionDeny, types.DecisionDenyAlways:
		return types.ApprovalDecision(value), true
	}
	return "", false
}

// riskLabel maps the approval tier onto the DTO risk vocabulary
// (read | write | network | exec); exec covers execute and network tiers.
func riskLabel(tier types.ApprovalTier) string {
	switch tier {
	case types.TierRead:
		return "read"
	case types.TierWrite:
		return "write"
	default:
		return "exec"
	}
}
