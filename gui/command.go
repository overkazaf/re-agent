package main

// SendCommand: run one slash command against a session's app.State and collect
// what it says into CommandResultDTO. Two output paths exist inside
// handleCommand and both are bridged:
//   - emitNoticeTo routes through state.NoticeSink (set here for the duration);
//   - raw fmt.Print output (/help, /version, /theme's clear+splash…) is caught
//     by swapping os.Stdout for a pipe — a process-wide swap, so a package
//     mutex serializes it and the per-session cmdMu keeps installs paired.
//
// Captured stdout is stripped of ANSI styling (the ui renderers color for a
// terminal) and appended as info notices. Returned errors become one error
// notice with OK=false.

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/app"
	"github.com/overkazaf/re-agent/internal/ui"
)

// commandMu guards the process-wide os.Stdout swap during SendCommand.
var commandMu sync.Mutex

// ansiRE strips CSI styling/clear sequences and OSC title sequences — the GUI
// renders notices as plain text in styled DOM.
var ansiRE = regexp.MustCompile("\x1b(?:\\[[0-9;?]*[A-Za-z]|\\][^\x07\x1b]*(?:\x07|\x1b\\\\))")

// guiInteractiveCommands would block reading stdin (password prompts, the
// reverse picker); the GUI has no stdin to offer them yet.
var guiInteractiveCommands = map[string]string{
	"/login": "login is terminal-only (reads the password without echo)",
}

// guiRunningSafeCommands are allowed mid-turn: read-only reports over data the
// turn goroutine does not write, plus the two display toggles (whose writes
// funnel into the locked hudTracker through pushDisplays). Excluded on purpose:
// /approval and /policy (touch policy.Approvals, which applyMemory writes on the
// tool goroutine), /context (reads loop history mid-append), and every routing
// or model command. The terminal app serializes all of these on one input loop;
// the GUI cannot, so they wait for the turn to end instead of racing it.
var guiRunningSafeCommands = map[string]bool{
	"/think": true, "/tasks": true, "/help": true, "/version": true,
	"/providers": true, "/tools": true, "/skills": true, "/mcp": true,
	"/status": true, "/auth": true, "/sessions": true, "/session": true,
	"/plan": true,
}

// SendCommand executes one slash command synchronously and returns what it
// printed. It never runs a turn; prompts go through SendPrompt.
func (m *SessionManager) SendCommand(id, line string) (CommandResultDTO, error) {
	s := m.get(id)
	if s == nil {
		return CommandResultDTO{}, errUnknownSession(id)
	}
	command := strings.Fields(strings.TrimSpace(line))
	if len(command) == 0 {
		return CommandResultDTO{}, nil
	}
	if hint, blocked := guiInteractiveCommands[strings.ToLower(command[0])]; blocked {
		return CommandResultDTO{}, errInteractiveCommand(hint)
	}

	s.mu.Lock()
	running := s.running
	s.mu.Unlock()
	if running && !guiRunningSafeCommands[strings.ToLower(command[0])] {
		return CommandResultDTO{}, fmt.Errorf(
			"command %s is not available while a turn is running — wait for it to finish", command[0])
	}
	// /workflow reverse opens the terminal RE picker (state.editor.ReadLine);
	// the GUI State has no editor, so it would nil-panic. Reverse sessions
	// belong to the frontend's own flow until a GUI-native picker exists.
	if strings.ToLower(command[0]) == "/workflow" && strings.EqualFold(command[len(command)-1], "reverse") {
		return CommandResultDTO{}, fmt.Errorf("/workflow reverse needs the terminal RE picker — not available from the GUI yet")
	}

	s.cmdMu.Lock()
	defer s.cmdMu.Unlock()

	var noticeMu sync.Mutex
	var notices []NoticeDTO
	sink := func(level, text string) {
		noticeMu.Lock()
		defer noticeMu.Unlock()
		notices = append(notices, NoticeDTO{Level: level, Text: text})
	}

	var runErr error
	stdout := captureStdout(func() {
		s.state.NoticeSink = sink
		runErr = app.RunCommand(line, s.state)
		s.state.NoticeSink = nil
	})
	pushDisplays(s) // /tasks, /think mutated the state — fold it into the HUD strip

	for _, line := range strings.Split(strings.TrimRight(stdout, "\n"), "\n") {
		text := strings.TrimSpace(ansiRE.ReplaceAllString(line, ""))
		if text == "" {
			continue
		}
		noticeMu.Lock()
		notices = append(notices, NoticeDTO{Level: "info", Text: text})
		noticeMu.Unlock()
	}
	if runErr != nil {
		noticeMu.Lock()
		notices = append(notices, NoticeDTO{Level: "error", Text: runErr.Error()})
		noticeMu.Unlock()
	}
	return CommandResultDTO{OK: runErr == nil, Notices: notices}, nil
}

// pushDisplays folds /tasks and /think state into the HUD strip right where the
// command wrote it — the write-time counterpart of the TUI pane's
// SetPlanDisplay/SetThinkDisplay. Snapshot paths never read app.State for these,
// so command writes cannot race the tick loop.
func pushDisplays(s *session) {
	plan := string(s.state.PlanDisplay)
	if plan == "" {
		plan = string(ui.PlanDisplayAuto)
	}
	think := string(s.state.ThinkDisplay)
	if think == "" {
		think = string(ui.ThinkDisplayAuto)
	}
	s.hud.setDisplays(plan, think)
}

// captureStdout runs run with os.Stdout swapped for a pipe and returns
// everything written. The swap is process-wide: commandMu must be held.
func captureStdout(run func()) string {
	commandMu.Lock()
	defer commandMu.Unlock()

	reader, writer, err := os.Pipe()
	if err != nil {
		run() // no capture possible; still run the command
		return ""
	}
	original := os.Stdout
	os.Stdout = writer

	captured := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(reader)
		captured <- string(data)
	}()

	run()

	writer.Close()
	os.Stdout = original
	return <-captured
}

func errInteractiveCommand(hint string) error {
	return &interactiveCommandError{hint}
}

type interactiveCommandError struct{ hint string }

func (e *interactiveCommandError) Error() string {
	return e.hint + " — run it in the terminal app"
}
