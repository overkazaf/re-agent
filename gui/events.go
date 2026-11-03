package main

// EventBridge: the manager's production eventSink. Everything crosses the one
// Wails channel ("gui:event") as an EventEnvelope (contract §0.3). Two cadence
// rules from the plan:
//   - progress-type loop events batch for 50ms per session, so streaming
//     providers do not flood the WebView; any other emission flushes the batch
//     first, preserving order.
//   - a 90ms ticker per running session assembles TickDTO{flow, hud, re, plan}
//     (and advances the spinner/sparkline); it stops when the session goes idle
//     or closed. State-change ticks arrive from the manager immediately.

import (
	"context"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

// EventChannel is the single Wails event channel the frontend listens on.
const EventChannel = "gui:event"

const (
	// progressBatchDelay groups streaming progress events; non-streaming
	// providers usually emit none, so this never delays ordinary narration.
	progressBatchDelay = 50 * time.Millisecond
	// tickInterval is the dashboard redraw cadence (ui.LivePane frameInterval).
	tickInterval = 90 * time.Millisecond
)

// EventBridge fans manager emissions out to the WebView. The emit func and the
// intervals are injectable so timing tests run without Wails or fake clocks.
type EventBridge struct {
	mu sync.Mutex

	// wailsCtx is guarded by ctxMu, not mu: the default emit reads it while
	// mu is already held by emitLocked.
	ctxMu    sync.Mutex
	wailsCtx context.Context
	// emit delivers one envelope; nil means events drop silently.
	emit func(envelope EventEnvelope)
	// tickSource builds one dashboard snapshot; the manager's TickSnapshot.
	tickSource func(sessionID string) (TickDTO, bool)

	batchDelay   time.Duration
	tickInterval time.Duration

	pending map[string][]core.LoopEvent // session → unflushed progress events
	timers  map[string]*time.Timer      // session → batch flush timer
	tickers map[string]chan struct{}    // session → ticker stop signal
}

// NewEventBridge wires the bridge to the manager: the manager is both the event
// producer (SetSink) and the tick snapshot source.
func NewEventBridge(mgr *SessionManager) *EventBridge {
	bridge := &EventBridge{
		tickSource:   mgr.TickSnapshot,
		batchDelay:   progressBatchDelay,
		tickInterval: tickInterval,
		pending:      map[string][]core.LoopEvent{},
		timers:       map[string]*time.Timer{},
		tickers:      map[string]chan struct{}{},
	}
	bridge.emit = func(envelope EventEnvelope) {
		if ctx := bridge.runtimeCtx(); ctx != nil {
			wruntime.EventsEmit(ctx, EventChannel, envelope)
		}
	}
	mgr.SetSink(bridge)
	return bridge
}

// SetRuntimeContext attaches the Wails context at app startup; until then the
// bridge buffers nothing and simply drops emissions (no window to receive them).
func (b *EventBridge) SetRuntimeContext(ctx context.Context) {
	b.ctxMu.Lock()
	b.wailsCtx = ctx
	b.ctxMu.Unlock()
}

func (b *EventBridge) runtimeCtx() context.Context {
	b.ctxMu.Lock()
	defer b.ctxMu.Unlock()
	return b.wailsCtx
}

// SetEmit replaces the delivery func (tests capture envelopes this way).
func (b *EventBridge) SetEmit(emit func(envelope EventEnvelope)) {
	b.mu.Lock()
	b.emit = emit
	b.mu.Unlock()
}

// --- eventSink ---------------------------------------------------------------

// LoopEvent batches progress events and emits everything else at once. Kind
// data is always a []core.LoopEvent slice, per the contract.
func (b *EventBridge) LoopEvent(sessionID string, event core.LoopEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if event.Type == "progress" {
		b.enqueueProgress(sessionID, event)
		return
	}
	b.flushLocked(sessionID) // keep progress narration ahead of the instant event
	b.emitLocked(EventEnvelope{
		SessionID: sessionID, Kind: "loop", Ts: types.NowMs(),
		Data: []core.LoopEvent{event},
	})
}

func (b *EventBridge) Notice(sessionID, level, text string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.flushLocked(sessionID)
	b.emitLocked(EventEnvelope{
		SessionID: sessionID, Kind: "notice", Ts: types.NowMs(),
		Data: NoticeDTO{Level: level, Text: text},
	})
}

func (b *EventBridge) Lifecycle(sessionID, state string) {
	b.mu.Lock()
	b.flushLocked(sessionID)
	b.emitLocked(EventEnvelope{
		SessionID: sessionID, Kind: "lifecycle", Ts: types.NowMs(),
		Data: LifecycleEvent{State: state},
	})
	running := state == LifecycleRunning
	stopped := state == LifecycleIdle || state == LifecycleClosed
	b.mu.Unlock()

	switch {
	case running:
		b.startTicker(sessionID)
	case stopped:
		b.stopTicker(sessionID)
	}
}

// Tick forwards a manager-driven (state-change) tick right away.
func (b *EventBridge) Tick(sessionID string, tick TickDTO) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.flushLocked(sessionID)
	b.emitLocked(EventEnvelope{
		SessionID: sessionID, Kind: "tick", Ts: types.NowMs(), Data: tick,
	})
}

