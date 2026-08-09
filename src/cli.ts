#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  credentialStatuses,
  initializeAuthSources,
  loginProvider,
  logoutProvider,
  promptSecret,
} from "./auth";
import { loadConfig, loadUiPrefs, saveUiPrefs, setReasoningEffort } from "./config";
import { AgentLoop, DEFAULT_CONTEXT_BUDGET_TOKENS } from "./core/agent-loop";
import { JsonlSession, listSessions, loadSession, resolveSession } from "./core/session";
import {
  assertShellCommandAllowed,
  isShellEscape,
  parseShellEscape,
  runShellCommand,
  shellContextMessage,
} from "./core/shell";
import { findBuiltInSkill, formatSkillList, loadBuiltInSkills, skillSystemPrompt, skillTurnPrompt } from "./skills";
import { createProvider } from "./providers";
import { REASONING_EFFORTS } from "./types";
import { isThemeName, THEME_NAMES } from "./ui";
import type { ThemeName, VizMode } from "./ui";
import type { AgentConfig, AgentRole, AgentTool, ApprovalMode, ExecutionPolicy, ReasoningEffort, ToolContext } from "./types";
import { APPROVAL_MODES, ApprovalDeniedError, DEFAULT_APPROVAL_MODE, isApprovalMode } from "./security/approval";
import { createReverseTools } from "./tools/reverse-tools";
import { connectMcpServers } from "./mcp/tools";
import type { McpConnection } from "./mcp/tools";
import {
  approvalPromptLabel,
  banner,
  createFlowModel,
  buildCompleter,
  c,
  createLivePane,
  createShellStreamWriter,
  formatAuthStatus,
  formatDuration,
  formatMcp,
  formatSessions,
  formatSlashCommandPalette,
  formatProviders,
  formatTools,
  helpText,
  promptLabel,
  renderApprovalRequest,
  renderError,
  renderNotice,
  renderPlan,
  renderReply,
  renderShellCommand,
  renderShellExit,
  renderToolEnd,
  renderToolStart,
  replyHeader,
  runFooter,
  playSplash,
  probeSystem,
  probeWorkspace,
  renderSplash,
  setTheme,
  themePicker,
  thinkingSummary,
  traceEnd,
  traceEvent,
  VIZ_MODES,
  isVizMode,
  welcomeText,
} from "./ui";
import type { SplashContext } from "./ui";
import { displayWidth, termWidth } from "./ui/theme";
import type { LoopEvent } from "./core/agent-loop";
import { formatError, isAbortError, readTextIfExists, textBlock, textFromBlocks } from "./utils";
import {
  buildKnowledgePrompt,
  formatKnowledgeAnswer,
  formatKnowledgeMatches,
  KNOWLEDGE_SYSTEM_PROMPT,
  packKnowledgeContext,
  parseKnowledgeAnswer,
  readKnowledgeEntry,
  readKnowledgeText,
  searchKnowledge,
} from "./knowledge";
import type { BuiltInSkill } from "./skills";

interface CliArgs {
  config?: string;
  workspace: string;
  sessionDir: string;
  role?: AgentRole;
  provider?: string;
  planner?: string;
  executor?: string;
  prompt?: string;
  print: boolean;
  smoke: boolean;
  welcome: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  allowSensitive: boolean;
  maxOutputChars?: number;
  approvalMode?: ApprovalMode;
  viz?: VizMode;
  /** `--resume [id]` / `--continue`: "" means "most recent", a value means that session. */
  resume?: string;
  listSessions: boolean;
  effort?: ReasoningEffort;
  theme?: ThemeName;
  authCommand?: { action: "login" | "status" | "logout"; provider?: string };
}

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Theme first: everything rendered afterwards (banner, errors) uses it.
  const prefs = await loadUiPrefs();
  const startupTheme = args.theme ?? (prefs.theme && isThemeName(prefs.theme) ? prefs.theme : undefined);
  if (startupTheme) setTheme(startupTheme);
  const { config, path: configPath } = await loadConfig(args.config);
  if (args.planner) config.plannerProvider = args.planner;
  if (args.executor) config.executorProvider = args.executor;
  if (args.effort) {
    // Applies to whichever providers this invocation can actually route to.
    const targets = args.provider
      ? [args.provider]
      : [...new Set([config.plannerProvider, config.executorProvider])];
    for (const name of targets) {
      const provider = config.providers[name];
      if (provider) setReasoningEffort(provider, args.effort);
    }
  }

  if (args.welcome) {
    process.stdout.write(welcomeText({ config, workspace: path.resolve(args.workspace), demoWorkspace: demoWorkspacePath() }));
    return;
  }

  await initializeAuthSources(config, path.resolve(args.workspace));

  if (args.smoke) {
    config.plannerProvider = "mock";
    config.executorProvider = "mock";
    config.defaultRole = "auto";
  }

  if (args.authCommand) {
    await handleAuthCli(args.authCommand, config);
    return;
  }

  const workspace = path.resolve(args.workspace);
  const sessionDir = path.resolve(args.sessionDir);
  const builtInSkills = await loadBuiltInSkills();
  const systemPrompt = `${await loadSystemPrompt()}${skillSystemPrompt(builtInSkills)}`;
  const policy: ExecutionPolicy = {
    allowWrites: args.allowWrites,
    allowNetwork: args.allowNetwork,
    allowSensitive: args.allowSensitive,
    commandTimeoutMs: 30_000,
    maxReadBytes: 128 * 1024,
    maxToolOutputChars: args.maxOutputChars ?? 24_000,
    // `safe` keeps the old behaviour for scripts (dangerous commands refused)
    // while letting an attended REPL answer the question instead.
    approvalMode: args.approvalMode ?? DEFAULT_APPROVAL_MODE,
    approvals: {},
  };

  const providers = new Map(
    Object.entries(config.providers).map(([name, providerConfig]) => [name, createProvider(name, providerConfig)]),
  );
  const tools = createReverseTools();
  // MCP servers join the same registry as the built-ins; a server that will not
  // start is reported and skipped, never fatal.
  const mcp = await connectMcpServers(config.mcpServers);
  for (const connection of mcp) {
    if (connection.error) process.stdout.write(`${renderNotice(`mcp ${connection.name}: ${connection.error}`)}\n`);
    else tools.push(...connection.tools);
  }
  process.on("exit", () => {
    for (const connection of mcp) connection.client?.close();
  });
  // Resolved before the new session file exists, or "most recent" would resolve
  // to the empty log this very run just created.
  const resumeTarget = args.resume !== undefined ? await resolveSession(sessionDir, args.resume || undefined) : undefined;
  const session = new JsonlSession(sessionDir, "0xaf");
  await session.init({
    agent: config.name,
    version: VERSION,
    workspace,
    configPath,
    plannerProvider: config.plannerProvider,
    executorProvider: config.executorProvider,
    policy,
  });

  const toolContext: ToolContext = { workspace, sessionDir, policy };
  const loop = new AgentLoop({ config, providers, tools, toolContext, systemPrompt, session });

  if (args.listSessions) {
    process.stdout.write(formatSessions(await listSessions(sessionDir)));
    return;
  }

  if (args.resume !== undefined) {
    if (!resumeTarget) {
      process.stdout.write(`${renderNotice(`No previous session found in ${sessionDir}`)}\n`);
    } else {
      const loaded = await loadSession(resumeTarget.file);
      await loop.restore(loaded.messages, loaded.plan);
      await session.appendEvent({ type: "resumed_from", file: resumeTarget.file, messages: loaded.messages.length });
      process.stdout.write(
        `${renderNotice(`resumed ${resumeTarget.id} — ${loaded.messages.length} messages, ≈${loop.contextTokens} tokens${resumeTarget.firstPrompt ? ` · started with: ${resumeTarget.firstPrompt}` : ""}`)}\n`,
      );
      // The task list came back with the history; show where the work stood.
      if (loop.plan) process.stdout.write(`${renderPlan(loop.plan).join("\n")}\n`);
    }
  }

  if (args.smoke) {
    const result = await loop.run("smoke test: identify yourself and list capabilities", { role: "auto" });
    printRunResult(result.messages);
    process.stdout.write(`\nsmoke: ok\nsession: ${session.file}\n`);
    return;
  }

  const viz: VizMode = args.viz ?? (prefs.flow && isVizMode(prefs.flow) ? prefs.flow : "full");

  const initialPrompt = args.prompt;
  if (args.print || initialPrompt) {
    if (!initialPrompt) throw new Error("--print requires a prompt.");
    const startedAt = Date.now();
    // No pane to animate in one-shot mode, but the trace is exactly what you
    // want when piping a run into a log.
    let slowest = 0;
    // Plan lines describe a transition, so they need the previous snapshot —
    // without it every update re-reports the list as freshly opened.
    let previousPlan = loop.plan;
    const result = await loop.run(initialPrompt, {
      role: args.role ?? config.defaultRole,
      providerName: args.provider,
      onEvent:
        viz === "full" || viz === "trace"
          ? event => {
              if (event.type === "wire" && event.phase === "recv") slowest = Math.max(slowest, event.ms);
              for (const traced of traceEvent(event, { startedAt, slowestMs: slowest || undefined, previousPlan })) {
                process.stdout.write(`${traced}\n`);
              }
              if (event.type === "plan") previousPlan = event.snapshot;
            }
          : undefined,
    });
    // No live pane in --print/pipe mode, so the plan is printed once, at the end.
    if (loop.plan) process.stdout.write(`${renderPlan(loop.plan).join("\n")}\n`);
    printRunResult(result.messages);
    process.stdout.write(
      `${runFooter({
        provider: result.provider,
        role: result.role,
        turns: result.turns,
        ms: Date.now() - startedAt,
        usage: result.usage,
      })}\n`,
    );
    return;
  }

  await repl({
    config,
    loop,
    session,
    tools,
    toolContext,
    role: args.role ?? config.defaultRole,
    provider: args.provider,
    builtInSkills,
    mcp,
    flow: viz,
  });
}

