package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
)

// approvalCapture collects approval envelopes.
func approvalCapture() (*[]EventEnvelope, *sync.Mutex, func(EventEnvelope)) {
	var mu sync.Mutex
	var envelopes []EventEnvelope
	return &envelopes, &mu, func(envelope EventEnvelope) {
		mu.Lock()
		defer mu.Unlock()
		envelopes = append(envelopes, envelope)
	}
}

func waitForApproval(t *testing.T, envelopes *[]EventEnvelope, mu *sync.Mutex) ApprovalDTO {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		for _, envelope := range *envelopes {
			if envelope.Kind == "approval" {
				if data, ok := envelope.Data.(ApprovalDTO); ok {
					mu.Unlock()
					return data
				}
			}
		}
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("approval envelope never arrived")
	return ApprovalDTO{}
}

// TestApprovalRoundTrip: Confirm blocks, the frontend sees the push, Deliver
// resolves it, Confirm returns the decision, and the table empties.
func TestApprovalRoundTrip(t *testing.T) {
	envelopes, mu, emit := approvalCapture()
	bridge := NewApprovalBridge()
	bridge.SetEmit(emit)

	decisions := make(chan types.ApprovalDecision, 1)
	go func() {
		decisions <- bridge.Confirm("s1", context.Background(), types.ApprovalRequest{
			Tool: "run_command", Tier: types.TierExec, Summary: "echo where-am-i",
		})
	}()

	pushed := waitForApproval(t, envelopes, mu)
	if pushed.ToolName != "run_command" || pushed.Risk != "exec" {
		t.Fatalf("pushed DTO wrong: %+v", pushed)
	}
	if pushed.Summary == "" || pushed.ArgsPreview != pushed.Summary {
		t.Fatalf("pushed text fields wrong: %+v", pushed)
	}
	if len(bridge.Pending("s1")) != 1 {
		t.Fatalf("pending table wrong: %+v", bridge.Pending("s1"))
	}

	if err := bridge.Deliver("s1", pushed.RequestID, "allow"); err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	select {
	case decision := <-decisions:
		if decision != types.DecisionAllow {
			t.Fatalf("decision = %s, want allow", decision)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Confirm never returned")
	}
	if left := bridge.Pending("s1"); len(left) != 0 {
		t.Fatalf("resolved approval still pending: %+v", left)
	}
}

// TestApprovalCtxCancelDenies: a cancelled ctx (session close) resolves to deny
// and clears the table.
func TestApprovalCtxCancelDenies(t *testing.T) {
	envelopes, mu, emit := approvalCapture()
	bridge := NewApprovalBridge()
	bridge.SetEmit(emit)

	ctx, cancel := context.WithCancel(context.Background())
	decisions := make(chan types.ApprovalDecision, 1)
	go func() {
		decisions <- bridge.Confirm("s1", ctx, types.ApprovalRequest{
			Tool: "write_file", Tier: types.TierWrite, Summary: "overwrite notes.md",
		})
	}()
	pushed := waitForApproval(t, envelopes, mu)
	if pushed.Risk != "write" {
		t.Fatalf("risk = %s, want write", pushed.Risk)
	}

	cancel()
	select {
	case decision := <-decisions:
		if decision != types.DecisionDeny {
			t.Fatalf("cancelled approval resolved %s, want deny", decision)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Confirm never returned after cancel")
	}
	if left := bridge.Pending("s1"); len(left) != 0 {
		t.Fatalf("cancelled approval still pending: %+v", left)
	}
}

// TestDeliverRejectsGarbage: unknown ids, wrong sessions, repeat deliveries,
// and malformed decision strings all error.
func TestDeliverRejectsGarbage(t *testing.T) {
	envelopes, mu, emit := approvalCapture()
	bridge := NewApprovalBridge()
	bridge.SetEmit(emit)

	decisions := make(chan types.ApprovalDecision, 1)
	go func() {
		decisions <- bridge.Confirm("s1", context.Background(), types.ApprovalRequest{
			Tool: "run_command", Tier: types.TierExec, Summary: "ls",
		})
	}()
	pushed := waitForApproval(t, envelopes, mu)

	if err := bridge.Deliver("s1", pushed.RequestID, "maybe"); err == nil {
		t.Fatal("malformed decision must error")
	}
	if err := bridge.Deliver("s2", pushed.RequestID, "allow"); err == nil {
		t.Fatal("wrong session must error")
	}
	if err := bridge.Deliver("s1", "apr-9999", "allow"); err == nil {
		t.Fatal("unknown request id must error")
	}
	if err := bridge.Deliver("s1", pushed.RequestID, "deny-always"); err != nil {
		t.Fatalf("first Deliver failed: %v", err)
	}
	<-decisions
	if err := bridge.Deliver("s1", pushed.RequestID, "deny-always"); err == nil {
		t.Fatal("double delivery must error")
	}
}

// TestDenyAll: the close-path backstop resolves everything for the session.
func TestDenyAll(t *testing.T) {
	envelopes, mu, emit := approvalCapture()
	bridge := NewApprovalBridge()
	bridge.SetEmit(emit)

	first := make(chan types.ApprovalDecision, 1)
	second := make(chan types.ApprovalDecision, 1)
	other := make(chan types.ApprovalDecision, 1)
	go func() {
		first <- bridge.Confirm("s1", context.Background(), types.ApprovalRequest{
			Tool: "run_command", Tier: types.TierExec, Summary: "one",
		})
	}()
	go func() {
		second <- bridge.Confirm("s1", context.Background(), types.ApprovalRequest{
			Tool: "write_file", Tier: types.TierWrite, Summary: "two",
		})
	}()
	go func() {
		other <- bridge.Confirm("s2", context.Background(), types.ApprovalRequest{
			Tool: "run_command", Tier: types.TierExec, Summary: "other session",
		})
	}()
	waitForApproval(t, envelopes, mu)
	deadline := time.Now().Add(2 * time.Second)
	for len(bridge.Pending("s1")) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	bridge.DenyAll("s1")
	for _, ch := range []chan types.ApprovalDecision{first, second} {
		select {
		case decision := <-ch:
			if decision != types.DecisionDeny {
				t.Fatalf("DenyAll resolved %s, want deny", decision)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("DenyAll left a pending approval blocked")
		}
	}
	if left := bridge.Pending("s1"); len(left) != 0 {
		t.Fatalf("s1 approvals left: %+v", left)
	}
	// Another session's approval is untouched by s1's DenyAll.
	if len(bridge.Pending("s2")) != 1 {
		t.Fatal("DenyAll must stay within the session")
	}
	bridge.DenyAll("s2")
	select {
	case <-other:
	case <-time.After(2 * time.Second):
		t.Fatal("s2 approval never resolved")
	}
}

// TestAllowAlwaysRememberedPerSession: the end-to-end memory story —
// allow-always on the first ask, the second identical tool call auto-approves
// through the session policy (exactly one approval push).
func TestAllowAlwaysRememberedPerSession(t *testing.T) {
	workspace := testEnv(t)
	sink := &collectSink{}
	bridge := NewApprovalBridge()

	envelopes, mu, emit := approvalCapture()
	bridge.SetEmit(emit)
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
	mockScript(t, s, `[{"toolCalls":[{"name":"run_command","arguments":{"command":"echo one"}}]},{"toolCalls":[{"name":"run_command","arguments":{"command":"echo two"}}]}]`)
	s.state.ToolContext.Policy.ApprovalMode = types.ApprovalAlwaysAsk

	if err := mgr.SendPrompt(info.ID, "two scripted tool calls"); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	// Answer the first push with allow-always.
	pushed := waitForApproval(t, envelopes, mu)
	if err := bridge.Deliver(info.ID, pushed.RequestID, "allow-always"); err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	waitFor(t, "turn to finish", func() bool {
		return mgr.Lifecycle(info.ID) == LifecycleIdle && sinkHasLifecycle(sink, info.ID, LifecycleRunning)
	})

	pushes := 0
	mu.Lock()
	for _, envelope := range *envelopes {
		if envelope.Kind == "approval" {
			pushes++
		}
	}
	mu.Unlock()
	if pushes != 1 {
		t.Fatalf("approval pushed %d times, want exactly 1 (allow-always must silence the second)", pushes)
	}
	if got := s.state.ToolContext.Policy.Approvals["run_command"]; got != "allow" {
		t.Fatalf("policy memory = %q, want allow", got)
	}
}
