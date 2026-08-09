import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { InterruptedError, isAbortError, textFromBlocks } from "../utils";
import { ClaudeTaskTable, StreamParser, streamFormatFor } from "./stream";
import type { StreamFormat } from "./stream";
import type { AgentMessage, AgentTool, ChatProvider, ProviderConfig, ProviderInput, ProviderResponse } from "../types";

interface CliPaths {
  runDir: string;
  prompt: string;
  output: string;
  stdout: string;
  stderr: string;
  exit: string;
  runner: string;
  socket: string;
}

export class CliTmuxProvider implements ChatProvider {
  // Native CLI conversation state, kept for the lifetime of this process so that
  // successive turns resume one persistent Claude Code session instead of
  // spawning a throwaway `claude -p` session each time.
  private cliSessionId?: string;
  private cliSessionStarted = false;
  /**
   * Claude's task list is session-scoped, and this provider resumes one native
   * session across turns, so the table has to outlive the per-turn parser.
   */
  private readonly claudeTasks = new ClaudeTaskTable();

  constructor(
    readonly name: string,
    readonly config: ProviderConfig,
  ) {}

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    const command = this.config.cliCommand;
    if (!command) throw new Error(`Provider '${this.name}' is missing cliCommand.`);
    const authIssue = await cliAuthIssue(command, this.config.cliUnsetEnv ?? []);
    if (authIssue) {
      throw new Error(formatCliAuthIssue(this.name, command, authIssue));
    }

    const workspace = path.resolve(input.workspace ?? process.cwd());
    const paths = await createRunPaths(this.name, input.sessionDir);
    const maxChars = this.config.cliPromptMaxChars ?? 80_000;
    const session = this.resolveSession();
    // A non-resuming turn spawns a brand new CLI session whose task ids restart
    // at 1. Keeping the old table would let those ids collide with the previous
    // session's steps and corrupt the plan, so the table is scoped to the
    // session it mirrors — not to this provider instance.
    if (!session.resuming) this.claudeTasks.reset();
    const prompt = session.resuming
      ? buildResumePrompt(deltaSince(input.messages, this.name), workspace, maxChars)
      : buildPrompt(input.system, input.messages, input.tools, workspace, maxChars);
    await fs.writeFile(paths.prompt, prompt, "utf8");

    const args = [...(this.config.cliArgs ?? []), ...session.args].map(arg => replacePlaceholders(arg, paths, workspace));
    const sessionName = tmuxSessionName(this.name);
    await fs.writeFile(paths.runner, runnerScript(command, args, paths, workspace, this.config.cliUnsetEnv ?? []), { mode: 0o700 });
    await fs.chmod(paths.runner, 0o700).catch(() => {});

    // When the CLI speaks JSONL, tail its stdout while it runs so the operator
    // sees real reasoning, tool activity, and token counts live.
    const format = this.config.cliStream === false ? undefined : streamFormatFor(command, args);
    const parser = format ? new StreamParser(format, this.claudeTasks) : undefined;
    const reasoning: string[] = [];
    // Tail whenever the CLI speaks JSONL, even with no progress listener: the
    // parsed stream *is* the reply text for these providers, and it is also the
    // only thing that keeps the task table in step with the CLI's own list. A
    // turn that skipped the tail (`/compact`, which passes no onProgress) used
    // to come back with the "completed without text output" placeholder.
    const tail = parser
      ? new StdoutTail(paths.stdout, chunk => {
          for (const event of parser.push(chunk)) {
            if (event.kind === "thinking" && event.text) reasoning.push(event.text);
            if (event.kind === "final") continue; // surfaced via the return value
            input.onProgress?.({
              kind: event.kind,
              text: event.text,
              tool: event.tool,
              status: event.status,
              usage: event.usage,
              plan: event.plan,
              planNote: event.planNote,
            });
          }
        })
      : undefined;