async function repl(state: {
  config: AgentConfig;
  loop: AgentLoop;
  session: JsonlSession;
  tools: AgentTool[];
  toolContext: ToolContext;
  role: AgentRole;
  provider?: string;
  splash?: SplashContext;
  builtInSkills: BuiltInSkill[];
  mcp?: McpConnection[];
  flow: VizMode;
}): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    // Line editing (TAB completion, ↑/↓ history) only applies to a real TTY.
    // In piped/non-interactive mode these options change input buffering and
    // must be omitted so the REPL still reads every line.
    ...(interactive
      ? {
          completer: buildCompleter(Object.keys(state.config.providers), state.builtInSkills.map(skill => skill.name)),
          terminal: true,
          historySize: 1000,
        }
      : {}),
  });
  const history = new ReplHistory();
  if (interactive) await history.load(rl);
  let slashPalette: ReturnType<typeof installSlashCommandPalette> | undefined;
  let activePrompt = "";

  // Auth is probed concurrently with the logo reveal so the boot screen costs
  // roughly nothing beyond the animation itself.
  const base = {
    config: state.config,
    policy: state.toolContext.policy,
    sessionFile: state.session.file,
    version: VERSION,
    tools: state.tools,
    system: await probeSystem(),
    workspace: await probeWorkspace(state.toolContext.workspace),
  };
  const auth = await playSplash(base, credentialStatuses(state.config).catch(() => undefined));
  state.splash = { ...base, auth };
  try {
    slashPalette = interactive
      ? installSlashCommandPalette(
          rl,
          () => Object.keys(state.config.providers),
          () => state.builtInSkills.map(skill => skill.name),
          () => activePrompt,
        )
      : undefined;
    while (true) {
      const prompt = promptLabel(state.config, state.role, state.provider);
      activePrompt = prompt;
      const rawLine = await questionOrEof(rl, prompt);
      slashPalette?.clear();
      activePrompt = "";
      if (rawLine === undefined) return;
      const line = rawLine.trim();
      if (!line) continue;
      await history.append(line);
      if (line === "/exit" || line === "/quit") return;
      if (isShellEscape(line)) {
        // A failing or refused command is normal here; report and keep the REPL.
        try {
          await runShellEscape(state, line, rl);
        } catch (error) {
          if (error instanceof ApprovalDeniedError) {
            process.stdout.write(`${renderNotice(`not run — ${error.message}`)}\n\n`);
          } else {
            process.stdout.write(`${renderError(formatError(error))}\n\n`);
          }
        }
        continue;
      }
      if (line.startsWith("/")) {
        // Command errors must never end the session: a typo in /read or an
        // unknown provider should report and return to the prompt.
        try {
          await handleCommand(line, state);
        } catch (error) {
          process.stdout.write(`${renderError(formatError(error))}\n`);
        }
        continue;
      }
      await runTurn(state, line, rl);
    }
  } finally {
    slashPalette?.dispose();
    rl.close();
  }
}

