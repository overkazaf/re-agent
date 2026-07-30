package app

// Two operator-facing ways into a binary that do not go through a model: a hex
// view over the existing hexdump tool, and a handover of the terminal to an
// interactive radare2 session.
//
// The split matters. /hex is a read-tier tool call like /scan, so it prints and
// returns. /r2 gives the terminal away to another full-screen program, which is
// the same move /prompt edit makes for $EDITOR — the pane cannot be live, the
// child inherits the real stdio, and the REPL takes the screen back afterwards.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/util"
)

// defaultHexLength matches the hexdump tool's own default so /hex and the
// model-facing tool show the same window when neither is given a length.
const defaultHexLength = 512

// handleHexCommand parses `/hex <file> [offset] [length]` and hands it to the
// hexdump tool. Offsets accept 0x form because that is how every other RE tool
// prints them, and retyping an address in decimal is a good way to lose it.
func handleHexCommand(arg string, state *State) error {
	args, err := parseHexCommand(arg)
	if err != nil {
		return err
	}
	return runDirectTool("hexdump", args, state)
}

// parseHexCommand is split out from the dispatch so the argument rules can be
// asserted without shelling out to xxd.
func parseHexCommand(arg string) (map[string]any, error) {
	path, rest := splitFirstToken(strings.TrimSpace(arg))
	if path == "" {
		return nil, fmt.Errorf("usage: /hex <file> [offset] [length]")
	}
	args := map[string]any{"path": path}

	offsetText, lengthText := splitFirstToken(rest)
	if offsetText != "" {
		offset, err := parseNumber(offsetText)
		if err != nil || offset < 0 {
			return nil, fmt.Errorf("bad offset %q: want a decimal or 0x number", offsetText)
		}
		args["offset"] = offset
	}
	if lengthText = strings.TrimSpace(lengthText); lengthText != "" {
		length, err := parseNumber(lengthText)
		if err != nil || length <= 0 {
			return nil, fmt.Errorf("bad length %q: want a positive decimal or 0x number", lengthText)
		}
		args["length"] = length
	} else if offsetText != "" {
		// An explicit offset with no length reads as "from here", not "from here
		// to the end of a default window that happens to start at zero".
		args["length"] = defaultHexLength
	}
	return args, nil
}

// parseNumber accepts 0x-prefixed hex as well as plain decimal.
func parseNumber(text string) (int, error) {
	text = strings.TrimSpace(text)
	if lowered := strings.ToLower(text); strings.HasPrefix(lowered, "0x") {
		value, err := strconv.ParseInt(lowered[2:], 16, 64)
		return int(value), err
	}
	value, err := strconv.ParseInt(text, 10, 64)
	return int(value), err
}

// handleRadare2Command opens an interactive radare2 session on a workspace file.
//
// Unlike /retool radare2 <action>, which runs one fixed command and captures the
// output for the model, this gives the terminal to r2 until you quit it. The
// file still has to resolve inside the workspace and still passes the exec-tier
// approval gate, because an r2 prompt can run shell commands of its own.
func handleRadare2Command(arg string, state *State) error {
	fields := strings.Fields(arg)
	var path string
	write := false
	for _, field := range fields {
		switch field {
		case "-w", "--write":
			write = true
		default:
			if path != "" {
				return fmt.Errorf("usage: /r2 <file> [-w]")
			}
			path = field
		}
	}
	if path == "" {
		return fmt.Errorf("usage: /r2 <file> [-w]")
	}

	target, err := util.ResolveInside(state.ToolContext.Workspace, path)
	if err != nil {
		return err
	}
	if err := security.ValidatePathRead(target, state.ToolContext.Policy); err != nil {
		return err
	}
	// Writing to the sample is a policy decision, not a flag the operator can
	// simply assert: -w only reaches r2 when the session already allows writes.
	// Checked before looking for the binary so the answer does not depend on
	// whether r2 happens to be installed on this machine.
	if write && !state.ToolContext.Policy.AllowWrites {
		return fmt.Errorf("/r2 -w needs write mode: restart with --write, or open read-only without -w")
	}

	binary, err := exec.LookPath("r2")
	if err != nil {
		if binary, err = exec.LookPath("radare2"); err != nil {
			return fmt.Errorf("radare2 is not installed or not on PATH. Run /retool inventory to see detected tools")
		}
	}

	// Elided for the notice, workspace-relative for the transcript: the operator
	// is looking at a narrow line, the model wants a path it can act on.
	shown := ui.ElidePath(target, 60)
	noted := target
	if rel, relErr := filepath.Rel(state.ToolContext.Workspace, target); relErr == nil {
		noted = rel
	}
	summary := "r2 " + shown
	if write {
		summary = "r2 -w " + shown + " (writable)"
	}
	approvalContext := *state.ToolContext
	approvalContext.Confirm = createApprover(state, nil, nil)
	if err := security.RequestApproval(types.ApprovalRequest{
		Tool: "radare2_interactive", Tier: types.TierExec, Summary: summary,
		Concerns: radare2Concerns(write),
	}, approvalContext); err != nil {
		return err
	}

	argv := []string{"-A"}
	if write {
		argv = append(argv, "-w")
	}
	argv = append(argv, target)

	fmt.Println(ui.RenderNotice("entering " + summary + " — quit with q to come back"))
	command := exec.Command(binary, argv...)
	command.Dir = state.ToolContext.Workspace
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	runErr := command.Run()

	// Whatever happened in there, the model's next turn should know the operator
	// went and looked, or the following prompt arrives with no antecedent.
	note := fmt.Sprintf("[operator] I opened %s in an interactive radare2 session.", noted)
	if runErr != nil {
		note += fmt.Sprintf(" It exited with an error: %v.", runErr)
	}
	_ = state.Loop.AddContext(note)

	if runErr != nil {
		return fmt.Errorf("radare2 exited: %w", runErr)
	}
	fmt.Println(ui.RenderNotice("left radare2 — back at the 0xAF prompt"))
	return nil
}

// radare2Concerns spells out why this prompt is worth reading rather than
// reflexively approving. An empty list would let a permissive mode auto-approve.
func radare2Concerns(write bool) []string {
	concerns := []string{"an interactive r2 prompt can run shell commands with ! and load scripts"}
	if write {
		concerns = append(concerns, "-w opens the sample for modification in place")
	}
	return concerns
}