    let mode = "tmux";
    try {
      tail?.start();
      try {
        await startTmux(this.name, sessionName, paths);
        await waitForCompletion(sessionName, paths, this.config.cliTimeoutMs ?? 10 * 60_000, input.signal);
      } catch (error) {
        // An interrupt must not fall back into a second run of the same prompt.
        if (isAbortError(error) || input.signal?.aborted) throw error;
        if (this.config.cliFallbackDirect === false) throw error;
        mode = "direct-fallback";
        await runDirect(paths.runner, this.config.cliTimeoutMs ?? 10 * 60_000, input.signal);
      }
    } finally {
      await tail?.stop();
    }

    const status = Number((await fs.readFile(paths.exit, "utf8").catch(() => "1")).trim() || "1");
    const stdout = await fs.readFile(paths.stdout, "utf8").catch(() => "");
    const stderr = await fs.readFile(paths.stderr, "utf8").catch(() => "");
    const output = await fs.readFile(paths.output, "utf8").catch(() => stdout);

    if (status !== 0) {
      throw new Error(formatCliFailure(this.name, command, status, stdout, stderr, paths.runDir, format));
    }

    // With a JSONL stream the raw stdout is events, not prose, so prefer the
    // parsed final message; `--output-last-message` (codex) still wins when set.
    const fileText = stripAnsi(output.trim());
    const streamed = parser?.lastText?.trim();
    const text = format ? (fileText && !fileText.startsWith("{") ? fileText : streamed ?? "") : fileText || stripAnsi(stdout.trim());

    return {
      text: text || `[${this.name}] CLI completed without text output. Logs: ${paths.runDir}`,
      toolCalls: [],
      usage: parser?.totals,
      reasoning: reasoning.length > 0 ? reasoning.join("") : undefined,
      raw: { runDir: paths.runDir, sessionName, command, status, mode, cliSessionId: session.id },
    };
  }

  // Decide whether this turn creates a new CLI session or resumes the running
  // one, and produce the extra argv needed. The session id is claimed eagerly
  // (before the CLI runs) so that a mid-run failure never re-issues the same
  // `--session-id`, which the CLI rejects as "already in use".
  private resolveSession(): { resuming: boolean; args: string[]; id?: string } {
    if (!this.config.cliResumeSession) return { resuming: false, args: [] };
    const idArg = this.config.cliSessionIdArg ?? "--session-id";
    const resumeArg = this.config.cliResumeArg ?? "--resume";
    if (this.cliSessionStarted && this.cliSessionId) {
      return { resuming: true, args: [resumeArg, this.cliSessionId], id: this.cliSessionId };
    }
    this.cliSessionId = randomUUID();
    this.cliSessionStarted = true;
    return { resuming: false, args: [idArg, this.cliSessionId], id: this.cliSessionId };
  }
}

// Messages that appeared after this provider last spoke — everything the
// resumed CLI session has not seen yet (the new user turn, tool results, and
// any other provider's contributions). On the first resume this is still just
// the tail, because the CLI already holds the earlier turns natively.
function deltaSince(messages: AgentMessage[], providerName: string): AgentMessage[] {
  let lastOwn = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.provider === providerName) {
      lastOwn = i;
      break;
    }
  }
  return lastOwn >= 0 ? messages.slice(lastOwn + 1) : messages;
}

