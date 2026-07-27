package ui

// The command deck: `/help`, the slash-command palette shown while typing, and
// TAB completion. One table drives all three so they can never disagree.

import (
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

type HelpEntry struct {
	Command     string
	Args        string
	Description string
}

type HelpSection struct {
	Title   string
	Entries []HelpEntry
}

var SlashCommandSections = []HelpSection{
	{"session", []HelpEntry{
		{"/", "", "Show executable slash commands"},
		{"/welcome", "", "Show guided first-run demos"},
		{"/help", "", "Show this deck"},
		{"/clear", "", "Clear the screen and redraw the banner"},
		{"/theme", "[name]", "Switch palette (deck/amber/matrix/mono)"},
		{"/flow", "[full|flow|trace|off]", "Live dataflow diagram and trace lines"},
		{"/workflow", "[off|auto|specialist|caveman]", "Pick RE workflow mode"},
		{"/tasks", "[auto|collapse|expand|toggle]", "Fold or expand the live task list"},
		{"/queue", "[list|add|edit|cancel|clear|run]", "Manage queued prompts"},
		{"/context", "", "Show the context estimate against the budget"},
		{"/compact", "[provider]", "Fold the session into a summary and free context"},
		{"/session", "", "Print the JSONL transcript path"},
		{"/sessions", "", "List recent sessions"},
		{"/resume", "[id]", "Load a previous session's history"},
		{"/policy", "", "Show the active safety policy"},
		{"/approval", "[mode|tool <n> allow|deny]", "Show or change tool approval (yolo/write/always-ask)"},
		{"/exit", "", "Quit"},
		{"/quit", "", "Quit"},
	}},
	{"routing", []HelpEntry{
		{"/role", "planner|executor|auto", "Pick which side of the deck answers"},
		{"/agent", "<name>|auto", "Pin one provider for the next prompts"},
		{"/model", "<provider|planner|executor> <model>", "Override a provider model for this session"},
		{"/planner", "<name>", "Set the planner provider"},
		{"/executor", "<name>", "Set the executor provider"},
		{"/effort", "<provider> <level>", "Set reasoning effort (minimal…max)"},
		{"/providers", "", "List configured providers"},
	}},
	{"auth", []HelpEntry{
		{"/auth", "", "Show credential status"},
		{"/status", "", "Show credential status"},
		{"/login", "<provider>", "Store an API key locally"},
		{"/logout", "<provider>", "Remove a stored credential"},
	}},
	{"direct tools", []HelpEntry{
		{"/tools", "", "List reverse/CTF tools"},
		{"/mcp", "", "Show MCP servers and the tools they contribute"},
		{"/scan", "<path>", "Fast CTF triage on an artifact or directory"},
		{"/mitigations", "<binary>", "Summarize native binary protections"},
		{"/entropy", "<file>", "Sliding-window entropy scan"},
		{"/findbytes", "<file> <needle>", "Find text/hex offsets with context"},
		{"/carve", "<file>", "Locate embedded file signatures"},
		{"/apk", "<apk>", "Inspect APK structure and packer/framework hints"},
		{"/retool", "[tool action path]", "Use common RE tools: radare2, JADX, Ghidra, Unicorn, unidbg"},
		{"/decode", "[mode] <input>", "Decode base64/hex/url/rot13/xor candidates"},
		{"/hook", "[java|native|objc] <target>", "Generate a Frida hook scaffold"},
		{"/plan", "", "Reprint the current task list"},
		{"/read", "<path>", "Read a file without the model"},
		{"/run", "<command>", "Run a local command without the model"},
	}},
	{"skills & knowledge", []HelpEntry{
		{"/skills", "", "List built-in reverse engineering skills"},
		{"/skill", "<name> [task]", "Show or force a built-in skill workflow"},
		{"/know", "<query>", "Answer from imported reverse knowledge, with sources"},
		{"/know raw", "<query>", "Raw index hits, no model call"},
		{"/know read", "<id>", "Read one knowledge entry in full"},
	}},
}

func HelpText() string {
	out := []string{"", C.Bold(C.Accent("0xAF")) + " " + C.Faint("command deck"), GradientRule(minOf(TermWidth(), 52))}
	width := 0
	for _, section := range SlashCommandSections {
		for _, entry := range section.Entries {
			label := strings.TrimSpace(entry.Command + " " + entry.Args)
			if DisplayWidth(label) > width {
				width = DisplayWidth(label)
			}
		}
	}
	for _, section := range SlashCommandSections {
		out = append(out, "", C.Faint(strings.ToUpper(section.Title)))
		for _, entry := range section.Entries {
			label := C.Accent(entry.Command)
			if entry.Args != "" {
				label += " " + C.Violet(entry.Args)
			}
			out = append(out, "  "+PadEnd(label, width+2)+C.Muted(entry.Description))
		}
	}
	out = append(out,
		"",
		C.Faint("SHELL"),
		"  "+PadEnd(C.Violet("!")+C.Accent("<command>"), width+2)+
			C.Muted("Run a shell command in the workspace; its output is shared with the agent"),
		"  "+PadEnd(C.Faint("e.g. !ls -la"), width+2)+C.Muted("Same policy as run_command · ^C cancels"),
	)
	out = append(out,
		"",
		C.Faint("CLI"),
		"  "+C.Muted("0xaf --welcome"),
		"  "+C.Muted("0xaf --workspace ./ctf"),
		"  "+C.Muted(`0xaf -p "triage ./chall" --role planner`),
		"  "+C.Muted(`0xaf --agent claude --effort high -p "..."`),
		"  "+C.Muted("0xaf auth status"),
		"",
	)
	return strings.Join(out, "\n") + "\n"
}

// --- completion --------------------------------------------------------------

type CompletionItem struct {
	Value       string
	Args        string
	Description string
	Replacement string
	Kind        string // command | argument
}

var slashCommandEntries = func() []HelpEntry {
	var out []HelpEntry
	for _, section := range SlashCommandSections {
		out = append(out, section.Entries...)
	}
	return out
}()

var roles = []string{"planner", "executor", "auto"}

var workflowModes = []string{"off", "auto", "specialist", "caveman"}

var taskModes = []string{"auto", "collapse", "expand", "toggle"}

var queueActions = []string{"list", "add", "edit", "cancel", "clear", "run"}

var retoolNames = []string{
	"inventory", "radare2", "rizin", "jadx", "apktool", "binwalk", "yara", "ghidra",
	"gdb", "lldb", "objdump", "readelf", "nm", "apkid", "aapt", "frida", "unicorn", "unidbg",
}

var providerArgCommands = map[string]bool{
	"/planner": true, "/executor": true, "/login": true, "/logout": true,
}

func SlashCompletions(line string, providerNames, skillNames []string) []CompletionItem {
	if !strings.HasPrefix(line, "/") {
		return nil
	}
	hasTrailingSpace := strings.HasSuffix(line, " ") || strings.HasSuffix(line, "\t")
	words := strings.Fields(strings.TrimSpace(line))
	if len(words) == 0 {
		return commandCompletions("/")
	}
	if len(words) == 1 && !hasTrailingSpace {
		return commandCompletions(words[0])
	}

	command := words[0]
	fragment := ""
	if !hasTrailingSpace {
		fragment = words[len(words)-1]
	}
	head := strings.Join(words[:len(words)-1], " ")
	argIndex := len(words) - 1
	if hasTrailingSpace {
		head = strings.TrimRight(line, " \t")
		argIndex = len(words)
	}
	pool := argumentPool(command, argIndex, providerNames, skillNames)
	if len(pool) == 0 {
		return nil
	}
	var hits []CompletionItem
	for _, item := range pool {
		if strings.HasPrefix(item.Value, fragment) {
			hits = append(hits, item)
		}
	}
	if len(hits) == 0 {
		hits = pool
	}
	for index := range hits {
		hits[index].Replacement = head + " " + hits[index].Value
		hits[index].Kind = "argument"
	}
	return hits
}

func commandCompletions(fragment string) []CompletionItem {
	var entries []HelpEntry
	for _, entry := range slashCommandEntries {
		if strings.HasPrefix(entry.Command, fragment) {
			entries = append(entries, entry)
		}
	}
	if len(entries) == 0 {
		entries = slashCommandEntries
	}
	out := make([]CompletionItem, 0, len(entries))
	for _, entry := range entries {
		replacement := entry.Command + " "
		if entry.Command == "/" {
			replacement = "/"
		}
		out = append(out, CompletionItem{
			Value: entry.Command, Args: entry.Args, Description: entry.Description,
			Replacement: replacement, Kind: "command",
		})
	}
	return out
}

func argumentPool(command string, argIndex int, providerNames, skillNames []string) []CompletionItem {
	simple := func(values []string, description string) []CompletionItem {
		out := make([]CompletionItem, 0, len(values))
		for _, value := range values {
			out = append(out, CompletionItem{Value: value, Description: description})
		}
		return out
	}
	if argIndex != 1 && command != "/effort" {
		if command != "/model" {
			return nil
		}
	}
	if command == "/model" {
		if argIndex == 1 {
			return simple(append([]string{"active", "planner", "executor"}, providerNames...), "provider")
		}
		return nil
	}
	switch command {
	case "/theme":
		return simple(ThemeNames, "theme")
	case "/flow":
		var modes []string
		for _, mode := range VizModes {
			modes = append(modes, string(mode))
		}
		return simple(modes, "visualization")
	case "/workflow":
		return simple(workflowModes, "workflow mode")
	case "/tasks":
		return simple(taskModes, "task display")
	case "/queue":
		return simple(queueActions, "queue action")
	case "/role":
		return simple(roles, "role")
	case "/agent":
		return simple(append([]string{"auto"}, providerNames...), "provider")
	case "/skill":
		return simple(skillNames, "built-in skill")
	case "/retool":
		return simple(retoolNames, "reverse toolkit")
	case "/effort":
		if argIndex == 1 {
			return simple(providerNames, "provider")
		}
		if argIndex == 2 {
			var efforts []string
			for _, effort := range types.ReasoningEfforts {
				efforts = append(efforts, string(effort))
			}
			return simple(efforts, "reasoning effort")
		}
		return nil
	}
	if providerArgCommands[command] {
		return simple(providerNames, "provider")
	}
	return nil
}

type PaletteOptions struct {
	Limit      int
	SkillNames []string
}

// FormatSlashCommandPalette renders the live suggestion panel shown while a
// slash command is being typed.
func FormatSlashCommandPalette(line string, providerNames []string, options PaletteOptions) string {
	items := SlashCompletions(line, providerNames, options.SkillNames)
	limit := options.Limit
	if limit == 0 {
		limit = 12
	}
	visible := items
	if len(visible) > limit {
		visible = visible[:limit]
	}
	title := "COMMANDS"
	for _, item := range items {
		if item.Kind == "argument" {
			title = "ARGUMENTS"
			break
		}
	}
	width := minOf(TermWidth(), 88)
	maxLabelWidth := 10
	for _, item := range visible {
		if candidate := DisplayWidth(completionLabelText(item)); candidate > maxLabelWidth {
			maxLabelWidth = candidate
		}
	}
	if maxLabelWidth > 32 {
		maxLabelWidth = 32
	}
	var rows []string
	for _, item := range visible {
		label := formatCompletionLabel(item, maxLabelWidth)
		descriptionWidth := width - maxLabelWidth - 6
		if descriptionWidth < 12 {
			descriptionWidth = 12
		}
		rows = append(rows, "  "+PadEnd(label, maxLabelWidth+2)+C.Muted(Truncate(item.Description, descriptionWidth)))
	}
	if len(items) > len(visible) {
		rows = append(rows, "  "+C.Faint(itemsRemaining(len(items)-len(visible))))
	}
	if len(rows) == 0 {
		rows = append(rows, "  "+C.Faint("No argument suggestions for this command"))
	}
	rows = append(rows, "  "+C.Faint("Enter runs command · TAB completes"))
	out := []string{C.Bold(C.Accent(title)), GradientRule(minOf(width, 52))}
	return strings.Join(append(out, rows...), "\n")
}

func itemsRemaining(count int) string {
	return "+" + itoa(count) + " more; keep typing or press TAB"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

func completionLabelText(item CompletionItem) string {
	if item.Args == "" {
		return item.Value
	}
	return item.Value + " " + item.Args
}

func formatCompletionLabel(item CompletionItem, width int) string {
	if item.Args == "" {
		return C.Accent(Truncate(item.Value, width))
	}
	commandWidth := DisplayWidth(item.Value)
	if commandWidth+1 >= width {
		return C.Accent(Truncate(item.Value, width))
	}
	return C.Accent(item.Value) + " " + C.Violet(Truncate(item.Args, width-commandWidth-1))
}

// CompletionReplacements is what the line editor's TAB handler consumes.
func CompletionReplacements(line string, providerNames, skillNames []string) []string {
	items := SlashCompletions(line, providerNames, skillNames)
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Replacement)
	}
	return out
}
