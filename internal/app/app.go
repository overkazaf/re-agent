package app

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/overkazaf/re-agent/internal/assets"
	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/buildinfo"
	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/mcp"
	"github.com/overkazaf/re-agent/internal/providers"
	"github.com/overkazaf/re-agent/internal/skills"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/workflow"
	"golang.org/x/term"
)

// State is everything one session needs; the REPL mutates it in place as the
// operator re-routes with /agent, /role, /planner, /executor, /researcher.
type State struct {
	Config       *types.AgentConfig
	Loop         *core.AgentLoop
	Session      *core.Session
	Tools        []types.Tool
	ToolContext  *types.ToolContext
	Role         types.AgentRole
	Provider     string
	Skills       []skills.Skill
	MCP          []mcp.Connection
	Flow         ui.VizMode
	Splash       *ui.SplashContext
	Providers    map[string]types.Provider
	Workflow     workflow.Mode
	Queue        *taskQueue
	PlanDisplay  ui.PlanDisplayMode
	ThinkDisplay ui.ThinkDisplayMode
	editor       *Editor
}

func Run(argv []string) error {
	args, err := ParseArgs(argv)
	if err != nil {
		return err
	}
	if args.ShowVersion {
		fmt.Println(buildinfo.VersionReport())
		return nil
	}

	// Theme first: everything rendered afterwards (banner, errors) uses it.
	prefs := config.LoadUIPrefs()
	if args.Theme != "" {
		ui.SetTheme(args.Theme)
	} else if prefs.Theme != "" && ui.IsThemeName(prefs.Theme) {
		ui.SetTheme(prefs.Theme)
	}

	agentConfig, configPath, err := config.Load(args.Config)
	if err != nil {
		return err
	}
	if args.Planner != "" {
		agentConfig.PlannerProvider = args.Planner
	}
	if args.Executor != "" {
		agentConfig.ExecutorProvider = args.Executor
	}
	if args.Researcher != "" {
		agentConfig.ResearcherProvider = args.Researcher
	}
	if args.Effort != "" {
		// Applies to whichever providers this invocation can actually route to.
		targets := []string{args.Provider}
		if args.Provider == "" {
			targets = unique([]string{agentConfig.PlannerProvider, agentConfig.ExecutorProvider, agentConfig.ResearcherProvider})
		}
		for _, name := range targets {
			if provider, ok := agentConfig.Providers[name]; ok {
				config.SetReasoningEffort(provider, args.Effort)
			}
		}
	}
	for _, override := range args.Models {
		provider, ok := agentConfig.Providers[override.Provider]
		if !ok {
			return fmt.Errorf("unknown provider for --model: %s", override.Provider)
		}
		if err := config.ValidateProviderModel(override.Provider, provider, override.Model); err != nil {
			return err
		}
		config.SetProviderModel(provider, override.Model)
	}

	workspace, _ := filepath.Abs(args.Workspace)
	sessionDir, _ := filepath.Abs(args.SessionDir)

	if args.Welcome {
		fmt.Print(ui.WelcomeText(ui.WelcomeOptions{
			Config: agentConfig, Workspace: workspace, DemoWorkspace: demoWorkspacePath(),
		}))
		return nil
	}

	auth.InitializeSources(agentConfig, workspace)

	if args.Smoke {
		agentConfig.PlannerProvider = "mock"
		agentConfig.ExecutorProvider = "mock"
		agentConfig.ResearcherProvider = "mock"
		agentConfig.DefaultRole = types.RoleAuto
	}

	if args.Auth != nil {
		return handleAuthCLI(*args.Auth, agentConfig)
	}

	builtInSkills := skills.Load()
	systemPrompt := buildRuntimeSystemPrompt(builtInSkills)
	rolePrompts := loadRuntimeRolePrompts()
	build := buildinfo.Current()

	policy := &types.ExecutionPolicy{
		AllowWrites:        args.AllowWrites,
		AllowNetwork:       args.AllowNetwork,
		AllowSensitive:     args.AllowSensitive,
		CommandTimeoutMs:   30_000,
		MaxReadBytes:       128 * 1024,
		MaxToolOutputChars: 24_000,
		ApprovalMode:       approvalModeOr(args.ApprovalMode),
		Approvals:          map[string]string{},
	}
	if args.MaxOutputChars > 0 {
		policy.MaxToolOutputChars = args.MaxOutputChars
	}

	// Operator-provided `--context` material becomes part of the system prompt
	// for the whole session: knowledge base hits, reference files, raw notes.
	referenceContext, err := buildReferenceContext(args.Contexts, workspace, sessionDir, policy)
	if err != nil {
		return err
	}
	if referenceContext != "" {
		systemPrompt += "\n\n" + referenceContext + "\n"
	}

	providerMap := map[string]types.Provider{}
	for name, providerConfig := range agentConfig.Providers {
		provider, err := providers.Create(name, providerConfig)
		if err != nil {
			return err
		}
		providerMap[name] = provider
	}

	registry := tools.CreateReverseTools()
	// MCP servers join the same registry as the built-ins; a server that will
	// not start is reported and skipped, never fatal.
	connections := mcp.ConnectAll(agentConfig.MCPServers)
	for _, connection := range connections {
		if connection.Error != "" {
			fmt.Println(ui.RenderNotice(fmt.Sprintf("mcp %s: %s", connection.Name, connection.Error)))
			continue
		}
		registry = append(registry, connection.Tools...)
	}
	defer func() {
		for _, connection := range connections {
			if connection.Client != nil {
				connection.Client.Close()
			}
		}
	}()

	// Resolved before the new session file exists, or "most recent" would
	// resolve to the empty log this very run just created.
	var resumeTarget *core.Summary
	if args.HasResume {
		resumeTarget = core.ResolveSession(sessionDir, args.Resume)
	}

	session := core.NewSession(sessionDir, "0xaf")
	if err := session.Init(map[string]any{
		"agent": agentConfig.Name, "version": build.Version, "commit": build.Commit,
		"moduleVersion": build.ModuleVersion, "workspace": workspace,
		"configPath": configPath, "plannerProvider": agentConfig.PlannerProvider,
		"executorProvider": agentConfig.ExecutorProvider, "researcherProvider": agentConfig.ResearcherProvider,
		"workflow":         workflow.Status(args.Workflow, agentConfig, args.Provider),
		"policy":           policy,
		"referenceContext": referenceContext,
	}); err != nil {
		return err
	}

	toolContext := &types.ToolContext{Workspace: workspace, SessionDir: sessionDir, Policy: policy}
	loop := core.NewAgentLoop(core.LoopOptions{
		Config: agentConfig, Providers: providerMap, Tools: registry,
		ToolContext: toolContext, SystemPrompt: systemPrompt, RolePrompts: rolePrompts, Session: session,
	})

	if args.ListSessions {
		fmt.Print(ui.FormatSessions(sessionRows(core.ListSessions(sessionDir, 20)), time.Now()))
		return nil
	}

	if args.HasResume {
		if resumeTarget == nil {
			fmt.Println(ui.RenderNotice("No previous session found in " + sessionDir))
		} else {
			loaded, err := core.LoadSession(resumeTarget.File)
			if err != nil {
				return err
			}
			if err := loop.Restore(loaded.Messages, loaded.Plan); err != nil {
				return err
			}
			_ = session.AppendEvent(map[string]any{
				"type": "resumed_from", "file": resumeTarget.File, "messages": len(loaded.Messages),
			})
			opener := ""
			if resumeTarget.FirstPrompt != "" {
				opener = " · started with: " + resumeTarget.FirstPrompt
			}
			fmt.Println(ui.RenderNotice(fmt.Sprintf("resumed %s — %d messages, ≈%d tokens%s",
				resumeTarget.ID, len(loaded.Messages), loop.ContextTokens(), opener)))
			// The task list came back with the history; show where work stood.
			if plan := loop.Plan(); plan != nil {
				fmt.Println(strings.Join(ui.RenderPlan(plan, ui.RenderPlanOptions{}), "\n"))
			}
		}
	}

	state := &State{
		Config: agentConfig, Loop: loop, Session: session, Tools: registry,
		ToolContext: toolContext, Role: orRole(args.Role, agentConfig.DefaultRole),
		Provider: args.Provider, Skills: builtInSkills, MCP: connections,
		Providers: providerMap, Workflow: args.Workflow, Queue: newTaskQueue(),
		PlanDisplay: ui.PlanDisplayAuto, ThinkDisplay: ui.ThinkDisplayAuto,
	}

	if args.Smoke {
		result, err := loop.Run("smoke test: identify yourself and list capabilities",
			core.RunOptions{Role: types.RoleAuto})
		if err != nil {
			return err
		}
		printRunResult(result.Messages)
		fmt.Printf("\nsmoke: ok\nsession: %s\n", session.File)
		return nil
	}

	viz := args.Viz
	if viz == "" {
		viz = "full"
		if prefs.Flow != "" && ui.IsVizMode(prefs.Flow) {
			viz = ui.VizMode(prefs.Flow)
		}
	}
	state.Flow = viz

	if args.Print || args.Prompt != "" {
		if args.Prompt == "" {
			return fmt.Errorf("--print requires a prompt")
		}
		return runOneShot(state, args.Prompt, viz)
	}

	return repl(state)
}

