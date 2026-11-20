package main

import (
	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/workflow"
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
	ID        string           `json:"id"`
	Workspace string           `json:"workspace"`
	Role      string           `json:"role"`
	Workflow  string           `json:"workflow"`
	Planner   string           `json:"planner"`
	Executor  string           `json:"executor"`
	Lifecycle string           `json:"lifecycle"` // idle | running | awaiting_approval | closed
	History   []core.LoopEvent `json:"history,omitempty"`
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
	RequestID   string   `json:"requestID"`
	ToolName    string   `json:"toolName"`
	Risk        string   `json:"risk"` // read | write | network | exec
	Summary     string   `json:"summary"`
	ArgsPreview string   `json:"argsPreview"`
	Concerns    []string `json:"concerns"`
}

// TokenUsage aliases core's tagged struct — identical wire format, zero mapping.
type TokenUsage = types.TokenUsage

// WireTokenUsage is types.TokenUsage with non-omitempty tags. core's tags save
// bytes in the transcript file, but on the wire a zero value must still arrive
// as {input:0,...} — with omitempty it crosses as {} and the frontend reads
// undefined, which crashed TelePanel/TranscriptStream on the first tick.
type WireTokenUsage struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	Thinking   float64 `json:"thinking"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	CostUsd    float64 `json:"costUsd"`
}

// wireUsage maps core usage onto the always-complete wire shape.
func wireUsage(u types.TokenUsage) WireTokenUsage {
	return WireTokenUsage{
		Input:      u.Input,
		Output:     u.Output,
		Thinking:   u.Thinking,
		CacheRead:  u.CacheRead,
		CacheWrite: u.CacheWrite,
		CostUsd:    u.CostUsd,
	}
}

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
	Stage          string         `json:"stage"` // idle|send|wait|think|calls|tool|write|done|error
	Turn           int            `json:"turn"`
	Provider       string         `json:"provider"`
	Model          string         `json:"model"`
	Endpoint       string         `json:"endpoint"`
	Messages       int            `json:"messages"`
	SentTokens     int            `json:"sentTokens"`
	Usage          WireTokenUsage `json:"usage"`
	PendingCalls   int            `json:"pendingCalls"`
	ActiveTool     string         `json:"activeTool"`
	ToolStartedAt  int64          `json:"toolStartedAt"` // wall-clock ms; >0 while a tool runs so the panel can show live elapsed
	ToolMs         int64          `json:"toolMs"`
	ToolsOK        int            `json:"toolsOk"`
	ToolsFailed    int            `json:"toolsFailed"`
	ToolRuns       []ToolRunDTO   `json:"toolRuns"`
	ReplyChars     int            `json:"replyChars"`
	CompactedDrop  int            `json:"compactedDrop"`
	CompactedElide int            `json:"compactedElide"`
	HasCompacted   bool           `json:"hasCompacted"`
	Plan           *PlanBadgeDTO  `json:"plan"`
	PlanKind       string         `json:"planKind"` // "" | open | write | step
	Error          string         `json:"error"`
	Frame          int            `json:"frame"`
	Packets        [][]int        `json:"packets"`
	Since          int64          `json:"since"`
}

// HudRouteDTO mirrors ui.HudRoute plus researcher/auditor seats for the
// multi-model governance view.
type HudRouteDTO struct {
	Planner    string `json:"planner"`
	Executor   string `json:"executor"`
	Researcher string `json:"researcher,omitempty"`
	Auditor    string `json:"auditor,omitempty"`
	Active     string `json:"active"`
}

// HudDTO is the per-tick HUD strip: stats, sparkline, routing, queue.
type HudDTO struct {
	Phase        string         `json:"phase"`
	Frame        string         `json:"frame"`
	ElapsedMs    int64          `json:"elapsedMs"`
	Stats        WireTokenUsage `json:"stats"`
	Spark        []float64      `json:"spark"`
	Route        *HudRouteDTO   `json:"route"`
	QueueCount   int            `json:"queueCount"`
	PlanDisplay  string         `json:"planDisplay"`  // auto | collapsed | expanded
	ThinkDisplay string         `json:"thinkDisplay"` // auto | collapsed | expanded
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

// RESamplePromptDTO and RESampleTypeDTO carry workflow.SampleTypes to the
// frontend's RE picker dialog — the one static surface the terminal picker
// renders interactively.
type RESamplePromptDTO struct {
	Short string `json:"short"`
	Full  string `json:"full"`
}

type RESampleTypeDTO struct {
	Key     string              `json:"key"`
	Label   string              `json:"label"`
	Desc    string              `json:"desc"`
	Prompts []RESamplePromptDTO `json:"prompts"`
}

// NewRESampleTypesDTO maps the workflow picker data; prompts are non-nil so
// the slice marshals as [] rather than null (the []-not-null convention).
func NewRESampleTypesDTO() []RESampleTypeDTO {
	types := workflow.SampleTypes()
	out := make([]RESampleTypeDTO, len(types))
	for i, st := range types {
		prompts := make([]RESamplePromptDTO, len(st.Prompts))
		for j, p := range st.Prompts {
			prompts[j] = RESamplePromptDTO{Short: p.Short, Full: p.Full}
		}
		out[i] = RESampleTypeDTO{Key: st.Key, Label: st.Label, Desc: st.Desc, Prompts: prompts}
	}
	return out
}

// GoalCriterionDTO is one host-checked acceptance gate evaluated against the ledger.
type GoalCriterionDTO struct {
	Label  string `json:"label"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail,omitempty"`
}

