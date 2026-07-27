package app

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/buildinfo"
	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/knowledge"
	"github.com/overkazaf/re-agent/internal/providers"
	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/skills"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/workflow"
)

func handleCommand(line string, state *State) error {
	command, arg := splitCommand(line)
	switch command {
	case "/welcome":
		fmt.Print(ui.WelcomeText(ui.WelcomeOptions{
			Config: state.Config, Workspace: state.ToolContext.Workspace, DemoWorkspace: demoWorkspacePath(),
		}))
		return nil
	case "/":
		fmt.Println(ui.FormatSlashCommandPalette("/", providerNames(state), ui.PaletteOptions{Limit: 100}))
		return nil
	case "/help":
		fmt.Print(ui.HelpText())
		return nil
	case "/version":
		fmt.Println(buildinfo.VersionReport())
		return nil
	case "/theme":
		if arg == "" {
			fmt.Print(ui.ThemePicker())
			return nil
		}
		if !ui.IsThemeName(arg) {
			return fmt.Errorf("usage: /theme %s", strings.Join(ui.ThemeNames, "|"))
		}
		ui.SetTheme(arg)
		config.SaveUIPrefs(config.UIPrefs{Theme: arg})
		fmt.Print("\x1b[2J\x1b[H")
		fmt.Print(redrawSplash(state))
		fmt.Println(ui.RenderNotice("theme=" + arg + " (saved)"))
		return nil
	case "/clear":
		fmt.Print("\x1b[2J\x1b[H")
		fmt.Print(redrawSplash(state))
		return nil
	case "/effort":
		fields := strings.Fields(arg)
		if len(fields) == 0 {
			return fmt.Errorf("usage: /effort <provider> [%s]", effortList())
		}
		provider, ok := state.Config.Providers[fields[0]]
		if !ok {
			return fmt.Errorf("unknown provider: %s", fields[0])
		}
		if len(fields) == 1 {
			current := string(provider.ReasoningEffort)
			if current == "" {
				current = "(provider default)"
			}
			fmt.Println(ui.RenderNotice(fields[0] + " effort=" + current))
			return nil
		}
		if !types.IsEffort(fields[1]) {
			return fmt.Errorf("effort must be one of: %s", effortList())
		}
		config.SetReasoningEffort(provider, types.ReasoningEffort(fields[1]))
		via := ""
		if provider.Type == types.KindCLITmux {
			via = fmt.Sprintf(" (via %s, applies to the next turn)", provider.CLICommand)
		}
		fmt.Println(ui.RenderNotice(fields[0] + " effort=" + fields[1] + via))
		return nil
	case "/model":
		return handleModelCommand(arg, state, nil)
	case "/providers":
		fmt.Print(ui.FormatProviders(state.Config))
		return nil
	case "/mcp":
		fmt.Print(ui.FormatMCP(mcpRows(state)))
		return nil
	case "/tools":
		fmt.Print(ui.FormatTools(state.Tools))
		return nil
	case "/skills":
		fmt.Println(skills.FormatList(state.Skills))
		return nil
	case "/skill":
		return runSkillCommand(arg, state)
	case "/know":
		return runKnowledgeCommand(arg, state)
	case "/scan":
		if arg == "" {
			return fmt.Errorf("usage: /scan <path>")
		}
		return runDirectTool("ctf_triage", map[string]any{"path": arg}, state)
	case "/decode":
		args, err := parseDecodeCommand(arg)
		if err != nil {
			return err
		}
		return runDirectTool("ctf_decode", args, state)
	case "/entropy":
		if arg == "" {
			return fmt.Errorf("usage: /entropy <path>")
		}
		return runDirectTool("entropy_scan", map[string]any{"path": arg}, state)
	case "/mitigations":
		if arg == "" {
			return fmt.Errorf("usage: /mitigations <binary>")
		}
		return runDirectTool("binary_mitigations", map[string]any{"path": arg}, state)
	case "/findbytes":
		file, needle := splitFirstToken(arg)
		if file == "" || needle == "" {
			return fmt.Errorf("usage: /findbytes <file> <text|hex>")
		}
		mode := "text"
		compact := regexp.MustCompile(`[\s:_-]`).ReplaceAllString(needle, "")
		if regexp.MustCompile(`^[0-9a-fA-F\s:_-]+$`).MatchString(needle) && len(compact)%2 == 0 {
			mode = "hex"
		}
		return runDirectTool("find_bytes", map[string]any{"path": file, "needle": needle, "mode": mode}, state)
	case "/carve":
		if arg == "" {
			return fmt.Errorf("usage: /carve <file>")
		}
		return runDirectTool("carve_artifacts", map[string]any{"path": arg}, state)
	case "/apk":
		if arg == "" {
			return fmt.Errorf("usage: /apk <apk>")
		}
		return runDirectTool("apk_inspect", map[string]any{"path": arg}, state)
	case "/retool":
		args, err := parseRetoolCommand(arg)
		if err != nil {
			return err
		}
		return runDirectTool("reverse_toolkit", args, state)
	case "/hook":
		args, err := parseHookCommand(arg)
		if err != nil {
			return err
		}
		return runDirectTool("frida_hook_template", args, state)
	case "/plan":
		plan := state.Loop.Plan()
		if plan == nil {
			fmt.Println(ui.RenderNotice("(no plan yet — it appears once the model lays one out)"))
			return nil
		}
		fmt.Println(strings.Join(ui.RenderPlan(plan, ui.RenderPlanOptions{}), "\n"))
		return nil
	case "/flow":
		if arg == "" {
			fmt.Println(ui.RenderNotice(fmt.Sprintf(
				"flow=%s — full (diagram + trace) · flow (diagram) · trace (lines) · off", state.Flow)))
			return nil
		}
		if !ui.IsVizMode(arg) {
			return fmt.Errorf("usage: /flow %s", vizList())
		}
		state.Flow = ui.VizMode(arg)
		config.SaveUIPrefs(config.UIPrefs{Flow: arg})
		fmt.Println(ui.RenderNotice("flow=" + arg + " (saved)"))
		return nil
	case "/workflow":
		if arg == "" {
			fmt.Println(ui.RenderNotice(workflow.Status(state.Workflow, state.Config, state.Provider)))
			return nil
		}
		if !workflow.IsMode(arg) {
			return fmt.Errorf("usage: /workflow %s", workflow.List())
		}
		state.Workflow = workflow.Mode(arg)
		fmt.Println(ui.RenderNotice(workflow.Status(state.Workflow, state.Config, state.Provider)))
		return nil
	case "/queue":
		return handleQueueCommand(arg, state, nil)
	case "/tasks":
		return handleTasksCommand(arg, state, nil)
	case "/context":
		tokens := state.Loop.ContextTokens()
		name := routeLabel(state)
		if name == "auto" {
			name = state.Config.PlannerProvider
		}
		budget := core.DefaultContextBudgetTokens
		if provider, ok := state.Config.Providers[name]; ok && provider.ContextBudgetTokens > 0 {
			budget = provider.ContextBudgetTokens
		}
		percent := 0
		if budget > 0 {
			percent = int(float64(tokens) / float64(budget) * 100)
		}
		fmt.Println(ui.RenderNotice(fmt.Sprintf(
			"context ≈%d tokens of %d budget (%d%%) · %d messages — /compact to fold it into a summary",
			tokens, budget, percent, len(state.Loop.History()))))
		return nil
	case "/compact":
		if arg != "" {
			if _, ok := state.Config.Providers[arg]; !ok {
				return fmt.Errorf("unknown provider: %s", arg)
			}
		}
		fmt.Println(ui.RenderNotice("compacting the session into a summary…"))
		result, err := state.Loop.Compact(arg, context.Background())
		if err != nil {
			return err
		}
		fmt.Println(ui.RenderReply(result.Summary))
		fmt.Println(ui.RenderNotice(fmt.Sprintf(
			"compacted via %s: ≈%d → ≈%d tokens (full transcript kept in %s)",
			result.Provider, result.TokensBefore, result.TokensAfter, state.Session.File)))
		return nil
	case "/sessions":
		fmt.Print(ui.FormatSessions(sessionRows(core.ListSessions(state.ToolContext.SessionDir, 20)), time.Now()))
		return nil
	case "/resume":
		target := core.ResolveSession(state.ToolContext.SessionDir, arg)
		if target == nil {
			if arg != "" {
				return fmt.Errorf("no session matching '%s'", arg)
			}
			return fmt.Errorf("no previous session found")
		}
		current, _ := filepath.Abs(state.Session.File)
		wanted, _ := filepath.Abs(target.File)
		if current == wanted {
			return fmt.Errorf("that is the session you are already in")
		}
		loaded, err := core.LoadSession(target.File)
		if err != nil {
			return err
		}
		if err := state.Loop.Restore(loaded.Messages, loaded.Plan); err != nil {
			return err
		}
		_ = state.Session.AppendEvent(map[string]any{
			"type": "resumed_from", "file": target.File, "messages": len(loaded.Messages),
		})
		fmt.Println(ui.RenderNotice(fmt.Sprintf(
			"resumed %s — %d messages, ≈%d tokens (still logging to this session)",
			target.ID, len(loaded.Messages), state.Loop.ContextTokens())))
		if plan := state.Loop.Plan(); plan != nil {
			fmt.Println(strings.Join(ui.RenderPlan(plan, ui.RenderPlanOptions{}), "\n"))
		}
		return nil
	case "/session":
		fmt.Println(state.Session.File)
		return nil
	case "/approval":
		return handleApproval(arg, state)
	case "/policy":
		encoded, err := json.MarshalIndent(state.ToolContext.Policy, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(encoded))
		return nil
	case "/status", "/auth":
		fmt.Print(ui.FormatAuthStatus(auth.Statuses(state.Config)))
		return nil
	case "/login":
		target := arg
		if target == "" {
			target = defaultLoginProvider(state)
		}
		return loginFromPrompt(state.Config, target)
	case "/logout":
		if arg == "" {
			return fmt.Errorf("usage: /logout <provider>")
		}
		removed, err := auth.Logout(state.Config, arg)
		if err != nil {
			return err
		}
		if removed {
			fmt.Printf("Removed stored credential for %s\n", arg)
		} else {
			fmt.Printf("No stored credential for %s\n", arg)
		}
		return nil
	case "/role":
		if !types.IsRole(arg) {
			return fmt.Errorf("usage: /role planner|executor|auto")
		}
		state.Role = types.AgentRole(arg)
		state.Provider = ""
		fmt.Printf("role=%s\n", state.Role)
		return nil
	case "/agent":
		if arg == "" || arg == "auto" {
			state.Provider = ""
			fmt.Printf("agent=auto role=%s\n", state.Role)
			return nil
		}
		if _, ok := state.Config.Providers[arg]; !ok {
			return fmt.Errorf("unknown provider: %s", arg)
		}
		state.Provider = arg
		fmt.Printf("agent=%s\n", state.Provider)
		return nil
	case "/planner":
		if _, ok := state.Config.Providers[arg]; !ok {
			return fmt.Errorf("unknown provider: %s", arg)
		}
		state.Config.PlannerProvider = arg
		fmt.Printf("planner=%s\n", arg)
		return nil
	case "/executor":
		if _, ok := state.Config.Providers[arg]; !ok {
			return fmt.Errorf("unknown provider: %s", arg)
		}
		state.Config.ExecutorProvider = arg
		fmt.Printf("executor=%s\n", arg)
		return nil
	case "/read":
		return runDirectTool("read_file", map[string]any{"path": arg}, state)
	case "/run":
		return runDirectTool("run_command", map[string]any{"command": arg}, state)
	}
	return fmt.Errorf("unknown command: %s. Try /help", command)
}

