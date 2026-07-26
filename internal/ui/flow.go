package ui

// The live dataflow diagram: where the turn currently is, drawn as nodes with
// packets moving along the wires between them.
//
//	[you]══•══▶[ctx]══•══▶((deepseek))
//	 42tok       ▲            ║ thinking 2.1s
//	             ║            ▼
//	          [tools]◀══•══[calls×1]
//	          ⚙ run_command ●●●○
//
// The loop stays the point: tool results flow back up into the context that
// feeds the next request. State comes from LoopEvents; motion comes from Tick(),
// driven by the pane's frame timer, so this file has no timers of its own and
// renders deterministically for a given state.

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

type planBadge struct {
	Done   int
	Total  int
	Source string
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
				state.ActiveTool = event.Progress.Tool
				state.ToolStartedAt = now
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
	case "tool_end":
		state.ToolMs = event.Ms
		state.ToolStartedAt = 0
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

// RenderFlow draws five rows of diagram. It returns nothing when the terminal is
// too narrow to be honest about it.
func RenderFlow(state FlowState, width int, now int64) []string {
	canvas := paintFlow(state, width, now)
	if canvas == nil {
		return nil
	}
	return canvas.Render()
}

// RenderFlowPlain is the same layout without escape sequences — used by tests.
func RenderFlowPlain(state FlowState, width int, now int64) []string {
	canvas := paintFlow(state, width, now)
	if canvas == nil {
		return nil
	}
	return canvas.Plain()
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

	// Wires take whatever is left after the boxes, split evenly and clamped so a
	// wide terminal does not turn into a mostly-empty diagram.
	fixed := youWidth + ctxWidth + DisplayWidth(modelBox)
	wire := (width - fixed - 4) / 2
	if wire < 3 {
		wire = 3
	}
	if wire > 16 {
		wire = 16
	}
	colYou := 1
	colCtx := colYou + youWidth + wire
	colModel := colCtx + ctxWidth + wire
	canvas := NewCanvas(width, 5)

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
	modelHot := active(stageSend, stageWait, stageThink, stageWrite, stageCalls)
	modelStyle := "faint"
	if modelHot {
		modelStyle = "violet"
	}
	canvas.Put(0, colModel, modelBox, modelStyle, modelHot)

	// --- row 1: what each node is carrying ------------------------------------
	canvas.Put(1, colYou+1, fmt.Sprintf("%dmsg", state.Messages), "faint", false)
	ctxLabel := CompactNumber(float64(state.SentTokens)) + "tok"
	canvas.Put(1, colCtx, ctxLabel, "muted", false)
	if state.HasCompacted {
		canvas.Put(1, colCtx+DisplayWidth(ctxLabel)+1, fmt.Sprintf("⇣%d", state.CompactedDrop), "warn", false)
	}
	phaseStyle := "violet"
	if state.Stage == stageError {
		phaseStyle = "err"
	}
	canvas.Put(1, colModel+1, phaseLabel(state, now), phaseStyle, false)

	// --- the plan node ---------------------------------------------------------
	// It lives in the left gutter (rows 2-4, left of colCtx) — the only region
	// free at every width — and is painted outside the tool block, since a plan
	// is routinely published before any tool runs.
	paintPlanBadge(canvas, state, colYou, colCtx)

	// --- row 2: the vertical legs ----------------------------------------------
	// Row 1 belongs to the labels; the verticals get row 2 to themselves so an
	// arrowhead never lands on top of a token count.
	feedbackCol := colCtx + 2
	returnCol := colModel + 2
	bottomActive := active(stageCalls, stageTool, stageWrite)
	toolsRan := state.ToolsOK+state.ToolsFailed > 0
	if bottomActive || toolsRan {
		downStyle := "faint"
		if bottomActive {
			downStyle = "violet"
		}
		canvas.Put(2, returnCol, "▼", downStyle, bottomActive)
		upStyle := "faint"
		if toolsRan {
			upStyle = "ok"
		}
		canvas.Put(2, feedbackCol, "▲", upStyle, toolsRan)

		// --- row 3: the return path ---------------------------------------------
		rightBox := fmt.Sprintf("[calls×%d]", maxOf(state.PendingCalls, 1))
		if state.Stage == stageWrite || (state.PendingCalls == 0 && state.ReplyChars > 0) {
			rightBox = "[reply " + CompactNumber(state.Usage.Output) + "tok]"
		}
		// Hang the box off the model's vertical, and never let it collide with
		// the tools box on a narrow terminal.
		colRight := maxOf(returnCol-1, colCtx+toolsWidth+3)
		toolStyle := "faint"
		if active(stageTool) {
			toolStyle = "ok"
		}
		canvas.Put(3, colCtx, toolsBox, toolStyle, active(stageTool))
		gap := colRight - (colCtx + toolsWidth)
		if gap > 2 {
			drawWire(canvas, 3, colCtx+len(toolsBox), gap, state.Packets[edgeCallsToTools], "left", "violet")
		}
		rightStyle := "faint"
		if bottomActive {
			rightStyle = "violet"
		}
		canvas.Put(3, colRight, rightBox, rightStyle, false)

		// --- row 4: the tool currently doing the work ---------------------------
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
			label := mark + " " + state.ActiveTool
			labelWidth := DisplayWidth(label)
			canvas.Put(4, colCtx, label, style, false)
			timing := FormatDuration(elapsed)
			canvas.Put(4, colCtx+labelWidth+1, timing, "faint", false)
			if toolsRan {
				tally := fmt.Sprintf("✓%d", state.ToolsOK)
				tallyStyle := "faint"
				if state.ToolsFailed > 0 {
					tally += fmt.Sprintf(" ✗%d", state.ToolsFailed)
					tallyStyle = "err"
				}
				canvas.Put(4, colCtx+labelWidth+DisplayWidth(timing)+3, tally, tallyStyle, false)
			}
		}
	}
	return canvas
}