// --- batching ----------------------------------------------------------------

// enqueueProgress accumulates one progress event and arms the flush timer.
// Caller holds b.mu.
func (b *EventBridge) enqueueProgress(sessionID string, event core.LoopEvent) {
	if _, armed := b.timers[sessionID]; !armed {
		session := sessionID
		b.timers[session] = time.AfterFunc(b.batchDelay, func() {
			b.mu.Lock()
			b.flushLocked(session)
			b.mu.Unlock()
		})
	}
	b.pending[sessionID] = append(b.pending[sessionID], event)
}

// flushLocked emits any pending progress batch now and disarms its timer.
// Caller holds b.mu.
func (b *EventBridge) flushLocked(sessionID string) {
	if timer, armed := b.timers[sessionID]; armed {
		timer.Stop()
		delete(b.timers, sessionID)
	}
	events := b.pending[sessionID]
	if len(events) == 0 {
		return
	}
	delete(b.pending, sessionID)
	b.emitLocked(EventEnvelope{
		SessionID: sessionID, Kind: "loop", Ts: types.NowMs(), Data: events,
	})
}

func (b *EventBridge) emitLocked(envelope EventEnvelope) {
	if b.emit != nil {
		b.emit(envelope)
	}
}

// --- ticker ------------------------------------------------------------------

// startTicker launches the 90ms snapshot loop for one running session. The
// goroutine owns its own ticker; stop signals through the per-session channel.
func (b *EventBridge) startTicker(sessionID string) {
	b.mu.Lock()
	if _, live := b.tickers[sessionID]; live {
		b.mu.Unlock()
		return
	}
	stop := make(chan struct{})
	b.tickers[sessionID] = stop
	interval := b.tickInterval
	b.mu.Unlock()

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				tick, ok := b.tickSnapshot(sessionID)
				if !ok {
					b.stopTicker(sessionID) // session vanished — end quietly
					return
				}
				b.Tick(sessionID, tick)
			}
		}
	}()
}

func (b *EventBridge) stopTicker(sessionID string) {
	b.mu.Lock()
	stop, live := b.tickers[sessionID]
	delete(b.tickers, sessionID)
	b.mu.Unlock()
	if live {
		close(stop)
	}
}

// tickSnapshot reads through to the manager under a scratch lock copy so a
// concurrent SetTickSource (tests) cannot race the field read.
func (b *EventBridge) tickSnapshot(sessionID string) (TickDTO, bool) {
	b.mu.Lock()
	source := b.tickSource
	b.mu.Unlock()
	if source == nil {
		return TickDTO{}, false
	}
	return source(sessionID)
}

// Close stops every ticker and flushes every pending batch (app shutdown).
func (b *EventBridge) Close() {
	b.mu.Lock()
	sessions := make([]string, 0, len(b.tickers))
	for sessionID := range b.tickers {
		sessions = append(sessions, sessionID)
	}
	b.mu.Unlock()
	for _, sessionID := range sessions {
		b.stopTicker(sessionID)
	}

	b.mu.Lock()
	pending := make([]string, 0, len(b.timers))
	for sessionID := range b.timers {
		pending = append(pending, sessionID)
	}
	b.mu.Unlock()
	for _, sessionID := range pending {
		b.mu.Lock()
		b.flushLocked(sessionID)
		b.mu.Unlock()
	}
}
