package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

// collectSink records every envelope a session manager emits — the test double
// for the real EventBridge.
type collectSink struct {
	mu        sync.Mutex
	envelopes []EventEnvelope
}

func (c *collectSink) LoopEvent(sessionID string, event core.LoopEvent) {
	c.record(EventEnvelope{SessionID: sessionID, Kind: "loop", Data: []core.LoopEvent{event}})
}

func (c *collectSink) Notice(sessionID, level, text string) {
	c.record(EventEnvelope{SessionID: sessionID, Kind: "notice", Data: NoticeDTO{Level: level, Text: text}})
}

func (c *collectSink) Lifecycle(sessionID, state string) {
	c.record(EventEnvelope{SessionID: sessionID, Kind: "lifecycle", Data: LifecycleEvent{State: state}})
}

func (c *collectSink) Tick(sessionID string, tick TickDTO) {
	c.record(EventEnvelope{SessionID: sessionID, Kind: "tick", Data: tick})
}

func (c *collectSink) record(event EventEnvelope) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.envelopes = append(c.envelopes, event)
}

func (c *collectSink) snapshot() []EventEnvelope {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]EventEnvelope{}, c.envelopes...)
}

// noticesFor collects the text of every notice emitted for one session.
func noticesFor(sink *collectSink, id string) []string {
	var out []string
	for _, event := range sink.snapshot() {
		if event.SessionID == id {
			if data, ok := event.Data.(NoticeDTO); ok {
				out = append(out, data.Text)
			}
		}
	}
	return out
}

// sinkHasLifecycle reports whether a lifecycle event of that state was emitted.
func sinkHasLifecycle(sink *collectSink, id, state string) bool {
	for _, event := range sink.snapshot() {
		if event.SessionID != id || event.Kind != "lifecycle" {
			continue
		}
		if data, ok := event.Data.(LifecycleEvent); ok && data.State == state {
			return true
		}
	}
	return false
}

// waitFor polls until cond passes — turn goroutines are asynchronous, so tests
// synchronize on emitted state rather than sleeping.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func testEnv(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir()) // keep config/prefs off the developer machine
	return t.TempDir()
}

// mockScript parses a JSON mock script into provider config — building
// types.MockStep literals by hand would repeat its anonymous ToolCalls struct.
func mockScript(t *testing.T, s *session, script string) {
	t.Helper()
	var steps []types.MockStep
	if err := json.Unmarshal([]byte(script), &steps); err != nil {
		t.Fatalf("mock script: %v", err)
	}
	s.config.Providers["mock"].MockScript = steps
}

