package main

import (
	"sync"
	"testing"
	"time"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

// captureEmit collects envelopes in arrival order.
func captureEmit() (*[]EventEnvelope, *sync.Mutex, func(EventEnvelope)) {
	var mu sync.Mutex
	var envelopes []EventEnvelope
	return &envelopes, &mu, func(envelope EventEnvelope) {
		mu.Lock()
		defer mu.Unlock()
		envelopes = append(envelopes, envelope)
	}
}

func capturedEnvelopes(envelopes *[]EventEnvelope, mu *sync.Mutex) []EventEnvelope {
	mu.Lock()
	defer mu.Unlock()
	return append([]EventEnvelope{}, *envelopes...)
}

func waitForEnvelopes(t *testing.T, atLeast int, envelopes *[]EventEnvelope, mu *sync.Mutex) []EventEnvelope {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got := capturedEnvelopes(envelopes, mu); len(got) >= atLeast {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("only %d/%d envelopes arrived", len(capturedEnvelopes(envelopes, mu)), atLeast)
	return nil
}

func testBridge(emit func(EventEnvelope), batch, tick time.Duration) *EventBridge {
	return &EventBridge{
		emit:         emit,
		batchDelay:   batch,
		tickInterval: tick,
		pending:      map[string][]core.LoopEvent{},
		timers:       map[string]*time.Timer{},
		tickers:      map[string]chan struct{}{},
	}
}

func progressOf(kind string) types.ProviderProgress {
	return types.ProviderProgress{Kind: kind}
}

// TestProgressEventsBatch: progress events hold back for the batch window and
// leave as one loop envelope carrying all of them, in order.
func TestProgressEventsBatch(t *testing.T) {
	envelopes, mu, emit := captureEmit()
	bridge := testBridge(emit, 60*time.Millisecond, time.Hour)
	defer bridge.Close()

	bridge.LoopEvent("s1", core.LoopEvent{Type: "progress", Progress: progressOf("thinking")})
	bridge.LoopEvent("s1", core.LoopEvent{Type: "progress", Progress: progressOf("status")})
	bridge.LoopEvent("s1", core.LoopEvent{Type: "progress", Progress: progressOf("text")})

	time.Sleep(20 * time.Millisecond) // inside the batch window
	if got := capturedEnvelopes(envelopes, mu); len(got) != 0 {
		t.Fatalf("progress escaped the batch window: %+v", got)
	}

	got := waitForEnvelopes(t, 1, envelopes, mu)
	if len(got) != 1 {
		t.Fatalf("batch arrived as %d envelopes, want 1", len(got))
	}
	if got[0].Kind != "loop" || got[0].SessionID != "s1" {
		t.Fatalf("envelope header wrong: %+v", got[0])
	}
	events, ok := got[0].Data.([]core.LoopEvent)
	if !ok || len(events) != 3 {
		t.Fatalf("batch data wrong: %+v", got[0].Data)
	}
	for i, want := range []string{"thinking", "status", "text"} {
		if events[i].Progress.Kind != want {
			t.Fatalf("batch[%d] = %s, want %s (order lost)", i, events[i].Progress.Kind, want)
		}
	}
}

// TestNonProgressFlushesBatchFirst: an instant event (reply) must not overtake
// pending progress — the batch flushes ahead of it.
func TestNonProgressFlushesBatchFirst(t *testing.T) {
	envelopes, mu, emit := captureEmit()
	bridge := testBridge(emit, time.Hour, time.Hour) // batch would never fire on its own
	defer bridge.Close()

	bridge.LoopEvent("s1", core.LoopEvent{Type: "progress", Progress: progressOf("thinking")})
	bridge.LoopEvent("s1", core.LoopEvent{Type: "reply", Text: "done"})

	got := waitForEnvelopes(t, 2, envelopes, mu)
	if len(got) != 2 {
		t.Fatalf("want exactly 2 envelopes (batch + reply), got %d", len(got))
	}
	first, ok := got[0].Data.([]core.LoopEvent)
	if !ok || len(first) != 1 || first[0].Type != "progress" {
		t.Fatalf("first envelope should flush the progress batch: %+v", got[0])
	}
	reply, ok := got[1].Data.([]core.LoopEvent)
	if !ok || len(reply) != 1 || reply[0].Type != "reply" {
		t.Fatalf("second envelope should be the reply: %+v", got[1])
	}
}

// TestBatchesStayPerSession: another session's traffic neither flushes nor
// merges a pending batch.
func TestBatchesStayPerSession(t *testing.T) {
	envelopes, mu, emit := captureEmit()
	bridge := testBridge(emit, time.Hour, time.Hour)
	defer bridge.Close()

	bridge.LoopEvent("s1", core.LoopEvent{Type: "progress", Progress: progressOf("thinking")})
	bridge.LoopEvent("s2", core.LoopEvent{Type: "reply", Text: "other session"})

	got := waitForEnvelopes(t, 1, envelopes, mu)
	if len(got) != 1 || got[0].SessionID != "s2" {
		t.Fatalf("s2 reply should arrive alone, got %+v", got)
	}
	if got := capturedEnvelopes(envelopes, mu); len(got) != 1 {
		t.Fatalf("s1 batch must stay pending, got %+v", got)
	}
}

// TestTickerRunsWhileActive: lifecycle running starts the 90ms (here: 20ms)
// snapshot cadence; idle stops it — snapshot counts flatten afterwards.
func TestTickerRunsWhileActive(t *testing.T) {
	envelopes, mu, emit := captureEmit()
	bridge := testBridge(emit, 50*time.Millisecond, 20*time.Millisecond)
	defer bridge.Close()

	snapshots := 0
	bridge.tickSource = func(sessionID string) (TickDTO, bool) {
		snapshots++
		return TickDTO{}, true
	}

	bridge.Lifecycle("s1", LifecycleRunning)
	got := waitForEnvelopes(t, 3, envelopes, mu)
	ticks := 0
	for _, envelope := range got {
		if envelope.Kind == "tick" && envelope.SessionID == "s1" {
			ticks++
		}
	}
	if ticks < 2 {
		t.Fatalf("expected repeated ticks while running, got %d of %+v", ticks, got)
	}

	bridge.Lifecycle("s1", LifecycleIdle)
	time.Sleep(80 * time.Millisecond) // several tick intervals
	before := snapshots
	time.Sleep(60 * time.Millisecond)
	if snapshots != before {
		t.Fatalf("ticker kept running after idle: %d → %d snapshots", before, snapshots)
	}
}

// TestTickerStopsWhenSessionVanishes: a tick source reporting "gone" ends the
// cadence quietly instead of spinning forever.
func TestTickerStopsWhenSessionVanishes(t *testing.T) {
	envelopes, mu, emit := captureEmit()
	bridge := testBridge(emit, 50*time.Millisecond, 15*time.Millisecond)
	defer bridge.Close()

	bridge.tickSource = func(sessionID string) (TickDTO, bool) {
		return TickDTO{}, false // session already closed
	}
	bridge.Lifecycle("s1", LifecycleRunning)
	time.Sleep(80 * time.Millisecond)

	for _, envelope := range capturedEnvelopes(envelopes, mu) {
		if envelope.Kind == "tick" {
			t.Fatalf("dead session must not tick: %+v", envelope)
		}
	}
	bridge.mu.Lock()
	live := len(bridge.tickers)
	bridge.mu.Unlock()
	if live != 0 {
		t.Fatalf("ticker registry still holds %d sessions", live)
	}
}

// TestEnvelopeShape: loop data is a []core.LoopEvent, notice data a NoticeDTO,
// lifecycle data a LifecycleEvent — the §0.3 shapes the frontend decodes.
func TestEnvelopeShape(t *testing.T) {
	envelopes, mu, emit := captureEmit()
	bridge := testBridge(emit, time.Hour, time.Hour)
	defer bridge.Close()

	bridge.LoopEvent("s1", core.LoopEvent{Type: "turn", Turn: 1})
	bridge.Notice("s1", "info", "hello")
	bridge.Lifecycle("s1", LifecycleRunning)

	got := waitForEnvelopes(t, 3, envelopes, mu)
	if got[0].Kind != "loop" {
		t.Fatalf("kind = %s", got[0].Kind)
	}
	if events, ok := got[0].Data.([]core.LoopEvent); !ok || len(events) != 1 || events[0].Turn != 1 {
		t.Fatalf("loop data wrong: %+v", got[0].Data)
	}
	if notice, ok := got[1].Data.(NoticeDTO); !ok || notice.Level != "info" || notice.Text != "hello" {
		t.Fatalf("notice data wrong: %+v", got[1].Data)
	}
	if lifecycle, ok := got[2].Data.(LifecycleEvent); !ok || lifecycle.State != LifecycleRunning {
		t.Fatalf("lifecycle data wrong: %+v", got[2].Data)
	}
	if got[0].Ts <= 0 {
		t.Fatal("envelope ts unset")
	}
}

// TestCloseFlushesPending: app shutdown must not swallow an in-flight batch.
func TestCloseFlushesPending(t *testing.T) {
	envelopes, mu, emit := captureEmit()
	bridge := testBridge(emit, time.Hour, time.Hour)

	bridge.LoopEvent("s1", core.LoopEvent{Type: "progress", Progress: progressOf("thinking")})
	bridge.Close()

	got := capturedEnvelopes(envelopes, mu)
	if len(got) != 1 || got[0].Kind != "loop" {
		t.Fatalf("close should flush pending batch, got %+v", got)
	}
}
