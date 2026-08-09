// Operator shell escape: a REPL line starting with `!` runs directly in the
// workspace instead of going to a model. The same execution policy that guards
// the agent's run_command tool applies here, so `--allow-network` /
// `--allow-sensitive` mean the same thing whoever types the command.

import { commandConcerns } from "../security/policy";
import { requestApproval } from "../security/approval";
import { streamProcess } from "../tools/process";
import type { ExecutionPolicy, ToolContext } from "../types";
import { clip } from "../utils";

/** Output beyond this is truncated before it is shared with the model. */
export const SHELL_CONTEXT_MAX_CHARS = 8000;

export interface ShellRunOptions {
  workspace: string;
  policy: ExecutionPolicy;
  signal?: AbortSignal;
  confirm?: ToolContext["confirm"];
  /** Set when the caller already ran `assertShellCommandAllowed`, so it is not asked twice. */
  preApproved?: boolean;
  onChunk?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export interface ShellRunResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  aborted: boolean;
}

/** True for REPL lines that are a shell escape rather than a prompt. */
export function isShellEscape(line: string): boolean {
  return line.startsWith("!");
}

/** Strips the `!` marker. Returns "" when the line is just the marker. */
export function parseShellEscape(line: string): string {
  return line.startsWith("!") ? line.slice(1).trim() : line.trim();
}

/**
 * Clears the command with the policy before any output is drawn. The operator
 * typed this one themselves, so a tripped safety pattern is a question ("really
 * run that?"), not a refusal — unless nobody is there to answer.
 */
export async function assertShellCommandAllowed(
  command: string,
  policy: ExecutionPolicy,
  confirm?: ToolContext["confirm"],
): Promise<void> {
  await requestApproval(
    { tool: "!shell", tier: "exec", summary: command, concerns: commandConcerns(command, policy) },
    { workspace: ".", sessionDir: ".", policy, confirm },
  );
}

export async function runShellCommand(command: string, options: ShellRunOptions): Promise<ShellRunResult> {
  if (!options.preApproved) await assertShellCommandAllowed(command, options.policy, options.confirm);
  const started = Date.now();
  const result = await streamProcess(["bash", "-c", command], {
    cwd: options.workspace,
    timeoutMs: options.policy.commandTimeoutMs,
    signal: options.signal,
    onChunk: options.onChunk,
  });
  return {
    command,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    ms: Date.now() - started,
    timedOut: result.timedOut,
    aborted: result.aborted,
  };
}

/**
 * The transcript entry recorded for a shell escape. It is attributed to the
 * operator so the model treats it as observed workspace state rather than as an
 * instruction, and it is truncated so a noisy command cannot swamp the context.
 */
export function shellContextMessage(result: ShellRunResult, maxChars = SHELL_CONTEXT_MAX_CHARS): string {
  const lines = [
    "[operator shell] I ran this command myself in the workspace; here is the output for your context.",
    "",
    `$ ${result.command}`,
    `exit=${result.code}${statusNote(result)}`,
  ];
  if (result.stdout.trim()) lines.push("", "stdout:", clip(result.stdout.trimEnd(), maxChars));
  if (result.stderr.trim()) lines.push("", "stderr:", clip(result.stderr.trimEnd(), Math.min(maxChars, 2000)));
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push("", "(no output)");
  return lines.join("\n");
}

function statusNote(result: ShellRunResult): string {
  if (result.timedOut) return " (killed: timed out)";
  if (result.aborted) return " (killed: cancelled by operator)";
  return "";
}
