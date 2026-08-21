package app

import (
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
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

func TestParseArgsContextSpecs(t *testing.T) {
	args, err := ParseArgs([]string{
		"--context", "know:apk packer",
		"-C", "file:notes/plan.md",
		"--context", "remember the flag format",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"know:apk packer", "file:notes/plan.md", "remember the flag format"}
	if len(args.Contexts) != len(want) {
		t.Fatalf("contexts not parsed: %+v", args.Contexts)
	}
	for index, expected := range want {
		if args.Contexts[index] != expected {
			t.Fatalf("context[%d] = %q, want %q", index, args.Contexts[index], expected)
		}
	}
}

func TestParseArgsContextRequiresValue(t *testing.T) {
	if _, err := ParseArgs([]string{"--context"}); err == nil {
		t.Fatal("--context without a value should be rejected")
	}
}

func TestParseArgsVersion(t *testing.T) {
	args, err := ParseArgs([]string{"--version"})
	if err != nil {
		t.Fatal(err)
	}
	if !args.ShowVersion {
		t.Fatalf("--version was not parsed")
	}
	if args.Prompt != "" {
		t.Fatalf("--version became a prompt: %q", args.Prompt)
	}
}

func TestParseArgsResearcherRoleAndProvider(t *testing.T) {
	args, err := ParseArgs([]string{"--role", "researcher", "--researcher", "grok"})
	if err != nil {
		t.Fatal(err)
	}
	if args.Role != types.RoleResearcher {
		t.Fatalf("researcher role not parsed: %s", args.Role)
	}
	if args.Researcher != "grok" {
		t.Fatalf("researcher provider not parsed: %s", args.Researcher)
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
