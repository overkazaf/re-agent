package main

import (
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

// DTO contracts between the Go bridge and the GUI frontend.
// Frozen contract: docs/plans/2026-11-03-gui-implementation.md §0.2-0.4.
// Field names and JSON tags are the API — changing them is a breaking change
// that must go through the plan doc first.

// StartOptions asks the manager to assemble a new session.
type StartOptions struct {
	Workspace string `json:"workspace"`
	Role      string `json:"role"`
	Workflow  string `json:"workflow"`
	Mock      bool   `json:"mock"` // true = all providers forced to mock (same as --smoke)
}

// SessionInfo describes a live GUI session after creation or resume.
type SessionInfo struct {
	ID        string `json:"id"`
	Workspace string `json:"workspace"`
	Role      string `json:"role"`
	Workflow  string `json:"workflow"`
	Planner   string `json:"planner"`
	Executor  string `json:"executor"`
	Lifecycle string `json:"lifecycle"` // idle | running | awaiting_approval | closed
}

// SessionSummaryDTO mirrors core.ListSessions summaries for the resume picker.
type SessionSummaryDTO struct {
	ID          string `json:"id"`
	Hash        string `json:"hash"`
	UpdatedAt   string `json:"updatedAt"`
	Messages    int    `json:"messages"`
	Workspace   string `json:"workspace"`
	FirstPrompt string `json:"firstPrompt"`
}

// NoticeDTO is one line of command output captured by the notice sink.
type NoticeDTO struct {
	Level string `json:"level"` // info | error
	Text  string `json:"text"`
}

// CommandResultDTO is what SendCommand returns to the frontend.
type CommandResultDTO struct {
	OK      bool        `json:"ok"`
	Notices []NoticeDTO `json:"notices"`
}

// ApprovalDTO is a pending tool approval pushed to the frontend.
type ApprovalDTO struct {
	RequestID   string `json:"requestID"`
	ToolName    string `json:"toolName"`
	Risk        string `json:"risk"` // read | write | network | exec
	Summary     string `json:"summary"`
	ArgsPreview string `json:"argsPreview"`
}

// TokenUsage aliases core's tagged struct — identical wire format, zero mapping.
type TokenUsage = types.TokenUsage

// ToolRunDTO mirrors ui.ToolRunSnapshot.
type ToolRunDTO struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	ArgsText   string `json:"argsText"`
	Preview    string `json:"preview"`
	Status     string `json:"status"` // running | done | failed
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt"`
	Ms         int64  `json:"ms"`
	OK         bool   `json:"ok"`
}

// PlanBadgeDTO mirrors ui.planBadge.
type PlanBadgeDTO struct {
	Done   int    `json:"done"`
	Total  int    `json:"total"`
	Source string `json:"source"`
}

// FlowDTO mirrors ui.FlowState — the animated dashboard data source.
type FlowDTO struct {
	Stage          string        `json:"stage"` // idle|send|wait|think|calls|tool|write|done|error
	Turn           int           `json:"turn"`
	Provider       string        `json:"provider"`
	Model          string        `json:"model"`
	Endpoint       string        `json:"endpoint"`
	Messages       int           `json:"messages"`
	SentTokens     int           `json:"sentTokens"`
	Usage          TokenUsage    `json:"usage"`
	PendingCalls   int           `json:"pendingCalls"`
	ActiveTool     string        `json:"activeTool"`
	ToolStartedAt  int64         `json:"toolStartedAt"` // wall-clock ms; >0 while a tool runs so the panel can show live elapsed
	ToolMs         int64         `json:"toolMs"`
	ToolsOK        int           `json:"toolsOk"`
	ToolsFailed    int           `json:"toolsFailed"`
	ToolRuns       []ToolRunDTO  `json:"toolRuns"`
	ReplyChars     int           `json:"replyChars"`
	CompactedDrop  int           `json:"compactedDrop"`
	CompactedElide int           `json:"compactedElide"`
	HasCompacted   bool          `json:"hasCompacted"`
	Plan           *PlanBadgeDTO `json:"plan"`
	PlanKind       string        `json:"planKind"` // "" | open | write | step
	Error          string        `json:"error"`
	Frame          int           `json:"frame"`
	Packets        [][]int       `json:"packets"`
	Since          int64         `json:"since"`
}

// HudRouteDTO mirrors ui.HudRoute.
type HudRouteDTO struct {
	Planner  string `json:"planner"`
	Executor string `json:"executor"`
	Active   string `json:"active"`
}

// HudDTO is the per-tick HUD strip: stats, sparkline, routing, queue.
type HudDTO struct {
	Phase        string       `json:"phase"`
	Frame        string       `json:"frame"`
	ElapsedMs    int64        `json:"elapsedMs"`
	Stats        TokenUsage   `json:"stats"`
	Spark        []float64    `json:"spark"`
	Route        *HudRouteDTO `json:"route"`
	QueueCount   int          `json:"queueCount"`
	PlanDisplay  string       `json:"planDisplay"`  // auto | collapsed | expanded
	ThinkDisplay string       `json:"thinkDisplay"` // auto | collapsed | expanded
}

// ReDTO mirrors ui.REHudModel — the reverse-mode phase tracker.
type ReDTO struct {
	SampleType string `json:"sampleType"`
	Phase      string `json:"phase"`
	PhaseIndex int    `json:"phaseIndex"`
	PhaseCount int    `json:"phaseCount"`
	Hypotheses int    `json:"hypotheses"`
	Evidence   int    `json:"evidence"`
}