// approvalModeOr defaults an unset --approval to `safe`, which keeps scripted
// runs refusing dangerous commands while an attended REPL can answer instead.
func approvalModeOr(mode types.ApprovalMode) types.ApprovalMode {
	if mode == "" {
		return types.ApprovalSafe
	}
	return mode
}

// runOneShot executes a single prompt with no pane: the trace is exactly what
// you want when piping a run into a log.
func runOneShot(state *State, prompt string, viz ui.VizMode) error {
	// An attended one-shot run can still hit a permission gate (a command with
	// safety concerns, a write under always-ask, …). Restarting with a new
	// approval mode is unfriendly, so when the terminal is interactive we attach
	// the same y/a/d/n prompt the REPL uses. Piped runs stay non-interactive and
	// keep refusing.
	if term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd())) {
		state.editor = NewEditor()
		state.ToolContext.Confirm = createApprover(state, nil, nil)
	}
	state.Loop.ResetPlan()
	startedAt := types.NowMs()
	var slowest int64
	// Plan lines describe a transition, so they need the previous snapshot —
	// without it every update re-reports the list as freshly opened.
	var previousPlan *types.PlanSnapshot

	ctx, cancel := interruptContext()
	defer cancel()

	var onEvent func(core.LoopEvent)
	if viz == "full" || viz == "trace" {
		onEvent = func(event core.LoopEvent) {
			if event.Type == "wire" && event.Phase == "recv" && event.Ms > slowest {
				slowest = event.Ms
			}
			for _, line := range ui.TraceEvent(event, ui.TraceOptions{
				StartedAt: startedAt, SlowestMs: slowest, PreviousPlan: previousPlan,
			}) {
				fmt.Println(line)
			}
			if event.Type == "plan" {
				previousPlan = event.Snapshot
			}
		}
	}

	result, err := runWithWorkflow(state, prompt, workflowRunOptions{Ctx: ctx, OnEvent: onEvent})
	if err != nil {
		return err
	}
	// No live pane in --print/pipe mode, so the plan is printed once, at the end.
	if plan := state.Loop.Plan(); plan != nil {
		fmt.Println(strings.Join(ui.RenderPlan(plan, ui.RenderPlanOptions{}), "\n"))
	}
	printRunResult(result.Messages)
	fmt.Println(ui.RunFooter(ui.RunFooterOptions{
		Provider: result.Provider, Role: string(result.Role), Turns: result.Turns,
		Ms: types.NowMs() - startedAt, Usage: result.Usage,
	}))
	return nil
}

