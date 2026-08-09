import type { AgentConfig } from "../types";
import { c, elidePath, gradientRule, termWidth } from "./theme";

interface WelcomeDemo {
  title: string;
  goal: string;
  commands: string[];
}

export interface WelcomeOptions {
  config?: AgentConfig;
  workspace?: string;
  demoWorkspace?: string;
}

const DEMOS: WelcomeDemo[] = [
  {
    title: "1. Wiring check",
    goal: "Confirm the CLI, config, session logging, and mock provider are usable.",
    commands: ["bun src/cli.ts --smoke"],
  },
  {
    title: "2. Read-only triage",
    goal: "Open the toy CTF workspace and ask for an initial artifact inventory.",
    commands: [
      "bun src/cli.ts --workspace ./demos/welcome \\",
      '  -p "Triage this workspace. List files, identify the challenge, and propose a first solve plan." \\',
      "  --role planner",
    ],
  },
  {
    title: "3. Guided solve",
    goal: "Recover the expected token from the demo checker and verify it locally.",
    commands: [
      "bun src/cli.ts --workspace ./demos/welcome \\",
      '  -p "Recover the expected token from chall.js, verify it with a local command, and explain the check."',
    ],
  },
  {
    title: "4. Direct tool tour",
    goal: "Use the REPL without asking a model to inspect files and run a safe local command.",
    commands: [
      "bun src/cli.ts --workspace ./demos/welcome",
      "/tools",
      "/read README.md",
      '/run "node chall.js test"',
      "!ls -la",
    ],
  },
  {
    title: "5. Notes with writes enabled",
    goal: "Let the agent create reproducible solve notes after you are comfortable with read-only mode.",
    commands: [
      "bun src/cli.ts --workspace ./demos/welcome --write \\",
      '  -p "Create notes/solve.md with the triage, verification command, and recovered token."',
    ],
  },
  {
    title: "6. Reverse lab",
    goal: "Try CTF triage, decode, carving, built-in skills, and knowledge search without a model round trip.",
    commands: [
      "bun src/cli.ts --workspace ./demos/reverse-lab",
      "/skills",
      "/scan artifact.txt",
      "/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9",
      "/carve carrier.bin",
      "/know frida ssl pinning",
    ],
  },
];

export function welcomeText(options: WelcomeOptions = {}): string {
  const workspace = options.workspace ? elidePath(options.workspace, 56) : "current directory";
  const demoWorkspace = options.demoWorkspace ?? "./demos/welcome";
  const route = options.config
    ? `planner ${options.config.plannerProvider} ${c.rule("·")} executor ${options.config.executorProvider}`
    : "planner/executor from config";

  const out: string[] = [
    "",
    `${c.bold(c.accent("0xAF-Re Welcome"))} ${c.faint("guided demos for the first session")}`,
    gradientRule(Math.min(termWidth(), 64)),
    "",
    `${c.faint("workspace")} ${c.text(workspace)}`,
    `${c.faint("demo")}      ${c.text(demoWorkspace)}`,
    `${c.faint("route")}     ${route}`,
    "",
    c.faint("START HERE"),
    `  ${c.accent("1")} Run ${c.text("bun src/cli.ts --welcome")} whenever you want this guide.`,
    `  ${c.accent("2")} Run the wiring check before configuring paid/API providers.`,
    `  ${c.accent("3")} Use the demo workspace for the first real tool-assisted run.`,
    "",
    c.faint("WELCOME DEMOS"),
  ];

  for (const demo of DEMOS) {
    out.push("", `  ${c.bold(c.accent(demo.title))}`);
    out.push(`  ${c.muted(demo.goal)}`);
    for (const [index, command] of demo.commands.entries()) {
      const prompt = index === 0 ? "$" : " ";
      out.push(`    ${c.faint(prompt)} ${c.text(command)}`);
    }
  }

  out.push(
    "",
    c.faint("REPL SHORTCUTS"),
    `  ${c.accent("/welcome")} ${c.muted("show this guide")}`,
    `  ${c.accent("/help")}    ${c.muted("show all commands")}`,
    `  ${c.accent("/auth")}    ${c.muted("check provider credentials")}`,
    `  ${c.accent("/tools")}   ${c.muted("list reverse/CTF tools")}`,
    `  ${c.violet("!")}${c.accent("cmd")}     ${c.muted("run a shell command; the agent sees the output")}`,
    "",
  );

  return `${out.join("\n")}\n`;
}
