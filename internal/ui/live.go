package ui

// A live, in-place terminal dashboard: one box carrying the routing chain,
// flow, tool state, task list, streamed reasoning, and token telemetry. Lines
// printed while the pane is active are "committed" above it, so tool activity
// and thinking stay readable without the dashboard scrolling away.
//
// This file owns the redraw and the state; hud.go owns the pixels. The redraw is
// a cursor walk back over exactly the number of lines last written, so the one
// invariant that matters is that the walk length always matches what was drawn.
// RenderHud guarantees both halves of that: every line fits the terminal width
// (no soft wrap inflating the real line count) and the body never exceeds the
// height budget (no scroll shifting the rows out from under the cursor).

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
	"golang.org/x/term"
)

var spinFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

const (
	thinkSummaryGlyph = "✻"
	thinkWindow       = 3
	// thinkBufferMax/Keep bound the retained reasoning tail. Keep has to cover
	// an expanded window on a wide terminal (24 rows × ~200 cols) or `/think
	// expand` would render fewer rows than it asked for.
	thinkBufferMax  = 16000
	thinkBufferKeep = 8000
	frameInterval   = 90 * time.Millisecond
	// heightMargin is the rows kept clear below the pane so the terminal never
	// scrolls under it.
	heightMargin = 2

	// sparkSamples/sampleMs define a ~6s window of output-token deltas.
	sparkSamples = 16
	sampleMs     = 400
)

type LivePaneOptions struct {
	// Route is the dual-model chain shown in the header. Active names the side
	// currently answering; leave empty to show the chain without highlighting.
	Route *HudRoute
	// Flow is the live dataflow state rendered as the FLOW / TOOLS sections of
	// the dashboard. The pane reads this model every frame, so the caller
	// mutates it through the model rather than pushing updates here.
	Flow *FlowModel
	// OnFrame is called once per animation frame, before the redraw.
	OnFrame func()
	// PlanDisplay controls whether task rows start auto-sized, folded, or
	// expanded. The terminal height budget still wins.
	PlanDisplay PlanDisplayMode
	// ThinkDisplay does the same for the streamed reasoning tail.
	ThinkDisplay ThinkDisplayMode
}

type LivePane struct {
	label       string
	interactive bool
	start       time.Time

	mu         sync.Mutex
	stats      types.TokenUsage
	route      *HudRoute
	flow       *FlowModel
	onFrame    func()
	phase      string
	thinking   string
	thinkChars int
	thinkMode  ThinkDisplayMode
	plan       *types.PlanSnapshot
	planMode   PlanDisplayMode
	queueDraft string
	queueCount int
	drawn      int
	tick       int
	stopped    bool
	paused     bool

	spark         []float64
	sawStats      bool
	sampledOutput float64
	sampledAt     int64

	// timer is the current frame generation, replaced on every Resume. Both its
	// fields belong to the goroutine that generation started, which is why it is
	// a value the goroutine closes over rather than state on the pane.
	timer *paneTimer
}

// paneTimer owns one animation generation: a stop channel and the goroutine
// waiting on it.
type paneTimer struct {
	done chan struct{}
	wg   sync.WaitGroup
}

// ComposePane composes one frame inside a single height budget. Wide terminals
// get the sectioned dashboard (one box with FLOW / TOOLS / PLAN / THINK / TELE
// sections); tight terminals fall back to the compact HUD.
//
// The budget is the invariant this whole file rests on — clear() walks back
// exactly as many lines as were drawn, so drawing more than the terminal can
// hold desynchronises the erase.
func ComposePane(now int64, width, budget int, flow *FlowState, hud HudModel) []string {
	if hud.Now == 0 {
		hud.Now = now
	}
	if budget > 0 {
		hud.MaxRows = budget
	}
	return RenderDashboard(flow, hud)
}

func NewLivePane(label string, options LivePaneOptions) *LivePane {
	pane := &LivePane{
		label:       label,
		interactive: term.IsTerminal(int(os.Stdout.Fd())),
		start:       time.Now(),
		phase:       "working",
		route:       options.Route,
		flow:        options.Flow,
		onFrame:     options.OnFrame,
		planMode:    options.PlanDisplay,
		thinkMode:   options.ThinkDisplay,
	}
	if !pane.interactive {
		// Non-TTY (pipes, --print, CI): emit one static line, no animation.
		fmt.Printf("%s\n", C.Faint(fmt.Sprintf("[..] %s %s", label, pane.phase)))
		return pane
	}
	fmt.Print("\x1b[?25l") // hide cursor
	pane.render()
	pane.startTimer()
	return pane
}

