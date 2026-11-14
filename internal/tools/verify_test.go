package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestVerifyArtifactBuildReplayDiff(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "solve.py")
	if err := os.WriteFile(script, []byte("print(6*7)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tc := types.ToolContext{Workspace: dir, SessionDir: dir, Policy: &types.ExecutionPolicy{CommandTimeoutMs: 5000}}
	result, err := Find([]types.Tool{VerifyArtifactTool()}, "verify_artifact").Execute(map[string]any{
		"artifact":     "solve.py",
		"buildCommand": "python3 -m py_compile solve.py",
		"cases": []any{map[string]any{
			"name": "known-output", "command": "python3 solve.py", "expected": "42",
		}},
	}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || !strings.Contains(result.Content[0].Text, "verification: PASS") {
		t.Fatalf("expected pass, got %#v", result)
	}
}
