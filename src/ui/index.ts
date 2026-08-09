import { REASONING_EFFORTS } from "../types";
import { VIZ_MODES } from "./flow";
import type { AgentConfig, AgentRole, AgentTool, ExecutionPolicy, TokenUsage } from "../types";
import type { AuthStatus } from "../auth";
import { renderMarkdown } from "./markdown";
import {
  c,
  compactNumber,
  currentTheme,
  displayWidth,
  elidePath,
  formatDuration,
  gradientRule,
  padEnd,
  setTheme,
  termWidth,
  truncate,
  THEME_BLURBS,
  THEME_NAMES,
} from "./theme";
import type { ThemeName } from "./theme";

export { createLivePane, thinkingSummary } from "./live";
export { createFlowModel, renderFlow, renderFlowPlain } from "./flow";
export { VIZ_MODES, isVizMode } from "./flow";
export type { FlowModel, FlowStage, FlowState, VizMode } from "./flow";
export { traceEnd, traceEvent } from "./trace";
export type { TraceOptions } from "./trace";
export type { LivePane, LivePaneOptions, LiveStats } from "./live";
export { renderHud } from "./hud";
export type { HudModel, HudRoute, HudStats } from "./hud";
export { renderMarkdown } from "./markdown";
export { renderPlan } from "./plan";
export type { RenderPlanOptions } from "./plan";
export { playSplash, renderSplash, probeSystem, probeWorkspace } from "./splash";
export type { SplashContext, SystemInfo, WorkspaceInfo } from "./splash";
export { welcomeText } from "./welcome";
export type { WelcomeOptions } from "./welcome";
export {
  c,
  termWidth,
  formatDuration,
  compactNumber,
  setTheme,
  currentTheme,
  isThemeName,
  THEME_NAMES,
} from "./theme";
export type { ThemeName } from "./theme";

// --- banner ------------------------------------------------------------------

export function banner(config: AgentConfig, sessionFile: string, policy: ExecutionPolicy, version: string): string {
  const width = termWidth();
  const brand = `${c.reverse(c.bold(" 0xAF "))} ${c.bold(c.text("REVERSE OPS DECK"))}`;
  const version_ = c.faint(`v${version}`);
  const gap = Math.max(1, width - displayWidth(brand) - displayWidth(version_));

  const kv = (key: string, value: string) => `${c.faint(key)} ${value}`;
  const route = [
    kv("plan", c.accent(config.plannerProvider)),
    kv("exec", c.violet(config.executorProvider)),
    kv("turns", c.text(String(config.maxTurns))),
  ].join(c.rule("  ·  "));

  const policyLine = [
    kv("write", flag(policy.allowWrites)),
    kv("net", flag(policy.allowNetwork)),
    kv("sensitive", flag(policy.allowSensitive)),
    kv("log", c.faint(elidePath(sessionFile, 26))),
  ].join(c.rule("  ·  "));

  const hint = [
    `${c.accent("/welcome")} ${c.faint("demos")}`,
    `${c.accent("/help")} ${c.faint("commands")}`,
    `${c.accent("!cmd")} ${c.faint("shell")}`,
    `${c.accent("/flow")} ${c.faint("dataflow")}`,
    `${c.accent("TAB")} ${c.faint("complete")}`,
    `${c.accent("↑↓")} ${c.faint("history")}`,
    `${c.accent("^C")} ${c.faint("cancel")}`,
  ].join(c.rule("  ·  "));

  return [
    "",
    `${brand}${" ".repeat(gap)}${version_}`,
    gradientRule(width),
    route,
    policyLine,
    c.rule("─".repeat(width)),
    hint,
    "",
  ].join("\n");
}

function flag(enabled: boolean): string {
  return enabled ? c.ok("on") : c.faint("off");
}

