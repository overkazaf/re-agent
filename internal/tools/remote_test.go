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
	ptys    []string
	current string
}

func (f *fakeRemote) Run(ctx context.Context, name, command string) (string, error) {
	f.ran = append(f.ran, name+":"+command)
	return f.output, f.err
}

func (f *fakeRemote) RunPty(ctx context.Context, name, command string, cols, rows int) (string, error) {
	f.ptys = append(f.ptys, name+":"+command)
	return f.output, f.err
}

func (f *fakeRemote) Current() string { return f.current }

func (f *fakeRemote) Connected(name string) bool { return f.current == name }

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
	if len(fake.ptys) != 1 || fake.ptys[0] != "lab:uname -a" {
		t.Fatalf("unexpected remote call: %+v", fake.ptys)
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
	if !strings.Contains(types.TextFromBlocks(result.Content), "remote ok") {
		t.Fatalf("remote output missing: %q", types.TextFromBlocks(result.Content))
	}
	// Default remote execution allocates a PTY (ssh -tt semantics).
	if len(fake.ptys) != 1 || fake.ptys[0] != "lab:echo remote" {
		t.Fatalf("run_command should use a PTY by default: %+v", fake.ptys)
	}
}

func TestRemoteExecCanDisablePty(t *testing.T) {
	fake := &fakeRemote{output: "ok", current: "lab"}
	tc := types.ToolContext{
		Policy:     policyForTools(),
		Remote:     fake,
		RemoteHost: "lab",
		Confirm: func(types.ApprovalRequest) types.ApprovalDecision {
			return types.DecisionAllow
		},
	}
	tool := remoteExecTool()
	if _, err := tool.Execute(map[string]any{"command": "ls", "pty": false}, tc); err != nil {
		t.Fatal(err)
	}
	if len(fake.ptys) != 0 || len(fake.ran) != 1 {
		t.Fatalf("pty=false should use the plain runner: pty=%+v run=%+v", fake.ptys, fake.ran)
	}
}
