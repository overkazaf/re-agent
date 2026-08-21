package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestBuildReferenceContextEmpty(t *testing.T) {
	got, err := buildReferenceContext(nil, t.TempDir(), "", policyForTest())
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("no specs should produce no context, got %q", got)
	}
}

func TestBuildReferenceContextRawNotes(t *testing.T) {
	got, err := buildReferenceContext([]string{"remember: the flag is in rodata"}, t.TempDir(), "", policyForTest())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "## Operator Notes") || !strings.Contains(got, "remember: the flag is in rodata") {
		t.Fatalf("raw notes not passed through:\n%s", got)
	}
}

func TestBuildReferenceContextFile(t *testing.T) {
	workspace := t.TempDir()
	notes := "reference file body\nsecond line"
	if err := os.WriteFile(filepath.Join(workspace, "notes.md"), []byte(notes), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := buildReferenceContext([]string{"file:notes.md"}, workspace, "", policyForTest())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "## Reference file: notes.md") || !strings.Contains(got, notes) {
		t.Fatalf("reference file not inlined:\n%s", got)
	}
}

func TestBuildReferenceContextFileEscapesWorkspace(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := buildReferenceContext([]string{"file:" + outside}, t.TempDir(), "", policyForTest())
	if err == nil {
		t.Fatal("a file outside the workspace must be rejected")
	}
}

func TestBuildReferenceContextKnowledge(t *testing.T) {
	got, err := buildReferenceContext([]string{"know:android packer"}, t.TempDir(), "", policyForTest())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "## Knowledge base") {
		t.Fatalf("knowledge section missing:\n%s", got)
	}
}

func policyForTest() *types.ExecutionPolicy {
	return &types.ExecutionPolicy{
		AllowWrites:      false,
		AllowNetwork:     false,
		AllowSensitive:   false,
		CommandTimeoutMs: 30_000,
		MaxReadBytes:     128 * 1024,
		ApprovalMode:     types.ApprovalSafe,
		Approvals:        map[string]string{},
	}
}