func handleApproval(arg string, state *State) error {
	policy := state.ToolContext.Policy
	if arg == "" {
		overrides := ""
		if len(policy.Approvals) > 0 {
			var parts []string
			for tool, value := range policy.Approvals {
				parts = append(parts, tool+"="+value)
			}
			sortStrings(parts)
			overrides = " · overrides: " + strings.Join(parts, ", ")
		}
		fmt.Println(ui.RenderNotice(fmt.Sprintf("approval=%s%s", policy.ApprovalMode, overrides)))
		return nil
	}
	fields := strings.Fields(arg)
	switch fields[0] {
	case "reset":
		policy.Approvals = map[string]string{}
		fmt.Println(ui.RenderNotice("cleared per-tool approval overrides"))
		return nil
	case "tool":
		if len(fields) < 3 || (fields[2] != "allow" && fields[2] != "deny") {
			return fmt.Errorf("usage: /approval tool <name> allow|deny")
		}
		if policy.Approvals == nil {
			policy.Approvals = map[string]string{}
		}
		policy.Approvals[fields[1]] = fields[2]
		fmt.Println(ui.RenderNotice(fmt.Sprintf("%s=%s for this session", fields[1], fields[2])))
		return nil
	}
	if !security.IsApprovalMode(fields[0]) {
		return fmt.Errorf("usage: /approval %s | tool <name> allow|deny | reset", approvalList())
	}
	policy.ApprovalMode = types.ApprovalMode(fields[0])
	fmt.Println(ui.RenderNotice("approval=" + fields[0]))
	return nil
}

