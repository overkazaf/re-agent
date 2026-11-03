package main

// End-to-end GUI smoke: the frontend journey driven headlessly through the
// SessionManager + ApprovalBridge — the same envelopes the WebView receives,
// minus the Wails runtime. The scenario script lives in testdata/
// smoke-config.json (the canonical smoke story): publish a plan, run an
// approval-gated command that writes an artifact, close with a final report
// and a completed plan. WS1's manager/approval tests cover the bridge
// mechanics; these cover the operator-visible story across sessions.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

// smokeScript loads the scripted mock turns from testdata/smoke-config.json.
func smokeScript(t *testing.T) []types.MockStep {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "smoke-config.json"))
	if err != nil {
		t.Fatalf("smoke config: %v", err)
	}
	var file struct {
		Providers map[string]struct {
			MockScript []types.MockStep `json:"mockScript"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("smoke config json: %v", err)
	}
	script := file.Providers["mock"].MockScript
	if len(script) != 2 {
		t.Fatalf("smoke config carries %d scripted turns, want 2", len(script))
	}
	return script
}

// loopEventsOf flattens one session's envelope stream into its loop events.
func loopEventsOf(sink *collectSink, id string) []core.LoopEvent {
	var out []core.LoopEvent
	for _, envelope := range sink.snapshot() {
		if envelope.SessionID != id || envelope.Kind != "loop" {
			continue
		}
		if batch, ok := envelope.Data.([]core.LoopEvent); ok {
			out = append(out, batch...)
		}
	}
	return out
}

// replyTexts collects one session's final reply texts.
func replyTexts(sink *collectSink, id string) []string {
	var out []string
	for _, event := range loopEventsOf(sink, id) {
		if event.Type == "reply" {
			out = append(out, event.Text)
		}
	}
	return out
}

// TestE2ESmokeApprovalRoundTrip: plan → approval push → allow → artifact on
// disk → final report → plan complete. One prompt exercises every frontend
// surface: lifecycle transitions, the approval dialog exchange, tool
// narration, plan progress, and the reply stream.
func TestE2ESmokeApprovalRoundTrip(t *testing.T) {
	workspace := testEnv(t)
	sink := &collectSink{}
	bridge := NewApprovalBridge()
	bridge.SetEmit(sink.record) // approval envelopes ride the stream the WebView sees
	mgr := NewSessionManager(sink, bridge.Approver())
	defer mgr.CloseAll()

	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	s := mgr.get(info.ID)
	if s == nil {
		t.Fatal("session missing after Start")
	}
	s.config.Providers["mock"].MockScript = smokeScript(t)

	if err := mgr.SendPrompt(info.ID, "gui smoke: plan, approval-gated write, final report"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	waitFor(t, "lifecycle running", func() bool {
		return sinkHasLifecycle(sink, info.ID, LifecycleRunning)
	})

	// `curl` trips the network concern, so even safe mode must ask.
	var approval ApprovalDTO
	waitFor(t, "approval push", func() bool {
		for _, envelope := range sink.snapshot() {
			if envelope.SessionID == info.ID && envelope.Kind == "approval" {
				if dto, ok := envelope.Data.(ApprovalDTO); ok {
					approval = dto
					return true
				}
			}
		}
		return false
	})
	if approval.ToolName != "run_command" || approval.Risk != "exec" {
		t.Fatalf("approval = %s/%s, want run_command/exec", approval.ToolName, approval.Risk)
	}
	if !strings.Contains(approval.Summary, "curl") {
		t.Fatalf("approval summary lost the command: %q", approval.Summary)
	}
	if !sinkHasLifecycle(sink, info.ID, LifecycleAwaitingApproval) {
		t.Fatal("session never reported awaiting_approval")
	}
	artifact := filepath.Join(workspace, "smoke-ok.txt")
	if _, err := os.Stat(artifact); err == nil {
		t.Fatal("artifact exists before the approve decision")
	}

	if err := bridge.Deliver(info.ID, approval.RequestID, "allow"); err != nil {
		t.Fatalf("Deliver(allow): %v", err)
	}
	waitFor(t, "artifact to land", func() bool {
		data, err := os.ReadFile(artifact)
		return err == nil && strings.Contains(string(data), "curl")
	})

	waitFor(t, "final report reply", func() bool {
		for _, text := range replyTexts(sink, info.ID) {
			if strings.Contains(text, "Smoke complete") {
				return true
			}
		}
		return false
	})
	waitFor(t, "turn to finish", func() bool {
		return mgr.Lifecycle(info.ID) == LifecycleIdle &&
			sinkHasLifecycle(sink, info.ID, LifecycleAwaitingApproval)
	})

	// The plan the operator sees ends fully complete (3/3).
	tick, ok := mgr.Snapshot(info.ID)
	if !ok {
		t.Fatal("snapshot missing after smoke turn")
	}
	if tick.Plan == nil || len(tick.Plan.Steps) != 3 {
		t.Fatalf("plan snapshot = %+v, want 3 steps", tick.Plan)
	}
	for _, step := range tick.Plan.Steps {
		if step.Status != types.StepCompleted {
			t.Fatalf("step %q = %s, want completed", step.Text, step.Status)
		}
	}

	// Ordering: the approval push sits between run_command's tool_start and
	// tool_end — the tool genuinely blocked on the decision.
	startIdx, approvalIdx, endIdx := -1, -1, -1
	for i, envelope := range sink.snapshot() {
		if envelope.SessionID != info.ID {
			continue
		}
		if envelope.Kind == "approval" && approvalIdx == -1 {
			approvalIdx = i
		}
		if batch, ok := envelope.Data.([]core.LoopEvent); ok {
			for _, event := range batch {
				if event.Type == "tool_start" && event.Name == "run_command" && startIdx == -1 {
					startIdx = i
				}
				if event.Type == "tool_end" && event.Name == "run_command" {
					endIdx = i
				}
			}
		}
	}
	if startIdx == -1 || approvalIdx == -1 || endIdx == -1 || startIdx >= approvalIdx || approvalIdx >= endIdx {
		t.Fatalf("approval ordering broken: tool_start@%d approval@%d tool_end@%d",
			startIdx, approvalIdx, endIdx)
	}
}

// TestE2ESmokeParallelSessionsNoCrossStream: two mock sessions turning at the
// same time on one manager — each stream stays its own, both reach idle.
func TestE2ESmokeParallelSessionsNoCrossStream(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dirA := filepath.Join(home, "alpha")
	dirB := filepath.Join(home, "beta")
	for _, dir := range []string{dirA, dirB} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("workspace: %v", err)
		}
	}

	sink := &collectSink{}
	mgr := NewSessionManager(sink, nil)
	defer mgr.CloseAll()

	// Echo mode (no script): each reply quotes its own prompt.
	a, err := mgr.Start(StartOptions{Workspace: dirA, Mock: true})
	if err != nil {
		t.Fatalf("Start alpha: %v", err)
	}
	b, err := mgr.Start(StartOptions{Workspace: dirB, Mock: true})
	if err != nil {
		t.Fatalf("Start beta: %v", err)
	}

	if err := mgr.SendPrompt(a.ID, "alpha probe 42"); err != nil {
		t.Fatalf("SendPrompt alpha: %v", err)
	}
	if err := mgr.SendPrompt(b.ID, "beta probe 7"); err != nil {
		t.Fatalf("SendPrompt beta: %v", err)
	}

	waitFor(t, "both sessions idle", func() bool {
		return mgr.Lifecycle(a.ID) == LifecycleIdle && mgr.Lifecycle(b.ID) == LifecycleIdle &&
			sinkHasLifecycle(sink, a.ID, LifecycleRunning) && sinkHasLifecycle(sink, b.ID, LifecycleRunning)
	})

	replyA := strings.Join(replyTexts(sink, a.ID), "\n")
	replyB := strings.Join(replyTexts(sink, b.ID), "\n")
	if !strings.Contains(replyA, "alpha probe 42") || strings.Contains(replyA, "beta probe 7") {
		t.Fatalf("alpha stream cross-contaminated: %q", replyA)
	}
	if !strings.Contains(replyB, "beta probe 7") || strings.Contains(replyB, "alpha probe 42") {
		t.Fatalf("beta stream cross-contaminated: %q", replyB)
	}
	for _, envelope := range sink.snapshot() {
		if envelope.SessionID != a.ID && envelope.SessionID != b.ID {
			t.Fatalf("envelope for unknown session %s", envelope.SessionID)
		}
	}
}

// TestE2ESmokeResumeContinuesWithHistory: the restored session not only holds
// the old transcript (WS1 covers restore) — its next turn sends the full
// history to the provider.
func TestE2ESmokeResumeContinuesWithHistory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	workspace := filepath.Join(home, "ws")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("workspace: %v", err)
	}
	t.Chdir(workspace) // Resume assembles in the cwd; keep that inside the sandbox

	sink := &collectSink{}
	mgr := NewSessionManager(sink, nil)
	defer mgr.CloseAll()

	first, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := mgr.SendPrompt(first.ID, "codeword kakapo"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	waitFor(t, "first turn to finish", func() bool {
		return mgr.Lifecycle(first.ID) == LifecycleIdle && sinkHasLifecycle(sink, first.ID, LifecycleRunning)
	})

	listings, err := mgr.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listings) == 0 {
		t.Fatal("no resumable sessions after the first turn")
	}
	resumed, err := mgr.Resume(listings[0].ID)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if resumed.ID == first.ID {
		t.Fatal("Resume must create a fresh session id")
	}

	if err := mgr.SendPrompt(resumed.ID, "repeat the codeword"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	// Fresh-session turn one sends just the user message (1); the resumed turn
	// carries user1 + assistant1 (restored) + user2 = 3+ on the wire.
	waitFor(t, "second-turn wire send carrying restored history", func() bool {
		for _, event := range loopEventsOf(sink, resumed.ID) {
			if event.Type == "wire" && event.Phase == "send" && event.Messages >= 3 {
				return true
			}
		}
		return false
	})
	waitFor(t, "resumed turn to finish", func() bool {
		return mgr.Lifecycle(resumed.ID) == LifecycleIdle &&
			sinkHasLifecycle(sink, resumed.ID, LifecycleRunning)
	})
}
