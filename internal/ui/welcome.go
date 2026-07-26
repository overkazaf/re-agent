package ui

import (
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

type welcomeDemo struct {
	title    string
	goal     string
	commands []string
}

type WelcomeOptions struct {
	Config        *types.AgentConfig
	Workspace     string
	DemoWorkspace string
}

var welcomeDemos = []welcomeDemo{
	{
		"1. Wiring check",
		"Confirm the CLI, config, session logging, and mock provider are usable.",
		[]string{"0xaf --smoke"},
	},
	{
		"2. Read-only triage",
		"Open the toy CTF workspace and ask for an initial artifact inventory.",
		[]string{
			"0xaf --workspace ./demos/welcome \\",
			`  -p "Triage this workspace. List files, identify the challenge, and propose a first solve plan." \`,
			"  --role planner",
		},
	},
	{
		"3. Guided solve",
		"Recover the expected token from the demo checker and verify it locally.",
		[]string{
			"0xaf --workspace ./demos/welcome \\",
			`  -p "Recover the expected token from chall.js, verify it with a local command, and explain the check."`,
		},
	},
	{
		"4. Direct tool tour",
		"Use the REPL without asking a model to inspect files and run a safe local command.",
		[]string{
			"0xaf --workspace ./demos/welcome",
			"/tools",
			"/read README.md",
			`/run "node chall.js test"`,
			"!ls -la",
		},
	},
	{
		"5. Notes with writes enabled",
		"Let the agent create reproducible solve notes after you are comfortable with read-only mode.",
		[]string{
			"0xaf --workspace ./demos/welcome --write \\",
			`  -p "Create notes/solve.md with the triage, verification command, and recovered token."`,
		},
	},
	{
		"6. Reverse lab",
		"Try CTF triage, decode, carving, built-in skills, and knowledge search without a model round trip.",
		[]string{
			"0xaf --workspace ./demos/reverse-lab",
			"/skills",
			"/scan artifact.txt",
			"/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9",
			"/carve carrier.bin",
			"/know frida ssl pinning",
		},
	},
}

func WelcomeText(options WelcomeOptions) string {
	workspace := "current directory"
	if options.Workspace != "" {
		workspace = ElidePath(options.Workspace, 56)
	}
	demoWorkspace := options.DemoWorkspace
	if demoWorkspace == "" {
		demoWorkspace = "./demos/welcome"
	}
	route := "planner/executor from config"
	if options.Config != nil {
		route = "planner " + options.Config.PlannerProvider + " " + C.Rule("·") +
			" executor " + options.Config.ExecutorProvider
	}

	out := []string{
		"",
		C.Bold(C.Accent("0xAF-Re Welcome")) + " " + C.Faint("guided demos for the first session"),
		GradientRule(minOf(TermWidth(), 64)),
		"",
		C.Faint("workspace") + " " + C.Text(workspace),
		C.Faint("demo") + "      " + C.Text(demoWorkspace),
		C.Faint("route") + "     " + route,
		"",
		C.Faint("START HERE"),
		"  " + C.Accent("1") + " Run " + C.Text("0xaf --welcome") + " whenever you want this guide.",
		"  " + C.Accent("2") + " Run the wiring check before configuring paid/API providers.",
		"  " + C.Accent("3") + " Use the demo workspace for the first real tool-assisted run.",
		"",
		C.Faint("WELCOME DEMOS"),
	}

	for _, demo := range welcomeDemos {
		out = append(out, "", "  "+C.Bold(C.Accent(demo.title)), "  "+C.Muted(demo.goal))
		for index, command := range demo.commands {
			prompt := " "
			if index == 0 {
				prompt = "$"
			}
			out = append(out, "    "+C.Faint(prompt)+" "+C.Text(command))
		}
	}

	out = append(out,
		"",
		C.Faint("REPL SHORTCUTS"),
		"  "+C.Accent("/welcome")+" "+C.Muted("show this guide"),
		"  "+C.Accent("/help")+"    "+C.Muted("show all commands"),
		"  "+C.Accent("/auth")+"    "+C.Muted("check provider credentials"),
		"  "+C.Accent("/tools")+"   "+C.Muted("list reverse/CTF tools"),
		"  "+C.Violet("!")+C.Accent("cmd")+"     "+C.Muted("run a shell command; the agent sees the output"),
		"",
	)
	return strings.Join(out, "\n") + "\n"
}