export function promptLabel(config: AgentConfig, role: AgentRole, forcedProvider?: string): string {
  const route =
    forcedProvider ??
    (role === "planner" ? config.plannerProvider : role === "executor" ? config.executorProvider : "auto");
  const badge = forcedProvider ? c.violet(route) : c.accent(route);
  return `${c.faint(role)}${c.rule("/")}${badge} ${c.accent("❯")} `;
}

// --- run rendering -----------------------------------------------------------

/** Header printed above a model reply. */
export function replyHeader(provider: string, model?: string): string {
  const bits = [c.accentDim("◆"), c.bold(c.accent(provider))];
  if (model && model !== provider) bits.push(c.rule("·"), c.faint(model));
  return bits.join(" ");
}

/** Model reply, markdown-rendered inside an accent gutter. */
export function renderReply(text: string): string {
  const width = termWidth();
  const body = renderMarkdown(text.trim(), width - 2);
  return body
    .split("\n")
    .map(line => `${c.accentDim("▏")} ${line}`)
    .join("\n");
}

export function renderToolStart(name: string, args: Record<string, unknown>): string {
  return `${c.rule("├─")} ${c.violet(name)} ${c.faint(truncate(summarizeArgs(args), Math.max(20, termWidth() - displayWidth(name) - 12)))}`;
}

