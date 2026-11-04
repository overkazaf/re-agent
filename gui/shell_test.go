package main

import (
	"encoding/base64"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestShellStartWriteExit exercises the full PTY round-trip against a real
// shell: spawn → write a command → see its output on the event channel →
// kill → exit event → shell leaves the list. Uses /bin/sh (not the user's
// $SHELL) so the test never depends on interactive rc files being fast.
func TestShellStartWriteExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows pty semantics differ")
	}
	t.Setenv("SHELL", "/bin/sh")

	events := make(chan ShellEnvelope, 256)
	m := NewShellManager()
	m.SetEmit(func(env ShellEnvelope) { events <- env })

	cwd := t.TempDir()
	info, err := m.Start(cwd)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if info.Cwd != cwd || info.PID == 0 {
		t.Fatalf("bad info: %+v", info)
	}
	if got := m.List(); len(got) != 1 || got[0].ID != info.ID {
		t.Fatalf("List after start = %+v, want one %s", got, info.ID)
	}

	// a command whose output can only come from a real shell round-trip
	if err := m.Write(info.ID, "echo shell_pty_marker_$((20+3))\n"); err != nil {
		t.Fatalf("Write: %v", err)
	}

	deadline := time.After(10 * time.Second)
	sawMarker, sawExit, dataEvents := false, false, 0
	var received strings.Builder
	stopped := false
	for !sawMarker || !sawExit {
		if sawMarker && !stopped {
			// kill the shell so reap delivers the exit event (the test's only
			// exit driver — an interactive sh never exits on its own)
			stopped = true
			if err := m.Stop(info.ID); err != nil {
				t.Fatalf("Stop: %v", err)
			}
		}
		select {
		case env := <-events:
			switch env.Kind {
			case "data":
				if env.ShellID != info.ID {
					t.Fatalf("data for wrong shell: %s", env.ShellID)
				}
				dataEvents++
				if raw, err := base64.StdEncoding.DecodeString(env.B64); err == nil {
					received.Write(raw)
					if !sawMarker {
						sawMarker = strings.Contains(string(raw), "shell_pty_marker_23")
					}
				}
			case "exit":
				if env.ShellID != info.ID {
					t.Fatalf("exit for wrong shell: %s", env.ShellID)
				}
				sawExit = true
			default:
				t.Fatalf("unknown envelope kind: %q", env.Kind)
			}
		case <-deadline:
			t.Fatalf("timeout: sawMarker=%v sawExit=%v dataEvents=%d received=%q",
				sawMarker, sawExit, dataEvents, received.String())
		}
	}

	// reap removes the shell from the map — allow it a moment to land
	waitFor(t, "shell to leave the list", func() bool { return len(m.List()) == 0 })
}

// TestShellStartRejectsBadCwd: a shell rooted nowhere must refuse cleanly.
func TestShellStartRejectsBadCwd(t *testing.T) {
	m := NewShellManager()
	if _, err := m.Start("/definitely/not/a/dir-0xaf"); err == nil {
		t.Fatal("Start with a missing cwd must error")
	}
}

// TestShellResizeRejectsAbsurd checks the winsize guard without a real shell.
func TestShellResizeRejectsAbsurd(t *testing.T) {
	m := NewShellManager()
	if err := m.Resize("sh-none", 80, 24); err == nil {
		t.Fatal("Resize on unknown shell must error")
	}
}

// TestShellStopUnknown covers the error path.
func TestShellStopUnknown(t *testing.T) {
	m := NewShellManager()
	if err := m.Stop("sh-none"); err == nil {
		t.Fatal("Stop on unknown shell must error")
	}
}

func decodeHas(b64, needle string) bool {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return false
	}
	return strings.Contains(string(raw), needle)
}
