package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/plan"
	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// DefaultContextBudgetTokens fits comfortably inside the smallest context we
// routinely route to (deepseek-chat, 64k).
const DefaultContextBudgetTokens = 48_000

// LoopEvent is everything the UI needs to narrate a run as it happens. One
// struct rather than a union: Go has no discriminated unions, and the Type
// field is what every consumer switches on anyway.
type LoopEvent struct {
	Type string // turn | wire | compaction | progress | plan | reply | tool_start | tool_end

	// turn
	Turn     int
	Provider string

	// wire
	Phase     string // send | recv
	Model     string
	Endpoint  string
	Messages  int
	Tokens    int
	Tools     int
	Ms        int64
	OK        bool
	ToolCalls int
	TextChars int
	Error     string

	// compaction
	TokensBefore      int
	TokensAfter       int
	DroppedMessages   int
	ElidedToolResults int

	// progress / plan / reply / tool_*
	Progress types.ProviderProgress
	Snapshot *types.PlanSnapshot
	Text     string
	Usage    *types.TokenUsage
	Reason   string
	Name     string
	Args     map[string]any
	Preview  string
}

type LoopOptions struct {
	Config       *types.AgentConfig
	Providers    map[string]types.Provider
	Tools        []types.Tool
	ToolContext  *types.ToolContext
	SystemPrompt string
	RolePrompts  map[types.AgentRole]string
	Session      *Session
}

type AgentLoop struct {
	options  LoopOptions
	messages []types.Message
	// The task list survives across runs: the CLI providers resume one native
	// session, so the next turn usually keeps editing the same list.
	planTracker plan.Tracker
	emit        func(LoopEvent)
	// lastProviderName is whoever answered last, so `/compact` defaults to the
	// model that holds the context.
	lastProviderName string
}

func NewAgentLoop(options LoopOptions) *AgentLoop {
	loop := &AgentLoop{options: options, emit: func(LoopEvent) {}}
	// The host-side update_plan tool publishes through the same path as the CLI
	// stream events, so both sources dedupe and persist identically.
	options.ToolContext.OnPlan = func(steps []types.PlanStep, meta types.PlanUpdateMeta) {
		loop.publishPlan(steps, meta)
	}
	return loop
}

func (l *AgentLoop) History() []types.Message { return l.messages }

func (l *AgentLoop) Plan() *types.PlanSnapshot { return l.planTracker.Current() }

// ContextTokens is the estimated size of the live transcript, for `/context`.
func (l *AgentLoop) ContextTokens() int { return HistoryTokens(l.messages) }

// AddContext appends out-of-band context (operator shell output) as a user
// message. Nothing is sent to a provider now: it rides along with the next
// prompt, which is also how the CLI providers pick it up in their resume delta.
func (l *AgentLoop) AddContext(text string) error {
	message := types.UserMessage(text)
	l.messages = append(l.messages, message)
	return l.options.Session.AppendMessage(message)
}

// Restore loads a previous session's transcript into this loop. The messages
// are replayed into the *new* session file too, so the resumed log is
// self-contained and can itself be resumed.
func (l *AgentLoop) Restore(messages []types.Message, snapshot *types.PlanSnapshot) error {
	l.messages = append([]types.Message{}, messages...)
	for _, message := range l.messages {
		if err := l.options.Session.AppendMessage(message); err != nil {
			return err
		}
	}
	if snapshot != nil {
		l.publishPlan(snapshot.Steps, types.PlanUpdateMeta{Source: snapshot.Source, Note: snapshot.Note})
	}
	return nil
}

type CompactResult struct {
	Provider     string
	TokensBefore int
	TokensAfter  int
	Summary      string
}

