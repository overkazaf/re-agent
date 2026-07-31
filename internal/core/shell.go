package core

// Operator shell escape: a REPL line starting with `!` runs directly in the
// workspace instead of going to a model. The same execution policy that guards
// the agent's run_command tool applies here, so `--allow-network` /
// `--allow-sensitive` mean the same thing whoever types the command.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// ShellContextMaxChars caps what a shell escape contributes to the transcript.
const ShellContextMaxChars = 8000

type ShellRunOptions struct {
	Workspace string
	Policy    *types.ExecutionPolicy
	Ctx       context.Context
	Confirm   func(types.ApprovalRequest) types.ApprovalDecision
	// PreApproved is set when the caller already ran AssertShellCommandAllowed,
	// so the operator is not asked twice.
	PreApproved bool
	OnChunk     func(stream, text string)
}

type ShellRunResult struct {
	Command  string
	Code     int
	Stdout   string
	Stderr   string
	Ms       int64
	TimedOut bool
	Aborted  bool
}

// IsShellEscape is true for REPL lines that are a shell escape, not a prompt.
func IsShellEscape(line string) bool { return strings.HasPrefix(line, "!") }

// ParseShellEscape strips the `!` marker.
func ParseShellEscape(line string) string {
	if strings.HasPrefix(line, "!") {
		return strings.TrimSpace(line[1:])
	}
	return strings.TrimSpace(line)
}

// AssertShellCommandAllowed clears the command with the policy before any
// output is drawn. The operator typed this one themselves, so a tripped safety
// pattern is a question ("really run that?"), not a refusal — unless nobody is
// there to answer.
func AssertShellCommandAllowed(
	command string,
	policy *types.ExecutionPolicy,
	confirm func(types.ApprovalRequest) types.ApprovalDecision,
) error {
	concerns, err := security.CommandConcerns(command, policy)
	if err != nil {
		return err
	}
	return security.RequestApproval(
		types.ApprovalRequest{Tool: "!shell", Tier: types.TierExec, Summary: command, Concerns: concerns},
		types.ToolContext{Workspace: ".", SessionDir: ".", Policy: policy, Confirm: confirm},
	)
}

// IsChdir reports whether a shell escape is a standalone directory change.
// Each `!` command runs in its own child shell, so a `cd` inside one is discarded
// the instant the child exits; the REPL has to intercept the pure form and move
// its own workspace instead. Anything that chains another command (`&&`, `;`,
// `|`, a newline) is left to the shell untouched, so just the plain `cd [dir]`
// shape is intercepted.
func IsChdir(command string) bool {
	trimmed := strings.TrimSpace(command)
	if trimmed != "cd" && !strings.HasPrefix(trimmed, "cd ") {
		return false
	}
	return !strings.ContainsAny(trimmed, "&|;\n\r")
}

// ResolveChdir runs the `cd` against the current workspace and returns the
// directory it lands in as an absolute path. Resolution is delegated to the
// selected shell so `~`, `$VARS`, relative paths, and symlinks behave exactly as
// they would for any other command run in the workspace.
func ResolveChdir(workspace, command string, policy *types.ExecutionPolicy) (string, error) {
	timeout := 0
	if policy != nil {
		timeout = policy.CommandTimeoutMs
	}
	argv, err := tools.ShellCommand(command + " && pwd")
	if err != nil {
		return "", err
	}
	result, err := tools.Stream(argv, tools.StreamOptions{
		Cwd:       workspace,
		TimeoutMs: timeout,
	})
	if err != nil {
		return "", err
	}
	if result.Code != 0 {
		if message := strings.TrimSpace(result.Stderr); message != "" {
			return "", errors.New(message)
		}
		return "", fmt.Errorf("cd failed (exit %d)", result.Code)
	}
	dir := strings.TrimSpace(result.Stdout)
	if dir == "" {
		return "", errors.New("cd produced no directory")
	}
	return dir, nil
}

func RunShellCommand(command string, options ShellRunOptions) (ShellRunResult, error) {
	if !options.PreApproved {
		if err := AssertShellCommandAllowed(command, options.Policy, options.Confirm); err != nil {
			return ShellRunResult{}, err
		}
	}
	started := types.NowMs()
	argv, err := tools.ShellCommand(command)
	if err != nil {
		return ShellRunResult{}, err
	}
	timeout := 0
	if options.Policy != nil {
		timeout = options.Policy.CommandTimeoutMs
	}
	result, err := tools.Stream(argv, tools.StreamOptions{
		Cwd:       options.Workspace,
		TimeoutMs: timeout,
		Ctx:       options.Ctx,
		OnChunk:   options.OnChunk,
	})
	if err != nil {
		return ShellRunResult{}, err
	}
	return ShellRunResult{
		Command:  command,
		Code:     result.Code,
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
		Ms:       types.NowMs() - started,
		TimedOut: result.TimedOut,
		Aborted:  result.Aborted,
	}, nil
}

// ShellContextMessage is the transcript entry recorded for a shell escape. It is
// attributed to the operator so the model treats it as observed workspace state
// rather than as an instruction, and it is truncated so a noisy command cannot
// swamp the context.
func ShellContextMessage(result ShellRunResult, maxChars int) string {
	if maxChars <= 0 {
		maxChars = ShellContextMaxChars
	}
	lines := []string{
		"[operator shell] I ran this command myself in the workspace; here is the output for your context.",
		"",
		"$ " + result.Command,
		fmt.Sprintf("exit=%d%s", result.Code, statusNote(result)),
	}
	if strings.TrimSpace(result.Stdout) != "" {
		lines = append(lines, "", "stdout:", util.Clip(strings.TrimRight(result.Stdout, " \t\r\n"), maxChars))
	}
	if strings.TrimSpace(result.Stderr) != "" {
		limit := maxChars
		if limit > 2000 {
			limit = 2000
		}
		lines = append(lines, "", "stderr:", util.Clip(strings.TrimRight(result.Stderr, " \t\r\n"), limit))
	}
	if strings.TrimSpace(result.Stdout) == "" && strings.TrimSpace(result.Stderr) == "" {
		lines = append(lines, "", "(no output)")
	}
	return strings.Join(lines, "\n")
}

func statusNote(result ShellRunResult) string {
	if result.TimedOut {
		return " (killed: timed out)"
	}
	if result.Aborted {
		return " (killed: cancelled by operator)"
	}
	return ""
}