// startTimer begins a new frame generation. The goroutine closes over its own
// timer, so a Stop racing a Resume can never signal the wrong generation.
func (p *LivePane) startTimer() {
	timer := &paneTimer{done: make(chan struct{})}
	p.mu.Lock()
	p.timer = timer
	p.mu.Unlock()

	timer.wg.Add(1)
	go func() {
		defer timer.wg.Done()
		ticker := time.NewTicker(frameInterval)
		defer ticker.Stop()
		for {
			select {
			case <-timer.done:
				return
			case <-ticker.C:
				p.mu.Lock()
				p.tick++
				p.mu.Unlock()
				if p.onFrame != nil {
					p.onFrame()
				}
				p.sampleThroughput(types.NowMs())
				p.render()
			}
		}
	}()
}

func (p *LivePane) SetPhase(phase string) {
	p.mu.Lock()
	p.phase = phase
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) SetStats(usage types.TokenUsage) {
	p.mu.Lock()
	p.stats = p.stats.Merge(usage)
	p.sawStats = true
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) PushThinking(delta string) {
	p.mu.Lock()
	p.thinkChars += len(delta)
	p.thinking += delta
	// Keep enough tail to fill an expanded window (24 wrapped rows) on a wide
	// terminal; the HUD only ever renders the last few rows of this.
	if len(p.thinking) > thinkBufferMax {
		p.thinking = p.thinking[len(p.thinking)-thinkBufferKeep:]
	}
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) SetPlan(snapshot *types.PlanSnapshot) {
	p.mu.Lock()
	p.plan = snapshot
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) SetPlanDisplay(mode PlanDisplayMode) {
	p.mu.Lock()
	p.planMode = mode
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) SetThinkDisplay(mode ThinkDisplayMode) {
	p.mu.Lock()
	p.thinkMode = mode
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) SetRoute(route *HudRoute) {
	p.mu.Lock()
	if route == nil {
		p.route = nil
	} else {
		copy := *route
		p.route = &copy
	}
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) SetQueueDraft(draft string) {
	p.mu.Lock()
	p.queueDraft = draft
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) SetQueueCount(count int) {
	p.mu.Lock()
	p.queueCount = count
	p.mu.Unlock()
	p.render()
}

func (p *LivePane) ThinkingChars() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.thinkChars
}

func (p *LivePane) Plan() *types.PlanSnapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.plan
}

// Commit prints a line permanently above the pane.
func (p *LivePane) Commit(line string) {
	if !p.interactive {
		fmt.Println(line)
		return
	}
	lines := safeCommitLines(line, paneWidth())
	p.mu.Lock()
	p.clearLocked()
	// CRLF, not Println: raw mode during a turn drops ONLCR, so a bare "\n"
	// would leave the next redraw starting mid-row (see render).
	for _, line := range lines {
		fmt.Print(line + "\r\n")
	}
	p.mu.Unlock()
	p.render()
}