// Compact folds the whole session into one summary message, using a model
// rather than the mechanical passes. Destructive by design: the detail lives on
// in the JSONL, while the working history restarts from the briefing.
func (l *AgentLoop) Compact(providerName string, ctx context.Context) (CompactResult, error) {
	if providerName == "" {
		providerName = l.lastProviderName
	}
	if providerName == "" {
		providerName = l.options.Config.ExecutorProvider
	}
	provider, ok := l.options.Providers[providerName]
	if !ok {
		return CompactResult{}, fmt.Errorf("provider not configured: %s", providerName)
	}
	if len(l.messages) == 0 {
		return CompactResult{}, errors.New("nothing to compact yet")
	}

	tokensBefore := HistoryTokens(l.messages)
	request := types.UserMessage(SummarizationPrompt())
	view := CompactHistory(append(append([]types.Message{}, l.messages...), request), CompactionOptions{
		BudgetTokens: budgetFor(provider.Config()),
	})
	response, err := provider.Complete(types.ProviderInput{
		System:     l.options.SystemPrompt,
		Messages:   view.Messages,
		Workspace:  l.options.ToolContext.Workspace,
		SessionDir: l.options.ToolContext.SessionDir,
		Ctx:        ctx,
	})
	if err != nil {
		return CompactResult{}, err
	}
	summary := strings.TrimSpace(response.Text)
	if summary == "" {
		return CompactResult{}, fmt.Errorf("%s returned an empty summary; history left untouched", providerName)
	}

	replacement := types.UserMessage("[session summary — earlier turns compacted]\n" + summary)
	l.messages = []types.Message{replacement}
	if err := l.options.Session.AppendMessage(replacement); err != nil {
		return CompactResult{}, err
	}
	tokensAfter := HistoryTokens(l.messages)
	_ = l.options.Session.AppendEvent(map[string]any{
		"type": "compaction", "mode": "summary", "provider": providerName,
		"tokensBefore": tokensBefore, "tokensAfter": tokensAfter,
	})
	return CompactResult{Provider: providerName, TokensBefore: tokensBefore, TokensAfter: tokensAfter, Summary: summary}, nil
}

// pushToolResult appends a tool result, keeping the in-memory history and the
// JSONL in step.
func (l *AgentLoop) pushToolResult(call types.ToolCall, content []types.ContentBlock, isError bool, details any) types.Message {
	message := types.Message{
		Role:       types.MessageToolResult,
		ToolCallID: call.ID,
		ToolName:   call.Name,
		Blocks:     content,
		IsError:    isError,
		Details:    details,
		Timestamp:  types.NowMs(),
	}
	l.messages = append(l.messages, message)
	_ = l.options.Session.AppendMessage(message)
	return message
}

// noteInterrupted closes out an interrupted run. The marker keeps
// user/assistant alternation intact for the strict chat APIs and tells the
// model, on the next turn, that the previous answer was cut short.
func (l *AgentLoop) noteInterrupted() {
	if len(l.messages) > 0 {
		last := l.messages[len(l.messages)-1]
		if last.Role == types.MessageAssistant && len(last.ToolCalls) == 0 {
			return
		}
	}
	marker := types.Message{
		Role:      types.MessageAssistant,
		Blocks:    []types.ContentBlock{types.TextBlock("[interrupted by operator]")},
		Timestamp: types.NowMs(),
	}
	l.messages = append(l.messages, marker)
	_ = l.options.Session.AppendMessage(marker)
	_ = l.options.Session.AppendEvent(map[string]any{"type": "interrupted"})
}

// publishPlan records a new task list, ignoring no-op updates.
func (l *AgentLoop) publishPlan(steps []types.PlanStep, meta types.PlanUpdateMeta) {
	snapshot := l.planTracker.Update(steps, meta)
	if snapshot == nil {
		return
	}
	l.emit(LoopEvent{Type: "plan", Snapshot: snapshot})
	// The plan is a decorative layer; never fail a run over persistence.
	_ = l.options.Session.AppendEvent(map[string]any{
		"type": "plan", "source": snapshot.Source, "note": snapshot.Note, "steps": snapshot.Steps,
	})
}

func budgetFor(config *types.ProviderConfig) int {
	if config.ContextBudgetTokens > 0 {
		return config.ContextBudgetTokens
	}
	return DefaultContextBudgetTokens
}

type RunOptions struct {
	Role         types.AgentRole
	ProviderName string
	MaxTurns     int
	Ctx          context.Context
	OnEvent      func(LoopEvent)
	// Isolated sends only this run's messages to the provider while still
	// appending the exchange to the full session transcript. Delegated workflows
	// use this so an executor receives a bounded packet instead of the planner's
	// full context.
	Isolated bool
	// SystemPrompt overrides the normal global + role prompt for this run.
	// Empty means "use the configured prompts".
	SystemPrompt string
	// Tools overrides the tool list visible to the provider and callable during
	// this run. Nil means "use the configured tools"; an empty slice means no
	// tools.
	Tools []types.Tool
	// FreshSession asks stateful providers not to resume their native session.
	FreshSession bool
}

