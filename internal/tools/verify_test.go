package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
)

func TestVerifyArtifactBuildReplayStdinAndSandboxGate(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "checker.py")
	body := "import sys\nprint('accepted' if sys.stdin.read().strip() == '0xaf{ok}' else 'rejected')\n"
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	sandbox := security.NewSandbox()
	sandbox.Activate(map[string]string{"network": "deny"})
	tc := types.ToolContext{
		Workspace: dir, SessionDir: dir, Sandbox: sandbox,
		Policy: &types.ExecutionPolicy{CommandTimeoutMs: 5000, ApprovalMode: types.ApprovalSafe},
	}
	tool := VerifyArtifactTool()
	result, err := tool.Execute(map[string]any{
		"artifact":     "checker.py",
		"buildCommand": "python3 -m py_compile checker.py",
		"cases": []any{
			map[string]any{"name": "valid-flag", "command": "python3 checker.py", "input": "0xaf{ok}\n", "expected": "accepted"},
			map[string]any{"name": "wrong-flag", "command": "python3 checker.py", "input": "nope\n", "expected": "rejected"},
		},
	}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || !strings.Contains(result.Text(), "verification: PASS") {
		t.Fatalf("expected stdin verification pass, got %s", result.Text())
	}

	// Network commands inside verify_artifact must be blocked by the capability sandbox!
	if _, err := tool.Execute(map[string]any{
		"artifact": "checker.py",
		"cases": []any{
			map[string]any{"name": "net", "command": "curl https://example.test", "expected": "ok"},
		},
	}, tc); err == nil {
		t.Fatal("expected verify_artifact to enforce task capability sandbox on case commands")
	}
}