/** Re-renders the boot screen from the cached probe results (no re-probing). */
function redrawSplash(state: {
  config: AgentConfig;
  session: JsonlSession;
  toolContext: ToolContext;
  splash?: SplashContext;
}): string {
  if (state.splash) return renderSplash(state.splash);
  return banner(state.config, state.session.file, state.toolContext.policy, VERSION);
}

function routeLabel(state: { config: AgentConfig; role: AgentRole; provider?: string }): string {
  if (state.provider) return state.provider;
  if (state.role === "planner") return state.config.plannerProvider;
  if (state.role === "executor") return state.config.executorProvider;
  return "auto";
}

/**
 * Executes one prompt with live narration: streamed reasoning and token
 * counters in a status pane, tool calls as a tree, then the markdown-rendered
 * reply and a usage footer.
 */
async function runTurn(
  state: {
    config: AgentConfig;
    loop: AgentLoop;
    role: AgentRole;
    provider?: string;
    toolContext: ToolContext;
    flow: VizMode;
  },
  line: string,
  rl?: ReturnType<typeof createInterface>,
): Promise<void> {
  const viz = state.flow ?? "full";
  // The dataflow model is mutated by events and read by the pane every frame.
  const flow = createFlowModel(routeLabel(state));
  flow.begin(routeLabel(state));
  // The HUD shows the planner → executor chain; under `auto` neither side is
  // committed until the loop routes, so `active` stays unset.
  const pane = createLivePane(routeLabel(state), {
    route: {
      planner: state.config.plannerProvider,
      executor: state.config.executorProvider,
      active:
        state.provider ??
        (state.role === "planner"
          ? state.config.plannerProvider
          : state.role === "executor"
            ? state.config.executorProvider
            : undefined),
    },
    ...(viz === "full" || viz === "flow" ? { flow: flow.state, onFrame: () => flow.tick() } : {}),
  });
  // The task list survives across turns, so the pane and both visualization
  // layers start from it — otherwise a turn that never re-sends an unchanged
  // list shows an empty plan for its whole duration.
  pane.setPlan(state.loop.plan);
  if (state.loop.plan) flow.seedPlan(state.loop.plan);
  const started = Date.now();
  const traceOn = viz === "full" || viz === "trace";
  // One shared scale for the duration bars, widened as slower requests land.
  let slowestMs = 0;
  let previousPlan = state.loop.plan;
  let thinkStart: number | undefined;
  let thinkTokens: number | undefined;
  let printedHeader = false;
  let sawTool = false;

  const onEvent = (event: LoopEvent) => {
    flow.apply(event);
    if (event.type === "wire" && event.phase === "recv") slowestMs = Math.max(slowestMs, event.ms);
    if (traceOn) {
      for (const traced of traceEvent(event, { startedAt: started, slowestMs: slowestMs || undefined, previousPlan })) {
        pane.commit(traced);
      }
    }
    if (event.type === "plan") {
      previousPlan = event.snapshot;
      planTouched = true;
    }
    switch (event.type) {
      case "turn":
        pane.setPhase(event.turn === 1 ? "working" : `turn ${event.turn}`);
        break;
      case "progress": {
        const progress = event.progress;
        if (progress.kind === "thinking") {
          if (thinkStart === undefined) {
            thinkStart = Date.now();
            pane.setPhase("thinking");
          }
          // Codex streams real reasoning text; Claude Code redacts it and
          // sends only a token estimate, so text may legitimately be empty.
          if (progress.text) pane.pushThinking(progress.text);
          if (progress.usage?.thinking) {
            thinkTokens = progress.usage.thinking;
            pane.setStats(progress.usage);
          }
        } else if (progress.kind === "status" && progress.status) {
          pane.setPhase(progress.status);
        } else if (progress.kind === "text") {
          if (thinkStart !== undefined) {
            pane.commit(thinkingSummary(Date.now() - thinkStart, thinkTokens, pane.thinkingChars));
            thinkStart = undefined;
          }
          pane.setPhase("writing");
        } else if (progress.kind === "tool" && progress.tool) {
          if (!traceOn) pane.commit(renderToolStart(progress.tool, {}));
          pane.setPhase("tool");
          sawTool = true;
        } else if (progress.kind === "usage" && progress.usage) {
          if (progress.usage.thinking) thinkTokens = progress.usage.thinking;
          pane.setStats(progress.usage);
        }
        break;
      }
      case "compaction":
        if (!traceOn) {
          pane.commit(
            renderNotice(
              `context compacted: ≈${event.tokensBefore} → ≈${event.tokensAfter} tokens (${event.droppedMessages} dropped, ${event.elidedToolResults} tool results elided)`,
            ),
          );
        }
        break;
      case "plan":
        pane.setPlan(event.snapshot);
        break;
      case "reply":
        if (thinkStart !== undefined) {
          pane.commit(thinkingSummary(Date.now() - thinkStart, event.usage?.thinking ?? thinkTokens, pane.thinkingChars));
          thinkStart = undefined;
        }
        break;
      case "tool_start":
        sawTool = true;
        if (!traceOn) pane.commit(renderToolStart(event.name, event.args));
        pane.setPhase(event.name);
        break;
      case "tool_end":
        if (!traceOn) pane.commit(renderToolEnd(event.name, event.ok, event.ms, event.preview));
        pane.setPhase("working");
        break;
    }
    if (!printedHeader && (sawTool || thinkStart !== undefined)) printedHeader = true;
  };

  // ^C aborts the turn (killing the provider request or its tmux task) and
  // returns to the prompt; the REPL itself only ends on /exit or EOF.
  const controller = new AbortController();
  let interruptedAt: number | undefined;
  const onSigint = () => {
    if (controller.signal.aborted) return;
    interruptedAt = Date.now();
    pane.setPhase("interrupting");
    controller.abort();
  };
  rl?.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);
  // Tools ask through the same prompt the shell escape uses, with the pane out
  // of the way while the question is on screen.
  state.toolContext.confirm = createApprover(rl, pane);

  // The live pane is gone once stopped, so the final task list is archived into
  // the scrollback — on every exit path, and exactly once.
  let archived = false;
  let planTouched = false;
  const archivePlan = () => {
    if (archived) return;
    archived = true;
    // Only when this turn actually moved the list. The plan survives across
    // turns, so archiving unconditionally would reprint the same box after
    // every turn — the trace stays silent in exactly that case, and the two
    // should agree.
    const plan = state.loop.plan;
    if (plan && planTouched) process.stdout.write(`${renderPlan(plan).join("\n")}\n`);
  };

  try {
    const result = await state.loop.run(line, {
      role: state.role,
      providerName: state.provider,
      signal: controller.signal,
      onEvent,
    });
    flow.end(result.interrupted ? "error" : "done");
    const ms = pane.stop();
    if (traceOn) {
      process.stdout.write(
        `${traceEnd({ startedAt: started, ms, provider: result.provider, interrupted: result.interrupted })}\n`,
      );
    }
    const provider = state.config.providers[result.provider];
    archivePlan();
    if (result.interrupted) {
      const waited = interruptedAt ? formatDuration(Date.now() - interruptedAt) : "";
      process.stdout.write(
        `${renderNotice(`interrupted — partial work kept in the transcript${waited ? ` (stopped in ${waited})` : ""}`)}\n`,
      );
      process.stdout.write(
        `${runFooter({ provider: result.provider, role: result.role, turns: result.turns, ms, usage: result.usage })}\n\n`,
      );
      return;
    }
    process.stdout.write(`${replyHeader(result.provider, provider?.model)}\n`);
    const text = lastAssistantText(result.messages);
    if (text) process.stdout.write(`${renderReply(text)}\n`);
    else process.stdout.write(`${renderNotice("(no text in reply)")}\n`);
    process.stdout.write(
      `${runFooter({ provider: result.provider, role: result.role, turns: result.turns, ms, usage: result.usage })}\n\n`,
    );
  } catch (error) {
    flow.end("error", formatError(error));
    pane.stop();
    // A failed turn still did work; the task list is the record of it.
    archivePlan();
    if (isAbortError(error)) process.stdout.write(`${renderNotice("interrupted")}\n\n`);
    else process.stdout.write(`${renderError(formatError(error))}\n\n`);
  } finally {
    rl?.off("SIGINT", onSigint);
    process.off("SIGINT", onSigint);
    state.toolContext.confirm = undefined;
  }
}

