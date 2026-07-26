package ui

// Startup sequence: a block-letter logo plus a self-check panel. Every line in
// the panel is a real probe (runtime, tmux, workspace artifacts, provider auth,
// tool inventory) rather than decoration — the boot screen doubles as the answer
// to "is this thing actually wired up right now?".

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/types"
)

var logoRows = []string{
	" ██████ ██   ██  █████  ███████",
	"██  ██████ ██   ██   ██ ██     ",
	"██ ██ ██  ███   ███████ █████  ",
	"████  ██ ██ ██  ██   ██ ██     ",
	" ██████ ██   ██ ██   ██ ██     ",
}

type SystemInfo struct {
	Runtime  string
	Platform string
	Tmux     string
}

type WorkspaceInfo struct {
	Path     string
	Files    int
	Dirs     int
	Binaries []string
}

type SplashContext struct {
	Config      *types.AgentConfig
	Policy      *types.ExecutionPolicy
	SessionFile string
	Version     string
	Tools       []types.Tool
	System      SystemInfo
	Workspace   WorkspaceInfo
	Auth        []auth.Status
	// AuthPending is true while the credential probe is still running.
	AuthPending bool
}

// --- probes ------------------------------------------------------------------

func ProbeSystem() SystemInfo {
	return SystemInfo{
		Runtime:  "go " + strings.TrimPrefix(runtime.Version(), "go"),
		Platform: runtime.GOOS + " " + runtime.GOARCH,
		Tmux:     probeTmux(),
	}
}

func probeTmux() string {
	binary, err := exec.LookPath("tmux")
	if err != nil {
		return "missing"
	}
	cmd := exec.Command(binary, "-V")
	var stdout strings.Builder
	cmd.Stdout = &stdout
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return "missing"
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return "missing"
		}
	case <-time.After(1500 * time.Millisecond):
		_ = cmd.Process.Kill()
		return "missing"
	}
	text := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(stdout.String()), "tmux"))
	if text == "" {
		return "present"
	}
	return text
}

var magicKinds = []struct {
	kind  string
	bytes []byte
}{
	{"ELF", []byte{0x7f, 0x45, 0x4c, 0x46}},
	{"PE", []byte{0x4d, 0x5a}},
	{"Mach-O", []byte{0xcf, 0xfa, 0xed, 0xfe}},
	{"Mach-O", []byte{0xce, 0xfa, 0xed, 0xfe}},
	{"Mach-O", []byte{0xca, 0xfe, 0xba, 0xbe}},
	{"ZIP/APK", []byte{0x50, 0x4b, 0x03, 0x04}},
	{"DEX", []byte{0x64, 0x65, 0x78, 0x0a}},
	{"WASM", []byte{0x00, 0x61, 0x73, 0x6d}},
}

// ProbeWorkspace is shallow triage: file counts plus magic-byte sniffing.
func ProbeWorkspace(workspace string) WorkspaceInfo {
	info := WorkspaceInfo{Path: workspace}
	entries, err := os.ReadDir(workspace)
	if err != nil {
		return info
	}
	kinds := map[string]int{}
	var order []string
	sniffed := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if entry.IsDir() {
			info.Dirs++
			continue
		}
		if !entry.Type().IsRegular() {
			continue
		}
		info.Files++
		if sniffed >= 24 {
			continue // keep startup cheap on large workspaces
		}
		sniffed++
		if kind := sniff(filepath.Join(workspace, entry.Name())); kind != "" {
			if kinds[kind] == 0 {
				order = append(order, kind)
			}
			kinds[kind]++
		}
	}
	for _, kind := range order {
		if kinds[kind] > 1 {
			info.Binaries = append(info.Binaries, fmt.Sprintf("%d %s", kinds[kind], kind))
		} else {
			info.Binaries = append(info.Binaries, kind)
		}
	}
	return info
}