// GoalSummaryDTO exposes the active /goal task declaration and gate verdicts.
type GoalSummaryDTO struct {
	Primary      string             `json:"primary"`
	Intent       string             `json:"intent,omitempty"`
	TargetFile   string             `json:"targetFile,omitempty"`
	TargetSHA256 string             `json:"targetSha256,omitempty"`
	Accepted     bool               `json:"accepted"`
	Constraints  map[string]string  `json:"constraints,omitempty"`
	Criteria     []GoalCriterionDTO `json:"criteria"`
}

// SandboxActionDTO mirrors security.ActionRecord for the governance graph.
type SandboxActionDTO struct {
	At         int64  `json:"at"`
	Tool       string `json:"tool"`
	Capability string `json:"capability,omitempty"`
	Subject    string `json:"subject"`
	SHA256     string `json:"sha256"`
	Decision   string `json:"decision"` // granted | denied | unmanaged
	Origin     string `json:"origin,omitempty"`
}

// SandboxDTO snapshots the task-scoped capability sandbox and its action audit log.
type SandboxDTO struct {
	Active        bool               `json:"active"`
	Granted       []string           `json:"granted"`
	Device        string             `json:"device,omitempty"`
	GrantedCount  int                `json:"grantedCount"`
	DeniedCount   int                `json:"deniedCount"`
	RecentActions []SandboxActionDTO `json:"recentActions"`
}

// LedgerDTO carries the live evidence ledger, hypothesis stack, and governance
// state (goal contract, capability sandbox, arbitrator findings) for the GUI.
// Slices are always non-nil ([] rather than null on the wire).
type LedgerDTO struct {
	Hypotheses      []types.Hypothesis     `json:"hypotheses"`
	Evidence        []types.EvidenceRecord `json:"evidence"`
	Path            string                 `json:"path,omitempty"`
	AuditorProvider string                 `json:"auditorProvider,omitempty"`
	Goal            *GoalSummaryDTO        `json:"goal,omitempty"`
	Sandbox         *SandboxDTO            `json:"sandbox,omitempty"`
	Findings        []types.Finding        `json:"findings"`
}

// NewLedgerDTO copies the latest hypotheses and evidence records onto the wire
// shape. Bounded so a very long session never bloats the 90ms tick payload.
func NewLedgerDTO(hypotheses []types.Hypothesis, evidence []types.EvidenceRecord, path string) *LedgerDTO {
	const maxEvidence = 100
	if len(evidence) > maxEvidence {
		evidence = evidence[len(evidence)-maxEvidence:]
	}
	hyps := make([]types.Hypothesis, len(hypotheses))
	copy(hyps, hypotheses)
	evs := make([]types.EvidenceRecord, len(evidence))
	copy(evs, evidence)
	return &LedgerDTO{
		Hypotheses: hyps,
		Evidence:   evs,
		Path:       path,
		Findings:   []types.Finding{},
	}
}

// TickDTO is the 90ms dashboard snapshot — everything the five panels render.
// types.PlanSnapshot is already json-tagged in core, so it crosses as-is.
type TickDTO struct {
	Flow   FlowDTO             `json:"flow"`
	Hud    HudDTO              `json:"hud"`
	Re     *ReDTO              `json:"re"`
	Plan   *types.PlanSnapshot `json:"plan"`
	Ledger *LedgerDTO          `json:"ledger,omitempty"`
}