func safeCommitLines(text string, width int) []string {
	if width < 1 {
		width = 1
	}
	raw := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		line = strings.TrimRight(line, "\r")
		if DisplayWidth(line) > width {
			line = C.Faint(Truncate(line, width))
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

// Pause stops drawing and gives the terminal back (cursor visible, no repaint),
// so something else can own the screen — an approval prompt, for instance.
func (p *LivePane) Pause() {
	if !p.interactive {
		return
	}
	p.mu.Lock()
	if p.stopped || p.paused {
		p.mu.Unlock()
		return
	}
	p.paused = true
	p.clearLocked()
	p.mu.Unlock()
	p.stopTimer()
	fmt.Print("\x1b[?25h") // the prompt needs a visible cursor
}

func (p *LivePane) Resume() {
	if !p.interactive {
		return
	}
	p.mu.Lock()
	if p.stopped || !p.paused {
		p.mu.Unlock()
		return
	}
	p.paused = false
	p.mu.Unlock()
	fmt.Print("\x1b[?25l")
	p.render()
	p.startTimer()
}

// Stop tears the pane down and returns the total elapsed milliseconds.
func (p *LivePane) Stop() int64 {
	elapsed := time.Since(p.start).Milliseconds()
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return elapsed
	}
	p.stopped = true
	paused := p.paused
	p.mu.Unlock()
	if !paused {
		p.stopTimer()
	}
	if !p.interactive {
		return elapsed
	}
	p.mu.Lock()
	p.clearLocked()
	p.mu.Unlock()
	fmt.Print("\x1b[?25h") // show cursor
	return elapsed
}

// stopTimer ends the current generation and waits for its goroutine, so a
// caller that has stopped the pane can be sure nothing will draw over it.
func (p *LivePane) stopTimer() {
	p.mu.Lock()
	timer := p.timer
	p.timer = nil
	p.mu.Unlock()
	if timer == nil {
		return
	}
	close(timer.done)
	timer.wg.Wait()
}

// width leaves the last column empty: writing into it makes some terminals wrap
// eagerly, which would desynchronise the erase walk. Dashboard rendering may use
// the full terminal; the compact HUD fallback caps itself separately.
func paneWidth() int {
	width := TerminalColumns(80) - 1
	if width < 1 {
		width = 1
	}
	return width
}

// heightBudget is the lines the pane may occupy. A terminal that reports no
// size gets a conservative floor rather than free rein: an unbounded body is
// exactly the case where the erase walk desynchronises, and 24 rows is the
// oldest safe answer to "how tall is a terminal".
func heightBudget() int {
	rows := TerminalRows()
	if rows <= 0 {
		rows = 24
	}
	budget := rows - heightMargin
	if budget < 1 {
		return 1
	}
	return budget
}

// sampleThroughput drives the sparkline on a fixed cadence. SetStats arrives in
// bursts (several updates inside one streaming chunk, then nothing for a
// second), so sampling per call would draw the shape of the transport rather
// than of the model.
func (p *LivePane) sampleThroughput(now int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.sawStats {
		return
	}
	if p.sampledAt == 0 {
		p.sampledAt = now
		p.sampledOutput = p.stats.Output
		return
	}
	// Bounded: a long stall (a suspended process, a slow tool) must not push a
	// thousand zero bars through the ring buffer.
	for guard := 0; guard < sparkSamples && now-p.sampledAt >= sampleMs; guard++ {
		current := p.stats.Output
		delta := current - p.sampledOutput
		if delta < 0 {
			delta = 0
		}
		p.spark = append(p.spark, delta)
		p.sampledOutput = current
		p.sampledAt += sampleMs
		if len(p.spark) > sparkSamples {
			p.spark = p.spark[1:]
		}
	}
	if now-p.sampledAt >= sampleMs {
		p.sampledAt = now
	}
}

func (p *LivePane) clearLocked() {
	if p.drawn == 0 {
		return
	}
	var seq strings.Builder
	seq.WriteString("\r")
	for i := 0; i < p.drawn; i++ {
		if i == 0 {
			seq.WriteString("\x1b[2K")
		} else {
			seq.WriteString("\x1b[1A\x1b[2K")
		}
	}
	fmt.Print(seq.String())
	p.drawn = 0
}

func (p *LivePane) render() {
	if !p.interactive {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped || p.paused {
		return
	}
	p.clearLocked()
	// clearLocked erases exactly the line count it last drew, so the body is
	// free to grow and shrink between frames.
	body := p.bodyLocked()
	// Join with CRLF, not a bare LF: the live-input controller holds the
	// terminal in raw mode for the whole turn, which clears ONLCR, so a lone
	// "\n" moves the cursor down without returning the carriage and every row
	// staircases to the right. An explicit "\r" is a no-op in cooked mode, so
	// this is correct whichever mode the terminal is in.
	fmt.Print(strings.Join(body, "\r\n"))
	p.drawn = len(body)
}

func (p *LivePane) bodyLocked() []string {
	now := types.NowMs()
	width := paneWidth()
	var flowState *FlowState
	if p.flow != nil {
		snapshot := p.flow.Snapshot()
		flowState = &snapshot
	}
	return ComposePane(now, width, heightBudget(), flowState, HudModel{
		Label:          p.label,
		Phase:          p.phase,
		Frame:          spinFrames[p.tick%len(spinFrames)],
		ElapsedMs:      time.Since(p.start).Milliseconds(),
		Now:            now,
		Width:          width,
		Stats:          p.stats,
		Spark:          p.spark,
		Route:          p.route,
		Plan:           p.plan,
		PlanDisplay:    p.planMode,
		QueueDraft:     p.queueDraft,
		QueueCount:     p.queueCount,
		Thinking:       p.thinking,
		ThinkingWindow: thinkWindow,
		ThinkDisplay:   p.thinkMode,
	})
}

// ThinkingSummary is the one-line summary printed after a reasoning phase.
func ThinkingSummary(ms int64, tokens float64, chars int) string {
	parts := []string{C.Violet(thinkSummaryGlyph), C.Faint("thought for"), C.Violet(FormatDuration(ms))}
	if tokens > 0 {
		parts = append(parts, C.Faint("·"), C.Violet(fmt.Sprintf("%d tokens", int(tokens))))
	} else if chars > 0 {
		parts = append(parts, C.Faint("·"), C.Violet(fmt.Sprintf("%d chars", chars)))
	}
	return strings.Join(parts, " ")
}