func handleModelCommand(arg string, state *State, pane *ui.LivePane) error {
	fields := strings.Fields(arg)
	if len(fields) == 0 {
		var lines []string
		for _, name := range providerNames(state) {
			provider := state.Config.Providers[name]
			model := provider.Model
			if model == "" {
				model = "(provider default)"
			}
			lines = append(lines, fmt.Sprintf("%s=%s", name, model))
		}
		emitNotice(pane, "models: "+strings.Join(lines, " · "))
		return nil
	}
	if len(fields) < 2 {
		return fmt.Errorf("usage: /model <provider|planner|executor> <model>")
	}
	names, err := modelTargets(fields[0], state)
	if err != nil {
		return err
	}
	model := strings.TrimSpace(strings.Join(fields[1:], " "))
	if model == "" {
		return fmt.Errorf("usage: /model <provider|planner|executor> <model>")
	}
	var notices []string
	for _, name := range names {
		provider, ok := state.Config.Providers[name]
		if !ok {
			return fmt.Errorf("unknown provider: %s", name)
		}
		change := config.SetProviderModel(provider, model)
		notices = append(notices, fmt.Sprintf("%s model=%s (%s)", name, model, change.Detail))
	}
	emitNotice(pane, strings.Join(notices, " · ")+"; applies to the next provider turn")
	return nil
}

