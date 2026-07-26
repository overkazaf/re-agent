package security

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func policy(mode types.ApprovalMode) *types.ExecutionPolicy {
	return &types.ExecutionPolicy{ApprovalMode: mode, Approvals: map[string]string{}}
}

func TestSafeModeRunsToolsButStopsForConcerns(t *testing.T) {
	tc := types.ToolContext{Policy: policy(types.ApprovalSafe)}
	if err := RequestApproval(types.ApprovalRequest{Tool: "run_command", Tier: types.TierExec}, tc); err != nil {
		t.Fatalf("safe mode should auto-approve a clean exec: %v", err)
	}
	err := RequestApproval(types.ApprovalRequest{
		Tool: "run_command", Tier: types.TierExec, Concerns: []string{"destructive pattern"},
	}, tc)
	if err == nil {
		t.Fatal("a concern with no one to ask must refuse")
	}
	if !strings.Contains(err.Error(), "Blocked by policy") {
		t.Fatalf("unexpected refusal message: %v", err)
	}
}

func TestYoloNeverAsks(t *testing.T) {
	tc := types.ToolContext{Policy: policy(types.ApprovalYolo)}
	if err := RequestApproval(types.ApprovalRequest{
		Tool: "run_command", Tier: types.TierExec, Concerns: []string{"rm -rf"},
	}, tc); err != nil {
		t.Fatalf("yolo should approve everything: %v", err)
	}
}

func TestAlwaysAskStopsForEverythingButReads(t *testing.T) {
	tc := types.ToolContext{Policy: policy(types.ApprovalAlwaysAsk)}
	if err := RequestApproval(types.ApprovalRequest{Tool: "read_file", Tier: types.TierRead}, tc); err != nil {
		t.Fatalf("reads stay free: %v", err)
	}
	if err := RequestApproval(types.ApprovalRequest{Tool: "write_file", Tier: types.TierWrite}, tc); err == nil {
		t.Fatal("always-ask must stop for a write with no one to ask")
	}
}

func TestConcernsOutrankAnAllowOverride(t *testing.T) {
	tc := types.ToolContext{Policy: policy(types.ApprovalSafe)}
	tc.Policy.Approvals["run_command"] = "allow"
	asked := false
	tc.Confirm = func(types.ApprovalRequest) types.ApprovalDecision {
		asked = true
		return types.DecisionAllow
	}
	if err := RequestApproval(types.ApprovalRequest{
		Tool: "run_command", Tier: types.TierExec, Concerns: []string{"network command 'curl'"},
	}, tc); err != nil {
		t.Fatal(err)
	}
	if !asked {
		t.Fatal("allowing a tool is not the same as allowing a dangerous command")
	}
}

func TestAlwaysDecisionsAreRemembered(t *testing.T) {
	tc := types.ToolContext{Policy: policy(types.ApprovalAlwaysAsk)}
	tc.Confirm = func(types.ApprovalRequest) types.ApprovalDecision { return types.DecisionAllowAlways }
	request := types.ApprovalRequest{Tool: "write_file", Tier: types.TierWrite}
	if err := RequestApproval(request, tc); err != nil {
		t.Fatal(err)
	}
	if tc.Policy.Approvals["write_file"] != "allow" {
		t.Fatalf("allow-always was not stored: %+v", tc.Policy.Approvals)
	}
	tc.Confirm = func(types.ApprovalRequest) types.ApprovalDecision {
		t.Fatal("a remembered allow should not ask again")
		return types.DecisionDeny
	}
	if err := RequestApproval(request, tc); err != nil {
		t.Fatal(err)
	}
}

func TestDenyAlwaysBlocksLater(t *testing.T) {
	tc := types.ToolContext{Policy: policy(types.ApprovalAlwaysAsk)}
	tc.Confirm = func(types.ApprovalRequest) types.ApprovalDecision { return types.DecisionDenyAlways }
	request := types.ApprovalRequest{Tool: "run_command", Tier: types.TierExec}
	if err := RequestApproval(request, tc); err == nil {
		t.Fatal("a denial must be an error")
	}
	tc.Confirm = nil
	err := RequestApproval(request, tc)
	if err == nil || !strings.Contains(err.Error(), "denied for this session") {
		t.Fatalf("deny-always was not remembered: %v", err)
	}
	if !IsDenied(err) {
		t.Fatal("IsDenied should recognise a refusal")
	}
}

func TestTierForRisk(t *testing.T) {
	cases := map[types.Risk]types.ApprovalTier{
		types.RiskRead:    types.TierRead,
		types.RiskWrite:   types.TierWrite,
		types.RiskExecute: types.TierExec,
		types.RiskNetwork: types.TierExec,
	}
	for risk, want := range cases {
		if got := TierForRisk(risk); got != want {
			t.Fatalf("risk %s mapped to %s, want %s", risk, got, want)
		}
	}
}
