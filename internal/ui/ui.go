package ui

// Banner, run rendering, approval prompts, tables, help, and slash-command
// completion — everything printed outside the live pane.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/types"
	"golang.org/x/term"
)

func isStdoutTTY() bool { return term.IsTerminal(int(os.Stdout.Fd())) }

// --- banner ------------------------------------------------------------------

func Banner(config *types.AgentConfig, sessionFile string, policy *types.ExecutionPolicy, version string) string {
	width := TermWidth()
	brand := C.Reverse(C.Bold(" 0xAF ")) + " " + C.Bold(C.Text("REVERSE OPS DECK"))
	versionText := C.Faint("v" + version)
	gap := width - DisplayWidth(brand) - DisplayWidth(versionText)
	if gap < 1 {
		gap = 1
	}

	kv := func(key, value string) string { return C.Faint(key) + " " + value }
	route := strings.Join([]string{
		kv("plan", C.Accent(config.PlannerProvider)),
		kv("exec", C.Violet(config.ExecutorProvider)),
		kv("research", C.Accent(researcherProvider(config))),
		kv("turns", C.Text(fmt.Sprintf("%d", config.MaxTurns))),
	}, C.Rule("  ·  "))

	policyLine := strings.Join([]string{
		kv("write", flag(policy.AllowWrites)),
		kv("net", flag(policy.AllowNetwork)),
		kv("sensitive", flag(policy.AllowSensitive)),
		kv("log", C.Faint(ElidePath(sessionFile, 26))),
	}, C.Rule("  ·  "))

	hint := strings.Join([]string{
		C.Accent("/welcome") + " " + C.Faint("demos"),
		C.Accent("/help") + " " + C.Faint("commands"),
		C.Accent("!cmd") + " " + C.Faint("shell"),
		C.Accent("/flow") + " " + C.Faint("dataflow"),
		C.Accent("TAB") + " " + C.Faint("complete"),
		C.Accent("↑↓") + " " + C.Faint("history"),
		C.Accent("^C") + " " + C.Faint("cancel"),
	}, C.Rule("  ·  "))

	return strings.Join([]string{
		"",
		brand + strings.Repeat(" ", gap) + versionText,
		GradientRule(width),
		route,
		policyLine,
		C.Rule(strings.Repeat("─", width)),
		hint,
		"",
	}, "\n")
}

func flag(enabled bool) string {
	if enabled {
		return C.OK("on")
	}
	return C.Faint("off")
}

func PromptLabel(config *types.AgentConfig, role types.AgentRole, forcedProvider string) string {
	route := forcedProvider
	if route == "" {
		switch role {
		case types.RolePlanner:
			route = config.PlannerProvider
		case types.RoleExecutor:
			route = config.ExecutorProvider
		case types.RoleResearcher:
			route = researcherProvider(config)
		default:
			route = "auto"
		}
	}
	badge := C.Accent(route)
	if forcedProvider != "" {
		badge = C.Violet(route)
	}
	return C.Faint(string(role)) + C.Rule("/") + badge + " " + C.Accent("❯") + " "
}

// --- run rendering -----------------------------------------------------------

// ReplyHeader is printed above a model reply.
func ReplyHeader(provider, model string) string {
	parts := []string{C.AccentDim("◆"), C.Bold(C.Accent(provider))}
	if model != "" && model != provider {
		parts = append(parts, C.Rule("·"), C.Faint(model))
	}
	return strings.Join(parts, " ")
}

// RenderReply is the model reply, markdown-rendered inside an accent gutter.
func RenderReply(text string) string {
	width := TermWidth()
	body := RenderMarkdown(strings.TrimSpace(text), width-2)
	lines := strings.Split(body, "\n")
	for index, line := range lines {
		lines[index] = C.AccentDim("▏") + " " + line
	}
	return strings.Join(lines, "\n")
}

func RenderToolStart(name string, args map[string]any) string {
	room := TermWidth() - DisplayWidth(name) - 12
	if room < 20 {
		room = 20
	}
	return C.Rule("├─") + " " + C.Violet(name) + " " + C.Faint(Truncate(summarizeToolArgs(args), room))
}

func RenderToolEnd(name string, ok bool, ms int64, preview string) string {
	mark := C.Err("✗")
	if ok {
		mark = C.OK("✓")
	}
	head := C.Rule("│ ") + mark + " " + C.Faint(FormatDuration(ms))
	if preview == "" {
		return head
	}
	room := TermWidth() - 24
	if room < 20 {
		room = 20
	}
	return head + " " + C.Rule("·") + " " + C.Faint(Truncate(preview, room))
}

