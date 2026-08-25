package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

type fakeRemote struct {
	host    string
	output  string
	err     error
	ran     []string
	current string
}

func (f *fakeRemote) Run(ctx context.Context, name, command string) (string, error) {
	f.ran = append(f.ran, name+":"+command)
	return f.output, f.err
}

func (f *fakeRemote) Current() string { return f.current }

func policyForTools() *types.ExecutionPolicy {
	return &types.ExecutionPolicy{
		CommandTimeoutMs: 5000, MaxReadBytes: 1024, MaxToolOutputChars: 4000,
		ApprovalMode: types.ApprovalYolo, Approvals: map[string]string{},
	}
}

func TestRemoteExecRunsOnCurrentHost(t *testing.T) {
	fake := &fakeRemote{output: "uname -a", current: "lab"}
	tc := types.ToolContext{
		Policy: policyForTools(),
		Remote: fake,
		Confirm: func(types.ApprovalRequest) types.ApprovalDecision {
			return types.DecisionAllow
		},
	}
	tool := remoteExecTool()
	result, err := tool.Execute(map[string]any{"command": "uname -a"}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.ran) != 1 || fake.ran[0] != "lab:uname -a" {
		t.Fatalf("unexpected remote call: %+v", fake.ran)
	}
	if !strings.Contains(types.TextFromBlocks(result.Content), "uname -a") {
		t.Fatalf("output missing: %q", types.TextFromBlocks(result.Content))
	}
}

func TestRemoteExecRequiresAHost(t *testing.T) {
	fake := &fakeRemote{}
	tc := types.ToolContext{
		Policy:  policyForTools(),
		Remote:  fake,
		Confirm: func(types.ApprovalRequest) types.ApprovalDecision { return types.DecisionAllow },
	}
	tool := remoteExecTool()
	if _, err := tool.Execute(map[string]any{"command": "ls"}, tc); err == nil {
		t.Fatal("remote_exec without any host should fail")
	}
}

func TestRemoteExecWithoutManagerFails(t *testing.T) {
	tool := remoteExecTool()
	if _, err := tool.Execute(map[string]any{"command": "ls"}, types.ToolContext{
		Policy: policyForTools(),
	}); err == nil {
		t.Fatal("missing SSH manager should fail")
	}
}

func TestRunCommandRedirectsToRemoteHost(t *testing.T) {
	fake := &fakeRemote{output: "remote ok", current: "lab"}
	tc := types.ToolContext{
		Policy:     policyForTools(),
		Remote:     fake,
		RemoteHost: "lab",
		Confirm: func(types.ApprovalRequest) types.ApprovalDecision {
			return types.DecisionAllow
		},
	}
	tool := runCommandTool()
	result, err := tool.Execute(map[string]any{"command": "echo remote"}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.ran) != 1 || fake.ran[0] != "lab:echo remote" {
		t.Fatalf("run_command did not redirect: %+v", fake.ran)
	}
	if !strings.Contains(types.TextFromBlocks(result.Content), "remote ok") {
		t.Fatalf("remote output missing: %q", types.TextFromBlocks(result.Content))
	}
}
