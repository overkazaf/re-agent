package tools

// Remote-mode tooling. The SSH manager and the host registry live in
// internal/remote; this file turns them into model-visible tools. Remote
// commands go through the same exec-tier approval gate as local ones, with the
// host named in the prompt.

import (
	"context"
	"fmt"
	"time"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// CreateRemoteTools returns the tools that execute on saved SSH hosts.
func CreateRemoteTools() []types.Tool {
	return []types.Tool{remoteExecTool()}
}

func remoteExecTool() types.Tool {
	return types.Tool{
		Name: "remote_exec",
		Description: "Run a command on a saved SSH host (background connection). " +
			"Omit host to use the current remote host set by /remote use or --remote.",
		Risk: types.RiskExecute,
		Parameters: objectSchema(map[string]any{
			"host":      map[string]any{"type": "string", "description": "Saved host name; defaults to the current remote host."},
			"command":   map[string]any{"type": "string", "description": "Shell command to run on the remote host."},
			"timeoutMs": map[string]any{"type": "number", "default": 30000},
		}, "command"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			host := util.AsString(args["host"])
			command := util.AsString(args["command"])
			if tc.Remote == nil {
				return types.ToolResult{}, fmt.Errorf("remote mode unavailable: no SSH manager in this context")
			}
			target := host
			if target == "" {
				target = tc.RemoteHost
			}
			if target == "" {
				target = tc.Remote.Current()
			}
			if target == "" {
				return types.ToolResult{}, fmt.Errorf("no remote host selected: use /remote use <name> or --remote <name>")
			}
			concerns, err := security.CommandConcerns(command, tc.Policy)
			if err != nil {
				return types.ToolResult{}, err
			}
			label := "ssh " + target
			if err := security.RequestApproval(types.ApprovalRequest{
				Tool: label, Tier: types.TierExec, Summary: command, Concerns: concerns,
			}, tc); err != nil {
				return types.ToolResult{}, err
			}
			timeoutMs := util.AsInt(args["timeoutMs"], tc.Policy.CommandTimeoutMs)
			if timeoutMs > tc.Policy.CommandTimeoutMs {
				timeoutMs = tc.Policy.CommandTimeoutMs
			}
			ctx, cancel := context.WithTimeout(tc.Context(), time.Duration(timeoutMs)*time.Millisecond)
			defer cancel()
			out, err := tc.Remote.Run(ctx, target, command)
			if err != nil {
				return types.ToolResult{}, err
			}
			spilled := SpillIfLarge(out, SpillOptions{Context: tc, Label: label})
			return textResult(spilled.Text, map[string]any{
				"host": target, "chars": spilled.OriginalChars, "artifact": spilled.Artifact,
			}), nil
		},
	}
}