func modelTargets(target string, state *State) ([]string, error) {
	switch target {
	case "planner":
		return []string{state.Config.PlannerProvider}, nil
	case "executor":
		return []string{state.Config.ExecutorProvider}, nil
	case "active", "agent":
		if state.Provider != "" {
			return []string{state.Provider}, nil
		}
		return unique([]string{state.Config.PlannerProvider, state.Config.ExecutorProvider}), nil
	default:
		if _, ok := state.Config.Providers[target]; !ok {
			return nil, fmt.Errorf("unknown provider: %s", target)
		}
		return []string{target}, nil
	}
}

func handleQueueCommand(arg string, state *State, pane *ui.LivePane) error {
	if state.Queue == nil {
		state.Queue = newTaskQueue()
	}
	defer updateQueuePane(state, pane)
	action, rest := splitFirstToken(arg)
	switch action {
	case "", "list":
		emitNotice(pane, formatQueue(state.Queue.List()))
	case "add":
		if strings.TrimSpace(rest) == "" {
			return fmt.Errorf("usage: /queue add <task>")
		}
		item := state.Queue.Add(rest)
		emitNotice(pane, fmt.Sprintf("queued #%d", item.ID))
	case "edit":
		idText, text := splitFirstToken(rest)
		id, err := strconv.Atoi(idText)
		if err != nil || strings.TrimSpace(text) == "" {
			return fmt.Errorf("usage: /queue edit <id> <task>")
		}
		if !state.Queue.Edit(id, text) {
			return fmt.Errorf("queued task not found: #%d", id)
		}
		emitNotice(pane, fmt.Sprintf("edited queued task #%d", id))
	case "cancel", "rm", "drop":
		target, _ := splitFirstToken(rest)
		if target == "all" {
			count := state.Queue.Clear()
			emitNotice(pane, fmt.Sprintf("cancelled %d queued task(s)", count))
			return nil
		}
		id, err := strconv.Atoi(target)
		if err != nil {
			return fmt.Errorf("usage: /queue cancel <id|all>")
		}
		if !state.Queue.Cancel(id) {
			return fmt.Errorf("queued task not found: #%d", id)
		}
		emitNotice(pane, fmt.Sprintf("cancelled queued task #%d", id))
	case "clear":
		count := state.Queue.Clear()
		emitNotice(pane, fmt.Sprintf("cancelled %d queued task(s)", count))
	case "run":
		if pane != nil {
			emitNotice(pane, "queue will continue after the current turn")
			return nil
		}
		drainQueue(state)
	default:
		return fmt.Errorf("usage: /queue [list|add <task>|edit <id> <task>|cancel <id|all>|clear|run]")
	}
	return nil
}

