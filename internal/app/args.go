// Package app is the CLI: argument parsing, the REPL, slash commands, and the
// wiring that turns a config into a running agent.
package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

const Version = "0.1.0"

type authCommand struct {
	Action   string // login | status | logout
	Provider string
}

type Args struct {
	Config     string
	Workspace  string
	SessionDir string
	Role       types.AgentRole
	Provider   string
	Planner    string
	Executor   string
	Prompt     string
	Print      bool
	Smoke      bool
	Welcome    bool

	AllowWrites    bool
	AllowNetwork   bool
	AllowSensitive bool
	MaxOutputChars int
	ApprovalMode   types.ApprovalMode
	Viz            ui.VizMode

	// Resume: "" with HasResume means "most recent"; a value names a session.
	Resume       string
	HasResume    bool
	ListSessions bool

	Effort types.ReasoningEffort
	Theme  string

	Auth *authCommand
}

func ParseArgs(argv []string) (Args, error) {
	cwd, _ := os.Getwd()
	args := Args{Workspace: cwd, SessionDir: filepath.Join(cwd, "sessions")}
	var positional []string

	requireValue := func(index int, flag string) (string, error) {
		if index >= len(argv) {
			return "", fmt.Errorf("%s requires a value", flag)
		}
		value := argv[index]
		if value == "" || strings.HasPrefix(value, "--") {
			return "", fmt.Errorf("%s requires a value", flag)
		}
		return value, nil
	}

	for index := 0; index < len(argv); index++ {
		item := argv[index]
		var err error
		switch item {
		case "--config":
			index++
			args.Config, err = requireValue(index, item)
		case "--workspace", "--cwd":
			index++
			args.Workspace, err = requireValue(index, item)
		case "--session-dir":
			index++
			args.SessionDir, err = requireValue(index, item)
		case "--role":
			index++
			var role string
			role, err = requireValue(index, item)
			if err == nil {
				if !types.IsRole(role) {
					return args, fmt.Errorf("invalid role: %s", role)
				}
				args.Role = types.AgentRole(role)
			}
		case "--agent", "--provider":
			index++
			args.Provider, err = requireValue(index, item)
		case "--planner":
			index++
			args.Planner, err = requireValue(index, item)
		case "--executor":
			index++
			args.Executor, err = requireValue(index, item)
		case "--prompt":
			index++
			args.Prompt, err = requireValue(index, item)
		case "--theme":
			index++
			var theme string
			theme, err = requireValue(index, item)
			if err == nil {
				if !ui.IsThemeName(theme) {
					return args, fmt.Errorf("--theme must be one of: %s", strings.Join(ui.ThemeNames, ", "))
				}
				args.Theme = theme
			}
		case "--effort":
			index++
			var effort string
			effort, err = requireValue(index, item)
			if err == nil {
				if !types.IsEffort(effort) {
					return args, fmt.Errorf("--effort must be one of: %s", effortList())
				}
				args.Effort = types.ReasoningEffort(effort)
			}
		case "--print", "-p":
			args.Print = true
		case "--smoke":
			args.Smoke = true
		case "--welcome", "welcome":
			args.Welcome = true
		case "--write":
			args.AllowWrites = true
		case "--allow-network":
			args.AllowNetwork = true
		case "--allow-sensitive":
			args.AllowSensitive = true
		case "--continue", "-c":
			args.HasResume = true
			args.Resume = ""
		case "--resume":
			args.HasResume = true
			args.Resume = ""
			if index+1 < len(argv) && !strings.HasPrefix(argv[index+1], "-") {
				index++
				args.Resume = argv[index]
			}
		case "--sessions":
			args.ListSessions = true
		case "--flow":
			index++
			var mode string
			mode, err = requireValue(index, item)
			if err == nil {
				if !ui.IsVizMode(mode) {
					return args, fmt.Errorf("--flow must be one of: %s", vizList())
				}
				args.Viz = ui.VizMode(mode)
			}
		case "--yolo":
			args.ApprovalMode = types.ApprovalYolo
		case "--approval":
			index++
			var mode string
			mode, err = requireValue(index, item)
			if err == nil {
				if !security.IsApprovalMode(mode) {
					return args, fmt.Errorf("--approval must be one of: %s", approvalList())
				}
				args.ApprovalMode = types.ApprovalMode(mode)
			}
		case "--max-output":
			index++
			var raw string
			raw, err = requireValue(index, item)
			if err == nil {
				value, convErr := strconv.Atoi(raw)
				if convErr != nil || value < 500 {
					return args, fmt.Errorf("--max-output takes a character budget of at least 500")
				}
				args.MaxOutputChars = value
			}
		case "--help", "-h":
			fmt.Print(ui.HelpText())
			os.Exit(0)
		case "auth":
			index++
			if index >= len(argv) {
				return args, fmt.Errorf("usage: auth login|status|logout [provider]")
			}
			action := argv[index]
			if action != "login" && action != "status" && action != "logout" {
				return args, fmt.Errorf("usage: auth login|status|logout [provider]")
			}
			command := &authCommand{Action: action}
			if index+1 < len(argv) && !strings.HasPrefix(argv[index+1], "-") {
				command.Provider = argv[index+1]
			}
			args.Auth = command
			return finish(args, positional), nil
		default:
			positional = append(positional, item)
		}
		if err != nil {
			return args, err
		}
	}
	return finish(args, positional), nil
}

func finish(args Args, positional []string) Args {
	if args.Prompt == "" && len(positional) > 0 {
		args.Prompt = strings.Join(positional, " ")
	}
	return args
}

func effortList() string {
	var out []string
	for _, effort := range types.ReasoningEfforts {
		out = append(out, string(effort))
	}
	return strings.Join(out, ", ")
}

func vizList() string {
	var out []string
	for _, mode := range ui.VizModes {
		out = append(out, string(mode))
	}
	return strings.Join(out, ", ")
}

func approvalList() string {
	var out []string
	for _, mode := range security.ApprovalModes {
		out = append(out, string(mode))
	}
	return strings.Join(out, ", ")
}
