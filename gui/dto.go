package main

import "github.com/overkazaf/re-agent/internal/types"

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
	Stage          string      `json:"stage"` // idle|send|wait|think|calls|tool|write|done|error
	Turn           int         `json:"turn"`
	Provider       string      `json:"provider"`
	Model          string      `json:"model"`
	Endpoint       string      `json:"endpoint"`
	Messages       int         `json:"messages"`
	SentTokens     int         `json:"sentTokens"`
	Usage          TokenUsage  `json:"usage"`
	PendingCalls   int         `json:"pendingCalls"`
	ActiveTool     string      `json:"activeTool"`
	ToolMs         int64       `json:"toolMs"`
	ToolsOK        int         `json:"toolsOk"`
	ToolsFailed    int         `json:"toolsFailed"`
	ToolRuns       []ToolRunDTO `json:"toolRuns"`
	ReplyChars     int         `json:"replyChars"`
	CompactedDrop  int         `json:"compactedDrop"`
	CompactedElide int         `json:"compactedElide"`
	HasCompacted   bool        `json:"hasCompacted"`
	Plan           *PlanBadgeDTO `json:"plan"`
	PlanKind       string      `json:"planKind"` // "" | open | write | step
	Error          string      `json:"error"`
	Frame          int         `json:"frame"`
	Packets        [][]int     `json:"packets"`
	Since          int64       `json:"since"`
}

// HudRouteDTO mirrors ui.HudRoute.
type HudRouteDTO struct {
	Planner  string `json:"planner"`
	Executor string `json:"executor"`
	Active   string `json:"active"`
}

// HudDTO is the per-tick HUD strip: stats, sparkline, routing, queue.
type HudDTO struct {
	Phase       string       `json:"phase"`
	Frame       string       `json:"frame"`
	ElapsedMs   int64        `json:"elapsedMs"`
	Stats       TokenUsage   `json:"stats"`
	Spark       []float64    `json:"spark"`
	Route       *HudRouteDTO `json:"route"`
	QueueCount  int          `json:"queueCount"`
	PlanDisplay string       `json:"planDisplay"` // auto | collapsed | expanded
	ThinkDisplay string      `json:"thinkDisplay"` // auto | collapsed | expanded
}

// ReDTO mirrors ui.REHudModel — the reverse-mode phase tracker.
type ReDTO struct {
	SampleType  string `json:"sampleType"`
	Phase       string `json:"phase"`
	PhaseIndex  int    `json:"phaseIndex"`
	PhaseCount  int    `json:"phaseCount"`
	Hypotheses  int    `json:"hypotheses"`
	Evidence    int    `json:"evidence"`
}

// TickDTO is the 90ms dashboard snapshot — everything the five panels render.
// types.PlanSnapshot is already json-tagged in core, so it crosses as-is.
type TickDTO struct {
	Flow FlowDTO            `json:"flow"`
	Hud  HudDTO             `json:"hud"`
	Re   *ReDTO             `json:"re"`
	Plan *types.PlanSnapshot `json:"plan"`
}

// LifecycleEvent rides kind=lifecycle.
type LifecycleEvent struct {
	State string `json:"state"` // idle | running | awaiting_approval | closed
}
