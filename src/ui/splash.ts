// Startup sequence: a block-letter logo plus a self-check panel. Every line in
// the panel is a real probe (runtime, tmux, workspace artifacts, provider auth,
// tool inventory) rather than decoration — the boot screen doubles as the
// answer to "is this thing actually wired up right now?".

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentConfig, AgentTool, ExecutionPolicy } from "../types";
import type { AuthStatus } from "../auth";
import { c, elidePath, fade, gradientRule, padEnd, terminalColumns, termWidth, truncate } from "./theme";

const LOGO = [
  " ██████ ██   ██  █████  ███████",
  "██  ██████ ██   ██   ██ ██     ",
  "██ ██ ██  ███   ███████ █████  ",
  "████  ██ ██ ██  ██   ██ ██     ",
  " ██████ ██   ██ ██   ██ ██     ",
];

export interface SystemInfo {
  runtime: string;
  platform: string;
  tmux: string;
}

export interface WorkspaceInfo {
  path: string;
  files: number;
  dirs: number;
  binaries: string[];
}

export interface SplashContext {
  config: AgentConfig;
  policy: ExecutionPolicy;
  sessionFile: string;
  version: string;
  tools: AgentTool[];
  system: SystemInfo;
  workspace: WorkspaceInfo;
  auth?: AuthStatus[];
}

// --- probes ------------------------------------------------------------------