func (l *AgentLoop) Run(prompt string, options RunOptions) (types.RunResult, error) {
	emit := options.OnEvent
	if emit == nil {
		emit = func(LoopEvent) {}
	}
	l.emit = emit
	// The handler belongs to this turn only. `publishPlan` is also reached from
	// outside a run — `/resume` restores a plan — and a stale handler would
	// commit trace lines to a pane that has already stopped.
	defer func() { l.emit = func(LoopEvent) {} }()
	ctx := options.Ctx
	if ctx == nil {
		ctx = context.Background()
	}

	totals := types.TokenUsage{}
	role := options.Role
	if role == "" {
		role = l.options.Config.DefaultRole
	}
	providerName := options.ProviderName
	effectiveRole := role
	if providerName == "" {
		var route routedRole
		route = l.route(role, prompt)
		providerName = route.Provider
		effectiveRole = route.Role
	}
	provider, ok := l.options.Providers[providerName]
	if !ok {
		return types.RunResult{}, fmt.Errorf("provider not configured: %s", providerName)
	}
	l.lastProviderName = providerName

	turnTools := l.options.Tools
	if options.Tools != nil {
		turnTools = options.Tools
	}
	systemPrompt := l.systemPrompt(effectiveRole)
	if strings.TrimSpace(options.SystemPrompt) != "" {
		systemPrompt = strings.TrimSpace(options.SystemPrompt)
	}

	userMessage := types.UserMessage(prompt)
	l.messages = append(l.messages, userMessage)
	_ = l.options.Session.AppendMessage(userMessage)
	runMessages := l.messages
	if options.Isolated {
		runMessages = []types.Message{userMessage}
	}

	maxTurns := options.MaxTurns
	if maxTurns <= 0 {
		maxTurns = l.options.Config.MaxTurns
	}
	finish := func(turnCount int, interrupted bool) types.RunResult {
		return types.RunResult{
			Provider:    providerName,
			Role:        role,
			Messages:    append([]types.Message{}, l.messages...),
			Turns:       turnCount,
			Usage:       totals,
			Interrupted: interrupted,
		}
	}

	turns := 0
	for ; turns < maxTurns; turns++ {
		if ctx.Err() != nil {
			l.noteInterrupted()
			return finish(turns, true), nil
		}
		emit(LoopEvent{Type: "turn", Turn: turns + 1, Provider: providerName})

		// The transcript on disk stays complete; only the view sent upstream is
		// trimmed to the provider's budget.
		viewMessages := l.messages
		if options.Isolated {
			viewMessages = runMessages
		}
		view := CompactHistory(viewMessages, CompactionOptions{BudgetTokens: budgetFor(provider.Config())})
		if view.DroppedMessages > 0 || view.ElidedToolResults > 0 {
			emit(LoopEvent{
				Type: "compaction", TokensBefore: view.TokensBefore, TokensAfter: view.TokensAfter,
				DroppedMessages: view.DroppedMessages, ElidedToolResults: view.ElidedToolResults,
			})
			_ = l.options.Session.AppendEvent(map[string]any{
				"type": "compaction", "tokensBefore": view.TokensBefore, "tokensAfter": view.TokensAfter,
				"dropped": view.DroppedMessages, "elided": view.ElidedToolResults,
			})
		}

		sentAt := types.NowMs()
		emit(LoopEvent{
			Type: "wire", Phase: "send", Provider: providerName, Model: provider.Config().Model,
			Endpoint: DescribeEndpoint(provider.Config()), Messages: len(view.Messages),
			Tokens: view.TokensAfter, Tools: len(turnTools),
		})

		response, err := provider.Complete(types.ProviderInput{
			System:       systemPrompt,
			Messages:     view.Messages,
			Tools:        turnTools,
			Workspace:    l.options.ToolContext.Workspace,
			SessionDir:   l.options.ToolContext.SessionDir,
			Ctx:          ctx,
			FreshSession: options.FreshSession,
			OnProgress: func(progress types.ProviderProgress) {
				if progress.Kind == "plan" && len(progress.Plan) > 0 {
					l.publishPlan(progress.Plan, types.PlanUpdateMeta{Source: providerName, Note: progress.PlanNote})
				}
				emit(LoopEvent{Type: "progress", Progress: progress})
			},
		})
		if err != nil {
			aborted := ctx.Err() != nil || util.IsAbort(err)
			reason := util.FormatError(err)
			if aborted {
				reason = "interrupted"
			}
			emit(LoopEvent{
				Type: "wire", Phase: "recv", Provider: providerName,
				Ms: types.NowMs() - sentAt, OK: false, Error: reason,
			})
			// An interrupt is an outcome, not a failure: keep the transcript
			// usable so the next prompt (or a resumed session) still lines up.
			if aborted {
				l.noteInterrupted()
				return finish(turns+1, true), nil
			}
			return types.RunResult{}, err
		}

		emit(LoopEvent{
			Type: "wire", Phase: "recv", Provider: providerName, Ms: types.NowMs() - sentAt, OK: true,
			Usage: &response.Usage, ToolCalls: len(response.ToolCalls), TextChars: len(response.Text),
		})
		totals.Add(response.Usage)
		emit(LoopEvent{Type: "reply", Text: response.Text, Usage: &response.Usage, Reason: response.Reasoning})

		assistant := types.Message{
			Role:      types.MessageAssistant,
			Provider:  providerName,
			Model:     provider.Config().Model,
			ToolCalls: response.ToolCalls,
			Timestamp: types.NowMs(),
		}
		if response.Text != "" {
			assistant.Blocks = []types.ContentBlock{types.TextBlock(response.Text)}
		}
		l.messages = append(l.messages, assistant)
		_ = l.options.Session.AppendMessage(assistant)
		if options.Isolated {
			runMessages = append(runMessages, assistant)
		}

		if len(response.ToolCalls) == 0 {
			return finish(turns+1, false), nil
		}

		// Every tool call must end up with a result, including on interrupt:
		// providers reject a history where an assistant tool call dangles.
		interrupted := false
		for _, call := range response.ToolCalls {
			if interrupted || ctx.Err() != nil {
				interrupted = true
				message := l.pushToolResult(call, []types.ContentBlock{
					types.TextBlock("Interrupted by operator before this tool ran."),
				}, true, nil)
				if options.Isolated {
					runMessages = append(runMessages, message)
				}
				continue
			}
			tool := findTool(turnTools, call.Name)
			if tool == nil {
				message := l.pushToolResult(call, []types.ContentBlock{
					types.TextBlock("Tool not found: " + call.Name),
				}, true, nil)
				if options.Isolated {
					runMessages = append(runMessages, message)
				}
				continue
			}

			emit(LoopEvent{Type: "tool_start", Name: call.Name, Args: call.Arguments})
			startedAt := types.NowMs()
			callContext := *l.options.ToolContext
			callContext.Ctx = ctx

			// Tier gate. Command-level safety concerns are raised inside the
			// tool, which is the only place that knows the actual command text.
			err := security.RequestApproval(types.ApprovalRequest{
				Tool: call.Name, Tier: security.TierForRisk(tool.Risk), Summary: summarizeCall(call),
			}, callContext)
			var result types.ToolResult
			if err == nil {
				result, err = tool.Execute(call.Arguments, callContext)
			}
			if err != nil {
				aborted := ctx.Err() != nil || util.IsAbort(err)
				if aborted {
					interrupted = true
				}
				message := util.FormatError(err)
				if aborted {
					message = "Interrupted by operator."
				}
				emit(LoopEvent{Type: "tool_end", Name: call.Name, OK: false, Ms: types.NowMs() - startedAt, Preview: message})
				resultMessage := l.pushToolResult(call, []types.ContentBlock{types.TextBlock(message)}, true, nil)
				if options.Isolated {
					runMessages = append(runMessages, resultMessage)
				}
			} else {
				emit(LoopEvent{
					Type: "tool_end", Name: call.Name, OK: !result.IsError,
					Ms: types.NowMs() - startedAt, Preview: previewOf(result.Content),
				})
				resultMessage := l.pushToolResult(call, result.Content, result.IsError, result.Details)
				if options.Isolated {
					runMessages = append(runMessages, resultMessage)
				}
			}
			// A tool call that finished right as the operator hit ^C still
			// counts: the remaining calls in this batch are the ones to skip.
			if ctx.Err() != nil {
				interrupted = true
			}
		}
		if interrupted {
			l.noteInterrupted()
			return finish(turns+1, true), nil
		}
	}

	_ = l.options.Session.AppendEvent(map[string]any{"type": "max_turns_reached", "maxTurns": maxTurns})
	return types.RunResult{
		Provider: providerName, Role: role,
		Messages: append([]types.Message{}, l.messages...), Turns: turns, Usage: totals,
	}, nil
}