func updateQueuePane(state *State, pane *ui.LivePane) {
	if pane == nil || state.Queue == nil {
		return
	}
	pane.SetQueueCount(state.Queue.Len())
}

func handleTasksCommand(arg string, state *State, pane *ui.LivePane) error {
	mode := strings.TrimSpace(arg)
	if mode == "" {
		emitNotice(pane, fmt.Sprintf("tasks=%s — auto · collapse · expand · toggle", planDisplayLabel(state.PlanDisplay)))
		return nil
	}
	switch mode {
	case "auto":
		state.PlanDisplay = ui.PlanDisplayAuto
	case "collapse", "collapsed":
		state.PlanDisplay = ui.PlanDisplayCollapsed
	case "expand", "expanded":
		state.PlanDisplay = ui.PlanDisplayExpanded
	case "toggle":
		if state.PlanDisplay == ui.PlanDisplayCollapsed {
			state.PlanDisplay = ui.PlanDisplayExpanded
		} else {
			state.PlanDisplay = ui.PlanDisplayCollapsed
		}
	default:
		return fmt.Errorf("usage: /tasks auto|collapse|expand|toggle")
	}
	if pane != nil {
		pane.SetPlanDisplay(state.PlanDisplay)
	}
	emitNotice(pane, "tasks="+planDisplayLabel(state.PlanDisplay))
	return nil
}

func planDisplayLabel(mode ui.PlanDisplayMode) string {
	if mode == "" {
		return string(ui.PlanDisplayAuto)
	}
	return string(mode)
}

func emitNotice(pane *ui.LivePane, message string) {
	for _, line := range strings.Split(message, "\n") {
		if pane != nil {
			pane.Commit(ui.RenderNotice(line))
		} else {
			fmt.Println(ui.RenderNotice(line))
		}
	}
}

func emitError(pane *ui.LivePane, message string) {
	for _, line := range strings.Split(message, "\n") {
		if pane != nil {
			pane.Commit(ui.RenderError(line))
		} else {
			fmt.Println(ui.RenderError(line))
		}
	}
}

// redrawSplash re-renders the boot screen from the cached probe results.
func redrawSplash(state *State) string {
	if state.Splash != nil {
		return ui.RenderSplash(*state.Splash)
	}
	return ui.Banner(state.Config, state.Session.File, state.ToolContext.Policy, buildinfo.DisplayVersion())
}

func mcpRows(state *State) []ui.MCPRow {
	rows := make([]ui.MCPRow, 0, len(state.MCP))
	for _, connection := range state.MCP {
		row := ui.MCPRow{Name: connection.Name, Error: connection.Error}
		if connection.Client != nil {
			row.Status = connection.Client.Status()
		}
		for _, tool := range connection.Tools {
			// Server-qualified prefixes are noise in this table; show bare names.
			row.Tools = append(row.Tools, mcpPrefixRE.ReplaceAllString(tool.Name, ""))
		}
		rows = append(rows, row)
	}
	return rows
}

var mcpPrefixRE = regexp.MustCompile(`^mcp__.*?__`)

func runSkillCommand(arg string, state *State) error {
	name, task := splitFirstToken(arg)
	if name == "" {
		return fmt.Errorf("usage: /skill <name> [task]")
	}
	skill := skills.Find(state.Skills, name)
	if skill == nil {
		return fmt.Errorf("unknown skill: %s. Try /skills", name)
	}
	if task == "" {
		fmt.Println(skill.Body)
		return nil
	}
	runTurn(state, skills.TurnPrompt(*skill, task))
	return nil
}

