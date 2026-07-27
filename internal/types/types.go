// Package types holds the data model shared by every layer: messages, tools,
// providers, plans, and the execution policy. It deliberately depends on
// nothing else in the tree so any package may import it.
package types

import (
	"context"
	"time"
)

type ProviderKind string

const (
	KindOpenAIResponses ProviderKind = "openai-responses"
	KindAnthropic       ProviderKind = "anthropic"
	KindOpenAIChat      ProviderKind = "openai-chat"
	KindCLITmux         ProviderKind = "cli-tmux"
	KindMock            ProviderKind = "mock"
)

type AgentRole string

const (
	RolePlanner    AgentRole = "planner"
	RoleExecutor   AgentRole = "executor"
	RoleResearcher AgentRole = "researcher"
	RoleAuto       AgentRole = "auto"
)

func IsRole(value string) bool {
	switch AgentRole(value) {
	case RolePlanner, RoleExecutor, RoleResearcher, RoleAuto:
		return true
	}
	return false
}

// ReasoningEffort is not accepted at every level by every backend: the OpenAI
// Responses API tops out at "high", while the Claude and Codex CLIs also accept
// "xhigh"/"max".
type ReasoningEffort string

var ReasoningEfforts = []ReasoningEffort{"minimal", "low", "medium", "high", "xhigh", "max"}

func IsEffort(value string) bool {
	for _, effort := range ReasoningEfforts {
		if string(effort) == value {
			return true
		}
	}
	return false
}

// MockStep is one scripted turn for the mock provider.
type MockStep struct {
	Text      string `json:"text,omitempty"`
	ToolCalls []struct {
		ID        string         `json:"id,omitempty"`
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments,omitempty"`
	} `json:"toolCalls,omitempty"`
	Usage *TokenUsage `json:"usage,omitempty"`
}

type ProviderConfig struct {
	Type       ProviderKind `json:"type"`
	Label      string       `json:"label,omitempty"`
	Model      string       `json:"model"`
	BaseURL    string       `json:"baseUrl,omitempty"`
	APIKey     string       `json:"apiKey,omitempty"`
	APIKeyEnv  []string     `json:"apiKeyEnv,omitempty"`
	AuthScheme string       `json:"authScheme,omitempty"` // api-key | bearer

	CLICommand       string   `json:"cliCommand,omitempty"`
	CLIArgs          []string `json:"cliArgs,omitempty"`
	CLITimeoutMs     int      `json:"cliTimeoutMs,omitempty"`
	CLIPromptMaxChar int      `json:"cliPromptMaxChars,omitempty"`
	CLIFallbackDirec *bool    `json:"cliFallbackDirect,omitempty"`
	CLIUnsetEnv      []string `json:"cliUnsetEnv,omitempty"`
	CLIResumeSession bool     `json:"cliResumeSession,omitempty"`
	CLISessionIDArg  string   `json:"cliSessionIdArg,omitempty"`
	CLIResumeArg     string   `json:"cliResumeArg,omitempty"`
	// CLIStream set to false disables live JSONL event streaming for this provider.
	CLIStream *bool `json:"cliStream,omitempty"`

	MaxTokens int `json:"maxTokens,omitempty"`
	// ContextBudgetTokens caps the transcript sent to this provider; older
	// history is compacted away.
	ContextBudgetTokens int `json:"contextBudgetTokens,omitempty"`

	// MockScript: one scripted response per turn, so tool flows run offline.
	MockScript []MockStep `json:"mockScript,omitempty"`

	ReasoningEffort ReasoningEffort   `json:"reasoningEffort,omitempty"`
	Headers         map[string]string `json:"headers,omitempty"`
}

type AgentConfig struct {
	Name               string `json:"name"`
	PlannerProvider    string `json:"plannerProvider"`
	ExecutorProvider   string `json:"executorProvider"`
	ResearcherProvider string `json:"researcherProvider,omitempty"`
	// KnowledgeProvider answers `/know` lookups; falls back to the executor.
	KnowledgeProvider string                      `json:"knowledgeProvider,omitempty"`
	DefaultRole       AgentRole                   `json:"defaultRole"`
	MaxTurns          int                         `json:"maxTurns"`
	Providers         map[string]*ProviderConfig  `json:"providers"`
	MCPServers        map[string]*MCPServerConfig `json:"mcpServers,omitempty"`
}

// MCPServerConfig describes one stdio MCP server whose tools join the registry.
type MCPServerConfig struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	// TimeoutMs is a per-call ceiling; decompiling a large function is not instant.
	TimeoutMs int  `json:"timeoutMs,omitempty"`
	Disabled  bool `json:"disabled,omitempty"`
	// Tools, when set, restricts the exposed tool names.
	Tools []string `json:"tools,omitempty"`
}

