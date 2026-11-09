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

// turnsThroughRepl reports whether this command line would run a terminal repl
// turn: its own signal handlers (repl.go takes over SIGINT/SIGTERM process-wide),
// its own Confirm overwrite (which nils out this session's GUI approval bridge
// for good), and a loop.Run that escapes the manager's turns.WaitGroup — so it
// survives CloseSession and can run concurrently with a SendPrompt turn on the
// same AgentLoop. The GUI runs turns exclusively through SendPrompt.
func turnsThroughRepl(command []string) bool {
	name := strings.ToLower(command[0])
	switch name {
	case "/skill":
		// `/skill` alone lists; `/skill <name> <task>` runs a repl turn.
		return len(command) >= 3
	case "/queue":
		return len(command) >= 2 && strings.ToLower(command[1]) == "run"
	default:
		return false
	}
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
		return CommandResultDTO{OK: true, Notices: []NoticeDTO{}}, nil
	}
	if hint, blocked := guiInteractiveCommands[strings.ToLower(command[0])]; blocked {
		return CommandResultDTO{}, errInteractiveCommand(hint)
	}
	if turnsThroughRepl(command) {
		return CommandResultDTO{}, fmt.Errorf(
			"%s would run a terminal turn — it installs its own signal handlers and would break this session's approval bridge; send the task as a normal prompt instead", command[0])
	}

	s.mu.Lock()
	running := s.running
	s.mu.Unlock()
	if running && !guiRunningSafeCommands[strings.ToLower(command[0])] {
		return CommandResultDTO{}, fmt.Errorf(
			"command %s is not available while a turn is running — wait for it to finish", command[0])
	}
	// Bare "/workflow reverse" opens the terminal RE picker (state.editor.ReadLine);
	// the GUI State has no editor, so it would nil-panic. The argument form
	// ("/workflow reverse apk") is non-interactive and flows through; the
	// frontend's RE picker dialog sends exactly that.
	if strings.ToLower(command[0]) == "/workflow" && len(command) == 2 && strings.EqualFold(command[1], "reverse") {
		return CommandResultDTO{}, fmt.Errorf(
			"bare /workflow reverse opens the terminal picker — pick the sample in the GUI dialog (send /workflow reverse from the prompt input) or use /workflow reverse <sample-type>")
	}

	s.cmdMu.Lock()
	defer s.cmdMu.Unlock()

	// Re-check under cmdMu: a SendPrompt landing between the early guard and
	// this lock could have started a turn that RunCommand would then race.
	s.mu.Lock()
	running = s.running
	s.mu.Unlock()
	if running && !guiRunningSafeCommands[strings.ToLower(command[0])] {
		return CommandResultDTO{}, fmt.Errorf(
			"command %s is not available while a turn is running — wait for it to finish", command[0])
	}

	var noticeMu sync.Mutex
	var notices []NoticeDTO
	sink := func(level, text string) {
		noticeMu.Lock()
		defer noticeMu.Unlock()
		notices = append(notices, NoticeDTO{Level: level, Text: text})
	}

	var runErr error
	stdout := captureStdout(func() {
		// a panicking command must degrade to an error notice, not take the
		// whole GUI process down (wails bindings run on app goroutines)
		defer func() {
			if rec := recover(); rec != nil {
				runErr = fmt.Errorf("command panicked: %v", rec)
			}
		}()
		s.state.NoticeSink = sink
		runErr = app.RunCommand(line, s.state)
		s.state.NoticeSink = nil
	})
	pushDisplays(s) // /tasks, /think mutated the state — fold it into the HUD strip
	// /workflow reverse <sample> wrote a fresh state.REState (and /workflow off
	// cleared it) — mirror it into the session field the tool binding, prompt
	// wrapper, and RE strip read. A change needs its own tick: SendCommand
	// otherwise emits none, so the strip would lag until the next turn.
	if syncREState(s) {
		m.emitTick(s)
	}

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
	if notices == nil {
		// nil slices marshal as null and the frontend reads res.notices.length
		notices = []NoticeDTO{}
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
// Restore/close ride a defer so a panicking run cannot leave the process
// writing into a dead pipe (the reader goroutine would block forever).
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

	// panic-only cleanup. The normal path restores and closes BEFORE reading
	// captured — the reader's EOF comes from the Close, so closing inside the
	// defer would deadlock the return value on the defer itself. Both steps
	// are idempotent: the second os.Stdout store is a no-op and a second
	// Close on an os.Pipe writer just errors.
	defer func() {
		os.Stdout = original
		_ = writer.Close() // EOF for the reader even when run() panicked
	}()
	run()
	os.Stdout = original
	_ = writer.Close()
	return <-captured
}

func errInteractiveCommand(hint string) error {
	return &interactiveCommandError{hint}
}

type interactiveCommandError struct{ hint string }

func (e *interactiveCommandError) Error() string {
	return e.hint + " — run it in the terminal app"
}