// planFlashFrames is how long the plan node stays lit after an update: ~1.3s at
// a 90ms frame.
const planFlashFrames = 14

const planBarCells = 7

// paintPlanBadge draws the task list as a badge plus a progress bar, hung under
// `[you]`: the plan is the operator's view of the work, so it belongs on the
// operator's side of the diagram. Only counts — the steps themselves are in the
// HUD box below, because Canvas addresses columns and plan steps are routinely
// CJK.
func paintPlanBadge(canvas *Canvas, state FlowState, colYou, colCtx int) {
	badge := state.Plan
	if badge == nil || badge.Total == 0 {
		return
	}
	gutter := colCtx - colYou - 1 // columns available before the ctx column
	if gutter < 7 {
		return
	}

	fresh := state.HasPlanFrame && state.Frame-state.PlanFrame < planFlashFrames
	complete := badge.Done >= badge.Total
	style := "faint"
	switch {
	case complete:
		style = "ok"
	case fresh && state.PlanKind == "step":
		style = "ok"
	case fresh:
		style = "accent"
	}

	// The leg ties the plan to the operator: a packet while it is being written,
	// an arrowhead when a step just closed, a quiet tie otherwise.
	leg := "║"
	if fresh {
		if state.PlanKind == "step" {
			leg = "▲"
		} else if (state.Frame-state.PlanFrame)%spawnEvery < 4 {
			leg = packetGlyph
		}
	}
	canvas.Put(2, colYou+2, leg, style, fresh)

	label := fmt.Sprintf("[%d/%d]", badge.Done, badge.Total)
	if gutter >= 12 {
		label = fmt.Sprintf("[plan %d/%d]", badge.Done, badge.Total)
	}
	canvas.Put(3, colYou, label, style, fresh || complete)

	if gutter >= 8 {
		filled := int(float64(badge.Done)/float64(badge.Total)*planBarCells + 0.5)
		if filled > planBarCells {
			filled = planBarCells
		}
		barStyle := "accentDim"
		if complete {
			barStyle = "ok"
		}
		canvas.Put(4, colYou, strings.Repeat("▰", filled), barStyle, false)
		canvas.Put(4, colYou+filled, strings.Repeat("▱", planBarCells-filled), "rule", false)
	}
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