func runKnowledgeCommand(arg string, state *State) error {
	trimmed := strings.TrimSpace(arg)
	if trimmed == "" {
		return fmt.Errorf("usage: /know <query>  ·  /know raw <query>  ·  /know read <entry-id>")
	}
	verb, rest := splitFirstToken(trimmed)
	switch verb {
	case "read":
		if rest == "" {
			return fmt.Errorf("usage: /know read <entry-id>")
		}
		entry := knowledge.ReadEntry(rest)
		if entry == nil {
			return fmt.Errorf("knowledge entry not found: %s", rest)
		}
		fmt.Println(knowledge.ReadText(*entry, 24_000))
		return nil
	case "raw":
		if rest == "" {
			return fmt.Errorf("usage: /know raw <query>")
		}
		fmt.Println(knowledge.FormatMatches(knowledge.Search(rest, 8)))
		return nil
	}

	matches := knowledge.Search(trimmed, 8)
	if len(matches) == 0 {
		fmt.Println(ui.RenderNotice("No matching reverse-engineering knowledge entries."))
		return nil
	}
	return synthesizeKnowledge(trimmed, matches, state)
}

// synthesizeKnowledge answers a knowledge query from the retrieved entries
// instead of dumping them.
//
// The synthesis runs on a FRESH provider instance: the configured CLI providers
// resume one long-lived native session, and a side lookup must not be spliced
// into the conversation the operator is actually having.
func synthesizeKnowledge(query string, matches []knowledge.Entry, state *State) error {
	providerName := state.Config.KnowledgeProvider
	if providerName == "" {
		providerName = state.Config.ExecutorProvider
	}
	providerConfig, ok := state.Config.Providers[providerName]
	if !ok {
		return fmt.Errorf("knowledge provider not configured: %s", providerName)
	}

	packed := knowledge.Pack(matches, knowledge.PackOptions{})
	pane := ui.NewLivePane("know · "+providerName, ui.LivePaneOptions{})
	pane.SetPhase(fmt.Sprintf("reading %d entries", len(packed.Used)))

	provider, err := providers.Create(providerName, providerConfig)
	if err != nil {
		pane.Stop()
		return err
	}
	response, err := provider.Complete(types.ProviderInput{
		System:     knowledge.SystemPrompt,
		Messages:   []types.Message{types.UserMessage(knowledge.BuildPrompt(query, packed))},
		Workspace:  state.ToolContext.Workspace,
		SessionDir: state.ToolContext.SessionDir,
		OnProgress: func(progress types.ProviderProgress) {
			switch progress.Kind {
			case "thinking":
				pane.SetPhase("thinking")
			case "text":
				pane.SetPhase("writing")
			}
		},
	})
	pane.Stop()
	if err != nil {
		return err
	}
	answer := knowledge.ParseAnswer(response.Text, matches)

	fmt.Println(ui.RenderReply(knowledge.FormatAnswer(answer)))
	if len(packed.Truncated) > 0 {
		fmt.Println(ui.RenderNotice(fmt.Sprintf(
			"%d more entries matched but did not fit the context — /know raw %s", len(packed.Truncated), query)))
	}
	// Lookups are advisory; never fail one over persistence.
	_ = state.Session.AppendEvent(map[string]any{
		"type": "knowledge", "query": query,
		"matched": entryIDs(matches), "used": entryIDs(packed.Used),
		"citations": entryIDs(answer.Citations), "inventedCitations": answer.InventedCitations,
		"parsed": answer.Parsed,
	})
	return nil
}

func entryIDs(entries []knowledge.Entry) []string {
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.ID)
	}
	return out
}

func runDirectTool(name string, args map[string]any, state *State) error {
	tool := tools.Find(state.Tools, name)
	if tool == nil {
		return fmt.Errorf("tool not found: %s", name)
	}
	result, err := tool.Execute(args, *state.ToolContext)
	if err != nil {
		return err
	}
	fmt.Println(types.TextFromBlocks(result.Content))
	return nil
}