func (l *AgentLoop) SetPrompts(system string, rolePrompts map[types.AgentRole]string) {
	l.options.SystemPrompt = system
	l.options.RolePrompts = rolePrompts
}

func (l *AgentLoop) systemPrompt(role types.AgentRole) string {
	var parts []string
	if strings.TrimSpace(l.options.SystemPrompt) != "" {
		parts = append(parts, strings.TrimSpace(l.options.SystemPrompt))
	}
	if role != "" && role != types.RoleAuto {
		if prompt := strings.TrimSpace(l.options.RolePrompts[role]); prompt != "" {
			parts = append(parts, prompt)
		}
	}
	return strings.Join(parts, "\n\n")
}

type routedRole struct {
	Provider string
	Role     types.AgentRole
}

func (l *AgentLoop) route(role types.AgentRole, prompt string) routedRole {
	switch role {
	case types.RolePlanner:
		return routedRole{Provider: l.options.Config.PlannerProvider, Role: types.RolePlanner}
	case types.RoleExecutor:
		return routedRole{Provider: l.options.Config.ExecutorProvider, Role: types.RoleExecutor}
	case types.RoleResearcher:
		return routedRole{Provider: l.researcherProvider(), Role: types.RoleResearcher}
	}
	if isExecutionPrompt(strings.ToLower(prompt)) {
		return routedRole{Provider: l.options.Config.ExecutorProvider, Role: types.RoleExecutor}
	}
	return routedRole{Provider: l.options.Config.PlannerProvider, Role: types.RolePlanner}
}

