package security

// Tool approval. Two independent inputs decide whether a call runs:
//
//  1. the tool's tier (read / write / exec), from its declared risk
//  2. the session's approval mode, plus any per-tool override
//
// On top of that, a command that trips a safety pattern (rm -rf, curl with the
// network off, anything that looks like a credential) always asks — that is the
// one case an "allow" override does not silence.

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

var ApprovalModes = []types.ApprovalMode{
	types.ApprovalYolo, types.ApprovalSafe, types.ApprovalWrite, types.ApprovalAlwaysAsk,
}

const DefaultApprovalMode = types.ApprovalSafe

func IsApprovalMode(value string) bool {
	for _, mode := range ApprovalModes {
		if string(mode) == value {
			return true
		}
	}
	return false
}

// DeniedError marks a refusal, so the REPL can report it as a decision rather
// than as a crash.
type DeniedError struct{ Message string }

func (e *DeniedError) Error() string { return e.Message }

func IsDenied(err error) bool {
	var denied *DeniedError
	return err != nil && asDenied(err, &denied)
}

func asDenied(err error, target **DeniedError) bool {
	for err != nil {
		if typed, ok := err.(*DeniedError); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

func TierForRisk(risk types.Risk) types.ApprovalTier {
	switch risk {
	case types.RiskRead:
		return types.TierRead
	case types.RiskWrite:
		return types.TierWrite
	default:
		// execute and network are both "can do anything" tiers
		return types.TierExec
	}
}

func AutoApproves(mode types.ApprovalMode, tier types.ApprovalTier) bool {
	if mode == types.ApprovalYolo || mode == types.ApprovalSafe {
		return true // `safe` only reacts to concerns
	}
	if tier == types.TierRead {
		return true
	}
	if mode == types.ApprovalWrite {
		return tier == types.TierWrite
	}
	return false // always-ask
}

// RequestApproval resolves one approval, prompting through tc.Confirm when a
// human is attached. Returns nil when the call may proceed.
func RequestApproval(request types.ApprovalRequest, tc types.ToolContext) error {
	policy := tc.Policy
	mode := policy.ApprovalMode
	if mode == "" {
		mode = DefaultApprovalMode
	}
	override := ""
	if policy.Approvals != nil {
		override = policy.Approvals[request.Tool]
	}
	if override == "deny" {
		return &DeniedError{Message: fmt.Sprintf("Tool '%s' is denied for this session.", request.Tool)}
	}

	// Safety concerns outrank an "allow" override in every mode but yolo: the
	// operator allowing `run_command` is not the same as allowing `rm -rf /`.
	mustAsk := len(request.Concerns) > 0 && mode != types.ApprovalYolo
	if !mustAsk && (override == "allow" || AutoApproves(mode, request.Tier)) {
		return nil
	}

	if tc.Confirm == nil {
		return &DeniedError{Message: refusalMessage(request, mode)}
	}

	decision := tc.Confirm(request)
	applyMemory(decision, request, policy)
	if decision == types.DecisionAllow || decision == types.DecisionAllowAlways {
		return nil
	}
	return &DeniedError{Message: fmt.Sprintf("Operator denied %s: %s", request.Tool, request.Summary)}
}

func applyMemory(decision types.ApprovalDecision, request types.ApprovalRequest, policy *types.ExecutionPolicy) {
	if decision != types.DecisionAllowAlways && decision != types.DecisionDenyAlways {
		return
	}
	if policy.Approvals == nil {
		policy.Approvals = map[string]string{}
	}
	if decision == types.DecisionAllowAlways {
		policy.Approvals[request.Tool] = "allow"
	} else {
		policy.Approvals[request.Tool] = "deny"
	}
}

// refusalMessage is what a non-interactive run reports instead of hanging on a
// prompt.
func refusalMessage(request types.ApprovalRequest, mode types.ApprovalMode) string {
	if len(request.Concerns) > 0 {
		return "Blocked by policy: " + strings.Join(request.Concerns, "; ")
	}
	return fmt.Sprintf(
		"Tool '%s' needs approval (mode=%s) and this run is not interactive. Use --approval yolo or run it in the REPL.",
		request.Tool, mode,
	)
}