// interruptContext cancels on SIGINT, which is how a non-interactive run is
// stopped without leaving a tmux CLI burning tokens.
func interruptContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case <-signals:
			cancel()
		case <-ctx.Done():
		}
		signal.Stop(signals)
	}()
	return ctx, cancel
}

func printRunResult(messages []types.Message) {
	if text := lastAssistantText(messages); text != "" {
		fmt.Println(ui.RenderReply(text))
	}
}

func lastAssistantText(messages []types.Message) string {
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index].Role == types.MessageAssistant {
			return strings.TrimSpace(messages[index].Text())
		}
	}
	return ""
}

func sessionRows(sessions []core.Summary) []ui.SessionRow {
	rows := make([]ui.SessionRow, 0, len(sessions))
	for _, session := range sessions {
		rows = append(rows, ui.SessionRow{
			ID: session.ID, UpdatedAt: session.UpdatedAt, Messages: session.Messages,
			Workspace: session.Workspace, FirstPrompt: session.FirstPrompt,
		})
	}
	return rows
}

func orRole(value, fallback types.AgentRole) types.AgentRole {
	if value == "" {
		return fallback
	}
	return value
}

func unique(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func demoWorkspacePath() string {
	root := assets.Root()
	if root == "" {
		return "./demos/welcome"
	}
	target := filepath.Join(root, "demos", "welcome")
	cwd, err := os.Getwd()
	if err != nil {
		return target
	}
	relative, err := filepath.Rel(cwd, target)
	if err != nil || strings.HasPrefix(relative, "..") {
		return target
	}
	if relative == "." {
		return "."
	}
	if !strings.HasPrefix(relative, ".") {
		return "./" + relative
	}
	return relative
}

func handleAuthCLI(command authCommand, agentConfig *types.AgentConfig) error {
	switch command.Action {
	case "status":
		fmt.Print(ui.FormatAuthStatus(auth.Statuses(agentConfig)))
		return nil
	case "login":
		if command.Provider == "" {
			return fmt.Errorf("usage: auth login <provider>")
		}
		return loginFromPrompt(agentConfig, command.Provider)
	default:
		if command.Provider == "" {
			return fmt.Errorf("usage: auth logout <provider>")
		}
		removed, err := auth.Logout(agentConfig, command.Provider)
		if err != nil {
			return err
		}
		if removed {
			fmt.Printf("Removed stored credential for %s\n", command.Provider)
		} else {
			fmt.Printf("No stored credential for %s\n", command.Provider)
		}
		return nil
	}
}

func loginFromPrompt(agentConfig *types.AgentConfig, providerName string) error {
	provider, ok := agentConfig.Providers[providerName]
	if !ok {
		return fmt.Errorf("unknown provider: %s", providerName)
	}
	if provider.Type == types.KindCLITmux {
		hint := provider.CLICommand + " login"
		if provider.CLICommand == "claude" {
			hint = "claude auth login"
		}
		if provider.CLICommand == "" {
			hint = providerName + " login"
		}
		return fmt.Errorf(
			"provider '%s' uses local CLI auth; run '%s' outside 0xAF-Re, or login to %s-api for direct API mode",
			providerName, hint, providerName)
	}
	envHint := ""
	if len(provider.APIKeyEnv) > 0 {
		envHint = " (" + strings.Join(provider.APIKeyEnv, " / ") + ")"
	}
	secret, err := ReadSecret(fmt.Sprintf("Paste credential for %s%s: ", providerName, envHint))
	if err != nil {
		return err
	}
	if err := auth.Login(agentConfig, providerName, secret); err != nil {
		return err
	}
	fmt.Printf("Saved credential for %s in %s\n", providerName, auth.SecretsFile())
	return nil
}
