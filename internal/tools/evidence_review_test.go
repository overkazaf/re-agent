package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

type stubArbitrator struct{ findings []types.Finding }

func (s *stubArbitrator) Review() []types.Finding { return s.findings }

func reviewTestContext(t *testing.T, arbiter types.Arbitrator) types.ToolContext {
	t.Helper()
	return types.ToolContext{
		Workspace:  t.TempDir(),
		SessionDir: t.TempDir(),
		Policy: &types.ExecutionPolicy{
			CommandTimeoutMs: 1000, MaxReadBytes: 1024, MaxToolOutputChars: 4000,
			ApprovalMode: types.ApprovalSafe, Approvals: map[string]string{},
		},
		Ctx:        context.Background(),
		Arbitrator: arbiter,
	}
}

func TestEvidenceReviewToolReportsFindings(t *testing.T) {
	tool := Find(CreateReverseTools(), "evidence_review")
	if tool == nil {
		t.Fatal("evidence_review not registered")
	}
	tc := reviewTestContext(t, &stubArbitrator{findings: []types.Finding{
		{Rule: "runtime-contradiction", HypothesisID: "H-001", EvidenceID: "ev_004", Applied: true,
			Message: "H-001: runtime error in ev_004 shares subject with the claim"},
		{Rule: "single-view", HypothesisID: "H-002", EvidenceID: "ev_007", Applied: false,
			Message: "H-002 is 0.90 confident on one view only"},
	}})
	result, err := tool.Execute(map[string]any{}, tc)
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("unexpected error result: %s", result.Text())
	}
	text := result.Text()
	if !strings.Contains(text, "H-001") || !strings.Contains(text, "runtime-contradiction") {
		t.Fatalf("findings not rendered:\n%s", text)
	}
	if !strings.Contains(text, "challenged") {
		t.Fatalf("applied findings should say the stack was challenged:\n%s", text)
	}
	if !strings.Contains(text, "advisory") || !strings.Contains(text, "H-002") {
		t.Fatalf("advisory findings should be labelled:\n%s", text)
	}
	if details, ok := result.Details.(map[string]any); !ok || details["total"] != 2 || details["applied"] != 1 {
		t.Fatalf("details should carry counts: %#v", result.Details)
	}
}

func TestEvidenceReviewToolCleanAndMissingArbitrator(t *testing.T) {
	tool := Find(CreateReverseTools(), "evidence_review")

	clean, err := tool.Execute(map[string]any{}, reviewTestContext(t, &stubArbitrator{}))
	if err != nil || clean.IsError {
		t.Fatalf("clean review should succeed: %+v / %v", clean, err)
	}
	if !strings.Contains(clean.Text(), "No findings") {
		t.Fatalf("clean review should say so:\n%s", clean.Text())
	}

	missing, err := tool.Execute(map[string]any{}, reviewTestContext(t, nil))
	if err != nil || !missing.IsError {
		t.Fatalf("missing arbitrator should be an error result, got %+v / %v", missing, err)
	}
}
