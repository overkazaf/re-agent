package main

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/ui"
)

// commandTestSession starts a mock session suitable for running slash commands.
func commandTestSession(t *testing.T) (*SessionManager, string) {
	t.Helper()
	workspace := testEnv(t)
	mgr := NewSessionManager(&collectSink{}, nil)
	t.Cleanup(mgr.CloseAll)
	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return mgr, info.ID
}

func noticeTexts(result CommandResultDTO) []string {
	out := make([]string, 0, len(result.Notices))
	for _, notice := range result.Notices {
		out = append(out, notice.Level+": "+notice.Text)
	}
	return out
}

// TestSendCommandHelp: /help prints through raw fmt.Print — the stdout capture
// must turn it into notices, ANSI stripped.
func TestSendCommandHelp(t *testing.T) {
	mgr, id := commandTestSession(t)

	result, err := mgr.SendCommand(id, "/help")
	if err != nil {
		t.Fatalf("SendCommand: %v", err)
	}
	if !result.OK {
		t.Fatalf("/help failed: %v", noticeTexts(result))
	}
	if len(result.Notices) == 0 {
		t.Fatal("no notices captured from /help")
	}
	joined := strings.Join(noticeTexts(result), "\n")
	if !strings.Contains(joined, "/theme") {
		t.Fatalf("help text lost its command list: %q", joined)
	}
	for _, notice := range result.Notices {
		if strings.ContainsRune(notice.Text, '\x1b') {
			t.Fatalf("ANSI escape survived stripping: %q", notice.Text)
		}
	}
}

// TestSendCommandTheme: /theme matrix saves the preference, emits a notice, and
// actually switches ui's theme.
func TestSendCommandTheme(t *testing.T) {
	mgr, id := commandTestSession(t)

	result, err := mgr.SendCommand(id, "/theme matrix")
	if err != nil {
		t.Fatalf("SendCommand: %v", err)
	}
	if !result.OK {
		t.Fatalf("/theme failed: %v", noticeTexts(result))
	}
	if ui.CurrentTheme() != "matrix" {
		t.Fatalf("theme = %s, want matrix", ui.CurrentTheme())
	}
	found := false
	for _, notice := range result.Notices {
		if strings.Contains(notice.Text, "theme=matrix") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no theme notice: %v", noticeTexts(result))
	}

	// An invalid theme is a returned error, surfaced as an error notice with
	// OK=false.
	bad, err := mgr.SendCommand(id, "/theme neon")
	if err != nil {
		t.Fatalf("SendCommand: %v", err)
	}
	if bad.OK {
		t.Fatal("/theme neon must fail")
	}
	hasError := false
	for _, notice := range bad.Notices {
		if notice.Level == "error" && strings.Contains(notice.Text, "usage: /theme") {
			hasError = true
		}
	}
	if !hasError {
		t.Fatalf("no usage error notice: %v", noticeTexts(bad))
	}
}

// TestSendCommandThink: /think expand mutates the shared State the dashboard
// reads, and reports it through the sink.
func TestSendCommandThink(t *testing.T) {
	mgr, id := commandTestSession(t)
	s := mgr.get(id)

	result, err := mgr.SendCommand(id, "/think expand")
	if err != nil {
		t.Fatalf("SendCommand: %v", err)
	}
	if !result.OK {
		t.Fatalf("/think failed: %v", noticeTexts(result))
	}
	if s.state.ThinkDisplay != ui.ThinkDisplayExpanded {
		t.Fatalf("think display = %s, want expanded", s.state.ThinkDisplay)
	}
	found := false
	for _, notice := range result.Notices {
		if strings.Contains(notice.Text, "think=expanded") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no think notice: %v", noticeTexts(result))
	}

	// The state change is visible in the very next tick.
	tick, ok := mgr.Snapshot(id)
	if !ok || tick.Hud.ThinkDisplay != "expanded" {
		t.Fatalf("tick think display = %+v, want expanded", tick.Hud.ThinkDisplay)
	}
}

// TestSendCommandErrors: unknown commands, unknown sessions, and stdin-bound
// commands all fail with a clear message.
func TestSendCommandErrors(t *testing.T) {
	mgr, id := commandTestSession(t)

	result, err := mgr.SendCommand(id, "/definitely-not-a-command")
	if err != nil {
		t.Fatalf("SendCommand transport error: %v", err)
	}
	if result.OK {
		t.Fatal("unknown command must not be OK")
	}
	found := false
	for _, notice := range result.Notices {
		if notice.Level == "error" && strings.Contains(notice.Text, "unknown command") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no unknown-command notice: %v", noticeTexts(result))
	}

	if _, err := mgr.SendCommand(id, "/login"); err == nil {
		t.Fatal("/login must be refused in the GUI")
	}
	if _, err := mgr.SendCommand(id, "/workflow reverse"); err == nil {
		t.Fatal("bare /workflow reverse must be refused in the GUI (terminal RE picker)")
	}
	// the argument form flows to the core handler; extra tokens surface as a
	// usage notice (OK=false), not a GUI transport error
	result, err = mgr.SendCommand(id, "/workflow reverse apk now")
	if err != nil {
		t.Fatalf("argument form must not hit the GUI block: %v", err)
	}
	if result.OK {
		t.Fatalf("usage error must not be OK: %v", noticeTexts(result))
	}
	if _, err := mgr.SendCommand("gui-missing", "/help"); err == nil {
		t.Fatal("unknown session must error")
	}
	if _, err := mgr.SendCommand(id, "   "); err != nil {
		t.Fatalf("blank command should be a quiet no-op: %v", err)
	}
}