func sniff(file string) string {
	handle, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer handle.Close()
	buffer := make([]byte, 4)
	read, _ := handle.Read(buffer)
	for _, entry := range magicKinds {
		if len(entry.bytes) > read {
			continue
		}
		match := true
		for index, b := range entry.bytes {
			if buffer[index] != b {
				match = false
				break
			}
		}
		if match {
			return entry.kind
		}
	}
	return ""
}

// --- rendering ---------------------------------------------------------------

func RenderLogo(version string) []string {
	out := make([]string, 0, len(logoRows)+1)
	for index, row := range logoRows {
		out = append(out, "  "+Fade("accent", "accentDim", float64(index)/float64(len(logoRows)-1), row))
	}
	return append(out, "  "+C.Faint("reverse ops deck")+"  "+C.Rule("·")+"  "+C.Faint("v"+version))
}

// RenderPanel draws the self-check panel. Auth may be pending while the probe is
// still running.
func RenderPanel(ctx SplashContext) []string {
	label := func(text string) string { return C.Faint(PadEnd(text, 10)) }
	branch := func(text string) string { return "  " + C.Rule("│") + " " + text }
	section := func(title string) string { return "  " + C.Rule("├─") + " " + C.Bold(C.Accent(title)) }

	out := []string{"  " + C.Rule("┌─") + " " + C.Bold(C.Accent("SYSTEM"))}
	out = append(out, branch(label("runtime")+C.Text(ctx.System.Runtime)+" "+C.Rule("·")+" "+C.Muted(ctx.System.Platform)))
	tmux := C.OK(ctx.System.Tmux)
	if ctx.System.Tmux == "missing" {
		tmux = C.Warn("missing (direct fallback)")
	}
	out = append(out, branch(label("tmux")+tmux))

	artifacts := "no binaries detected"
	if len(ctx.Workspace.Binaries) > 0 {
		artifacts = strings.Join(ctx.Workspace.Binaries, ", ")
	}
	out = append(out, section("WORKSPACE"))
	out = append(out, branch(label("path")+C.Text(ElidePath(ctx.Workspace.Path, 40))))
	artifactText := C.Faint(artifacts)
	if len(ctx.Workspace.Binaries) > 0 {
		artifactText = C.Violet(artifacts)
	}
	out = append(out, branch(fmt.Sprintf("%s%s %s %s %s %s",
		label("contents"),
		C.Text(fmt.Sprintf("%d files", ctx.Workspace.Files)), C.Rule("·"),
		C.Text(fmt.Sprintf("%d dirs", ctx.Workspace.Dirs)), C.Rule("·"), artifactText)))

	out = append(out, section("ROUTE"))
	for _, entry := range [][2]string{
		{"plan", ctx.Config.PlannerProvider},
		{"exec", ctx.Config.ExecutorProvider},
	} {
		provider := ctx.Config.Providers[entry[1]]
		state := C.Faint("checking…")
		if !ctx.AuthPending {
			state = C.Err("○ not authenticated")
			for _, status := range ctx.Auth {
				if status.Provider != entry[1] {
					continue
				}
				state = AuthStateBadge(status.State)
				if status.State == auth.StateMissing {
					state = C.Err("○ not authenticated")
				}
				break
			}
		}
		effort := ""
		if provider != nil && provider.ReasoningEffort != "" {
			effort = " " + C.Rule("·") + " " + C.Warn(string(provider.ReasoningEffort))
		}
		out = append(out, branch(label(entry[0])+C.Accent(PadEnd(entry[1], 12))+state+effort))
	}

	risks := map[string]int{}
	var riskOrder []string
	for _, tool := range ctx.Tools {
		key := string(tool.Risk)
		if risks[key] == 0 {
			riskOrder = append(riskOrder, key)
		}
		risks[key]++
	}
	sort.Strings(riskOrder)
	var riskParts []string
	for _, risk := range riskOrder {
		riskParts = append(riskParts, C.Faint(risk)+" "+C.Text(fmt.Sprintf("%d", risks[risk])))
	}
	out = append(out, section("ARSENAL"))
	out = append(out, branch(fmt.Sprintf("%s%s %s %s",
		label("tools"), C.Text(fmt.Sprintf("%d", len(ctx.Tools))), C.Rule("·"),
		strings.Join(riskParts, C.Rule(" · ")))))

	flags := strings.Join([]string{
		flagText("write", ctx.Policy.AllowWrites),
		flagText("net", ctx.Policy.AllowNetwork),
		flagText("sensitive", ctx.Policy.AllowSensitive),
	}, C.Rule(" · "))
	out = append(out, "  "+C.Rule("└─")+" "+C.Faint("policy")+" "+flags+" "+C.Rule("·")+" "+
		C.Faint("log")+" "+C.Faint(ElidePath(ctx.SessionFile, 24)))
	return out
}

