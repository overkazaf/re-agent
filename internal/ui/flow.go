package ui

// The live dataflow strip: where the turn currently is, drawn as a compact
// two-line pipeline that lives inside the dashboard box. The request path is
// one line, the tool path a second line that only appears when tools are in
// play.
//
//	[you]═•═▶[ctx]▲═•═▶((deepseek))     ⣻ thinking 2.1s
//	[tools]◀═•═[calls×1]   ⚙ run_command 0.2s  ✓3 ✗1
//
// The loop stays the point: the ▲ on the ctx end of the model wire marks tool
// results flowing back into the context that feeds the next request. State
// comes from LoopEvents; motion comes from Tick(), driven by the pane's frame
// timer, so this file has no timers of its own and renders deterministically
// for a given state.

import (
	"fmt"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

// VizMode is what the visualization layer draws: both, one, or nothing.
type VizMode string

var VizModes = []VizMode{"full", "flow", "trace", "off"}

func IsVizMode(value string) bool {
	for _, mode := range VizModes {
		if string(mode) == value {
			return true
		}
	}
	return false
}

type FlowStage string

const (
	stageIdle  FlowStage = "idle"
	stageSend  FlowStage = "send"
	stageWait  FlowStage = "wait"
	stageThink FlowStage = "think"
	stageCalls FlowStage = "calls"
	stageTool  FlowStage = "tool"
	stageWrite FlowStage = "write"
	stageDone  FlowStage = "done"
	stageError FlowStage = "error"
)

// edge names a wire that can carry packets, after the direction data moves.
type edge int

const (
	edgeYouToCtx edge = iota
	edgeCtxToModel
	edgeModelToCalls
	edgeCallsToTools
	edgeToolsToCtx
	edgeCount
)

var spinnerFrames = []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"}

const packetGlyph = "•"

// spawnEvery is the frames between packets: wide enough that packets read as
// moving objects, not as a dashed line.
const spawnEvery = 7
const toolRunKeep = 6

type ToolRunStatus string

const (
	ToolRunRunning ToolRunStatus = "running"
	ToolRunDone    ToolRunStatus = "done"
	ToolRunFailed  ToolRunStatus = "failed"
)

type planBadge struct {
	Done   int
	Total  int
	Source string
}

type ToolRunSnapshot struct {
	ID         int
	Name       string
	ArgsText   string
	Preview    string
	Status     ToolRunStatus
	StartedAt  int64
	FinishedAt int64
	Ms         int64
	OK         bool
}

type FlowState struct {
	Stage          FlowStage
	Turn           int
	Provider       string
	Model          string
	Endpoint       string
	Messages       int
	SentTokens     int
	ToolsAvailable int
	Usage          types.TokenUsage
	PendingCalls   int
	ActiveTool     string
	ToolStartedAt  int64
	ToolMs         int64
	ToolsOK        int
	ToolsFailed    int
	ToolRuns       []ToolRunSnapshot
	NextToolRunID  int
	ReplyChars     int
	CompactedDrop  int
	CompactedElide int
	HasCompacted   bool
	Plan           *planBadge
	// PlanFrame is the frame when the last plan update landed — it drives the
	// flash without a clock.
	PlanFrame    int
	HasPlanFrame bool
	// PlanKind is what that update did, so the flash can pick a colour.
	PlanKind string // open | write | step
	Error    string
	Frame    int
	// Packets holds offsets (in cells) per wire, oldest first.
	Packets [edgeCount][]int
	Since   int64
}

type FlowModel struct {
	mu    sync.Mutex
	state FlowState
}

func NewFlowModel(provider string) *FlowModel {
	return &FlowModel{state: blankState(provider)}
}

// Snapshot copies the state for rendering, so a frame is never drawn from a
// half-applied event.
func (m *FlowModel) Snapshot() FlowState {
	m.mu.Lock()
	defer m.mu.Unlock()
	clone := m.state
	for index := range clone.Packets {
		clone.Packets[index] = append([]int{}, m.state.Packets[index]...)
	}
	clone.ToolRuns = append([]ToolRunSnapshot{}, m.state.ToolRuns...)
	return clone
}

// Begin resets to the pre-request state at the start of a turn.
func (m *FlowModel) Begin(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	turn := m.state.Turn
	// The task list deliberately outlives a turn (see internal/plan), so it is
	// carried over rather than reset with everything else.
	badge := m.state.Plan
	m.state = blankState(name)
	m.state.Turn = turn
	m.state.Plan = badge
	m.state.Stage = stageSend
}

// SeedPlan adopts a plan that predates this turn. Deliberately not Apply: the
// list did not just change, so it must not flash as though it had.
func (m *FlowModel) SeedPlan(snapshot *types.PlanSnapshot) {
	if snapshot == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	done := 0
	for _, step := range snapshot.Steps {
		if step.Status == types.StepCompleted {
			done++
		}
	}
	m.state.Plan = &planBadge{Done: done, Total: len(snapshot.Steps), Source: snapshot.Source}
	m.state.HasPlanFrame = false
	m.state.PlanKind = ""
}

func (m *FlowModel) End(stage FlowStage, detail string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state.Stage = stage
	if detail != "" {
		m.state.Error = detail
	}
	for index := range m.state.Packets {
		m.state.Packets[index] = nil
	}
}

func (m *FlowModel) Apply(event core.LoopEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := types.NowMs()
	state := &m.state

	switch event.Type {
	case "turn":
		state.Turn = event.Turn
		state.Provider = event.Provider
		state.Stage = stageSend
		state.Since = now
	case "compaction":
		state.HasCompacted = true
		state.CompactedDrop = event.DroppedMessages
		state.CompactedElide = event.ElidedToolResults
	case "wire":
		if event.Phase == "send" {
			state.Stage = stageSend
			state.Provider = event.Provider
			state.Model = event.Model
			state.Endpoint = event.Endpoint
			state.Messages = event.Messages
			state.SentTokens = event.Tokens
			state.ToolsAvailable = event.Tools
			state.Since = now
		} else {
			if event.Usage != nil {
				state.Usage = state.Usage.Merge(*event.Usage)
			}
			state.PendingCalls = event.ToolCalls
			state.ReplyChars = event.TextChars
			if event.OK {
				if event.ToolCalls > 0 {
					state.Stage = stageCalls
				} else {
					state.Stage = stageWrite
				}
			} else {
				state.Stage = stageError
				state.Error = event.Error
			}
			state.Packets[edgeCtxToModel] = nil
			state.Since = now
		}
	case "progress":
		switch event.Progress.Kind {
		case "thinking":
			state.Stage = stageThink
		case "text":
			state.Stage = stageWrite
		case "tool":
			if event.Progress.Tool != "" {
				state.Stage = stageTool
				if state.ActiveTool != event.Progress.Tool || state.ToolStartedAt == 0 {
					state.ToolStartedAt = now
				}
				state.ActiveTool = event.Progress.Tool
				ensureToolRunRunning(state, event.Progress.Tool, "", now)
			}
		}
		if event.Progress.Usage != nil {
			state.Usage = state.Usage.Merge(*event.Progress.Usage)
		}
	case "tool_start":
		state.Stage = stageTool
		state.ActiveTool = event.Name
		state.ToolStartedAt = now
		state.ToolMs = 0
		state.Packets[edgeModelToCalls] = nil
		appendToolRun(state, event.Name, summarizeToolArgs(event.Args), now)
	case "tool_end":
		state.ToolMs = event.Ms
		state.ToolStartedAt = 0
		finishToolRun(state, event.Name, event.OK, event.Ms, event.Preview, now)
		if event.OK {
			state.ToolsOK++
		} else {
			state.ToolsFailed++
		}
		if state.PendingCalls > 0 {
			state.PendingCalls--
		}
		// Results feed back into the context for the next request.
		if state.PendingCalls > 0 {
			state.Stage = stageTool
		} else {
			state.Stage = stageSend
		}
	case "plan":
		if event.Snapshot == nil {
			break
		}
		done := 0
		for _, step := range event.Snapshot.Steps {
			if step.Status == types.StepCompleted {
				done++
			}
		}
		previous := state.Plan
		state.Plan = &planBadge{Done: done, Total: len(event.Snapshot.Steps), Source: event.Snapshot.Source}
		state.PlanFrame = state.Frame
		state.HasPlanFrame = true
		switch {
		case previous == nil:
			state.PlanKind = "open"
		case done != previous.Done:
			state.PlanKind = "step"
		default:
			state.PlanKind = "write"
		}
	case "reply":
		state.Stage = stageWrite
		if event.Usage != nil {
			state.Usage = state.Usage.Merge(*event.Usage)
		}
	}
}

func ensureToolRunRunning(state *FlowState, name, argsText string, now int64) {
	if name == "" || name == planTool {
		return
	}
	for index := len(state.ToolRuns) - 1; index >= 0; index-- {
		run := state.ToolRuns[index]
		if run.Name == name && run.Status == ToolRunRunning {
			return
		}
	}
	appendToolRun(state, name, argsText, now)
}

func appendToolRun(state *FlowState, name, argsText string, now int64) {
	if name == "" || name == planTool {
		return
	}
	state.NextToolRunID++
	state.ToolRuns = append(state.ToolRuns, ToolRunSnapshot{
		ID:        state.NextToolRunID,
		Name:      name,
		ArgsText:  argsText,
		Status:    ToolRunRunning,
		StartedAt: now,
	})
	trimToolRuns(state)
}

func finishToolRun(state *FlowState, name string, ok bool, ms int64, preview string, now int64) {
	if name == "" || name == planTool {
		return
	}
	for index := len(state.ToolRuns) - 1; index >= 0; index-- {
		run := &state.ToolRuns[index]
		if run.Name == name && run.Status == ToolRunRunning {
			run.OK = ok
			run.Ms = ms
			run.Preview = preview
			run.FinishedAt = now
			if ok {
				run.Status = ToolRunDone
			} else {
				run.Status = ToolRunFailed
			}
			return
		}
	}
	state.NextToolRunID++
	status := ToolRunFailed
	if ok {
		status = ToolRunDone
	}
	state.ToolRuns = append(state.ToolRuns, ToolRunSnapshot{
		ID:         state.NextToolRunID,
		Name:       name,
		Preview:    preview,
		Status:     status,
		StartedAt:  now,
		FinishedAt: now,
		Ms:         ms,
		OK:         ok,
	})
	trimToolRuns(state)
}

func trimToolRuns(state *FlowState) {
	if len(state.ToolRuns) <= toolRunKeep {
		return
	}
	state.ToolRuns = append([]ToolRunSnapshot{}, state.ToolRuns[len(state.ToolRuns)-toolRunKeep:]...)
}

// Tick advances the animation one frame.
func (m *FlowModel) Tick() {
	m.mu.Lock()
	defer m.mu.Unlock()
	state := &m.state
	now := types.NowMs()
	state.Frame++
	// Non-streaming providers report nothing between request and response, so
	// "sending" would otherwise sit there for the whole round trip.
	if state.Stage == stageSend && now-state.Since > 600 {
		state.Stage = stageWait
	}
	for index := range state.Packets {
		var kept []int
		for _, offset := range state.Packets[index] {
			if offset+1 < 64 {
				kept = append(kept, offset+1)
			}
		}
		state.Packets[index] = kept
	}
	spawn := func(id edge) {
		if state.Frame%spawnEvery == 0 {
			state.Packets[id] = append(state.Packets[id], 0)
		}
	}
	switch state.Stage {
	case stageSend:
		spawn(edgeYouToCtx)
		spawn(edgeCtxToModel)
	case stageWait, stageThink:
		spawn(edgeCtxToModel)
	case stageCalls:
		spawn(edgeModelToCalls)
		spawn(edgeCallsToTools)
	case stageTool:
		spawn(edgeCallsToTools)
	case stageWrite:
		spawn(edgeModelToCalls)
	}
}

func blankState(provider string) FlowState {
	return FlowState{Stage: stageIdle, Turn: 1, Provider: provider, Since: types.NowMs()}
}

const flowMinWidth = 46

// RenderFlow draws a compact one- or two-line strip. It returns nothing when
// the terminal is too narrow to be honest about it.
func RenderFlow(state FlowState, width int, now int64) []string {
	canvas := paintFlow(state, width, now)
	if canvas == nil {
		return nil
	}
	return trimFlowRows(canvas.Render())
}

// RenderFlowPlain is the same layout without escape sequences — used by tests.
func RenderFlowPlain(state FlowState, width int, now int64) []string {
	canvas := paintFlow(state, width, now)
	if canvas == nil {
		return nil
	}
	return trimFlowRows(canvas.Plain())
}

func trimFlowRows(rows []string) []string {
	for len(rows) > 0 && strings.TrimSpace(rows[len(rows)-1]) == "" {
		rows = rows[:len(rows)-1]
	}
	return rows
}

func paintFlow(state FlowState, width int, now int64) *Canvas {
	if width < flowMinWidth || state.Stage == stageIdle {
		return nil
	}
	youBox := "[you]"
	ctxBox := "[ctx]"
	modelBox := "((" + state.Provider + "))"
	toolsBox := "[tools]"

	// Every width here is a column count, not a byte count: the model box
	// embeds a provider name straight from the config, and a non-ASCII one would
	// otherwise shift every column in the diagram.
	youWidth := DisplayWidth(youBox)
	ctxWidth := DisplayWidth(ctxBox)
	toolsWidth := DisplayWidth(toolsBox)
	modelWidth := DisplayWidth(modelBox)

	// Wires take whatever is left after the boxes, split evenly and clamped so a
	// wide terminal does not turn into a mostly-empty strip — the dashboard owns
	// the rest of the row.
	fixed := youWidth + ctxWidth + modelWidth
	wire := (width - fixed - 3) / 2
	if wire < 2 {
		wire = 2
	}
	if wire > 14 {
		wire = 14
	}
	colYou := 0
	colCtx := colYou + youWidth + wire
	colModel := colCtx + ctxWidth + wire
	canvas := NewCanvas(width, 2)

	active := func(stages ...FlowStage) bool {
		for _, stage := range stages {
			if state.Stage == stage {
				return true
			}
		}
		return false
	}
	nodeStyle := func(on bool) string {
		if on {
			return "accent"
		}
		return "faint"
	}

	// --- row 0: the request path ---------------------------------------------
	sending := active(stageSend)
	canvas.Put(0, colYou, youBox, nodeStyle(sending), sending)
	drawWire(canvas, 0, colYou+youWidth, wire, state.Packets[edgeYouToCtx], "right", "accent")
	canvas.Put(0, colCtx, ctxBox, nodeStyle(sending), sending)
	drawWire(canvas, 0, colCtx+ctxWidth, wire, state.Packets[edgeCtxToModel], "right", "accent")
	// Tool results flow back into the context: a lit ▲ on the ctx end of the
	// model wire once any tool has returned.
	toolsRan := state.ToolsOK+state.ToolsFailed > 0
	if toolsRan {
		canvas.Put(0, colCtx+ctxWidth, "▲", "ok", true)
	}
	modelHot := active(stageSend, stageWait, stageThink, stageWrite, stageCalls)
	modelStyle := "faint"
	if modelHot {
		modelStyle = "violet"
	}
	canvas.Put(0, colModel, modelBox, modelStyle, modelHot)
	// The phase label rides the right edge when there is room, so the strip
	// reads as a dashboard instead of a left-heavy diagram with dead space.
	phase := phaseLabel(state, now)
	phaseStyle := "violet"
	if state.Stage == stageError {
		phaseStyle = "err"
	}
	phaseRoom := width - (colModel + modelWidth + 2)
	phaseCol := colModel + modelWidth + 2
	if phaseRoom >= DisplayWidth(phase)+1 {
		phaseCol = width - DisplayWidth(phase) - 1
	}
	canvas.Put(0, phaseCol, phase, phaseStyle, false)

	// --- row 1: the tool path --------------------------------------------------
	bottomActive := active(stageCalls, stageTool)
	if bottomActive || toolsRan {
		rightBox := fmt.Sprintf("[calls×%d]", maxOf(state.PendingCalls, 1))
		if state.Stage == stageWrite || (state.PendingCalls == 0 && state.ReplyChars > 0) {
			rightBox = "[reply " + CompactNumber(state.Usage.Output) + "tok]"
		}
		toolStyle := "faint"
		if active(stageTool) {
			toolStyle = "ok"
		}
		canvas.Put(1, 0, toolsBox, toolStyle, active(stageTool))
		if wire > 1 {
			drawWire(canvas, 1, toolsWidth, wire, state.Packets[edgeCallsToTools], "left", "violet")
		}
		rightStyle := "faint"
		if bottomActive {
			rightStyle = "violet"
		}
		canvas.Put(1, toolsWidth+wire, rightBox, rightStyle, false)

		if state.ActiveTool != "" {
			elapsed := state.ToolMs
			if state.ToolStartedAt != 0 {
				elapsed = now - state.ToolStartedAt
			}
			mark := "✓"
			style := "faint"
			if state.ToolStartedAt != 0 {
				mark = spinnerFrames[state.Frame%len(spinnerFrames)]
				style = "ok"
			} else if state.ToolsFailed > 0 {
				mark = "✗"
				style = "err"
			}
			// A tool name can be anything the provider streams, including a
			// shell command with CJK in it, so measure it in columns too.
			label := mark + " " + state.ActiveTool + " " + FormatDuration(elapsed)
			tally := ""
			tallyStyle := "faint"
			if toolsRan {
				tally = fmt.Sprintf("✓%d", state.ToolsOK)
				if state.ToolsFailed > 0 {
					tally += fmt.Sprintf(" ✗%d", state.ToolsFailed)
					tallyStyle = "err"
				}
			}
			block := label
			if tally != "" {
				block += "  " + tally
			}
			blockWidth := DisplayWidth(block)
			leftCol := toolsWidth + wire + DisplayWidth(rightBox) + 2
			// Same right-edge treatment as the phase label; only falls back to
			// left-adjacent when the block would not fit on its own.
			col := leftCol
			if width-leftCol >= blockWidth+1 {
				col = width - blockWidth - 1
			}
			canvas.Put(1, col, label, style, false)
			if tally != "" {
				canvas.Put(1, col+DisplayWidth(label)+2, tally, tallyStyle, false)
			}
		}
	}
	return canvas
}

func phaseLabel(state FlowState, now int64) string {
	elapsed := now - state.Since
	if elapsed < 0 {
		elapsed = 0
	}
	seconds := FormatDuration(elapsed)
	switch state.Stage {
	case stageSend:
		return "⇢ sending " + seconds
	case stageWait:
		return spinnerFrames[state.Frame%len(spinnerFrames)] + " waiting " + seconds
	case stageThink:
		return spinnerFrames[state.Frame%len(spinnerFrames)] + " thinking " + seconds
	case stageCalls:
		plural := "s"
		if state.PendingCalls == 1 {
			plural = ""
		}
		return fmt.Sprintf("⇠ %d tool call%s", state.PendingCalls, plural)
	case stageTool:
		return "⋯ awaiting tools"
	case stageWrite:
		return "✎ writing " + seconds
	case stageDone:
		return "✓ done"
	case stageError:
		detail := state.Error
		if detail == "" {
			detail = "failed"
		}
		return "✗ " + detail
	}
	return ""
}

// drawWire paints one horizontal wire with packets on it. `offsets` are cell
// distances from the wire's own origin; direction decides which end that is.
func drawWire(canvas *Canvas, row, col, length int, offsets []int, direction, style string) {
	if length <= 0 {
		return
	}
	body := strings.Repeat("═", maxOf(0, length-1)) + "▶"
	if direction == "left" {
		body = "◀" + strings.Repeat("═", maxOf(0, length-1))
	}
	canvas.Put(row, col, body, "rule", false)
	for _, offset := range offsets {
		if offset >= length-1 {
			continue
		}
		at := col + offset
		if direction == "left" {
			at = col + length - 1 - offset
		}
		canvas.Put(row, at, packetGlyph, style, true)
	}
}

func maxOf(a, b int) int {
	if a > b {
		return a
	}
	return b
}