async function startTmux(providerName: string, sessionName: string, paths: CliPaths): Promise<void> {
  const start = Bun.spawn(["tmux", "-S", paths.socket, "new-session", "-d", "-s", sessionName, `bash ${shellQuote(paths.runner)}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const startExit = await start.exited;
  const startStderr = await new Response(start.stderr).text();
  if (startExit !== 0 || startStderr.trim()) {
    throw new Error(`Failed to start tmux provider '${providerName}': ${startStderr.trim() || `tmux exit ${startExit}`}`);
  }
}

async function runDirect(runner: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const process = Bun.spawn(["bash", runner], { stdout: "ignore", stderr: "ignore", signal });
  const timedOut = await Promise.race([
    process.exited.then(() => false),
    Bun.sleep(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    process.kill();
    throw new Error(`CLI provider direct fallback timed out after ${timeoutMs}ms`);
  }
  if (signal?.aborted) throw new InterruptedError();
}

function buildPrompt(system: string, messages: AgentMessage[], tools: AgentTool[], workspace: string, maxChars: number): string {
  const toolList = tools.map(tool => `- ${tool.name}: ${tool.description}`).join("\n");
  const transcript = messages.map(formatMessage).filter(Boolean).join("\n\n");
  const prompt = [
    system,
    "",
    "You are running as a local CLI agent launched from 0xAF-Re.",
    `Workspace: ${workspace}`,
    "Return a concise final answer. Use local tools only when needed and keep work inside the workspace.",
    "",
    "Available host-side tools in 0xAF-Re, if you need to ask the operator to switch back:",
    toolList,
    "",
    "Conversation:",
    transcript,
  ].join("\n");
  if (prompt.length <= maxChars) return prompt;
  return `${prompt.slice(0, maxChars)}\n\n[0xAF-Re clipped ${prompt.length - maxChars} chars from CLI prompt]`;
}

function buildResumePrompt(messages: AgentMessage[], workspace: string, maxChars: number): string {
  const transcript = messages.map(formatMessage).filter(Boolean).join("\n\n");
  const prompt = [
    "Continue the same 0xAF-Re session. Below are only the new turns since your last reply.",
    `Workspace: ${workspace}`,
    "Return a concise final answer. Use local tools only when needed and keep work inside the workspace.",
    // The system prompt is only sent on the first turn of a resumed CLI session,
    // so the standing instructions that matter for the operator's view have to
    // ride along with every resume.
    "Keep your task list current with your native task tool (TaskCreate/TaskUpdate, update_plan, TodoWrite): one step in_progress at a time, mark steps completed as they land.",
    "",
    "New turns:",
    transcript || "(no new turns)",
  ].join("\n");
  if (prompt.length <= maxChars) return prompt;
  return `${prompt.slice(0, maxChars)}\n\n[0xAF-Re clipped ${prompt.length - maxChars} chars from CLI prompt]`;
}

function formatMessage(message: AgentMessage): string {
  if (message.role === "system") return "";
  if (message.role === "user") return `USER:\n${textFromBlocks(message.content)}`;
  if (message.role === "assistant") return `ASSISTANT (${message.provider ?? "unknown"}):\n${textFromBlocks(message.content)}`;
  if (message.role === "toolResult") {
    const status = message.isError ? "ERROR" : "OK";
    return `TOOL ${message.toolName} ${status}:\n${textFromBlocks(message.content)}`;
  }
  return "";
}

/**
 * Follows a growing log file and hands newly appended text to a sink. Used to
 * surface CLI JSONL events while the child process is still running, since the
 * runner script redirects stdout to a file rather than a pipe.
 */
class StdoutTail {
  private position = 0;
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(
    private readonly file: string,
    private readonly sink: (chunk: string) => void,
    private readonly intervalMs = 100,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.drain(); // final pass so trailing events are not lost
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const stats = await fs.stat(this.file).catch(() => undefined);
      if (!stats || stats.size <= this.position) return;
      const handle = await fs.open(this.file, "r").catch(() => undefined);
      if (!handle) return;
      try {
        const length = stats.size - this.position;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.position);
        this.position += bytesRead;
        if (bytesRead > 0) this.sink(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close().catch(() => {});
      }
    } catch {
      // tailing is best-effort; never fail a run because of it
    } finally {
      this.draining = false;
    }
  }
}

async function createRunPaths(providerName: string, sessionDir?: string): Promise<CliPaths> {
  const base = path.resolve(sessionDir ?? path.resolve(process.cwd(), "sessions"), "cli-tmux");
  const runDir = path.join(base, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(providerName)}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(runDir, { recursive: true });
  return {
    runDir,
    prompt: path.join(runDir, "prompt.txt"),
    output: path.join(runDir, "output.txt"),
    stdout: path.join(runDir, "stdout.log"),
    stderr: path.join(runDir, "stderr.log"),
    exit: path.join(runDir, "exit.status"),
    runner: path.join(runDir, "runner.sh"),
    socket: path.join(runDir, "tmux.sock"),
  };
}

function runnerScript(command: string, args: string[], paths: CliPaths, workspace: string, unsetEnv: string[]): string {
  const argv = [command, ...args].map(shellQuote).join(" ");
  return [
    "#!/usr/bin/env bash",
    "set +e",
    `cd ${shellQuote(workspace)} || exit 97`,
    ...unsetEnv.map(name => `unset ${shellName(name)}`),
    `${argv} < ${shellQuote(paths.prompt)} > ${shellQuote(paths.stdout)} 2> ${shellQuote(paths.stderr)}`,
    "status=$?",
    `if [ ! -s ${shellQuote(paths.output)} ] && [ -s ${shellQuote(paths.stdout)} ]; then cp ${shellQuote(paths.stdout)} ${shellQuote(paths.output)}; fi`,
    `printf "%s" "$status" > ${shellQuote(paths.exit)}`,
    "exit 0",
    "",
  ].join("\n");
}

async function waitForCompletion(
  sessionName: string,
  paths: CliPaths,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(paths.exit)) return;
    if (signal?.aborted) {
      // The CLI runs detached in tmux; without killing the session it would
      // keep burning tokens after the operator walked away from the turn.
      await killTmux(sessionName, paths);
      throw new InterruptedError();
    }
    // Poll faster than the CLI is slow, so ^C feels immediate.
    await Bun.sleep(200);
  }
  await killTmux(sessionName, paths);
  throw new Error(`tmux provider timed out after ${timeoutMs}ms; killed session ${sessionName}`);
}

async function killTmux(sessionName: string, paths: CliPaths): Promise<void> {
  await Bun.spawn(["tmux", "-S", paths.socket, "kill-session", "-t", sessionName], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited.catch(() => {});
}

export function formatCliFailure(
  providerName: string,
  command: string,
  status: number,
  stdout: string,
  stderr: string,
  runDir: string,
  format?: StreamFormat,
): string {
  // A JSONL stdout is hundreds of event lines; dumping it raw buries the one
  // line that explains the failure. Read the cause out of the stream instead.
  const cause = format ? failureCause(stdout) : undefined;
  const authHint = cause
    ? undefined
    : command === "claude"
      ? "Run `claude auth status` / `claude auth login` outside 0xAF-Re if this is an auth failure."
      : command === "codex"
        ? "Run `codex login status` / `codex login` outside 0xAF-Re if this is an auth failure. If OPENAI_API_KEY is bad, unset it so Codex can use ChatGPT login."
        : "Check the local CLI authentication and command configuration.";
  const raw = format ? undefined : stdout.trim() ? `stdout:\n${stripAnsi(stdout.trim())}` : undefined;
  return [
    `CLI provider '${providerName}' failed with exit ${status}.`,
    cause,
    authHint,
    `Logs: ${runDir}`,
    stderr.trim() ? `stderr:\n${stripAnsi(stderr.trim())}` : "",
    raw,
  ].filter(Boolean).join("\n");
}

/**
 * Explains a JSONL-stream failure from the terminal `result` event: the CLI
 * exits non-zero for reasons that have nothing to do with auth (an upstream
 * refusal, a hit rate limit, an execution error), and each needs a different
 * response from the operator.
 */
function failureCause(stdout: string): string | undefined {
  let result: Record<string, unknown> | undefined;
  let rateLimit: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type === "result" || parsed.is_error !== undefined) result = parsed;
    if (parsed.type === "rate_limit_event") {
      const info = parsed.rate_limit_info;
      if (info && typeof info === "object") rateLimit = info as Record<string, unknown>;
    }
  }
  if (!result) return undefined;

  const stop = typeof result.stop_reason === "string" ? result.stop_reason : undefined;
  const subtype = typeof result.subtype === "string" ? result.subtype : undefined;
  const message = typeof result.result === "string" ? result.result.trim() : "";
  const lines: string[] = [];

  if (stop === "refusal") {
    lines.push(
      "The upstream model refused this request (stop_reason=refusal). This is not an auth or config problem.",
      "0xAF-Re's system prompt frames every turn as reverse engineering, which can trip the refusal classifier on",
      "topics that would be answered normally otherwise. Try rephrasing, or route the turn elsewhere: /agent codex.",
    );
  } else if (subtype === "error_max_turns") {
    lines.push("The CLI stopped at its own max-turn limit before finishing.");
  } else if (stop) {
    lines.push(`The CLI ended with stop_reason=${stop}.`);
  } else if (subtype) {
    lines.push(`The CLI ended with subtype=${subtype}.`);
  }

  if (rateLimit?.overageStatus === "rejected" && typeof rateLimit.overageDisabledReason === "string") {
    lines.push(`Rate limit note: overage rejected (${rateLimit.overageDisabledReason}).`);
  }
  if (message) lines.push(`CLI message: ${clipLine(message)}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function clipLine(value: string): string {
  const flat = stripAnsi(value).split("\n")[0] ?? "";
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

async function cliAuthIssue(command: string, unsetEnv: string[]): Promise<string | undefined> {
  const args = cliAuthStatusArgs(command);
  if (!args) return undefined;
  try {
    const child = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: filteredEnv(unsetEnv),
    });
    const timedOut = await Promise.race([
      child.exited.then(status => ({ timedOut: false, status })),
      Bun.sleep(10_000).then(() => ({ timedOut: true, status: 124 })),
    ]);
    if (timedOut.timedOut) child.kill();
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch(() => ""),
      new Response(child.stderr).text().catch(() => ""),
    ]);
    if (timedOut.status === 0) return undefined;
    return stripAnsi(`${stdout}\n${stderr}`.trim()) || `status ${timedOut.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function cliAuthStatusArgs(command: string): string[] | undefined {
  if (command === "claude") return ["auth", "status", "--text"];
  if (command === "codex") return ["login", "status"];
  if (command === "grok") return ["version"];
  return undefined;
}

function formatCliAuthIssue(providerName: string, command: string, issue: string): string {
  if (command === "claude") {
    return [
      `CLI provider '${providerName}' is not authenticated.`,
      "Claude Code OAuth login is failing before 0xAF-Re can use it.",
      "Try: claude auth login --console",
      "Or: claude auth login --sso",
      "Or use API mode: /executor claude-api after setting ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN.",
      "Temporary bypass: /executor codex",
      `Status: ${issue}`,
    ].join("\n");
  }
  if (command === "codex") {
    return [
      `CLI provider '${providerName}' is not authenticated.`,
      "Run: codex login",
      "If OPENAI_API_KEY is stale, unset it before using Codex CLI login.",
      `Status: ${issue}`,
    ].join("\n");
  }
  return `CLI provider '${providerName}' is not authenticated. Status: ${issue}`;
}

function filteredEnv(unsetEnv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of unsetEnv) delete env[key];
  return env;
}

function replacePlaceholders(value: string, paths: CliPaths, workspace: string): string {
  return value
    .replaceAll("{prompt}", paths.prompt)
    .replaceAll("{output}", paths.output)
    .replaceAll("{stdout}", paths.stdout)
    .replaceAll("{stderr}", paths.stderr)
    .replaceAll("{runDir}", paths.runDir)
    .replaceAll("{workspace}", workspace);
}

function tmuxSessionName(providerName: string): string {
  return `0xaf-${safeName(providerName)}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`.slice(0, 80);
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid environment variable name: ${value}`);
  }
  return value;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