// --- messages ----------------------------------------------------------------

type ContentBlock struct {
	Type     string `json:"type"` // text | image
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

func TextBlock(text string) ContentBlock {
	return ContentBlock{Type: "text", Text: text}
}

func TextFromBlocks(blocks []ContentBlock) string {
	out := make([]byte, 0, 64)
	first := true
	for _, block := range blocks {
		if block.Type != "text" {
			continue
		}
		if !first {
			out = append(out, '\n')
		}
		out = append(out, block.Text...)
		first = false
	}
	return string(out)
}

type ToolCall struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

type Role string

const (
	MessageSystem     Role = "system"
	MessageUser       Role = "user"
	MessageAssistant  Role = "assistant"
	MessageToolResult Role = "toolResult"
)

// Message is the union of every transcript entry, flattened so it round-trips
// through the session JSONL exactly like the TypeScript original. Encoding
// lives in message_json.go: `content` is a string for system messages and a
// block array for every other role.
type Message struct {
	Role Role
	// Blocks carries the content of user/assistant/toolResult messages.
	Blocks []ContentBlock
	// System carries the content of a system message.
	System string

	ToolCalls []ToolCall
	Provider  string
	Model     string

	ToolCallID string
	ToolName   string
	IsError    bool
	Details    any

	Timestamp int64
}

func UserMessage(text string) Message {
	return Message{Role: MessageUser, Blocks: []ContentBlock{TextBlock(text)}, Timestamp: NowMs()}
}

func (m Message) Text() string { return TextFromBlocks(m.Blocks) }

func NowMs() int64 { return time.Now().UnixMilli() }

// --- plans -------------------------------------------------------------------

type PlanStepStatus string

const (
	StepPending    PlanStepStatus = "pending"
	StepInProgress PlanStepStatus = "in_progress"
	StepCompleted  PlanStepStatus = "completed"
)

func IsPlanStatus(value string) bool {
	switch PlanStepStatus(value) {
	case StepPending, StepInProgress, StepCompleted:
		return true
	}
	return false
}

// PlanStep is one step of the task list a provider is working through.
type PlanStep struct {
	Text   string         `json:"text"`
	Status PlanStepStatus `json:"status"`
	// ID is the provider-side identifier, when the source has one.
	ID string `json:"id,omitempty"`
	// StartedAt/CompletedAt are filled in by the tracker, for HUD timings.
	StartedAt   int64 `json:"startedAt,omitempty"`
	CompletedAt int64 `json:"completedAt,omitempty"`
}

type PlanSnapshot struct {
	Steps []PlanStep `json:"steps"`
	// Source is a provider name, or "update_plan" for the host tool.
	Source    string `json:"source"`
	Note      string `json:"note,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

type PlanUpdateMeta struct {
	Source string
	Note   string
}

// --- approval ----------------------------------------------------------------

// ApprovalTier states how much trust a call needs: reads are cheap, exec can do
// anything.
type ApprovalTier string

const (
	TierRead  ApprovalTier = "read"
	TierWrite ApprovalTier = "write"
	TierExec  ApprovalTier = "exec"
)

// ApprovalMode: `yolo` never prompts. `safe` (default) runs any tool but stops
// for commands that trip a safety pattern. `write` also stops for every
// exec-tier tool, and `always-ask` stops for anything that is not a read.
type ApprovalMode string

const (
	ApprovalYolo      ApprovalMode = "yolo"
	ApprovalSafe      ApprovalMode = "safe"
	ApprovalWrite     ApprovalMode = "write"
	ApprovalAlwaysAsk ApprovalMode = "always-ask"
)

type ApprovalDecision string

const (
	DecisionAllow       ApprovalDecision = "allow"
	DecisionAllowAlways ApprovalDecision = "allow-always"
	DecisionDeny        ApprovalDecision = "deny"
	DecisionDenyAlways  ApprovalDecision = "deny-always"
)

type ApprovalRequest struct {
	Tool string
	Tier ApprovalTier
	// Summary is a one-line description of what is about to happen.
	Summary string
	// Concerns are the safety patterns the request tripped; non-empty means
	// always prompt.
	Concerns []string
}

type ExecutionPolicy struct {
	AllowWrites      bool `json:"allowWrites"`
	AllowNetwork     bool `json:"allowNetwork"`
	AllowSensitive   bool `json:"allowSensitive"`
	CommandTimeoutMs int  `json:"commandTimeoutMs"`
	MaxReadBytes     int  `json:"maxReadBytes"`
	// MaxToolOutputChars is the per-call context budget; anything larger is
	// spilled to an artifact file.
	MaxToolOutputChars int          `json:"maxToolOutputChars"`
	ApprovalMode       ApprovalMode `json:"approvalMode"`
	// Approvals holds per-tool overrides, including the ones the operator sets
	// with "always" during a session.
	Approvals map[string]string `json:"approvals"`
}

// ToolContext carries everything a tool needs beyond its arguments.
type ToolContext struct {
	Workspace  string
	SessionDir string
	Policy     *ExecutionPolicy
	// Ctx is cancelled when the operator interrupts the turn.
	Ctx context.Context
	// Confirm is set by the CLI in interactive mode; nil means "no one is there
	// to ask".
	Confirm func(ApprovalRequest) ApprovalDecision
	// OnPlan lets the update_plan tool publish into the live pane.
	OnPlan func([]PlanStep, PlanUpdateMeta)
}

func (tc ToolContext) Context() context.Context {
	if tc.Ctx == nil {
		return context.Background()
	}
	return tc.Ctx
}

type ToolResult struct {
	Content []ContentBlock
	IsError bool
	Details any
}

// Risk is what a tool can do; the approval tier is derived from it.
type Risk string

const (
	RiskRead    Risk = "read"
	RiskWrite   Risk = "write"
	RiskExecute Risk = "execute"
	RiskNetwork Risk = "network"
)

type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
	Risk        Risk
	Execute     func(args map[string]any, tc ToolContext) (ToolResult, error)
}

// --- providers ---------------------------------------------------------------

type TokenUsage struct {
	Input      float64 `json:"input,omitempty"`
	Output     float64 `json:"output,omitempty"`
	Thinking   float64 `json:"thinking,omitempty"`
	CacheRead  float64 `json:"cacheRead,omitempty"`
	CacheWrite float64 `json:"cacheWrite,omitempty"`
	CostUsd    float64 `json:"costUsd,omitempty"`
}

func (u TokenUsage) Empty() bool { return u == TokenUsage{} }

// Merge overwrites the fields set in next (used by streaming counters).
func (u TokenUsage) Merge(next TokenUsage) TokenUsage {
	out := u
	if next.Input != 0 {
		out.Input = next.Input
	}
	if next.Output != 0 {
		out.Output = next.Output
	}
	if next.Thinking != 0 {
		out.Thinking = next.Thinking
	}
	if next.CacheRead != 0 {
		out.CacheRead = next.CacheRead
	}
	if next.CacheWrite != 0 {
		out.CacheWrite = next.CacheWrite
	}
	if next.CostUsd != 0 {
		out.CostUsd = next.CostUsd
	}
	return out
}

// Add sums usage across turns; each turn bills separately.
func (u *TokenUsage) Add(next TokenUsage) {
	u.Input += next.Input
	u.Output += next.Output
	u.Thinking += next.Thinking
	u.CacheRead += next.CacheRead
	u.CacheWrite += next.CacheWrite
	u.CostUsd += next.CostUsd
}

type ProviderResponse struct {
	Text      string
	ToolCalls []ToolCall
	Usage     TokenUsage
	// Reasoning is the full reasoning text, when the provider exposes one.
	Reasoning string
	Raw       any
}

// ProviderProgress is live progress emitted while a turn is still running.
type ProviderProgress struct {
	Kind string // status | thinking | text | tool | usage | plan
	Text string
	Tool string
	// Status is a short phase label.
	Status string
	Usage  *TokenUsage
	// Plan is a full replacement task list, carried by kind=plan.
	Plan     []PlanStep
	PlanNote string
}

type ProviderInput struct {
	System     string
	Messages   []Message
	Tools      []Tool
	Workspace  string
	SessionDir string
	Ctx        context.Context
	OnProgress func(ProviderProgress)
}

func (in ProviderInput) Context() context.Context {
	if in.Ctx == nil {
		return context.Background()
	}
	return in.Ctx
}

type Provider interface {
	Name() string
	Config() *ProviderConfig
	Complete(input ProviderInput) (ProviderResponse, error)
}

type RunOptions struct {
	Role         AgentRole
	ProviderName string
	MaxTurns     int
	Ctx          context.Context
	OnEvent      func(any)
}

type RunResult struct {
	Provider string
	Role     AgentRole
	Messages []Message
	Turns    int
	Usage    TokenUsage
	// Interrupted: the operator stopped this run; Messages is still valid.
	Interrupted bool
}
