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
		{"/version", "", "Show version, commit, and build metadata"},
		{"/clear", "", "Clear the screen and redraw the banner"},
		{"/new", "", "Clear the current session and start a fresh one"},
		{"/theme", "[name]", "Switch palette (deck/amber/matrix/mono)"},
		{"/flow", "[full|flow|trace|off]", "Live dataflow diagram and trace lines"},
		{"/refresh", "[ms|calm|normal|off]", "Set the live pane refresh interval (calm/off quiet the scrollback)"},
		{"/workflow", "[off|auto|specialist|caveman|research|writeup|ctf|reverse [sample]|engineering]", "Pick RE workflow mode; reverse [sample] skips the picker"},
		{"/phase", "[next|<phase-name>]", "Show or advance the RE workflow phase"},
		{"/goal", "[<objective>|show|accept|clear]", "Draft, arm, or clear the task declaration and its acceptance gates"},
		{"/cap", "[show|network on|off|device on <id>|off]", "Inspect or adjust the task capability sandbox"},
		{"/tasks", "[auto|collapse|expand|toggle]", "Fold or expand the live task list"},
		{"/think", "[auto|collapse|expand|toggle]", "Fold or expand the streamed reasoning"},
		{"/queue", "[list|add|edit|cancel|clear|run]", "Manage queued prompts"},
		{"/prompt", "[list|show|path|edit|set|reset|reload]", "Edit global and per-role system prompts"},
		{"/context", "", "Show the context estimate against the budget"},
		{"/compact", "[provider]", "Fold the session into a summary and free context"},
		{"/session", "", "Print the JSONL transcript path"},
		{"/sessions", "", "List recent sessions"},
		{"/resume", "[hash|id]", "Load a previous session's history"},
		{"/policy", "", "Show the active safety policy"},
		{"/approval", "[yolo|safe|write|always-ask|tool <n> allow|deny|reset]", "Show or change tool approval policy"},
		{"/exit", "", "Quit"},
		{"/quit", "", "Quit"},
	}},
	{"routing", []HelpEntry{
		{"/role", "planner|executor|researcher|auto", "Pick which side of the deck answers"},
		{"/agent", "<name>|auto", "Pin one provider for the next prompts"},
		{"/model", "[<provider|planner|executor|researcher> <model>]", "Show or override a provider model for this session"},
		{"/planner", "<name>", "Set the planner provider"},
		{"/executor", "<name>", "Set the executor provider"},
		{"/researcher", "<name>", "Set the researcher provider"},
		{"/effort", "<provider> [level]", "Show or set reasoning effort (minimal…max)"},
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
		{"/inspect", "<binary>", "Deep cross-platform ELF/PE/Mach-O structural inspection"},
		{"/anti", "<binary>", "Detect packers, anti-debug APIs, direct syscalls, and RWX sections"},
		{"/diff", "<fileA> <fileB>", "Compare binary patches with x86/ARM64 instruction diffs"},
		{"/mitigations", "<binary>", "Summarize native binary protections"},
		{"/entropy", "<file>", "Sliding-window entropy scan"},
		{"/findbytes", "<file> <needle>", "Find text/hex offsets with context"},
		{"/carve", "<file>", "Locate embedded file signatures"},
		{"/hex", "<file> [offset] [len]", "Hex view of a file window (0x offsets welcome)"},
		{"/r2", "<file> [-w]", "Hand the terminal to an interactive radare2 session"},
		{"/apk", "<apk>", "Inspect APK structure, manifest, and packer/framework hints"},
		{"/retool", "[tool action path]", "Use common RE tools: radare2, JADX, Ghidra, Unicorn, unidbg"},
		{"/decode", "[mode] [key] <input>", "Decode base64/base32/hex/url/rot13/xor/rc4/zlib/gzip"},
		{"/hook", "[java|native|objc] <target>", "Generate a Frida hook scaffold"},
		{"/plan", "", "Reprint the current task list"},
		{"/read", "<path>", "Read a file without the model"},
		{"/run", "<command>", "Run a local command without the model"},
		{"/remote", "[list|add|rm|use|connect|off]", "Manage saved SSH hosts and remote mode"},
	}},
	{"skills & knowledge", []HelpEntry{
		{"/skills", "", "List built-in reverse engineering skills"},
		{"/skill", "<name> [task]", "Show or force a built-in skill workflow"},
		{"/know", "<query>", "Answer from imported reverse knowledge, with sources"},
		{"/know raw", "<query>", "Raw index hits, no model call"},
		{"/know read", "<id>", "Read one knowledge entry in full"},
	}},
	{"verification", []HelpEntry{
		{"/audit", "", "Cross-model adversarial audit of the hypothesis stack"},
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
		"  "+C.Muted("0xaf --version  ·  0xaf --welcome  ·  0xaf --smoke"),
		"  "+C.Muted("0xaf --workspace ./ctf --workflow reverse"),
		"  "+C.Muted(`0xaf -p "triage ./chall" --role planner --planner codex --executor claude`),
		"  "+C.Muted(`0xaf --agent claude --model claude=sonnet --effort high -C ./notes.md -p "..."`),
		"  "+C.Muted("0xaf --resume [id]  ·  0xaf -c  ·  0xaf --sessions"),
		"  "+C.Muted("0xaf --write --allow-network --approval safe --remote <host>"),
		"  "+C.Muted("0xaf --flow full|flow|trace|off --refresh calm|off --theme deck|amber|matrix|mono"),
		"  "+C.Muted("0xaf auth status | login <provider> | logout <provider>"),
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

var roles = []string{"planner", "executor", "researcher", "auto"}

var promptTargets = []string{"system", "planner", "executor", "researcher"}

var promptActions = []string{"list", "show", "path", "edit", "set", "reset", "reload"}

var workflowModes = []string{"off", "auto", "specialist", "caveman", "research", "writeup", "ctf", "reverse", "engineering"}

var sampleTypeKeys = []string{"apk", "so", "elf", "pe", "macho", "js", "wasm", "firmware", "generic"}

var phaseTargets = []string{"next", "triage", "static", "dynamic", "evidence", "interface", "hypothesis", "verify", "audit", "writeup"}

var goalActions = []string{"show", "accept", "clear"}

var capTargets = []string{"show", "network", "device", "reset"}

var approvalTargets = []string{"yolo", "safe", "write", "always-ask", "tool", "reset"}

var remoteActions = []string{"list", "add", "rm", "use", "connect", "off"}

var refreshModes = []string{"normal", "calm", "off"}

var decodeModes = []string{"auto", "base64", "base64url", "base32", "hex", "url", "rot13", "xor", "xor_bruteforce", "zlib", "gzip", "rc4"}

var taskModes = []string{"auto", "collapse", "expand", "toggle"}

// thinkModes mirrors taskModes. /think also accepts off/on as aliases for
// collapse/expand, but the completion offers the canonical four.
var thinkModes = []string{"auto", "collapse", "expand", "toggle"}

var queueActions = []string{"list", "add", "edit", "cancel", "clear", "run"}

var retoolNames = []string{
	"inventory", "radare2", "rizin", "jadx", "apktool", "binwalk", "yara", "ghidra",
	"gdb", "lldb", "objdump", "readelf", "nm", "apkid", "aapt", "frida", "unicorn", "unidbg",
	"angr", "burp", "mitmproxy",
}

var providerArgCommands = map[string]bool{
	"/planner": true, "/executor": true, "/researcher": true, "/login": true, "/logout": true, "/compact": true,
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
	pool := argumentPool(command, argIndex, words, providerNames, skillNames)
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

func argumentPool(command string, argIndex int, words, providerNames, skillNames []string) []CompletionItem {
	simple := func(values []string, description string) []CompletionItem {
		out := make([]CompletionItem, 0, len(values))
		for _, value := range values {
			out = append(out, CompletionItem{Value: value, Description: description})
		}
		return out
	}
	switch command {
	case "/model":
		if argIndex == 1 {
			return simple(append([]string{"active", "planner", "executor", "researcher"}, providerNames...), "provider")
		}
		return nil
	case "/prompt":
		if argIndex == 1 {
			return simple(promptActions, "prompt action")
		}
		if argIndex == 2 {
			return simple(promptTargets, "prompt target")
		}
		return nil
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
	case "/workflow":
		if argIndex == 1 {
			return simple(workflowModes, "workflow mode")
		}
		if argIndex == 2 && len(words) >= 2 && words[1] == "reverse" {
			return simple(sampleTypeKeys, "sample type")
		}
		return nil
	case "/cap":
		if argIndex == 1 {
			return simple(capTargets, "capability")
		}
		if argIndex == 2 && len(words) >= 2 && (words[1] == "network" || words[1] == "device") {
			return simple([]string{"on", "off"}, "toggle")
		}
		return nil
	case "/approval":
		if argIndex == 1 {
			return simple(approvalTargets, "approval policy")
		}
		if argIndex == 3 && len(words) >= 2 && words[1] == "tool" {
			return simple([]string{"allow", "deny"}, "tool override")
		}
		return nil
	}
	if argIndex != 1 {
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
	case "/refresh":
		return simple(refreshModes, "refresh interval")
	case "/phase":
		return simple(phaseTargets, "RE phase")
	case "/goal":
		return simple(goalActions, "goal action")
	case "/tasks":
		return simple(taskModes, "task display")
	case "/think":
		return simple(thinkModes, "reasoning display")
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
	case "/decode":
		return simple(decodeModes, "decode mode")
	case "/remote":
		return simple(remoteActions, "remote action")
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
