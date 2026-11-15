// /cap — inspect and adjust the task capability scope.
//
// The sandbox activates from a /goal declaration's constraints and denies by
// default; this command is the operator's mid-task lever: grant or withdraw
// one capability when the analysis genuinely needs it, and read the action
// log — every gated command with its decision and origin.
package app

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/ui"
)

func handleCapCommand(arg string, state *State) error {
	fields := strings.Fields(arg)
	if len(fields) == 0 {
		fmt.Println(renderSandbox(state.Sandbox))
		return nil
	}
	switch fields[0] {
	case "show":
		fmt.Println(renderSandbox(state.Sandbox))
		return nil
	case "network", "device":
		capability := security.Capability(fields[0])
		if len(fields) < 2 {
			return fmt.Errorf("usage: /cap %s on|off%s", fields[0], deviceHint(fields[0]))
		}
		switch strings.ToLower(fields[1]) {
		case "on", "allow":
			note := strings.TrimSpace(strings.Join(fields[2:], " "))
			if err := state.Sandbox.Grant(capability, "operator", note); err != nil {
				return err
			}
			fmt.Println(ui.RenderNotice(fmt.Sprintf("capability %s granted by operator%s", capability, grantNote(note))))
		case "off", "deny":
			state.Sandbox.Revoke(capability, "operator")
			fmt.Println(ui.RenderNotice(fmt.Sprintf("capability %s revoked by operator", capability)))
		default:
			return fmt.Errorf("usage: /cap %s on|off%s", fields[0], deviceHint(fields[0]))
		}
		return nil
	default:
		return fmt.Errorf("usage: /cap [show | network on|off | device on <id>|off]")
	}
}

func deviceHint(kind string) string {
	if kind == "device" {
		return " <device-id>"
	}
	return ""
}

func grantNote(note string) string {
	if note == "" {
		return ""
	}
	return " — " + note
}

// renderSandbox prints the capability scope and the tail of the action log:
// what the agent reached for, and who said yes.
func renderSandbox(sandbox *security.Sandbox) string {
	var lines []string
	if sandbox == nil {
		return ui.RenderNotice("sandbox unavailable in this context")
	}
	if !sandbox.Active() {
		lines = append(lines, ui.RenderNotice("sandbox inactive — no task declaration accepted; commands run under the base policy"))
	} else {
		grants := sandbox.Granted()
		held := make([]string, 0, len(grants))
		for capability, origin := range grants {
			label := string(capability)
			if capability == security.CapDevice && sandbox.Device() != "" {
				label += " (" + sandbox.Device() + ")"
			}
			held = append(held, fmt.Sprintf("%s ← %s", label, origin))
		}
		sortStrings(held)
		if len(held) == 0 {
			lines = append(lines, ui.RenderNotice("sandbox active — no capabilities granted (network/device deny-by-default)"))
		} else {
			lines = append(lines, ui.RenderNotice("sandbox active — granted: "+strings.Join(held, ", ")))
		}
	}
	actions := sandbox.Actions()
	if len(actions) == 0 {
		lines = append(lines, "  actions: (none recorded yet)")
		return strings.Join(lines, "\n")
	}
	lines = append(lines, "  recent actions:")
	tail := actions
	if len(tail) > 8 {
		tail = tail[len(tail)-8:]
	}
	for _, action := range tail {
		subject := action.Subject
		if len(subject) > 48 {
			subject = subject[:48] + "…"
		}
		capability := string(action.Capability)
		if capability == "" {
			capability = "—"
		}
		lines = append(lines, fmt.Sprintf(
			"  [%s] %s cap=%s %s (sha256 %s)", action.Decision, action.Tool, capability, subject, action.SHA256[:8]))
	}
	return strings.Join(lines, "\n")
}