// TestSendCommandMidTurnGuard: while a turn runs, display toggles and read-only
// reports pass; state-mutating routing commands are refused.
func TestSendCommandMidTurnGuard(t *testing.T) {
	mgr, id := commandTestSession(t)
	s := mgr.get(id)

	s.mu.Lock()
	s.running = true
	s.mu.Unlock()

	if result, err := mgr.SendCommand(id, "/think expand"); err != nil || !result.OK {
		t.Fatalf("/think must be allowed mid-turn: %v %v", err, noticeTexts(result))
	}
	if result, err := mgr.SendCommand(id, "/theme matrix"); err == nil || result.OK {
		t.Fatal("/theme must be refused mid-turn")
	}
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
	if result, err := mgr.SendCommand(id, "/theme matrix"); err != nil || !result.OK {
		t.Fatalf("/theme must work once the turn ends: %v %v", err, noticeTexts(result))
	}
}

// TestSendCommandSerializes: two commands in a row keep their outputs separate
// (no stdout bleed between commands).
func TestSendCommandSerializes(t *testing.T) {
	mgr, id := commandTestSession(t)

	for i := 0; i < 3; i++ {
		result, err := mgr.SendCommand(id, "/version")
		if err != nil {
			t.Fatalf("SendCommand: %v", err)
		}
		if !result.OK {
			t.Fatalf("/version failed: %v", noticeTexts(result))
		}
		joined := strings.Join(noticeTexts(result), "\n")
		if strings.Count(joined, "0xAF-Re") > 1 {
			t.Fatalf("version output repeated across runs: %q", joined)
		}
		if !strings.Contains(joined, "version") && !strings.Contains(joined, "0xAF-Re") {
			t.Fatalf("version output lost: %q", joined)
		}
	}
}

// TestSendCommandWorkflowReverse: the argument form starts the RE session end
// to end — state.REState mirrors into s.reState (the field split the /phase
// handler and the RE strip read), /phase works, re-picks don't leave a stale
// pointer, and /workflow off clears both fields and the strip.
func TestSendCommandWorkflowReverse(t *testing.T) {
	mgr, id := commandTestSession(t)
	s := mgr.get(id)

	start := func(line string) CommandResultDTO {
		t.Helper()
		result, err := mgr.SendCommand(id, line)
		if err != nil {
			t.Fatalf("SendCommand(%q): %v", line, err)
		}
		return result
	}

	result := start("/workflow reverse apk")
	if !result.OK {
		t.Fatalf("reverse start failed: %v", noticeTexts(result))
	}
	s.mu.Lock()
	re := s.reState
	core := s.state.REState
	s.mu.Unlock()
	if core == nil || re != core {
		t.Fatalf("s.reState must mirror state.REState: re=%v core=%v", re, core)
	}
	if re.SampleType != "apk" {
		t.Fatalf("sample type = %s, want apk", re.SampleType)
	}

	tick, ok := mgr.Snapshot(id)
	if !ok || tick.Re == nil {
		t.Fatalf("RE strip missing from snapshot: ok=%v re=%v", ok, tick.Re)
	}
	if tick.Re.SampleType != "apk" || tick.Re.Phase != "triage" {
		t.Fatalf("strip = %+v, want apk/triage", tick.Re)
	}

	// /phase reads state.REState — the field split must be healed
	result = start("/phase")
	if !result.OK || !strings.Contains(strings.Join(noticeTexts(result), "\n"), "phase=triage") {
		t.Fatalf("/phase after GUI start: %v", noticeTexts(result))
	}
	result = start("/phase next")
	if !result.OK || !strings.Contains(strings.Join(noticeTexts(result), "\n"), "static") {
		t.Fatalf("/phase next: %v", noticeTexts(result))
	}

	// re-pick swaps in a fresh state — no stale pointer
	start("/workflow reverse so")
	s.mu.Lock()
	re = s.reState
	s.mu.Unlock()
	if re.SampleType != "so" {
		t.Fatalf("re-pick left stale state: sample=%s, want so", re.SampleType)
	}

	// off clears both fields and the strip
	result = start("/workflow off")
	if !result.OK {
		t.Fatalf("/workflow off: %v", noticeTexts(result))
	}
	s.mu.Lock()
	re = s.reState
	core = s.state.REState
	s.mu.Unlock()
	if re != nil || core != nil {
		t.Fatalf("off must clear both fields: re=%v core=%v", re, core)
	}
	if tick, ok := mgr.Snapshot(id); ok && tick.Re != nil {
		t.Fatalf("RE strip must be gone after off: %+v", tick.Re)
	}

	// unknown sample errors through the handler without starting anything
	result = start("/workflow reverse alien")
	if result.OK {
		t.Fatalf("unknown sample must fail: %v", noticeTexts(result))
	}
}

// TestSendCommandWorkflowReverseMidTurn: the argument form is not in the
// mid-turn safe list — a live turn refuses it like every other routing command.
func TestSendCommandWorkflowReverseMidTurn(t *testing.T) {
	mgr, id := commandTestSession(t)
	s := mgr.get(id)
	s.mu.Lock()
	s.running = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()

	if _, err := mgr.SendCommand(id, "/workflow reverse apk"); err == nil {
		t.Fatal("reverse start must be refused while a turn runs")
	}
}
