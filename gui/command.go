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
	"io"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/app"
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