function lastAssistantText(messages: readonly { role: string; content?: Array<{ type: string; text?: string }> }[]): string {
  const last = [...messages].reverse().find(message => message.role === "assistant");
  return last?.content ? textFromBlocks(last.content).trim() : "";
}

// Persistent, cross-session REPL history backed by a plain-text file so the
// up/down arrows recall commands from previous 0xAF-Re sessions too.
class ReplHistory {
  private readonly file = path.join(os.homedir(), ".0xaf-re-agent", "repl-history");
  private last?: string;

  async load(rl: ReturnType<typeof createInterface>): Promise<void> {
    const text = await readTextIfExists(this.file);
    if (!text) return;
    const lines = text.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean);
    this.last = lines[lines.length - 1];
    // readline keeps history newest-first; the file is stored oldest-first.
    (rl as unknown as { history: string[] }).history = lines.slice(-1000).reverse();
  }

  async append(line: string): Promise<void> {
    if (line === this.last) return; // skip consecutive duplicates
    this.last = line;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.file, `${line}\n`, "utf8");
    } catch {
      // history persistence is best-effort; never break the REPL over it
    }
  }
}

async function handleCommand(
  line: string,
  state: {
    config: AgentConfig;
    loop: AgentLoop;
    session: JsonlSession;
    tools: AgentTool[];
    toolContext: ToolContext;
    role: AgentRole;
    provider?: string;
    splash?: SplashContext;
    mcp?: McpConnection[];
    flow: VizMode;
    builtInSkills: BuiltInSkill[];
  },
): Promise<void> {
  const [command, ...rest] = splitCommand(line);
  const arg = rest.join(" ");
  switch (command) {
    case "/welcome":
      process.stdout.write(welcomeText({ config: state.config, workspace: state.toolContext.workspace, demoWorkspace: demoWorkspacePath() }));
      return;
    case "/":
      process.stdout.write(`${formatSlashCommandPalette("/", Object.keys(state.config.providers), { limit: 100 })}\n`);
      return;
    case "/help":
      process.stdout.write(helpText());
      return;
    case "/theme": {
      if (!arg) {
        process.stdout.write(themePicker());
        return;
      }
      if (!isThemeName(arg)) throw new Error(`Usage: /theme ${THEME_NAMES.join("|")}`);
      setTheme(arg);
      await saveUiPrefs({ theme: arg });
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(redrawSplash(state));
      process.stdout.write(`${renderNotice(`theme=${arg} (saved)`)}\n`);
      return;
    }
    case "/clear":
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(redrawSplash(state));
      return;
    case "/effort": {
      const [target, level] = arg.split(/\s+/).filter(Boolean);
      if (!target) throw new Error(`Usage: /effort <provider> [${REASONING_EFFORTS.join("|")}]`);
      const provider = state.config.providers[target];
      if (!provider) throw new Error(`Unknown provider: ${target}`);
      if (!level) {
        process.stdout.write(`${renderNotice(`${target} effort=${provider.reasoningEffort ?? "(provider default)"}`)}\n`);
        return;
      }
      if (!isEffort(level)) throw new Error(`Effort must be one of: ${REASONING_EFFORTS.join(", ")}`);
      setReasoningEffort(provider, level);
      const via = provider.type === "cli-tmux" ? ` (via ${provider.cliCommand}, applies to the next turn)` : "";
      process.stdout.write(`${renderNotice(`${target} effort=${level}${via}`)}\n`);
      return;
    }
    case "/providers":
      process.stdout.write(formatProviders(state.config));
      return;
    case "/mcp": {
      process.stdout.write(formatMcp(state.mcp ?? []));
      return;
    }
    case "/tools":
      process.stdout.write(formatTools(state.tools));
      return;
    case "/skills":
      process.stdout.write(`${formatSkillList(state.builtInSkills)}\n`);
      return;
    case "/skill":
      await runSkillCommand(arg, state);
      return;
    case "/know":
      await runKnowledgeCommand(arg, state);
      return;
    case "/scan":
      if (!arg) throw new Error("Usage: /scan <path>");
      await runDirectTool("ctf_triage", { path: arg }, state);
      return;
    case "/decode":
      await runDirectTool("ctf_decode", parseDecodeCommand(arg), state);
      return;
    case "/entropy":
      if (!arg) throw new Error("Usage: /entropy <path>");
      await runDirectTool("entropy_scan", { path: arg }, state);
      return;
    case "/mitigations":
      if (!arg) throw new Error("Usage: /mitigations <binary>");
      await runDirectTool("binary_mitigations", { path: arg }, state);
      return;
    case "/findbytes": {
      const [file, needle] = splitFirstToken(arg);
      if (!file || !needle) throw new Error("Usage: /findbytes <file> <text|hex>");
      const mode = /^[0-9a-fA-F\s:_-]+$/.test(needle) && needle.replace(/[\s:_-]/g, "").length % 2 === 0 ? "hex" : "text";
      await runDirectTool("find_bytes", { path: file, needle, mode }, state);
      return;
    }
    case "/carve":
      if (!arg) throw new Error("Usage: /carve <file>");
      await runDirectTool("carve_artifacts", { path: arg }, state);
      return;
    case "/apk":
      if (!arg) throw new Error("Usage: /apk <apk>");
      await runDirectTool("apk_inspect", { path: arg }, state);
      return;
    case "/hook":
      await runDirectTool("frida_hook_template", parseHookCommand(arg), state);
      return;
    case "/plan": {
      const plan = state.loop.plan;
      if (!plan) {
        process.stdout.write(`${renderNotice("(no plan yet — it appears once the model lays one out)")}\n`);
        return;
      }
      process.stdout.write(`${renderPlan(plan).join("\n")}\n`);
      return;
    }
    case "/flow": {
      if (!arg) {
        process.stdout.write(
          `${renderNotice(`flow=${state.flow} — full (diagram + trace) · flow (diagram) · trace (lines) · off`)}\n`,
        );
        return;
      }
      if (!isVizMode(arg)) throw new Error(`Usage: /flow ${VIZ_MODES.join("|")}`);
      state.flow = arg;
      await saveUiPrefs({ flow: arg });
      process.stdout.write(`${renderNotice(`flow=${arg} (saved)`)}\n`);
      return;
    }
    case "/context": {
      const tokens = state.loop.contextTokens;
      const provider = state.config.providers[routeLabel(state) === "auto" ? state.config.plannerProvider : routeLabel(state)];
      const budget = provider?.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      const pct = Math.round((tokens / budget) * 100);
      process.stdout.write(
        `${renderNotice(`context ≈${tokens} tokens of ${budget} budget (${pct}%) · ${state.loop.history.length} messages — /compact to fold it into a summary`)}\n`,
      );
      return;
    }
    case "/compact": {
      const target = arg || undefined;
      if (target && !state.config.providers[target]) throw new Error(`Unknown provider: ${target}`);
      process.stdout.write(`${renderNotice("compacting the session into a summary…")}\n`);
      const result = await state.loop.compact({ providerName: target });
      process.stdout.write(`${renderReply(result.summary)}\n`);
      process.stdout.write(
        `${renderNotice(`compacted via ${result.provider}: ≈${result.tokensBefore} → ≈${result.tokensAfter} tokens (full transcript kept in ${state.session.file})`)}\n`,
      );
      return;
    }
    case "/sessions": {
      process.stdout.write(formatSessions(await listSessions(state.toolContext.sessionDir)));
      return;
    }
    case "/resume": {
      const target = await resolveSession(state.toolContext.sessionDir, arg || undefined);
      if (!target) throw new Error(arg ? `No session matching '${arg}'` : "No previous session found.");
      if (path.resolve(target.file) === path.resolve(state.session.file)) {
        throw new Error("That is the session you are already in.");
      }
      const loaded = await loadSession(target.file);
      await state.loop.restore(loaded.messages, loaded.plan);
      await state.session.appendEvent({ type: "resumed_from", file: target.file, messages: loaded.messages.length });
      process.stdout.write(
        `${renderNotice(`resumed ${target.id} — ${loaded.messages.length} messages, ≈${state.loop.contextTokens} tokens (still logging to this session)`)}\n`,
      );
      if (state.loop.plan) process.stdout.write(`${renderPlan(state.loop.plan).join("\n")}\n`);
      return;
    }
    case "/session":
      process.stdout.write(`${state.session.file}\n`);
      return;
    case "/approval": {
      const policy = state.toolContext.policy;
      if (!arg) {
        const overrides = Object.entries(policy.approvals);
        process.stdout.write(
          `${renderNotice(`approval=${policy.approvalMode}${overrides.length ? ` · overrides: ${overrides.map(([tool, value]) => `${tool}=${value}`).join(", ")}` : ""}`)}\n`,
        );
        return;
      }
      const [mode, tool, decision] = arg.split(/\s+/).filter(Boolean);
      if (mode === "reset") {
        for (const key of Object.keys(policy.approvals)) delete policy.approvals[key];
        process.stdout.write(`${renderNotice("cleared per-tool approval overrides")}\n`);
        return;
      }
      if (mode === "tool") {
        if (!tool || (decision !== "allow" && decision !== "deny")) {
          throw new Error("Usage: /approval tool <name> allow|deny");
        }
        policy.approvals[tool] = decision;
        process.stdout.write(`${renderNotice(`${tool}=${decision} for this session`)}\n`);
        return;
      }
      if (!isApprovalMode(mode)) throw new Error(`Usage: /approval ${APPROVAL_MODES.join("|")} | tool <name> allow|deny | reset`);
      policy.approvalMode = mode;
      process.stdout.write(`${renderNotice(`approval=${mode}`)}\n`);
      return;
    }
    case "/policy":
      process.stdout.write(`${JSON.stringify(state.toolContext.policy, null, 2)}\n`);
      return;
    case "/status":
    case "/auth":
      await printAuthStatus(state.config);
      return;
    case "/login":
      await loginFromPrompt(state.config, arg || defaultLoginProvider(state));
      return;
    case "/logout":
      if (!arg) throw new Error("Usage: /logout <provider>");
      if (await logoutProvider(state.config, arg)) process.stdout.write(`Removed stored credential for ${arg}\n`);
      else process.stdout.write(`No stored credential for ${arg}\n`);
      return;
    case "/role":
      if (!isRole(arg)) throw new Error("Usage: /role planner|executor|auto");
      state.role = arg;
      state.provider = undefined;
      process.stdout.write(`role=${state.role}\n`);
      return;
    case "/agent":
      if (!arg || arg === "auto") {
        state.provider = undefined;
        process.stdout.write(`agent=auto role=${state.role}\n`);
        return;
      }
      if (!state.config.providers[arg]) throw new Error(`Unknown provider: ${arg}`);
      state.provider = arg;
      process.stdout.write(`agent=${state.provider}\n`);
      return;
    case "/planner":
      if (!state.config.providers[arg]) throw new Error(`Unknown provider: ${arg}`);
      state.config.plannerProvider = arg;
      process.stdout.write(`planner=${arg}\n`);
      return;
    case "/executor":
      if (!state.config.providers[arg]) throw new Error(`Unknown provider: ${arg}`);
      state.config.executorProvider = arg;
      process.stdout.write(`executor=${arg}\n`);
      return;
    case "/read":
      await runDirectTool("read_file", { path: arg }, state);
      return;
    case "/run":
      await runDirectTool("run_command", { command: arg }, state);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}. Try /help\n`);
  }
}

function installSlashCommandPalette(
  rl: ReturnType<typeof createInterface>,
  providerNames: () => string[],
  skillNames: () => string[],
  currentPrompt: () => string,
): { clear(): void; dispose(): void } {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { clear() {}, dispose() {} };
  }
  emitKeypressEvents(process.stdin, rl);

  let visible = false;
  let lastPanel = "";
  let panelRows = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const refreshLine = () => {
    const refresh = (rl as unknown as { _refreshLine?: () => void })._refreshLine;
    if (refresh) refresh.call(rl);
    else rl.prompt(true);
  };

  const lineState = () => {
    const state = rl as unknown as { line?: unknown; cursor?: unknown };
    const line = typeof state.line === "string" ? state.line : "";
    const cursor = typeof state.cursor === "number" ? state.cursor : line.length;
    return { line, cursor: Math.max(0, Math.min(cursor, line.length)) };
  };

  const terminalWidth = () => Math.max(1, process.stdout.columns ?? termWidth());

  const screenRowsForLine = (line: string, columns: number) => {
    return Math.max(1, Math.ceil(displayWidth(line) / columns));
  };

  const screenRowsForBlock = (block: string, columns: number) => {
    return block.split("\n").reduce((rows, line) => rows + screenRowsForLine(line, columns), 0);
  };

  const promptCursorRowOffset = (line: string, cursor: number, columns: number) => {
    return Math.floor(displayWidth(`${currentPrompt()}${line.slice(0, cursor)}`) / columns);
  };

  const clearFromPanelStart = () => {
    if (visible && panelRows > 0) {
      const columns = terminalWidth();
      const { line, cursor } = lineState();
      const rowsUp = panelRows + promptCursorRowOffset(line, cursor, columns);
      if (rowsUp > 0) process.stdout.write(`\x1b[${rowsUp}A`);
    }
    process.stdout.write("\r\x1b[0J");
  };

  const clear = (options: { refresh?: boolean } = {}) => {
    if (!visible) return;
    const refresh = options.refresh ?? true;
    process.stdout.write("\x1b[?25l");
    clearFromPanelStart();
    visible = false;
    lastPanel = "";
    panelRows = 0;
    if (refresh) refreshLine();
    process.stdout.write("\x1b[?25h");
  };

  const render = () => {
    pending = undefined;
    const { line } = lineState();
    if (!line.startsWith("/")) {
      clear();
      return;
    }
    const panel = formatSlashCommandPalette(line, providerNames(), { skillNames: skillNames() });
    if (visible && panel === lastPanel) return;
    process.stdout.write("\x1b[?25l");
    clearFromPanelStart();
    process.stdout.write(`${panel}\n`);
    visible = true;
    lastPanel = panel;
    panelRows = screenRowsForBlock(panel, terminalWidth());
    refreshLine();
    process.stdout.write("\x1b[?25h");
  };

  const schedule = (_input: string, key: { name?: string; ctrl?: boolean } = {}) => {
    if (key.name === "return" || key.name === "enter") {
      clear({ refresh: false });
      return;
    }
    if (key.name === "escape" || key.ctrl) {
      clear();
      return;
    }
    if (pending) clearTimeout(pending);
    pending = setTimeout(render, 0);
  };

  process.stdin.on("keypress", schedule);
  return {
    clear,
    dispose() {
      if (pending) clearTimeout(pending);
      process.stdin.off("keypress", schedule);
      clear();
    },
  };
}

const CLI_DECODE_MODES = new Set(["auto", "base64", "base64url", "hex", "url", "rot13", "xor", "xor_bruteforce"]);
const CLI_DECODE_ALIASES: Record<string, string> = {
  b64: "base64",
  b64url: "base64url",
  urldecode: "url",
  xorbf: "xor_bruteforce",
};

function parseDecodeCommand(arg: string): Record<string, unknown> {
  const trimmed = arg.trim();
  if (!trimmed) throw new Error("Usage: /decode [auto|base64|base64url|hex|url|rot13|xor|xor_bruteforce] <input>");
  const [first, rest] = splitFirstToken(trimmed);
  const mode = CLI_DECODE_ALIASES[first] ?? first;
  if (!CLI_DECODE_MODES.has(mode)) return { mode: "auto", input: trimmed };
  if (!rest && mode !== "rot13") throw new Error(`Usage: /decode ${mode} <input>`);
  if (mode !== "xor") return { mode, input: rest || trimmed };
  const [key, input] = splitFirstToken(rest);
  if (!key || !input) throw new Error("Usage: /decode xor <key> <input>");
  return { mode, key, input };
}

function splitFirstToken(value: string): [string, string] {
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  if (space < 0) return [trimmed, ""];
  return [trimmed.slice(0, space), trimmed.slice(space).trim()];
}

async function runSkillCommand(
  arg: string,
  state: { builtInSkills: BuiltInSkill[]; config: AgentConfig; loop: AgentLoop; role: AgentRole; provider?: string },
): Promise<void> {
  const [name, task] = splitFirstToken(arg);
  if (!name) throw new Error("Usage: /skill <name> [task]");
  const skill = findBuiltInSkill(state.builtInSkills, name);
  if (!skill) throw new Error(`Unknown skill: ${name}. Try /skills`);
  if (!task) {
    process.stdout.write(`${skill.body}\n`);
    return;
  }
  await runTurn(state, skillTurnPrompt(skill, task));
}

async function runKnowledgeCommand(
  arg: string,
  state: { config: AgentConfig; session: JsonlSession; toolContext: ToolContext },
): Promise<void> {
  const trimmed = arg.trim();
  if (!trimmed) throw new Error("Usage: /know <query>  ·  /know raw <query>  ·  /know read <entry-id>");
  const [verb, rest] = splitFirstToken(trimmed);
  if (verb === "read") {
    if (!rest) throw new Error("Usage: /know read <entry-id>");
    const entry = await readKnowledgeEntry(rest);
    if (!entry) throw new Error(`Knowledge entry not found: ${rest}`);
    process.stdout.write(`${await readKnowledgeText(entry)}\n`);
    return;
  }
  if (verb === "raw") {
    if (!rest) throw new Error("Usage: /know raw <query>");
    process.stdout.write(`${formatKnowledgeMatches(await searchKnowledge(rest, 8))}\n`);
    return;
  }

  const matches = await searchKnowledge(trimmed, 8);
  if (matches.length === 0) {
    process.stdout.write(`${renderNotice("No matching reverse-engineering knowledge entries.")}\n`);
    return;
  }
  await synthesizeKnowledge(trimmed, matches, state);
}

/**
 * Answers a knowledge query from the retrieved entries instead of dumping them.
 *
 * The synthesis runs on a FRESH provider instance: the configured CLI providers
 * resume one long-lived native session, and a side lookup must not be spliced
 * into the conversation the operator is actually having.
 */
async function synthesizeKnowledge(
  query: string,
  matches: Awaited<ReturnType<typeof searchKnowledge>>,
  state: { config: AgentConfig; session: JsonlSession; toolContext: ToolContext },
): Promise<void> {
  const providerName = state.config.knowledgeProvider ?? state.config.executorProvider;
  const providerConfig = state.config.providers[providerName];
  if (!providerConfig) throw new Error(`Knowledge provider not configured: ${providerName}`);

  const packed = await packKnowledgeContext(matches);
  const pane = createLivePane(`know · ${providerName}`);
  pane.setPhase(`reading ${packed.used.length} entries`);
  let answer;
  try {
    const provider = createProvider(providerName, providerConfig);
    const response = await provider.complete({
      system: KNOWLEDGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [textBlock(buildKnowledgePrompt(query, packed))], timestamp: Date.now() }],
      tools: [],
      workspace: state.toolContext.workspace,
      sessionDir: state.toolContext.sessionDir,
      onProgress: progress => {
        if (progress.kind === "thinking") pane.setPhase("thinking");
        else if (progress.kind === "text") pane.setPhase("writing");
      },
    });
    answer = parseKnowledgeAnswer(response.text, matches);
  } finally {
    pane.stop();
  }

  process.stdout.write(`${renderReply(formatKnowledgeAnswer(answer))}\n`);
  if (packed.truncated.length > 0) {
    process.stdout.write(
      `${renderNotice(`${packed.truncated.length} more entries matched but did not fit the context — /know raw ${query}`)}\n`,
    );
  }
  await state.session
    .appendEvent({
      type: "knowledge",
      query,
      matched: matches.map(entry => entry.id),
      used: packed.used.map(entry => entry.id),
      citations: answer.citations.map(entry => entry.id),
      inventedCitations: answer.inventedCitations,
      parsed: answer.parsed,
    })
    .catch(() => {
      // lookups are advisory; never fail one over persistence
    });
}

function parseHookCommand(arg: string): Record<string, unknown> {
  const trimmed = arg.trim();
  if (!trimmed) throw new Error("Usage: /hook [java|native|objc] <target> [method] [signature]");
  const [first, rest1] = splitFirstToken(trimmed);
  const platformMap: Record<string, string> = {
    java: "android_java",
    android_java: "android_java",
    native: "android_native",
    android_native: "android_native",
    objc: "ios_objc",
    ios: "ios_objc",
    ios_objc: "ios_objc",
  };
  const platform = platformMap[first] ?? "android_java";
  const rest = platformMap[first] ? rest1 : trimmed;
  const [target, rest2] = splitFirstToken(rest);
  const [method, signature] = splitFirstToken(rest2);
  if (!target) throw new Error("Usage: /hook [java|native|objc] <target> [method] [signature]");
  if (platform === "android_native") return { platform, target };
  return { platform, target, method, signature };
}

/**
 * Interactive approval. The live pane is paused so the prompt owns the screen,
 * and a bare Enter means "no" — the safe answer is the one you get by reflex.
 */
function createApprover(
  rl: ReturnType<typeof createInterface> | undefined,
  pane?: { pause(): void; resume(): void },
): ToolContext["confirm"] | undefined {
  if (!rl || !process.stdin.isTTY) return undefined;
  return async request => {
    pane?.pause();
    try {
      process.stdout.write(`${renderApprovalRequest(request)}\n`);
      const answer = (await rl.question(approvalPromptLabel())).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return "allow";
      if (answer === "a" || answer === "always") return "allow-always";
      if (answer === "d" || answer === "never") return "deny-always";
      return "deny";
    } catch {
      return "deny"; // readline closed under us: refuse rather than assume yes
    } finally {
      pane?.resume();
    }
  };
}

/**
 * `!command` — run a shell command in the workspace without a model round trip.
 * Output streams to the terminal as it arrives and is then appended to the
 * transcript, so the next prompt can refer to what was just seen. ^C kills the
 * child without ending the REPL.
 */
async function runShellEscape(
  state: { loop: AgentLoop; toolContext: ToolContext },
  line: string,
  rl?: ReturnType<typeof createInterface>,
): Promise<void> {
  const command = parseShellEscape(line);
  if (!command) {
    process.stdout.write(`${renderNotice("Usage: !<command>   e.g. !ls -la   (runs in the workspace, output goes to the agent)")}\n`);
    return;
  }

  // Clear it before drawing the header, so a refused command never leaves an
  // unfinished output box behind.
  await assertShellCommandAllowed(command, state.toolContext.policy, createApprover(rl));

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  const writer = createShellStreamWriter(text => process.stdout.write(text));
  process.stdout.write(`${renderShellCommand(command)}\n`);
  // In raw mode the tty never raises SIGINT, so ^C arrives as a readline
  // event instead; listening for it also stops readline closing the REPL.
  rl?.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);
  try {
    const result = await runShellCommand(command, {
      workspace: state.toolContext.workspace,
      policy: state.toolContext.policy,
      signal: controller.signal,
      preApproved: true, // cleared above, before the header was drawn
      onChunk: chunk => writer.push(chunk.stream, chunk.text),
    });
    writer.flush();
    process.stdout.write(`${renderShellExit(result)}\n\n`);
    // Best-effort: a transcript write must not lose the output already shown.
    await state.loop.addContext(shellContextMessage(result)).catch(() => {});
  } finally {
    rl?.off("SIGINT", onSigint);
    process.off("SIGINT", onSigint);
    writer.flush();
  }
}

async function runDirectTool(
  toolName: string,
  args: Record<string, unknown>,
  state: { tools: AgentTool[]; toolContext: ToolContext },
): Promise<void> {
  const tool = state.tools.find(candidate => candidate.name === toolName);
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  const result = await tool.execute(args, state.toolContext);
  process.stdout.write(`${textFromBlocks(result.content)}\n`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    workspace: process.cwd(),
    sessionDir: path.resolve(process.cwd(), "sessions"),
    print: false,
    smoke: false,
    welcome: false,
    allowWrites: false,
    allowNetwork: false,
    allowSensitive: false,
    listSessions: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--config") args.config = requireValue(argv, ++i, item);
    else if (item === "--workspace" || item === "--cwd") args.workspace = requireValue(argv, ++i, item);
    else if (item === "--session-dir") args.sessionDir = requireValue(argv, ++i, item);
    else if (item === "--role") {
      const role = requireValue(argv, ++i, item);
      if (!isRole(role)) throw new Error(`Invalid role: ${role}`);
      args.role = role;
    } else if (item === "--agent" || item === "--provider") args.provider = requireValue(argv, ++i, item);
    else if (item === "--planner") args.planner = requireValue(argv, ++i, item);
    else if (item === "--executor") args.executor = requireValue(argv, ++i, item);
    else if (item === "--prompt") args.prompt = requireValue(argv, ++i, item);
    else if (item === "--theme") {
      const theme = requireValue(argv, ++i, item);
      if (!isThemeName(theme)) throw new Error(`--theme must be one of: ${THEME_NAMES.join(", ")}`);
      args.theme = theme;
    }
    else if (item === "--effort") {
      const effort = requireValue(argv, ++i, item);
      if (!isEffort(effort)) throw new Error(`--effort must be one of: ${REASONING_EFFORTS.join(", ")}`);
      args.effort = effort;
    }
    else if (item === "--print" || item === "-p") args.print = true;
    else if (item === "--smoke") args.smoke = true;
    else if (item === "--welcome" || item === "welcome") args.welcome = true;
    else if (item === "--write") args.allowWrites = true;
    else if (item === "--allow-network") args.allowNetwork = true;
    else if (item === "--allow-sensitive") args.allowSensitive = true;
    else if (item === "--continue" || item === "-c") args.resume = "";
    else if (item === "--resume") {
      const next = argv[i + 1];
      args.resume = next && !next.startsWith("-") ? argv[++i] : "";
    }
    else if (item === "--sessions") args.listSessions = true;
    else if (item === "--flow") {
      const mode = requireValue(argv, ++i, item);
      if (!isVizMode(mode)) throw new Error(`--flow must be one of: ${VIZ_MODES.join(", ")}`);
      args.viz = mode;
    }
    else if (item === "--yolo") args.approvalMode = "yolo";
    else if (item === "--approval") {
      const mode = requireValue(argv, ++i, item);
      if (!isApprovalMode(mode)) throw new Error(`--approval must be one of: ${APPROVAL_MODES.join(", ")}`);
      args.approvalMode = mode;
    }
    else if (item === "--max-output") {
      const value = Number(requireValue(argv, ++i, item));
      if (!Number.isFinite(value) || value < 500) throw new Error("--max-output takes a character budget of at least 500.");
      args.maxOutputChars = Math.floor(value);
    }
    else if (item === "--help" || item === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    } else if (item === "auth") {
      const action = argv[++i];
      if (action !== "login" && action !== "status" && action !== "logout") {
        throw new Error("Usage: auth login|status|logout [provider]");
      }
      const provider = argv[i + 1]?.startsWith("-") ? undefined : argv[i + 1];
      args.authCommand = { action, provider };
      break;
    } else positional.push(item);
  }
  if (!args.prompt && positional.length > 0) args.prompt = positional.join(" ");
  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function isRole(value: string): value is AgentRole {
  return value === "planner" || value === "executor" || value === "auto";
}

function isEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as string[]).includes(value);
}

function splitCommand(line: string): string[] {
  const trimmed = line.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) return [trimmed];
  return [trimmed.slice(0, space), trimmed.slice(space + 1).trim()];
}

function printRunResult(messages: readonly { role: string; content?: Array<{ type: string; text?: string }> }[]): void {
  const text = lastAssistantText(messages);
  if (text) process.stdout.write(`${renderReply(text)}\n`);
}

async function questionOrEof(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string | undefined> {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if (error instanceof Error && error.message.includes("readline was closed")) return undefined;
    throw error;
  }
}

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function demoWorkspacePath(): string {
  const target = path.join(projectRoot(), "demos", "welcome");
  const relative = path.relative(process.cwd(), target);
  if (!relative) return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.startsWith(".") ? relative : `./${relative}`;
  }
  return target;
}

async function loadSystemPrompt(): Promise<string> {
  const promptPath = path.join(projectRoot(), "prompts", "system.md");
  const prompt = await readTextIfExists(promptPath);
  if (prompt) return prompt;
  return "You are 0xAF-Re, a reverse engineering and CTF assistant.";
}

async function handleAuthCli(
  command: { action: "login" | "status" | "logout"; provider?: string },
  config: AgentConfig,
): Promise<void> {
  if (command.action === "status") {
    await printAuthStatus(config);
    return;
  }
  if (!command.provider) {
    throw new Error(`Usage: auth ${command.action} <provider>`);
  }
  if (command.action === "login") {
    await loginFromPrompt(config, command.provider);
    return;
  }
  if (await logoutProvider(config, command.provider)) {
    process.stdout.write(`Removed stored credential for ${command.provider}\n`);
  } else {
    process.stdout.write(`No stored credential for ${command.provider}\n`);
  }
}

async function loginFromPrompt(config: AgentConfig, providerName: string): Promise<void> {
  if (!config.providers[providerName]) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  const provider = config.providers[providerName];
  if (provider.type === "cli-tmux") {
    throw new Error(
      `Provider '${providerName}' uses local CLI auth. Use '${provider.cliCommand === "claude" ? "claude auth login" : `${provider.cliCommand ?? providerName} login`}' outside 0xAF-Re, or login to ${providerName}-api if you want direct API mode.`,
    );
  }
  const envHint = provider.apiKeyEnv?.length ? ` (${provider.apiKeyEnv.join(" / ")})` : "";
  const secret = await promptSecret(`Paste credential for ${providerName}${envHint}: `);
  await loginProvider(config, providerName, secret);
  process.stdout.write(`Saved credential for ${providerName} in ~/.0xaf-re-agent/secrets.json\n`);
}

async function printAuthStatus(config: AgentConfig): Promise<void> {
  const statuses = await credentialStatuses(config);
  process.stdout.write(formatAuthStatus(statuses));
}

function defaultLoginProvider(state: { config: AgentConfig; role: AgentRole; provider?: string }): string {
  if (state.provider) return state.provider;
  if (state.role === "planner") return state.config.plannerProvider;
  if (state.role === "executor") return state.config.executorProvider;
  return state.config.executorProvider;
}

main().catch(error => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
});