export function probeSystem(): Promise<SystemInfo> {
  const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.versions.node}`;
  const platform = `${process.platform} ${process.arch}`;
  return probeTmux().then(tmux => ({ runtime, platform, tmux }));
}

async function probeTmux(): Promise<string> {
  try {
    const child = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "ignore" });
    const status = await Promise.race([child.exited, Bun.sleep(1500).then(() => 124)]);
    if (status !== 0) {
      child.kill();
      return "missing";
    }
    const text = (await new Response(child.stdout).text()).trim();
    return text.replace(/^tmux\s*/, "") || "present";
  } catch {
    return "missing";
  }
}

const MAGIC: Array<{ kind: string; bytes: number[] }> = [
  { kind: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { kind: "PE", bytes: [0x4d, 0x5a] },
  { kind: "Mach-O", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { kind: "Mach-O", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { kind: "Mach-O", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { kind: "ZIP/APK", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: "DEX", bytes: [0x64, 0x65, 0x78, 0x0a] },
  { kind: "WASM", bytes: [0x00, 0x61, 0x73, 0x6d] },
];

/** Shallow workspace triage: file counts plus magic-byte sniffing of artifacts. */
export async function probeWorkspace(workspace: string): Promise<WorkspaceInfo> {
  const info: WorkspaceInfo = { path: workspace, files: 0, dirs: 0, binaries: [] };
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(workspace, { withFileTypes: true });
  } catch {
    return info;
  }
  const kinds = new Map<string, number>();
  let sniffed = 0;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      info.dirs++;
      continue;
    }
    if (!entry.isFile()) continue;
    info.files++;
    if (sniffed >= 24) continue; // keep startup cheap on large workspaces
    sniffed++;
    const kind = await sniff(path.join(workspace, entry.name));
    if (kind) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  info.binaries = [...kinds.entries()].map(([kind, count]) => (count > 1 ? `${count} ${kind}` : kind));
  return info;
}

async function sniff(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    for (const entry of MAGIC) {
      if (entry.bytes.length > bytesRead) continue;
      if (entry.bytes.every((byte, index) => buffer[index] === byte)) return entry.kind;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// --- rendering ---------------------------------------------------------------

export function renderLogo(version: string): string[] {
  const rows = LOGO.map((row, index) => `  ${fade("accent", "accentDim", index / (LOGO.length - 1), row)}`);
  const tag = `  ${c.faint("reverse ops deck")}  ${c.rule("·")}  ${c.faint(`v${version}`)}`;
  return [...rows, tag];
}

/** The self-check panel. `auth` may be omitted while the probe is still running. */
export function renderPanel(ctx: SplashContext): string[] {
  const out: string[] = [];
  const label = (text: string) => c.faint(padEnd(text, 10));
  const branch = (text: string) => `  ${c.rule("│")} ${text}`;
  const section = (title: string) => `  ${c.rule("├─")} ${c.bold(c.accent(title))}`;

  out.push(`  ${c.rule("┌─")} ${c.bold(c.accent("SYSTEM"))}`);
  out.push(branch(`${label("runtime")}${c.text(ctx.system.runtime)} ${c.rule("·")} ${c.muted(ctx.system.platform)}`));
  out.push(
    branch(
      `${label("tmux")}${ctx.system.tmux === "missing" ? c.warn("missing (direct fallback)") : c.ok(ctx.system.tmux)}`,
    ),
  );

  const artifacts = ctx.workspace.binaries.length > 0 ? ctx.workspace.binaries.join(", ") : "no binaries detected";
  out.push(section("WORKSPACE"));
  out.push(branch(`${label("path")}${c.text(elidePath(ctx.workspace.path, 40))}`));
  out.push(
    branch(
      `${label("contents")}${c.text(`${ctx.workspace.files} files`)} ${c.rule("·")} ${c.text(`${ctx.workspace.dirs} dirs`)} ${c.rule("·")} ${ctx.workspace.binaries.length > 0 ? c.violet(artifacts) : c.faint(artifacts)}`,
    ),
  );

  out.push(section("ROUTE"));
  for (const [role, name] of [
    ["plan", ctx.config.plannerProvider],
    ["exec", ctx.config.executorProvider],
  ] as const) {
    const provider = ctx.config.providers[name];
    const status = ctx.auth?.find(entry => entry.provider === name);
    const state = !ctx.auth
      ? c.faint("checking…")
      : status?.configured
        ? c.ok("● ready")
        : c.err("○ not authenticated");
    const effort = provider?.reasoningEffort ? ` ${c.rule("·")} ${c.warn(provider.reasoningEffort)}` : "";
    out.push(branch(`${label(role)}${c.accent(padEnd(name, 12))}${state}${effort}`));
  }

  const risks = ctx.tools.reduce<Record<string, number>>((acc, tool) => {
    acc[tool.risk] = (acc[tool.risk] ?? 0) + 1;
    return acc;
  }, {});
  const riskText = Object.entries(risks)
    .map(([risk, count]) => `${c.faint(risk)} ${c.text(String(count))}`)
    .join(c.rule(" · "));
  out.push(section("ARSENAL"));
  out.push(branch(`${label("tools")}${c.text(String(ctx.tools.length))} ${c.rule("·")} ${riskText}`));

  const flags = [
    flagText("write", ctx.policy.allowWrites),
    flagText("net", ctx.policy.allowNetwork),
    flagText("sensitive", ctx.policy.allowSensitive),
  ].join(c.rule(" · "));
  out.push(`  ${c.rule("└─")} ${c.faint("policy")} ${flags} ${c.rule("·")} ${c.faint("log")} ${c.faint(elidePath(ctx.sessionFile, 24))}`);
  return out;
}

function flagText(name: string, enabled: boolean): string {
  return `${c.faint(name)} ${enabled ? c.ok("on") : c.muted("off")}`;
}

export function renderHint(): string {
  return [
    `  ${c.accent("/welcome")} ${c.faint("demos")}`,
    `${c.accent("/help")} ${c.faint("commands")}`,
    `${c.accent("!cmd")} ${c.faint("shell")}`,
    `${c.accent("/flow")} ${c.faint("dataflow")}`,
    `${c.accent("TAB")} ${c.faint("complete")}`,
    `${c.accent("↑↓")} ${c.faint("history")}`,
    `${c.accent("/theme")} ${c.faint("palette")}`,
    `${c.accent("^C")} ${c.faint("cancel")}`,
  ].join(c.rule("  ·  "));
}

/** Complete splash as one string, no animation. Used by /clear and /theme. */
export function renderSplash(ctx: SplashContext): string {
  return [
    "",
    ...renderLogo(ctx.version),
    "",
    ...renderPanel(ctx),
    "",
    gradientRule(Math.min(termWidth(), 64)),
    renderHint(),
    "",
  ].join("\n");
}

/**
 * Animated boot. Reveals the logo scanline-style while the auth probe runs in
 * the background, then fills in the panel. Falls back to a single write when
 * stdout is not a TTY so piped output stays clean.
 */
export async function playSplash(
  base: Omit<SplashContext, "auth">,
  authProbe: Promise<AuthStatus[] | undefined>,
): Promise<AuthStatus[] | undefined> {
  if (!process.stdout.isTTY) {
    const auth = await authProbe;
    process.stdout.write(renderSplash({ ...base, auth }));
    return auth;
  }

  process.stdout.write("\x1b[?25l"); // hide cursor during the reveal
  try {
    process.stdout.write("\n");
    for (const row of renderLogo(base.version)) {
      process.stdout.write(`${row}\n`);
      await Bun.sleep(45);
    }
    process.stdout.write("\n");

    // Draw the panel with auth pending, then repaint those rows once the probe
    // lands. Lines are clipped to the terminal width so each occupies exactly
    // one row — otherwise a wrapped line desyncs the cursor-up count below.
    const fit = (line: string) => truncate(line, terminalColumns() - 1);
    const pending = renderPanel({ ...base, auth: undefined });
    for (const line of pending) {
      process.stdout.write(`${fit(line)}\n`);
      await Bun.sleep(22);
    }

    const auth = await authProbe;
    const settled = renderPanel({ ...base, auth });
    process.stdout.write(`\x1b[${settled.length}A`); // back to the panel top
    for (const line of settled) process.stdout.write(`\r\x1b[2K${fit(line)}\n`);

    process.stdout.write("\n");
    process.stdout.write(`${gradientRule(Math.min(termWidth(), 64))}\n`);
    process.stdout.write(`${renderHint()}\n\n`);
    return auth;
  } finally {
    process.stdout.write("\x1b[?25h");
  }
}
