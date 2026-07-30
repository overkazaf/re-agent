package app

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/ui"
)

func TestThinkCommandModes(t *testing.T) {
	state := &State{ThinkDisplay: ui.ThinkDisplayAuto}
	for _, testCase := range []struct {
		arg  string
		want ui.ThinkDisplayMode
	}{
		{"expand", ui.ThinkDisplayExpanded},
		{"collapse", ui.ThinkDisplayCollapsed},
		{"on", ui.ThinkDisplayExpanded},
		{"off", ui.ThinkDisplayCollapsed},
		{"toggle", ui.ThinkDisplayExpanded},
		{"toggle", ui.ThinkDisplayCollapsed},
		{"auto", ui.ThinkDisplayAuto},
	} {
		if err := handleThinkCommand(testCase.arg, state, nil); err != nil {
			t.Fatalf("/think %s: %v", testCase.arg, err)
		}
		if state.ThinkDisplay != testCase.want {
			t.Fatalf("/think %s left mode %q, want %q", testCase.arg, state.ThinkDisplay, testCase.want)
		}
	}

	if err := handleThinkCommand("sideways", state, nil); err == nil {
		t.Fatal("an unknown mode should be rejected, not silently ignored")
	}
	if state.ThinkDisplay != ui.ThinkDisplayAuto {
		t.Fatalf("a rejected mode must not change state, got %q", state.ThinkDisplay)
	}
}

// The point of /think is reading reasoning while it is still streaming, so the
// mid-turn dispatcher has to accept it — not just the idle prompt.
func TestThinkCommandRunsMidTurn(t *testing.T) {
	controller := &liveInputController{state: &State{ThinkDisplay: ui.ThinkDisplayAuto}}
	if err := controller.handleLiveCommand("/think expand"); err != nil {
		t.Fatalf("/think should be accepted during a turn: %v", err)
	}
	if controller.state.ThinkDisplay != ui.ThinkDisplayExpanded {
		t.Fatalf("mid-turn /think did not apply, got %q", controller.state.ThinkDisplay)
	}

	err := controller.handleLiveCommand("/theme matrix")
	if err == nil {
		t.Fatal("a prompt-only command should still be refused mid-turn")
	}
	if !strings.Contains(err.Error(), "/think") {
		t.Fatalf("the mid-turn refusal should list /think as available, got: %v", err)
	}
}