// HypothesisMutationDTO creates or updates a hypothesis or adds a planned
// falsification experiment. It can NEVER create or alter EvidenceRecords.
type HypothesisMutationDTO struct {
	// Action: create | revise | reject | support | challenge | meta | add_experiment
	Action      string   `json:"action"`
	ID          string   `json:"id,omitempty"`
	Claim       string   `json:"claim,omitempty"`
	Confidence  *float64 `json:"confidence,omitempty"`
	EvidenceIDs []string `json:"evidenceIds,omitempty"`
	DependsOn   []string `json:"dependsOn,omitempty"`
	Note        string   `json:"note,omitempty"`
	ExpTitle    string   `json:"expTitle,omitempty"`
	ExpCommand  string   `json:"expCommand,omitempty"`
	ExpExpected string   `json:"expExpected,omitempty"`
}

// RunExperimentDTO executes a hypothesis experiment through the host shell +
// sandbox + approval gate and mints an immutable ev_NNN record from stdout.
type RunExperimentDTO struct {
	HypothesisID string `json:"hypothesisId"`
	ExperimentID string `json:"experimentId,omitempty"`
	Title        string `json:"title,omitempty"`
	Command      string `json:"command,omitempty"`
	Expected     string `json:"expected,omitempty"`
}

// VerificationCaseDTO is one replay test vector for RunVerification.
type VerificationCaseDTO struct {
	Name     string `json:"name"`
	Command  string `json:"command"`
	Input    string `json:"input,omitempty"`
	Expected string `json:"expected"`
}

// VerificationRequestDTO invokes VerifyArtifactTool on a real workspace file
// and files an immutable verification_result ev_NNN record.
type VerificationRequestDTO struct {
	Artifact     string                `json:"artifact"`
	BuildCommand string                `json:"buildCommand,omitempty"`
	Cases        []VerificationCaseDTO `json:"cases"`
	HypothesisID string                `json:"hypothesisId,omitempty"`
}

// ReviewRequestDTO triggers deterministic arbitration or records a formal
// review citing existing ledger ev_NNN records.
type ReviewRequestDTO struct {
	// Mode: arbitrate | operator_audit | model_audit
	Mode          string   `json:"mode"`
	Summary       string   `json:"summary,omitempty"`
	HypothesisID  string   `json:"hypothesisId,omitempty"`
	Verdict       string   `json:"verdict,omitempty"` // support | challenge | reject | ""
	CitedEvidence []string `json:"citedEvidence,omitempty"`
}

// ReviewResultDTO returns the arbitration findings and optional minted audit_finding record.
type ReviewResultDTO struct {
	AuditRecord *types.EvidenceRecord `json:"auditRecord,omitempty"`
	Findings    []types.Finding       `json:"findings"`
}

// LifecycleEvent rides kind=lifecycle.
type LifecycleEvent struct {
	State string `json:"state"` // idle | running | awaiting_approval | closed
}

// ProviderInfoDTO is one configured provider, read-only detail for the
// settings dialog. API keys and base URLs never cross this bridge.
type ProviderInfoDTO struct {
	Name  string `json:"name"`
	Model string `json:"model"`
	Type  string `json:"type"`
}

// SettingsDTO is the active session's effective configuration — what the
// settings dialog renders. Workspace/session identity stays client-side (the
// store already has it); this is pure config.
type SettingsDTO struct {
	Role               string            `json:"role"`
	Provider           string            `json:"provider"` // agent override, "" = auto routing
	PlannerProvider    string            `json:"plannerProvider"`
	ExecutorProvider   string            `json:"executorProvider"`
	ResearcherProvider string            `json:"researcherProvider"`
	AuditProvider      string            `json:"auditProvider"`
	ProviderNames      []string          `json:"providerNames"`
	Providers          []ProviderInfoDTO `json:"providers"`
	MaxTurns           int               `json:"maxTurns"`
	CompactionStrategy string            `json:"compactionStrategy"`
	MCPServerCount     int               `json:"mcpServerCount"`
}

// SettingsPatch is the editable subset; empty/zero fields mean "leave
// unchanged". Provider routes persist through SaveUIPrefs exactly like the
// terminal /planner /executor /researcher /auditor commands; maxTurns is
// session-local (no prefs slot exists for it).
type SettingsPatch struct {
	PlannerProvider    string `json:"plannerProvider"`
	ExecutorProvider   string `json:"executorProvider"`
	ResearcherProvider string `json:"researcherProvider"`
	AuditProvider      string `json:"auditProvider"`
	MaxTurns           int    `json:"maxTurns"`
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
		Usage:          wireUsage(state.Usage),
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
		Stats:        wireUsage(snapshot.Stats),
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