func (l *AgentLoop) routeProvider(role types.AgentRole, prompt string) string {
	return l.route(role, prompt).Provider
}

func (l *AgentLoop) researcherProvider() string {
	if l.options.Config.ResearcherProvider != "" {
		return l.options.Config.ResearcherProvider
	}
	return l.options.Config.PlannerProvider
}

func findTool(list []types.Tool, name string) *types.Tool {
	for i := range list {
		if list[i].Name == name {
			return &list[i]
		}
	}
	return nil
}

// DescribeEndpoint says where a turn is actually going, in the shortest honest
// form: a URL for the HTTP providers, the child command for the tmux CLIs.
func DescribeEndpoint(config *types.ProviderConfig) string {
	base := strings.TrimRight(config.BaseURL, "/")
	switch config.Type {
	case types.KindOpenAIChat:
		return orDefault(base, "https://api.openai.com/v1") + "/chat/completions"
	case types.KindOpenAIResponses:
		return orDefault(base, "https://api.openai.com/v1") + "/responses"
	case types.KindAnthropic:
		return orDefault(base, "https://api.anthropic.com") + "/v1/messages"
	case types.KindCLITmux:
		return "tmux:" + orDefault(config.CLICommand, "cli")
	default:
		return fmt.Sprintf("%s://%s", config.Type, config.Model)
	}
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// summarizeCall is the one-line "what is about to run" for the approval prompt.
func summarizeCall(call types.ToolCall) string {
	if len(call.Arguments) == 0 {
		return call.Name
	}
	var parts []string
	for key, value := range call.Arguments {
		rendered, ok := value.(string)
		if !ok {
			encoded, _ := json.Marshal(value)
			rendered = string(encoded)
		}
		parts = append(parts, key+"="+rendered)
	}
	sortStrings(parts)
	return util.Truncate(strings.Join(parts, " "), 200)
}

func previewOf(content []types.ContentBlock) string {
	var texts []string
	for _, block := range content {
		if block.Type == "text" {
			texts = append(texts, block.Text)
		}
	}
	return util.Truncate(util.FirstLine(strings.TrimSpace(strings.Join(texts, " "))), 120)
}

func isExecutionPrompt(lowerPrompt string) bool {
	keywords := []string{
		"run ", "execute", "shell", "command", "read file", "list files", "ls ", "cat ",
		"grep", "strings", "hexdump", "objdump", "nm ", "file ", "check ./", "inspect ./",
		"summarize ./",
		"执行", "运行", "跑一下", "跑 ", "读取", "读一下", "列出", "查看文件", "看文件",
		"检查 ./", "分析 ./", "总结 ./",
	}
	for _, keyword := range keywords {
		if strings.Contains(lowerPrompt, keyword) {
			return true
		}
	}
	return false
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