export function renderToolEnd(name: string, ok: boolean, ms: number, preview: string): string {
  const mark = ok ? c.ok("✓") : c.err("✗");
  const head = `${c.rule("│ ")}${mark} ${c.faint(formatDuration(ms))}`;
  const detail = preview ? ` ${c.rule("·")} ${c.faint(truncate(preview, Math.max(20, termWidth() - 24)))}` : "";
  return `${head}${detail}`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      const rendered = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${truncate(String(rendered ?? ""), 48)}`;
    })
    .join(" ");
}

/** Footer summarizing a completed run: route, turns, timing, tokens, cost. */
export function runFooter(options: {
  provider: string;
  role: string;
  turns: number;
  ms: number;
  usage?: TokenUsage;
}): string {
  const bits = [
    `${c.faint("via")} ${c.accent(options.provider)}`,
    `${c.faint("role")} ${c.text(options.role)}`,
    `${c.faint("turns")} ${c.text(String(options.turns))}`,
    `${c.faint("took")} ${c.text(formatDuration(options.ms))}`,
  ];
  const usage = options.usage;
  if (usage && Object.keys(usage).length > 0) {
    const tokens: string[] = [];
    if (usage.input) tokens.push(`${c.faint("in")} ${c.text(compactNumber(usage.input))}`);
    if (usage.output) tokens.push(`${c.faint("out")} ${c.text(compactNumber(usage.output))}`);
    if (usage.thinking) tokens.push(`${c.faint("think")} ${c.violet(compactNumber(usage.thinking))}`);
    if (usage.cacheRead) tokens.push(`${c.faint("cache")} ${c.ok(compactNumber(usage.cacheRead))}`);
    if (usage.costUsd) tokens.push(`${c.faint("$")}${c.warn(usage.costUsd.toFixed(4))}`);
    if (tokens.length > 0) bits.push(tokens.join(" "));
  }
  const line = bits.join(c.rule("  ·  "));
  return `${c.rule("╰")}${c.rule("─ ")}${line}`;
}

// --- approval ----------------------------------------------------------------

/** The block drawn above an approval prompt: what is about to run, and why we are asking. */
export function renderApprovalRequest(request: {
  tool: string;
  tier: string;
  summary: string;
  concerns: string[];
}): string {
  const width = Math.min(termWidth(), 88);
  const badge = request.concerns.length > 0 ? c.err(" REVIEW ") : c.warn(" APPROVE ");
  const lines = [
    "",
    `${c.reverse(badge)} ${c.bold(c.text(request.tool))} ${c.faint(`(${request.tier})`)}`,
    `${c.rule("│")} ${c.text(truncate(request.summary, width - 4))}`,
  ];
  for (const concern of request.concerns) {
    lines.push(`${c.err("│")} ${c.err("!")} ${c.muted(truncate(concern, width - 6))}`);
  }
  return lines.join("\n");
}

export function approvalPromptLabel(): string {
  return [
    `${c.rule("│")} ${c.accent("y")} ${c.faint("run once")}`,
    `${c.accent("a")} ${c.faint("always this tool")}`,
    `${c.accent("n")} ${c.faint("skip")}`,
    `${c.accent("d")} ${c.faint("never this tool")}`,
  ].join(c.rule("  ·  ")) + `\n${c.accent("❯")} `;
}

// --- shell escape ------------------------------------------------------------

/** Header printed above the live output of a `!command` shell escape. */
export function renderShellCommand(command: string): string {
  return `${c.rule("╭─")} ${c.violet("!")} ${c.bold(c.text(command))}`;
}

/** Footer with the exit status of a shell escape. */
export function renderShellExit(result: { code: number; ms: number; timedOut?: boolean; aborted?: boolean }): string {
  const ok = result.code === 0 && !result.timedOut && !result.aborted;
  const mark = ok ? c.ok("✓") : c.err("✗");
  const note = result.timedOut ? ` ${c.rule("·")} ${c.warn("timed out")}` : result.aborted ? ` ${c.rule("·")} ${c.warn("cancelled")}` : "";
  const code = ok ? c.faint("exit 0") : c.err(`exit ${result.code}`);
  return `${c.rule("╰─")} ${mark} ${code} ${c.rule("·")} ${c.faint(formatDuration(result.ms))}${note}`;
}

/**
 * Line-buffered writer for streamed command output. Chunks arrive on arbitrary
 * boundaries, so partial lines are held back until their newline lands; that
 * keeps the gutter aligned and leaves the program's own coloring intact.
 */
export function createShellStreamWriter(write: (text: string) => void): {
  push(stream: "stdout" | "stderr", text: string): void;
  flush(): void;
} {
  const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  const gutter = (stream: "stdout" | "stderr") => (stream === "stderr" ? c.err("│") : c.rule("│"));
  return {
    push(stream, text) {
      const lines = (buffers[stream] + text).split("\n");
      buffers[stream] = lines.pop() ?? "";
      for (const line of lines) write(`${gutter(stream)} ${line}\n`);
    },
    flush() {
      for (const stream of ["stdout", "stderr"] as const) {
        if (!buffers[stream]) continue;
        write(`${gutter(stream)} ${buffers[stream]}\n`);
        buffers[stream] = "";
      }
    },
  };
}

export function renderError(message: string): string {
  const width = termWidth();
  return message
    .split("\n")
    .flatMap(line => (line ? [line] : [""]))
    .map((line, index) => `${c.err("▏")} ${index === 0 ? c.err(truncate(line, width - 2)) : c.muted(truncate(line, width - 2))}`)
    .join("\n");
}

export function renderNotice(message: string): string {
  return `${c.accentDim("▏")} ${c.muted(message)}`;
}

/**
 * Theme picker. Each row is painted in the theme it describes, so the swatches
 * are the actual palette rather than a legend — briefly switching the active
 * theme is the only way to render another theme's colors.
 */
export function themePicker(): string {
  const active = currentTheme();
  const width = Math.max(...THEME_NAMES.map(name => displayWidth(name)));
  const rows = THEME_NAMES.map(name => {
    setTheme(name);
    const mark = name === active ? c.accent("●") : c.faint("○");
    const swatch = [c.accent("██"), c.violet("██"), c.ok("█"), c.warn("█"), c.err("█"), c.muted("█"), c.rule("█")].join("");
    const label = name === active ? c.bold(c.accent(padEnd(name, width))) : c.text(padEnd(name, width));
    return `  ${mark} ${label}  ${swatch}  ${c.faint(THEME_BLURBS[name])}`;
  });
  setTheme(active); // restore before returning
  return ["", c.bold(c.accent("THEMES")), gradientRule(Math.min(termWidth(), 46)), ...rows, "", `  ${c.faint("switch with")} ${c.accent("/theme <name>")}`, ""].join("\n");
}

// --- tables ------------------------------------------------------------------

function table(title: string, headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map(row => displayWidth(row[index] ?? ""))),
  );
  const head = headers.map((header, index) => c.faint(padEnd(header.toUpperCase(), widths[index]))).join("  ");
  const body = rows.map(row => row.map((cell, index) => padEnd(cell, widths[index])).join("  "));
  return [
    "",
    `${c.bold(c.accent(title))}`,
    gradientRule(Math.min(termWidth(), Math.max(20, displayWidth(head) + 2))),
    head,
    ...body,
    "",
  ].join("\n");
}

export function formatProviders(config: AgentConfig): string {
  const rows = Object.entries(config.providers).map(([name, provider]) => {
    const role =
      name === config.plannerProvider && name === config.executorProvider
        ? c.violet("plan+exec")
        : name === config.plannerProvider
          ? c.accent("planner")
          : name === config.executorProvider
            ? c.violet("executor")
            : c.faint("–");
    const kind = provider.type === "cli-tmux" ? c.ok(provider.type) : c.faint(provider.type);
    const effort = provider.reasoningEffort ? c.warn(provider.reasoningEffort) : c.faint("–");
    return [c.text(name), role, kind, c.muted(provider.model), effort];
  });
  return table("PROVIDERS", ["name", "role", "kind", "model", "effort"], rows);
}

export function formatTools(tools: AgentTool[]): string {
  const rows = tools.map(tool => [c.text(tool.name), riskBadge(tool.risk), c.muted(tool.description)]);
  return table("TOOLS", ["tool", "risk", "description"], rows);
}

export function formatSessions(
  sessions: Array<{ id: string; updatedAt: Date; messages: number; workspace?: string; firstPrompt?: string }>,
  now = new Date(),
): string {
  if (sessions.length === 0) return `\n${c.faint("  no sessions recorded yet")}\n\n`;
  const rows = sessions.map(session => [
    c.text(session.id.replace(/-0xaf$/, "")),
    c.faint(ago(now.getTime() - session.updatedAt.getTime())),
    c.violet(String(session.messages)),
    c.muted(truncate(session.firstPrompt ?? session.workspace ?? "–", 52)),
  ]);
  return `${table("SESSIONS", ["id", "age", "msgs", "opened with"], rows)}${c.faint("  resume with")} ${c.accent("/resume <id>")} ${c.faint("or")} ${c.accent("--resume <id>")}\n\n`;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatMcp(
  connections: Array<{ name: string; error?: string; tools: AgentTool[]; client?: { status: string } }>,
): string {
  if (connections.length === 0) {
    return `\n${c.faint('  no MCP servers configured — add an "mcpServers" block to agent.config.json')}\n\n`;
  }
  const rows = connections.map(connection => [
    c.text(connection.name),
    connection.error ? c.err("○ failed") : connection.client?.status === "ready" ? c.ok("● ready") : c.warn(`○ ${connection.client?.status ?? "unknown"}`),
    c.violet(String(connection.tools.length)),
    c.muted(truncate(connection.error ?? toolNameList(connection.tools), 60)),
  ]);
  return table("MCP SERVERS", ["server", "state", "tools", "detail"], rows);
}

/** Server-qualified prefixes are noise in this table; show the bare tool names. */
function toolNameList(tools: AgentTool[]): string {
  const names = tools.map(tool => tool.name.replace(/^mcp__.*?__/, ""));
  return names.join(", ") || "–";
}

export function formatAuthStatus(statuses: AuthStatus[]): string {
  const rows = statuses.map(status => [
    c.text(status.provider),
    status.configured ? c.ok("● ready") : c.err("○ missing"),
    c.muted(status.source),
    c.faint(status.envVars.join(", ") || "–"),
  ]);
  return table("AUTH", ["provider", "state", "source", "env"], rows);
}

function riskBadge(risk: AgentTool["risk"]): string {
  if (risk === "read") return c.ok("read");
  if (risk === "write") return c.warn("write");
  if (risk === "network") return c.err("network");
  return c.violet("exec");
}

// --- help --------------------------------------------------------------------

interface HelpEntry {
  command: string;
  args?: string;
  description: string;
}

interface SlashCompletionItem {
  value: string;
  args?: string;
  description: string;
  replacement: string;
  kind: "command" | "argument";
}

export const SLASH_COMMAND_SECTIONS: Array<{ title: string; entries: HelpEntry[] }> = [
  {
    title: "session",
    entries: [
      { command: "/", description: "Show executable slash commands" },
      { command: "/welcome", description: "Show guided first-run demos" },
      { command: "/help", description: "Show this deck" },
      { command: "/clear", description: "Clear the screen and redraw the banner" },
      { command: "/theme", args: "[name]", description: "Switch palette (deck/amber/matrix/mono)" },
      { command: "/flow", args: "[full|flow|trace|off]", description: "Live dataflow diagram and trace lines" },
      { command: "/context", description: "Show the context estimate against the budget" },
      { command: "/compact", args: "[provider]", description: "Fold the session into a summary and free context" },
      { command: "/session", description: "Print the JSONL transcript path" },
      { command: "/sessions", description: "List recent sessions" },
      { command: "/resume", args: "[id]", description: "Load a previous session's history" },
      { command: "/policy", description: "Show the active safety policy" },
      { command: "/approval", args: "[mode|tool <n> allow|deny]", description: "Show or change tool approval (yolo/write/always-ask)" },
      { command: "/exit", description: "Quit" },
      { command: "/quit", description: "Quit" },
    ],
  },
  {
    title: "routing",
    entries: [
      { command: "/role", args: "planner|executor|auto", description: "Pick which side of the deck answers" },
      { command: "/agent", args: "<name>|auto", description: "Pin one provider for the next prompts" },
      { command: "/planner", args: "<name>", description: "Set the planner provider" },
      { command: "/executor", args: "<name>", description: "Set the executor provider" },
      { command: "/effort", args: "<provider> <level>", description: "Set reasoning effort (minimal…max)" },
      { command: "/providers", description: "List configured providers" },
    ],
  },
  {
    title: "auth",
    entries: [
      { command: "/auth", description: "Show credential status" },
      { command: "/status", description: "Show credential status" },
      { command: "/login", args: "<provider>", description: "Store an API key locally" },
      { command: "/logout", args: "<provider>", description: "Remove a stored credential" },
    ],
  },
  {
    title: "direct tools",
    entries: [
      { command: "/tools", description: "List reverse/CTF tools" },
      { command: "/mcp", description: "Show MCP servers and the tools they contribute" },
      { command: "/scan", args: "<path>", description: "Fast CTF triage on an artifact or directory" },
      { command: "/mitigations", args: "<binary>", description: "Summarize native binary protections" },
      { command: "/entropy", args: "<file>", description: "Sliding-window entropy scan" },
      { command: "/findbytes", args: "<file> <needle>", description: "Find text/hex offsets with context" },
      { command: "/carve", args: "<file>", description: "Locate embedded file signatures" },
      { command: "/apk", args: "<apk>", description: "Inspect APK structure and packer/framework hints" },
      { command: "/decode", args: "[mode] <input>", description: "Decode base64/hex/url/rot13/xor candidates" },
      { command: "/hook", args: "[java|native|objc] <target>", description: "Generate a Frida hook scaffold" },
      { command: "/plan", description: "Reprint the current task list" },
      { command: "/read", args: "<path>", description: "Read a file without the model" },
      { command: "/run", args: "<command>", description: "Run a local command without the model" },
    ],
  },
  {
    title: "skills & knowledge",
    entries: [
      { command: "/skills", description: "List built-in reverse engineering skills" },
      { command: "/skill", args: "<name> [task]", description: "Show or force a built-in skill workflow" },
      { command: "/know", args: "<query>", description: "Answer from imported reverse knowledge, with sources" },
      { command: "/know raw", args: "<query>", description: "Raw index hits, no model call" },
      { command: "/know read", args: "<id>", description: "Read one knowledge entry in full" },
    ],
  },
];

export function helpText(): string {
  const out: string[] = ["", `${c.bold(c.accent("0xAF"))} ${c.faint("command deck")}`, gradientRule(Math.min(termWidth(), 52))];
  const width = Math.max(
    ...SLASH_COMMAND_SECTIONS.flatMap(section =>
      section.entries.map(entry => displayWidth(`${entry.command} ${entry.args ?? ""}`.trim())),
    ),
  );
  for (const section of SLASH_COMMAND_SECTIONS) {
    out.push("", c.faint(section.title.toUpperCase()));
    for (const entry of section.entries) {
      const label = `${c.accent(entry.command)}${entry.args ? ` ${c.violet(entry.args)}` : ""}`;
      out.push(`  ${padEnd(label, width + 2)}${c.muted(entry.description)}`);
    }
  }
  out.push(
    "",
    c.faint("SHELL"),
    `  ${padEnd(`${c.violet("!")}${c.accent("<command>")}`, width + 2)}${c.muted("Run a shell command in the workspace; its output is shared with the agent")}`,
    `  ${padEnd(c.faint("e.g. !ls -la"), width + 2)}${c.muted("Same policy as run_command · ^C cancels")}`,
  );
  out.push(
    "",
    c.faint("CLI"),
    `  ${c.muted("bun src/cli.ts --welcome")}`,
    `  ${c.muted("bun src/cli.ts --workspace ./ctf")}`,
    `  ${c.muted("bun src/cli.ts -p \"triage ./chall\" --role planner")}`,
    `  ${c.muted("bun src/cli.ts --agent claude --effort high -p \"...\"")}`,
    `  ${c.muted("bun src/cli.ts auth status")}`,
    "",
  );
  return `${out.join("\n")}\n`;
}

// --- completion --------------------------------------------------------------

const SLASH_COMMAND_ENTRIES = SLASH_COMMAND_SECTIONS.flatMap(section => section.entries);
export const SLASH_COMMANDS = SLASH_COMMAND_ENTRIES.map(entry => entry.command);

const ROLES = ["planner", "executor", "auto"];
const PROVIDER_ARG_COMMANDS = new Set(["/planner", "/executor", "/login", "/logout"]);

export function slashCompletions(line: string, providerNames: string[], skillNames: string[] = []): SlashCompletionItem[] {
  if (!line.startsWith("/")) return [];
  const hasTrailingSpace = /\s$/.test(line);
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commandCompletions("/", true);

  if (words.length === 1 && !hasTrailingSpace) {
    return commandCompletions(words[0], true);
  }

  const command = words[0];
  const fragment = hasTrailingSpace ? "" : words[words.length - 1] ?? "";
  const head = hasTrailingSpace ? line.trimEnd() : words.slice(0, -1).join(" ");
  const argIndex = hasTrailingSpace ? words.length : words.length - 1;
  const pool = argumentPool(command, argIndex, providerNames, skillNames);
  if (pool.length === 0) return [];
  const hits = pool.filter(item => item.value.startsWith(fragment));
  return (hits.length > 0 ? hits : pool).map(item => ({
    ...item,
    replacement: `${head} ${item.value}`,
    kind: "argument",
  }));
}

function commandCompletions(fragment: string, allowFallback: boolean): SlashCompletionItem[] {
  const hits = SLASH_COMMAND_ENTRIES.filter(entry => entry.command.startsWith(fragment));
  const entries = hits.length > 0 ? hits : allowFallback ? SLASH_COMMAND_ENTRIES : [];
  return entries.map(entry => ({
    value: entry.command,
    args: entry.args,
    description: entry.description,
    replacement: entry.command === "/" ? "/" : `${entry.command} `,
    kind: "command",
  }));
}

function argumentPool(command: string, argIndex: number, providerNames: string[], skillNames: string[]): Array<Omit<SlashCompletionItem, "replacement" | "kind">> {
  if (argIndex !== 1 && command !== "/effort") return [];
  if (command === "/theme") return THEME_NAMES.map(value => ({ value, description: "theme" }));
  if (command === "/flow") return VIZ_MODES.map(value => ({ value, description: "visualization" }));
  if (command === "/role") return ROLES.map(value => ({ value, description: "role" }));
  if (command === "/agent") return ["auto", ...providerNames].map(value => ({ value, description: "provider" }));
  if (command === "/skill") return skillNames.map(value => ({ value, description: "built-in skill" }));
  if (PROVIDER_ARG_COMMANDS.has(command)) return providerNames.map(value => ({ value, description: "provider" }));
  if (command === "/effort") {
    if (argIndex === 1) return providerNames.map(value => ({ value, description: "provider" }));
    if (argIndex === 2) return REASONING_EFFORTS.map(value => ({ value, description: "reasoning effort" }));
  }
  return [];
}

export function formatSlashCommandPalette(
  line: string,
  providerNames: string[],
  options: { limit?: number; skillNames?: string[] } = {},
): string {
  const items = slashCompletions(line, providerNames, options.skillNames ?? []);
  const limit = options.limit ?? 12;
  const visible = items.slice(0, limit);
  const title = items.some(item => item.kind === "argument") ? "ARGUMENTS" : "COMMANDS";
  const width = Math.min(termWidth(), 88);
  const maxLabelWidth = Math.min(
    32,
    Math.max(10, ...visible.map(item => displayWidth(completionLabelText(item)))),
  );
  const rows = visible.map(item => {
    const label = formatCompletionLabel(item, maxLabelWidth);
    const padded = padEnd(label, maxLabelWidth + 2);
    const descriptionWidth = Math.max(12, width - maxLabelWidth - 6);
    return `  ${padded}${c.muted(truncate(item.description, descriptionWidth))}`;
  });
  if (items.length > visible.length) {
    rows.push(`  ${c.faint(`+${items.length - visible.length} more; keep typing or press TAB`)}`);
  }
  if (rows.length === 0) rows.push(`  ${c.faint("No argument suggestions for this command")}`);
  rows.push(`  ${c.faint("Enter runs command · TAB completes")}`);
  return [`${c.bold(c.accent(title))}`, gradientRule(Math.min(width, 52)), ...rows].join("\n");
}

function completionLabelText(item: SlashCompletionItem): string {
  return `${item.value}${item.args ? ` ${item.args}` : ""}`;
}

function formatCompletionLabel(item: SlashCompletionItem, width: number): string {
  if (!item.args) return c.accent(truncate(item.value, width));
  const commandWidth = displayWidth(item.value);
  if (commandWidth + 1 >= width) return c.accent(truncate(item.value, width));
  return `${c.accent(item.value)} ${c.violet(truncate(item.args, width - commandWidth - 1))}`;
}

/**
 * readline completer for slash commands and their arguments. Returns whole-line
 * replacements, and appends a trailing space after a bare command so the next
 * token does not glue onto it.
 */
export function buildCompleter(providerNames: string[], skillNames: string[] = []): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    if (!line.startsWith("/")) return [[], line];
    return [slashCompletions(line, providerNames, skillNames).map(item => item.replacement), line];
  };
}
