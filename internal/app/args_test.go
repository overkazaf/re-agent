package app

import (
	"testing"

	"github.com/overkazaf/re-agent/internal/workflow"
)

func TestParseArgsWorkflow(t *testing.T) {
	args, err := ParseArgs([]string{"--workflow", "caveman", "-p", "triage ./chall"})
	if err != nil {
		t.Fatal(err)
	}
	if args.Workflow != workflow.Caveman {
		t.Fatalf("workflow not parsed: %s", args.Workflow)
	}
}

func TestParseArgsRejectsUnknownWorkflow(t *testing.T) {
	if _, err := ParseArgs([]string{"--workflow", "latin"}); err == nil {
		t.Fatal("unknown workflow mode should be rejected")
	}
}

func TestParseArgsModelOverride(t *testing.T) {
	args, err := ParseArgs([]string{"--model", "deepseek=deepseek-reasoner", "--model", "claude=opus"})
	if err != nil {
		t.Fatal(err)
	}
	if len(args.Models) != 2 {
		t.Fatalf("model overrides not parsed: %+v", args.Models)
	}
	if args.Models[0].Provider != "deepseek" || args.Models[0].Model != "deepseek-reasoner" {
		t.Fatalf("first model override wrong: %+v", args.Models[0])
	}
	if args.Models[1].Provider != "claude" || args.Models[1].Model != "opus" {
		t.Fatalf("second model override wrong: %+v", args.Models[1])
	}
}

func TestParseArgsRejectsMalformedModelOverride(t *testing.T) {
	for _, argv := range [][]string{
		{"--model", "deepseek"},
		{"--model", "=model"},
		{"--model", "deepseek="},
	} {
		if _, err := ParseArgs(argv); err == nil {
			t.Fatalf("malformed --model should be rejected: %v", argv)
		}
	}
}
