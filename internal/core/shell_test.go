package core

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestShellEscapeParsing(t *testing.T) {
	if !IsShellEscape("!ls -la") || IsShellEscape("ls -la") {
		t.Fatal("shell escapes are the lines starting with !")
	}
	if got := ParseShellEscape("!  ls -la  "); got != "ls -la" {
		t.Fatalf("marker not stripped: %q", got)
	}
	if got := ParseShellEscape("!"); got != "" {
		t.Fatalf("a bare marker is an empty command: %q", got)
	}
}

func TestIsChdirInterceptsOnlyThePureForm(t *testing.T) {
	for _, command := range []string{"cd", "cd ..", "cd /tmp", "cd  ~/work", "cd internal/ui"} {
		if !IsChdir(command) {
			t.Fatalf("a bare cd should be intercepted: %q", command)
		}
	}
	for _, command := range []string{"cd foo && ls", "cd foo; ls", "cd foo | tee x", "ls", "cdr", "echo cd"} {
		if IsChdir(command) {
			t.Fatalf("only a standalone cd may be intercepted: %q", command)
		}
	}
}

func TestResolveChdirMovesAndReportsFailures(t *testing.T) {
	policy := &types.ExecutionPolicy{CommandTimeoutMs: 5000}
	root := t.TempDir()

	moved, err := ResolveChdir(root, "cd .", policy)
	if err != nil {
		t.Fatal(err)
	}
	// The workspace resolves through symlinks (macOS /tmp, for one), so compare
	// against pwd's own answer rather than the raw temp path.
	if !strings.HasSuffix(moved, root) && moved != root {
		// pwd -P may differ from t.TempDir()'s prefix; a relative cd . must at
		// least stay put, so re-resolving it is idempotent.
		again, err := ResolveChdir(moved, "cd .", policy)
		if err != nil || again != moved {
			t.Fatalf("cd . should be idempotent: %q -> %q (%v)", moved, again, err)
		}
	}

	if _, err := ResolveChdir(root, "cd does-not-exist", policy); err == nil {
		t.Fatal("cd into a missing directory must be an error")
	}
}

func TestRunShellCommandCapturesOutputAndStreams(t *testing.T) {
	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 5000, ApprovalMode: types.ApprovalYolo, Approvals: map[string]string{},
	}
	var streamed strings.Builder
	result, err := RunShellCommand("printf 'a\nb\n'; printf 'oops\n' >&2; exit 2", ShellRunOptions{
		Workspace: t.TempDir(), Policy: policy, PreApproved: true,
		OnChunk: func(stream, text string) { streamed.WriteString(text) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Code != 2 || !strings.Contains(result.Stdout, "a\nb") || !strings.Contains(result.Stderr, "oops") {
		t.Fatalf("command result wrong: %+v", result)
	}
	if !strings.Contains(streamed.String(), "a") {
		t.Fatal("output should also stream as it arrives")
	}

	message := ShellContextMessage(result, ShellContextMaxChars)
	for _, want := range []string{"[operator shell]", "exit=2", "stdout:", "stderr:"} {
		if !strings.Contains(message, want) {
			t.Fatalf("transcript entry missing %q:\n%s", want, message)
		}
	}
}

func TestRunShellCommandSkipsBrokenPathBash(t *testing.T) {
	dir := t.TempDir()
	brokenBash := filepath.Join(dir, "bash")
	if err := os.Symlink(filepath.Join(dir, "missing-bash"), brokenBash); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("SHELL", brokenBash)

	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 5000, ApprovalMode: types.ApprovalYolo, Approvals: map[string]string{},
	}
	result, err := RunShellCommand("printf ok", ShellRunOptions{
		Workspace: t.TempDir(), Policy: policy, PreApproved: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Code != 0 || strings.TrimSpace(result.Stdout) != "ok" {
		t.Fatalf("command should run through a fallback shell: %+v", result)
	}
}

func TestRunShellCommandHonoursCancellation(t *testing.T) {
	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 10_000, ApprovalMode: types.ApprovalYolo, Approvals: map[string]string{},
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		cancel()
	}()
	result, err := RunShellCommand("sleep 5", ShellRunOptions{
		Workspace: t.TempDir(), Policy: policy, PreApproved: true, Ctx: ctx,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Aborted {
		t.Fatalf("a cancelled command should report the kill: %+v", result)
	}
	if strings.Contains(ShellContextMessage(result, 0), "(killed: timed out)") {
		t.Fatal("a cancel is not a timeout")
	}
}

func TestShellTimeoutIsReported(t *testing.T) {
	policy := &types.ExecutionPolicy{
		CommandTimeoutMs: 200, ApprovalMode: types.ApprovalYolo, Approvals: map[string]string{},
	}
	result, err := RunShellCommand("sleep 5", ShellRunOptions{
		Workspace: t.TempDir(), Policy: policy, PreApproved: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.TimedOut {
		t.Fatalf("expected a timeout: %+v", result)
	}
	if !strings.Contains(ShellContextMessage(result, 0), "killed: timed out") {
		t.Fatal("the transcript should say why the command died")
	}
}

func TestAssertShellCommandAllowedRefusesWithoutAnOperator(t *testing.T) {
	policy := &types.ExecutionPolicy{ApprovalMode: types.ApprovalSafe, Approvals: map[string]string{}}
	if err := AssertShellCommandAllowed("rm -rf /", policy, nil); err == nil {
		t.Fatal("a destructive command with no one to ask must be refused")
	}
	if err := AssertShellCommandAllowed("file ./chall", policy, nil); err != nil {
		t.Fatalf("an ordinary command should pass: %v", err)
	}
}