func summarizeToolArgs(args map[string]any) string {
	if len(args) == 0 {
		return ""
	}
	var parts []string
	for key, value := range args {
		rendered, ok := value.(string)
		if !ok {
			encoded, _ := json.Marshal(value)
			rendered = string(encoded)
		}
		parts = append(parts, key+"="+Truncate(rendered, 48))
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

type RunFooterOptions struct {
	Provider string
	Role     string
	Turns    int
	Ms       int64
	Usage    types.TokenUsage
}

// RunFooter summarizes a completed run: route, turns, timing, tokens, cost.
func RunFooter(options RunFooterOptions) string {
	parts := []string{
		C.Faint("via") + " " + C.Accent(options.Provider),
		C.Faint("role") + " " + C.Text(options.Role),
		C.Faint("turns") + " " + C.Text(fmt.Sprintf("%d", options.Turns)),
		C.Faint("took") + " " + C.Text(FormatDuration(options.Ms)),
	}
	usage := options.Usage
	var tokens []string
	if usage.Input != 0 {
		tokens = append(tokens, C.Faint("in")+" "+C.Text(CompactNumber(usage.Input)))
	}
	if usage.Output != 0 {
		tokens = append(tokens, C.Faint("out")+" "+C.Text(CompactNumber(usage.Output)))
	}
	if usage.Thinking != 0 {
		tokens = append(tokens, C.Faint("think")+" "+C.Violet(CompactNumber(usage.Thinking)))
	}
	if usage.CacheRead != 0 {
		tokens = append(tokens, C.Faint("cache")+" "+C.OK(CompactNumber(usage.CacheRead)))
	}
	if usage.CostUsd != 0 {
		tokens = append(tokens, C.Faint("$")+C.Warn(fmt.Sprintf("%.4f", usage.CostUsd)))
	}
	if len(tokens) > 0 {
		parts = append(parts, strings.Join(tokens, " "))
	}
	return C.Rule("╰") + C.Rule("─ ") + strings.Join(parts, C.Rule("  ·  "))
}

// --- approval ----------------------------------------------------------------

// RenderApprovalRequest is the block drawn above an approval prompt: what is
// about to run, and why we are asking.
func RenderApprovalRequest(request types.ApprovalRequest) string {
	width := minOf(TermWidth(), 88)
	badge := C.Warn(" APPROVE ")
	if len(request.Concerns) > 0 {
		badge = C.Err(" REVIEW ")
	}
	lines := []string{
		"",
		C.Reverse(badge) + " " + C.Bold(C.Text(request.Tool)) + " " + C.Faint("("+string(request.Tier)+")"),
		C.Rule("│") + " " + C.Text(Truncate(request.Summary, width-4)),
	}
	for _, concern := range request.Concerns {
		lines = append(lines, C.Err("│")+" "+C.Err("!")+" "+C.Muted(Truncate(concern, width-6)))
	}
	return strings.Join(lines, "\n")
}

func ApprovalPromptLabel() string {
	return strings.Join([]string{
		C.Rule("│") + " " + C.Accent("y") + " " + C.Faint("run once"),
		C.Accent("a") + " " + C.Faint("always this tool"),
		C.Accent("n") + " " + C.Faint("skip"),
		C.Accent("d") + " " + C.Faint("never this tool"),
	}, C.Rule("  ·  ")) + "\n" + C.Accent("❯") + " "
}

// --- shell escape ------------------------------------------------------------

// RenderShellCommand is the header printed above the live output of a `!command`.
func RenderShellCommand(command string) string {
	return C.Rule("╭─") + " " + C.Violet("!") + " " + C.Bold(C.Text(command))
}

// RenderShellExit is the footer with the exit status of a shell escape.
func RenderShellExit(code int, ms int64, timedOut, aborted bool) string {
	ok := code == 0 && !timedOut && !aborted
	mark := C.Err("✗")
	codeText := C.Err(fmt.Sprintf("exit %d", code))
	if ok {
		mark = C.OK("✓")
		codeText = C.Faint("exit 0")
	}
	note := ""
	if timedOut {
		note = " " + C.Rule("·") + " " + C.Warn("timed out")
	} else if aborted {
		note = " " + C.Rule("·") + " " + C.Warn("cancelled")
	}
	return C.Rule("╰─") + " " + mark + " " + codeText + " " + C.Rule("·") + " " + C.Faint(FormatDuration(ms)) + note
}

// ShellStreamWriter is a line-buffered writer for streamed command output.
// Chunks arrive on arbitrary boundaries, so partial lines are held back until
// their newline lands; that keeps the gutter aligned and leaves the program's
// own coloring intact.
type ShellStreamWriter struct {
	write   func(string)
	buffers map[string]string
}

func NewShellStreamWriter(write func(string)) *ShellStreamWriter {
	return &ShellStreamWriter{write: write, buffers: map[string]string{"stdout": "", "stderr": ""}}
}

func (w *ShellStreamWriter) gutterFor(stream string) string {
	if stream == "stderr" {
		return C.Err("│")
	}
	return C.Rule("│")
}

func (w *ShellStreamWriter) Push(stream, text string) {
	lines := strings.Split(w.buffers[stream]+text, "\n")
	w.buffers[stream] = lines[len(lines)-1]
	for _, line := range lines[:len(lines)-1] {
		w.write(w.gutterFor(stream) + " " + line + "\n")
	}
}

func (w *ShellStreamWriter) Flush() {
	for _, stream := range []string{"stdout", "stderr"} {
		if w.buffers[stream] == "" {
			continue
		}
		w.write(w.gutterFor(stream) + " " + w.buffers[stream] + "\n")
		w.buffers[stream] = ""
	}
}

func RenderError(message string) string {
	width := TermWidth()
	lines := strings.Split(message, "\n")
	for index, line := range lines {
		painted := C.Muted(Truncate(line, width-2))
		if index == 0 {
			painted = C.Err(Truncate(line, width-2))
		}
		lines[index] = C.Err("▏") + " " + painted
	}
	return strings.Join(lines, "\n")
}

func RenderNotice(message string) string {
	return C.AccentDim("▏") + " " + C.Muted(message)
}

// ThemePicker paints each row in the theme it describes, so the swatches are the
// actual palette rather than a legend.
func ThemePicker() string {
	active := CurrentTheme()
	width := 0
	for _, name := range ThemeNames {
		if DisplayWidth(name) > width {
			width = DisplayWidth(name)
		}
	}
	var rows []string
	for _, name := range ThemeNames {
		SetTheme(name)
		mark := C.Faint("○")
		if name == active {
			mark = C.Accent("●")
		}
		swatch := C.Accent("██") + C.Violet("██") + C.OK("█") + C.Warn("█") + C.Err("█") + C.Muted("█") + C.Rule("█")
		label := C.Text(PadEnd(name, width))
		if name == active {
			label = C.Bold(C.Accent(PadEnd(name, width)))
		}
		rows = append(rows, "  "+mark+" "+label+"  "+swatch+"  "+C.Faint(ThemeBlurbs[name]))
	}
	SetTheme(active) // restore before returning
	out := []string{"", C.Bold(C.Accent("THEMES")), GradientRule(minOf(TermWidth(), 46))}
	out = append(out, rows...)
	out = append(out, "", "  "+C.Faint("switch with")+" "+C.Accent("/theme <name>"), "")
	return strings.Join(out, "\n")
}

// --- tables ------------------------------------------------------------------

func table(title string, headers []string, rows [][]string) string {
	widths := make([]int, len(headers))
	for index, header := range headers {
		widths[index] = DisplayWidth(header)
		for _, row := range rows {
			if index < len(row) && DisplayWidth(row[index]) > widths[index] {
				widths[index] = DisplayWidth(row[index])
			}
		}
	}
	var headCells []string
	for index, header := range headers {
		headCells = append(headCells, C.Faint(PadEnd(strings.ToUpper(header), widths[index])))
	}
	head := strings.Join(headCells, "  ")
	out := []string{"", C.Bold(C.Accent(title)), GradientRule(minOf(TermWidth(), maxOf(20, DisplayWidth(head)+2))), head}
	for _, row := range rows {
		var cells []string
		for index := range headers {
			value := ""
			if index < len(row) {
				value = row[index]
			}
			cells = append(cells, PadEnd(value, widths[index]))
		}
		out = append(out, strings.Join(cells, "  "))
	}
	return strings.Join(append(out, ""), "\n")
}

func FormatProviders(config *types.AgentConfig) string {
	names := make([]string, 0, len(config.Providers))
	for name := range config.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	var rows [][]string
	for _, name := range names {
		provider := config.Providers[name]
		role := C.Faint("–")
		if labels := providerRoleLabels(config, name); len(labels) > 0 {
			role = C.Violet(strings.Join(labels, "+"))
		}
		kind := C.Faint(string(provider.Type))
		if provider.Type == types.KindCLITmux {
			kind = C.OK(string(provider.Type))
		}
		effort := C.Faint("–")
		if provider.ReasoningEffort != "" {
			effort = C.Warn(string(provider.ReasoningEffort))
		}
		rows = append(rows, []string{C.Text(name), role, kind, C.Muted(provider.Model), effort})
	}
	return table("PROVIDERS", []string{"name", "role", "kind", "model", "effort"}, rows)
}

func providerRoleLabels(config *types.AgentConfig, name string) []string {
	var labels []string
	if name == config.PlannerProvider {
		labels = append(labels, "planner")
	}
	if name == config.ExecutorProvider {
		labels = append(labels, "executor")
	}
	if name == researcherProvider(config) {
		labels = append(labels, "researcher")
	}
	return labels
}

func researcherProvider(config *types.AgentConfig) string {
	if config.ResearcherProvider != "" {
		return config.ResearcherProvider
	}
	return config.PlannerProvider
}

func FormatTools(tools []types.Tool) string {
	var rows [][]string
	for _, tool := range tools {
		rows = append(rows, []string{C.Text(tool.Name), riskBadge(tool.Risk), C.Muted(tool.Description)})
	}
	return table("TOOLS", []string{"tool", "risk", "description"}, rows)
}

type SessionRow struct {
	ID          string
	UpdatedAt   time.Time
	Messages    int
	Workspace   string
	FirstPrompt string
}

func FormatSessions(sessions []SessionRow, now time.Time) string {
	if len(sessions) == 0 {
		return "\n" + C.Faint("  no sessions recorded yet") + "\n\n"
	}
	var rows [][]string
	for _, session := range sessions {
		opened := session.FirstPrompt
		if opened == "" {
			opened = session.Workspace
		}
		if opened == "" {
			opened = "–"
		}
		rows = append(rows, []string{
			C.Text(strings.TrimSuffix(session.ID, "-0xaf")),
			C.Faint(ago(now.Sub(session.UpdatedAt).Milliseconds())),
			C.Violet(fmt.Sprintf("%d", session.Messages)),
			C.Muted(Truncate(opened, 52)),
		})
	}
	return table("SESSIONS", []string{"id", "age", "msgs", "opened with"}, rows) +
		C.Faint("  resume with") + " " + C.Accent("/resume <id>") + " " +
		C.Faint("or") + " " + C.Accent("--resume <id>") + "\n\n"
}

func ago(ms int64) string {
	minutes := int(math.Round(float64(ms) / 60_000))
	if minutes < 1 {
		return "just now"
	}
	if minutes < 60 {
		return fmt.Sprintf("%dm ago", minutes)
	}
	hours := int(math.Round(float64(minutes) / 60))
	if hours < 48 {
		return fmt.Sprintf("%dh ago", hours)
	}
	return fmt.Sprintf("%dd ago", int(math.Round(float64(hours)/24)))
}

type MCPRow struct {
	Name   string
	Status string
	Error  string
	Tools  []string
}

func FormatMCP(connections []MCPRow) string {
	if len(connections) == 0 {
		return "\n" + C.Faint(`  no MCP servers configured — add an "mcpServers" block to agent.config.json`) + "\n\n"
	}
	var rows [][]string
	for _, connection := range connections {
		state := C.Warn("○ " + orText(connection.Status, "unknown"))
		switch {
		case connection.Error != "":
			state = C.Err("○ failed")
		case connection.Status == "ready":
			state = C.OK("● ready")
		}
		detail := connection.Error
		if detail == "" {
			detail = orText(strings.Join(connection.Tools, ", "), "–")
		}
		rows = append(rows, []string{
			C.Text(connection.Name), state,
			C.Violet(fmt.Sprintf("%d", len(connection.Tools))),
			C.Muted(Truncate(detail, 60)),
		})
	}
	return table("MCP SERVERS", []string{"server", "state", "tools", "detail"}, rows)
}

func FormatAuthStatus(statuses []auth.Status) string {
	var rows [][]string
	for _, status := range statuses {
		rows = append(rows, []string{
			C.Text(status.Provider), AuthStateBadge(status.State), C.Muted(status.Source),
			C.Faint(orText(strings.Join(status.EnvVars, ", "), "–")),
		})
	}
	return table("AUTH", []string{"provider", "state", "source", "env"}, rows)
}

// AuthStateBadge keeps the three states visually distinct. `present` is not a
// warning about the operator's setup — it is this program admitting it could not
// verify the login, because the CLI offers no way to ask.
func AuthStateBadge(state auth.State) string {
	switch state {
	case auth.StateReady:
		return C.OK("● ready")
	case auth.StatePresent:
		return C.Warn("◐ present")
	}
	return C.Err("○ missing")
}

func riskBadge(risk types.Risk) string {
	switch risk {
	case types.RiskRead:
		return C.OK("read")
	case types.RiskWrite:
		return C.Warn("write")
	case types.RiskNetwork:
		return C.Err("network")
	}
	return C.Violet("exec")
}

func orText(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