// TickDTO is the 90ms dashboard snapshot — everything the five panels render.
// types.PlanSnapshot is already json-tagged in core, so it crosses as-is.
type TickDTO struct {
	Flow FlowDTO             `json:"flow"`
	Hud  HudDTO              `json:"hud"`
	Re   *ReDTO              `json:"re"`
	Plan *types.PlanSnapshot `json:"plan"`
}

// LifecycleEvent rides kind=lifecycle.
type LifecycleEvent struct {
	State string `json:"state"` // idle | running | awaiting_approval | closed
}

// EventEnvelope is the gui:event payload wrapper (contract §0.3). Data holds
// one of: []core.LoopEvent (kind=loop), TickDTO, ApprovalDTO, NoticeDTO,
// LifecycleEvent.
type EventEnvelope struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Ts        int64  `json:"ts"`
	Data      any    `json:"data"`
}

// --- ui state → DTO mapping --------------------------------------------------
//
// The GUI never runs a terminal LivePane, so these functions are the only place
// internal/ui render state becomes wire data. ui.planBadge and ui.FlowStage's
// constant values are unexported on purpose; the mappings here are the sanctioned
// read path (fields of unexported types reached through exported fields).

// NewFlowDTO maps a ui.FlowState snapshot onto the frozen FlowDTO wire shape.
// Slices are always non-nil so the frontend sees [] rather than null.
func NewFlowDTO(state ui.FlowState) FlowDTO {
	dto := FlowDTO{
		Stage:          string(state.Stage),
		Turn:           state.Turn,
		Provider:       state.Provider,
		Model:          state.Model,
		Endpoint:       state.Endpoint,
		Messages:       state.Messages,
		SentTokens:     state.SentTokens,
		Usage:          state.Usage,
		PendingCalls:   state.PendingCalls,
		ActiveTool:     state.ActiveTool,
		ToolStartedAt:  state.ToolStartedAt,
		ToolMs:         state.ToolMs,
		ToolsOK:        state.ToolsOK,
		ToolsFailed:    state.ToolsFailed,
		ToolRuns:       make([]ToolRunDTO, 0, len(state.ToolRuns)),
		ReplyChars:     state.ReplyChars,
		CompactedDrop:  state.CompactedDrop,
		CompactedElide: state.CompactedElide,
		HasCompacted:   state.HasCompacted,
		PlanKind:       state.PlanKind,
		Error:          state.Error,
		Frame:          state.Frame,
		Packets:        make([][]int, len(state.Packets)),
		Since:          state.Since,
	}
	for _, run := range state.ToolRuns {
		dto.ToolRuns = append(dto.ToolRuns, ToolRunDTO{
			ID: run.ID, Name: run.Name, ArgsText: run.ArgsText, Preview: run.Preview,
			Status: string(run.Status), StartedAt: run.StartedAt, FinishedAt: run.FinishedAt,
			Ms: run.Ms, OK: run.OK,
		})
	}
	if state.Plan != nil {
		dto.Plan = &PlanBadgeDTO{Done: state.Plan.Done, Total: state.Plan.Total, Source: state.Plan.Source}
	}
	for index, offsets := range state.Packets {
		packet := make([]int, len(offsets))
		copy(packet, offsets)
		dto.Packets[index] = packet
	}
	return dto
}

// HudSnapshot is the server-side HUD strip state the manager tracks per turn —
// the same fields a ui.HudModel would carry, minus terminal-only details.
type HudSnapshot struct {
	Phase        string
	Frame        string
	ElapsedMs    int64
	Stats        TokenUsage
	Spark        []float64
	Route        *ui.HudRoute
	QueueCount   int
	PlanDisplay  string // auto | collapsed | expanded
	ThinkDisplay string // auto | collapsed | expanded
}

// NewHudDTO maps the tracked HUD state onto the wire shape. Spark is always
// non-nil so the sparkline renders an empty series rather than vanishing.
func NewHudDTO(snapshot HudSnapshot) HudDTO {
	spark := make([]float64, len(snapshot.Spark))
	copy(spark, snapshot.Spark)
	dto := HudDTO{
		Phase:        snapshot.Phase,
		Frame:        snapshot.Frame,
		ElapsedMs:    snapshot.ElapsedMs,
		Stats:        snapshot.Stats,
		Spark:        spark,
		QueueCount:   snapshot.QueueCount,
		PlanDisplay:  snapshot.PlanDisplay,
		ThinkDisplay: snapshot.ThinkDisplay,
	}
	if snapshot.Route != nil {
		dto.Route = &HudRouteDTO{
			Planner: snapshot.Route.Planner, Executor: snapshot.Route.Executor, Active: snapshot.Route.Active,
		}
	}
	return dto
}

// NewReDTO maps the reverse-mode HUD model; nil stays nil so the frontend hides
// the RE panel outside reverse workflow sessions.
func NewReDTO(model *ui.REHudModel) *ReDTO {
	if model == nil {
		return nil
	}
	return &ReDTO{
		SampleType: model.SampleType,
		Phase:      model.Phase,
		PhaseIndex: model.PhaseIndex,
		PhaseCount: model.PhaseCount,
		Hypotheses: model.Hypotheses,
		Evidence:   model.Evidence,
	}
}

// NewTickDTO assembles the per-tick dashboard snapshot.
func NewTickDTO(flow ui.FlowState, hud HudSnapshot, re *ui.REHudModel, plan *types.PlanSnapshot) TickDTO {
	return TickDTO{Flow: NewFlowDTO(flow), Hud: NewHudDTO(hud), Re: NewReDTO(re), Plan: plan}
}
