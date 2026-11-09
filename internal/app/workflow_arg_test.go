package app

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/workflow"
)

// The argument form /workflow reverse <sample> must work without the terminal
// picker: the GUI bridge drives RunCommand with no editor and no task queue,
// so this path touches neither.
func TestWorkflowReverseArgumentStartsRESession(t *testing.T) {
	state := &State{Config: config.Defaults()}
	if err := RunCommand("/workflow reverse apk", state); err != nil {
		t.Fatal(err)
	}
	if state.Workflow != workflow.Reverse {
		t.Fatalf("workflow = %s, want reverse", state.Workflow)
	}
	if state.REState == nil {
		t.Fatal("REState not created")
	}
	if state.REState.SampleType != "apk" {
		t.Fatalf("sample type = %s, want apk", state.REState.SampleType)
	}
	if state.REState.Phase != workflow.PhaseTriage {
		t.Fatalf("phase = %s, want triage", state.REState.Phase)
	}
}

func TestWorkflowReverseArgumentLowercasesKey(t *testing.T) {
	state := &State{Config: config.Defaults()}
	if err := RunCommand("/workflow reverse PE", state); err != nil {
		t.Fatal(err)
	}
	if state.REState.SampleType != "pe" {
		t.Fatalf("sample type = %s, want pe", state.REState.SampleType)
	}
}

func TestWorkflowReverseArgumentUnknownKeyLeavesStateUntouched(t *testing.T) {
	state := &State{Config: config.Defaults()}
	if err := RunCommand("/workflow specialist", state); err != nil {
		t.Fatal(err)
	}
	before := state.Workflow
	err := RunCommand("/workflow reverse alien", state)
	if err == nil {
		t.Fatal("unknown sample type should error")
	}
	if !strings.Contains(err.Error(), "apk") {
		t.Fatalf("error should list valid keys: %v", err)
	}
	if state.Workflow != before || state.REState != nil {
		t.Fatalf("failed start must not mutate state: workflow=%s reState=%v", state.Workflow, state.REState)
	}
}

func TestWorkflowReverseArgumentTooManyFieldsIsUsage(t *testing.T) {
	state := &State{Config: config.Defaults()}
	err := RunCommand("/workflow reverse apk now", state)
	if err == nil {
		t.Fatal("extra tokens should be a usage error")
	}
	if !strings.Contains(err.Error(), "usage: /workflow reverse") {
		t.Fatalf("error should carry usage: %v", err)
	}
}

func TestWorkflowOffClearsREStateAfterReverseStart(t *testing.T) {
	state := &State{Config: config.Defaults()}
	if err := RunCommand("/workflow reverse so", state); err != nil {
		t.Fatal(err)
	}
	if err := RunCommand("/workflow off", state); err != nil {
		t.Fatal(err)
	}
	if state.Workflow != workflow.Off || state.REState != nil {
		t.Fatalf("off should clear the RE session: workflow=%s reState=%v", state.Workflow, state.REState)
	}
}