// TestMockSessionTurnEmitsEventStream: a mock session runs one turn and the
// frontend event stream carries the full narration — lifecycle transitions,
// loop events (turn → wire send → wire recv → reply), notices, and ticks.
func TestMockSessionTurnEmitsEventStream(t *testing.T) {
	workspace := testEnv(t)
	sink := &collectSink{}
	mgr := NewSessionManager(sink, nil)
	defer mgr.CloseAll()

	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if info.Lifecycle != LifecycleIdle {
		t.Fatalf("fresh session lifecycle = %s", info.Lifecycle)
	}
	if info.Planner != "mock" || info.Executor != "mock" {
		t.Fatalf("mock session routed to %s/%s, want mock/mock", info.Planner, info.Executor)
	}

	if err := mgr.SendPrompt(info.ID, "smoke test: identify yourself"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	waitFor(t, "turn to finish (lifecycle idle again)", func() bool {
		return mgr.Lifecycle(info.ID) == LifecycleIdle && sinkHasLifecycle(sink, info.ID, LifecycleRunning)
	})

	var loopTypes []string
	ticks := 0
	var lifecycles []string
	for _, event := range sink.snapshot() {
		if event.SessionID != info.ID {
			t.Fatalf("envelope for wrong session: %+v", event)
		}
		switch data := event.Data.(type) {
		case []core.LoopEvent:
			for _, loop := range data {
				loopTypes = append(loopTypes, loop.Type)
			}
		case TickDTO:
			ticks++
			if data.Flow.Stage == "" {
				t.Fatal("tick carried an empty flow stage")
			}
		case LifecycleEvent:
			lifecycles = append(lifecycles, data.State)
		}
	}
	// The TUI turn narration: turn header, wire send, wire recv, reply.
	for _, want := range []string{"turn", "wire", "reply"} {
		found := false
		for _, got := range loopTypes {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("loop events missing %q; got %v", want, loopTypes)
		}
	}
	sends, recvs := 0, 0
	for _, event := range sink.snapshot() {
		if data, ok := event.Data.([]core.LoopEvent); ok {
			for _, loop := range data {
				if loop.Type == "wire" && loop.Phase == "send" {
					sends++
				}
				if loop.Type == "wire" && loop.Phase == "recv" {
					recvs++
				}
			}
		}
	}
	if sends == 0 || recvs == 0 {
		t.Fatalf("wire send/recv missing: sends=%d recvs=%d in %v", sends, recvs, loopTypes)
	}
	if ticks == 0 {
		t.Fatal("no tick emitted on state change")
	}
	if len(lifecycles) < 3 || lifecycles[0] != LifecycleIdle ||
		lifecycles[1] != LifecycleRunning || lifecycles[len(lifecycles)-1] != LifecycleIdle {
		t.Fatalf("lifecycle sequence wrong: %v", lifecycles)
	}

	s := mgr.get(info.ID)
	if s == nil {
		t.Fatal("session missing after Start")
	}
	if len(s.loop.History()) < 2 {
		t.Fatalf("expected user+assistant messages, got %d", len(s.loop.History()))
	}
}

// TestSendPromptQueuesWhileRunning: a prompt arriving mid-turn is queued with a
// notice instead of opening a second turn.
func TestSendPromptQueuesWhileRunning(t *testing.T) {
	workspace := testEnv(t)
	sink := &collectSink{}
	mgr := NewSessionManager(sink, nil)
	defer mgr.CloseAll()

	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	s := mgr.get(info.ID)
	if s == nil {
		t.Fatal("session missing after Start")
	}
	// Simulate an in-flight turn without a provider round trip.
	s.mu.Lock()
	s.running = true
	s.mu.Unlock()

	if err := mgr.SendPrompt(info.ID, "queued work"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	if s.queue.Len() != 1 {
		t.Fatalf("queue len = %d, want 1", s.queue.Len())
	}
	found := false
	for _, text := range noticesFor(sink, info.ID) {
		if strings.Contains(text, "queued #1") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no queued notice emitted; notices: %v", noticesFor(sink, info.ID))
	}
}

// TestCloseSessionDeniesPendingApprovalAndLeaksNothing: a turn blocked on an
// approval unwinds when the session closes — the approver sees a cancelled ctx
// and denies, the turn goroutine exits, and no goroutine lingers.
func TestCloseSessionDeniesPendingApprovalAndLeaksNothing(t *testing.T) {
	workspace := testEnv(t)
	sink := &collectSink{}

	approvals := make(chan context.Context, 8)
	approver := func(sessionID string, request types.ApprovalRequest, ctx context.Context) types.ApprovalDecision {
		approvals <- ctx
		<-ctx.Done() // only a session close can unblock this
		return types.DecisionDeny
	}
	mgr := NewSessionManager(sink, approver)

	before := runtime.NumGoroutine()
	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	s := mgr.get(info.ID)
	if s == nil {
		t.Fatal("session missing after Start")
	}
	// Script the mock provider to call a tool, and put the session into
	// always-ask so the exec-tier tool must ask.
	mockScript(t, s, `[{"toolCalls":[{"name":"run_command","arguments":{"command":"echo where-am-i"}}]}]`)
	s.state.ToolContext.Policy.ApprovalMode = types.ApprovalAlwaysAsk

	if err := mgr.SendPrompt(info.ID, "run the scripted tool"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	waitFor(t, "session to reach awaiting_approval", func() bool {
		return mgr.Lifecycle(info.ID) == LifecycleAwaitingApproval
	})
	select {
	case ctx := <-approvals:
		if ctx.Err() != nil {
			t.Fatal("approval ctx already cancelled while the session is open")
		}
		if _, ok := ctx.Deadline(); ok {
			t.Fatal("approval ctx should inherit the session ctx, not a timeout")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("approval never reached the approver")
	}

	if err := mgr.CloseSession(info.ID); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if mgr.Lifecycle(info.ID) != LifecycleClosed {
		t.Fatalf("closed session lifecycle = %s", mgr.Lifecycle(info.ID))
	}
	s.turns.Wait()
	if !sinkHasLifecycle(sink, info.ID, LifecycleClosed) {
		t.Fatal("no closed lifecycle event emitted")
	}

	// Goroutine hygiene: everything the session spawned (turn goroutine, MCP
	// loops) must be gone shortly after close.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= before+1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before+1 {
		t.Fatalf("goroutine leak: %d before, %d after close", before, after)
	}
	if err := mgr.CloseSession(info.ID); err == nil {
		t.Fatal("closing an unknown session must fail")
	}
}

// TestWorkflowDelegationPath: caveman-style delegation (planner → isolated
// executor) runs through the GUI manager with mock providers on both sides —
// the flow model restarts per phase and the transcript lands in the loop.
func TestWorkflowDelegationPath(t *testing.T) {
	workspace := testEnv(t)
	sink := &collectSink{}
	mgr := NewSessionManager(sink, nil)
	defer mgr.CloseAll()

	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true, Workflow: "caveman"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	s := mgr.get(info.ID)
	if s == nil {
		t.Fatal("session missing after Start")
	}
	mockScript(t, s, `[{"text":"planner packet"},{"text":"executor done"}]`)

	if err := mgr.SendPrompt(info.ID, "plan then execute"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	waitFor(t, "delegated turn to finish", func() bool {
		return mgr.Lifecycle(info.ID) == LifecycleIdle && sinkHasLifecycle(sink, info.ID, LifecycleRunning)
	})

	if len(s.loop.History()) < 2 {
		t.Fatal("delegated run produced no transcript")
	}
	if lastAssistantText(s.loop.History()) == "" {
		t.Fatal("delegated run produced no assistant text")
	}
	// Delegation runs two provider sessions in one turn: the planner phase
	// receives the operator task through DelegatedPlannerPrompt, not bare.
	found := false
	for _, message := range s.loop.History() {
		if strings.Contains(message.Text(), "Original operator task") {
			found = true
		}
	}
	if !found {
		t.Fatal("delegation did not wrap the prompt")
	}
}

// TestSessionListAndResume: a completed mock turn leaves a resumable session on
// disk; List shows it and Resume restores its history into a fresh session.
func TestSessionListAndResume(t *testing.T) {
	workspace := testEnv(t)
	t.Chdir(workspace) // Resume assembles in the cwd; keep that inside the sandbox
	sink := &collectSink{}
	mgr := NewSessionManager(sink, nil)
	defer mgr.CloseAll()

	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := mgr.SendPrompt(info.ID, "remember this marker phrase zz-qq"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	waitFor(t, "turn to finish", func() bool {
		return mgr.Lifecycle(info.ID) == LifecycleIdle && sinkHasLifecycle(sink, info.ID, LifecycleRunning)
	})

	listings, err := mgr.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listings) == 0 {
		t.Fatal("List returned no sessions after a completed turn")
	}
	resumed, err := mgr.Resume(listings[0].ID)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	s := mgr.get(resumed.ID)
	if s == nil {
		t.Fatal("resumed session missing")
	}
	if len(s.loop.History()) < 2 {
		t.Fatalf("resumed history too short: %d messages", len(s.loop.History()))
	}
	found := false
	for _, message := range s.loop.History() {
		if strings.Contains(message.Text(), "zz-qq") {
			found = true
		}
	}
	if !found {
		t.Fatal("resumed session lost the original prompt")
	}
	if _, err := mgr.Resume("does-not-exist"); err == nil {
		t.Fatal("Resume with an unknown id must fail")
	}
}

func TestSessionWorkbenchExperimentVerificationAndReview(t *testing.T) {
	workspace := testEnv(t)
	sink := &collectSink{}
	mgr := NewSessionManager(sink, nil)
	defer mgr.CloseAll()

	info, err := mgr.Start(StartOptions{Workspace: workspace, Mock: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// 1. Create hypothesis H-001 with a planned experiment.
	conf := 0.75
	hyp, err := mgr.MutateHypothesis(info.ID, HypothesisMutationDTO{
		Action:      "create",
		Claim:       "decoder script outputs flag{verified_by_host}",
		Confidence:  &conf,
		Note:        "created from workbench",
		ExpTitle:    "Echo test vector",
		ExpCommand:  "printf 'flag{verified_by_host}\\n'",
		ExpExpected: "flag{verified_by_host}",
	})
	if err != nil {
		t.Fatalf("MutateHypothesis(create): %v", err)
	}
	if hyp.ID != "H-001" || len(hyp.Experiments) != 1 || hyp.Experiments[0].EvidenceID != "" {
		t.Fatalf("unexpected initial hypothesis state: %+v", hyp)
	}

	// 2. Run the planned experiment -> mints real ev_001 (runtime_trace) and supports H-001.
	expRec, err := mgr.RunHypothesisExperiment(info.ID, RunExperimentDTO{
		HypothesisID: hyp.ID,
		ExperimentID: hyp.Experiments[0].ID,
	})
	if err != nil {
		t.Fatalf("RunHypothesisExperiment: %v", err)
	}
	if expRec.ID != "ev_001" || expRec.Kind != "runtime_trace" {
		t.Fatalf("expected runtime_trace ev_001, got %+v", expRec)
	}

	// 3. Create a real artifact file in workspace and run RunVerification -> mints ev_002 with SHA256.
	artifactRel := "solve.sh"
	artifactAbs := filepath.Join(workspace, artifactRel)
	if writeErr := os.WriteFile(artifactAbs, []byte("#!/bin/sh\nprintf 'flag{verified_by_host}\\n'\n"), 0o755); writeErr != nil {
		t.Fatalf("write artifact: %v", writeErr)
	}
	verRec, err := mgr.RunVerification(info.ID, VerificationRequestDTO{
		Artifact:     artifactRel,
		HypothesisID: hyp.ID,
		Cases: []VerificationCaseDTO{
			{Name: "replay_flag", Command: "sh solve.sh", Expected: "flag{verified_by_host}"},
		},
	})
	if err != nil {
		t.Fatalf("RunVerification: %v", err)
	}
	if verRec.ID != "ev_002" || verRec.SHA256 == "" || verRec.Verification == nil || verRec.Verification.Passed != 1 {
		t.Fatalf("expected SHA256-stamped verification ev_002, got %+v", verRec)
	}

	// 4. Submit operator review citing ev_001 + ev_002 -> mints audit_finding ev_003.
	revRes, err := mgr.SubmitReview(info.ID, ReviewRequestDTO{
		Mode:          "review",
		HypothesisID:  hyp.ID,
		Verdict:       "support",
		CitedEvidence: []string{"ev_001", "ev_002"},
		Summary:       "Dynamic experiment and artifact replay both match expected flag.",
	})
	if err != nil {
		t.Fatalf("SubmitReview: %v", err)
	}
	if revRes.AuditRecord == nil || revRes.AuditRecord.ID != "ev_003" || revRes.AuditRecord.Kind != "audit_finding" {
		t.Fatalf("expected audit_finding ev_003, got %+v", revRes)
	}
}
