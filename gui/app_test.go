package main

import (
	"strings"
	"testing"
)

// TestAppCompletionsAndThemes: the §0.2 surface works before any window exists —
// completions map to Replacement strings (whole-line semantics) and themes come
// straight from ui.
func TestAppCompletionsAndThemes(t *testing.T) {
	app := NewApp()

	completions, err := app.Completions("/the")
	if err != nil {
		t.Fatalf("Completions: %v", err)
	}
	found := false
	for _, entry := range completions {
		if strings.TrimRight(entry, " ") == "/theme" {
			found = true
		}
		if !strings.HasPrefix(entry, "/") {
			t.Fatalf("completion is not a whole line: %q", entry)
		}
	}
	if !found {
		t.Fatalf("no /theme completion: %v", completions)
	}

	// Argument completions carry the full new line, not just the argument.
	if args, err := app.Completions("/theme "); err != nil || len(args) == 0 {
		t.Fatalf("/theme argument completions: %v (%v)", args, err)
	} else {
		for _, entry := range args {
			if !strings.HasPrefix(entry, "/theme ") {
				t.Fatalf("argument completion lost the line prefix: %q", entry)
			}
		}
	}

	themes, err := app.GetThemes()
	if err != nil {
		t.Fatalf("GetThemes: %v", err)
	}
	if len(themes) == 0 {
		t.Fatal("no themes")
	}
	for _, theme := range themes {
		if strings.TrimSpace(theme) == "" {
			t.Fatalf("empty theme name in %v", themes)
		}
	}
}

// TestAppSessionLifecycle: Start → prompt → GetState → Close through the
// binding surface, with no window (events drop, sessions still run).
func TestAppSessionLifecycle(t *testing.T) {
	workspace := testEnv(t)
	app := NewApp()

	info, err := app.StartSession(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if err := app.SendPrompt(info.ID, "one prompt"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	waitFor(t, "turn to finish", func() bool {
		return app.manager.Lifecycle(info.ID) == LifecycleIdle
	})

	tick, err := app.GetState(info.ID)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if tick.Flow.Turn < 1 {
		t.Fatalf("tick shows turn %d", tick.Flow.Turn)
	}

	if _, err := app.GetState("gui-missing"); err == nil {
		t.Fatal("GetState on an unknown session must error")
	}
	if err := app.CloseSession(info.ID); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
}

// TestAppApproveUnknownIsError: the binding surface keeps the approval bridge's
// strictness.
func TestAppApproveUnknownIsError(t *testing.T) {
	app := NewApp()
	if err := app.Approve("s1", "apr-9999", "allow"); err == nil {
		t.Fatal("approving an unknown request must error")
	}
}