func parseRetoolCommand(arg string) (map[string]any, error) {
	trimmed := strings.TrimSpace(arg)
	if trimmed == "" {
		return map[string]any{"tool": "inventory"}, nil
	}
	tool, rest := splitFirstToken(trimmed)
	if tool == "inventory" || tool == "list" || tool == "check" {
		return map[string]any{"tool": "inventory"}, nil
	}
	action, rest := splitFirstToken(rest)
	if action == "" {
		return map[string]any{"tool": tool, "action": "auto"}, nil
	}
	args := map[string]any{"tool": tool, "action": action}
	path, rest := splitFirstToken(rest)
	if path != "" {
		args["path"] = path
	}
	for _, field := range strings.Fields(rest) {
		key, value, ok := strings.Cut(field, "=")
		if !ok {
			continue
		}
		switch key {
		case "rules", "address", "symbol", "arch":
			args[key] = value
		case "timeoutMs", "maxBytes", "lines":
			if parsed, err := strconv.Atoi(value); err == nil {
				args[key] = parsed
			}
		}
	}
	return args, nil
}

var cliDecodeAliases = map[string]string{
	"b64": "base64", "b64url": "base64url", "urldecode": "url", "xorbf": "xor_bruteforce",
}

var cliDecodeModes = map[string]bool{
	"auto": true, "base64": true, "base64url": true, "hex": true,
	"url": true, "rot13": true, "xor": true, "xor_bruteforce": true,
}

func parseDecodeCommand(arg string) (map[string]any, error) {
	trimmed := strings.TrimSpace(arg)
	if trimmed == "" {
		return nil, fmt.Errorf("usage: /decode [auto|base64|base64url|hex|url|rot13|xor|xor_bruteforce] <input>")
	}
	first, rest := splitFirstToken(trimmed)
	mode := first
	if alias, ok := cliDecodeAliases[first]; ok {
		mode = alias
	}
	if !cliDecodeModes[mode] {
		return map[string]any{"mode": "auto", "input": trimmed}, nil
	}
	if rest == "" && mode != "rot13" {
		return nil, fmt.Errorf("usage: /decode %s <input>", mode)
	}
	if mode != "xor" {
		input := rest
		if input == "" {
			input = trimmed
		}
		return map[string]any{"mode": mode, "input": input}, nil
	}
	key, input := splitFirstToken(rest)
	if key == "" || input == "" {
		return nil, fmt.Errorf("usage: /decode xor <key> <input>")
	}
	return map[string]any{"mode": mode, "key": key, "input": input}, nil
}

var hookPlatforms = map[string]string{
	"java": "android_java", "android_java": "android_java",
	"native": "android_native", "android_native": "android_native",
	"objc": "ios_objc", "ios": "ios_objc", "ios_objc": "ios_objc",
}

func parseHookCommand(arg string) (map[string]any, error) {
	trimmed := strings.TrimSpace(arg)
	if trimmed == "" {
		return nil, fmt.Errorf("usage: /hook [java|native|objc] <target> [method] [signature]")
	}
	first, rest1 := splitFirstToken(trimmed)
	platform, known := hookPlatforms[first]
	rest := trimmed
	if known {
		rest = rest1
	} else {
		platform = "android_java"
	}
	target, rest2 := splitFirstToken(rest)
	method, signature := splitFirstToken(rest2)
	if target == "" {
		return nil, fmt.Errorf("usage: /hook [java|native|objc] <target> [method] [signature]")
	}
	if platform == "android_native" {
		return map[string]any{"platform": platform, "target": target}, nil
	}
	return map[string]any{
		"platform": platform, "target": target, "method": method, "signature": signature,
	}, nil
}

func defaultLoginProvider(state *State) string {
	if state.Provider != "" {
		return state.Provider
	}
	if state.Role == types.RolePlanner {
		return state.Config.PlannerProvider
	}
	return state.Config.ExecutorProvider
}

func splitCommand(line string) (string, string) {
	trimmed := strings.TrimSpace(line)
	space := strings.IndexAny(trimmed, " \t")
	if space < 0 {
		return trimmed, ""
	}
	return trimmed[:space], strings.TrimSpace(trimmed[space+1:])
}

func splitFirstToken(value string) (string, string) {
	trimmed := strings.TrimSpace(value)
	space := strings.IndexAny(trimmed, " \t")
	if space < 0 {
		return trimmed, ""
	}
	return trimmed[:space], strings.TrimSpace(trimmed[space+1:])
}