func flagText(name string, enabled bool) string {
	if enabled {
		return C.Faint(name) + " " + C.OK("on")
	}
	return C.Faint(name) + " " + C.Muted("off")
}

func RenderHint() string {
	return strings.Join([]string{
		"  " + C.Accent("/welcome") + " " + C.Faint("demos"),
		C.Accent("/help") + " " + C.Faint("commands"),
		C.Accent("!cmd") + " " + C.Faint("shell"),
		C.Accent("/flow") + " " + C.Faint("dataflow"),
		C.Accent("TAB") + " " + C.Faint("complete"),
		C.Accent("↑↓") + " " + C.Faint("history"),
		C.Accent("/theme") + " " + C.Faint("palette"),
		C.Accent("^C") + " " + C.Faint("cancel"),
	}, C.Rule("  ·  "))
}

// RenderSplash is the complete splash as one string, no animation. Used by
// /clear and /theme.
func RenderSplash(ctx SplashContext) string {
	lines := []string{""}
	lines = append(lines, RenderLogo(ctx.Version)...)
	lines = append(lines, "")
	lines = append(lines, RenderPanel(ctx)...)
	lines = append(lines, "", GradientRule(minOf(TermWidth(), 64)), RenderHint(), "")
	return strings.Join(lines, "\n")
}

// PlaySplash is the animated boot. It reveals the logo scanline-style while the
// auth probe runs in the background, then fills in the panel. Falls back to a
// single write when stdout is not a TTY so piped output stays clean.
func PlaySplash(base SplashContext, authProbe <-chan []auth.Status) []auth.Status {
	if !isStdoutTTY() {
		result := <-authProbe
		base.Auth = result
		fmt.Print(RenderSplash(base))
		return result
	}

	fmt.Print("\x1b[?25l") // hide cursor during the reveal
	defer fmt.Print("\x1b[?25h")

	fmt.Println()
	for _, row := range RenderLogo(base.Version) {
		fmt.Println(row)
		time.Sleep(45 * time.Millisecond)
	}
	fmt.Println()

	// Draw the panel with auth pending, then repaint those rows once the probe
	// lands. Lines are clipped to the terminal width so each occupies exactly
	// one row — otherwise a wrapped line desyncs the cursor-up count below.
	fit := func(line string) string { return Truncate(line, TerminalColumns(80)-1) }
	pending := base
	pending.AuthPending = true
	rows := RenderPanel(pending)
	for _, line := range rows {
		fmt.Println(fit(line))
		time.Sleep(22 * time.Millisecond)
	}

	result := <-authProbe
	base.Auth = result
	settled := RenderPanel(base)
	fmt.Printf("\x1b[%dA", len(settled)) // back to the panel top
	for _, line := range settled {
		fmt.Printf("\r\x1b[2K%s\n", fit(line))
	}

	fmt.Println()
	fmt.Println(GradientRule(minOf(TermWidth(), 64)))
	fmt.Printf("%s\n\n", RenderHint())
	return result
}
