import { textBlock } from "../utils";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runProcess(
  command: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal },
): Promise<CommandResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), options.timeoutMs);
  // The operator's ^C has to reach the child too, or an interrupted turn leaves
  // a long `strings`/`objdump` running until its timeout.
  const onAbort = () => controller.abort("cancelled");
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
      env: options.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export interface StreamedCommandResult extends CommandResult {
  /** The command was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** The caller's signal fired (^C in the REPL) and the child was killed. */
  aborted: boolean;
}

export interface StreamProcessOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Called with each decoded chunk as it arrives, for live echoing. */
  onChunk?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

/**
 * Like {@link runProcess}, but hands output to the caller as it arrives instead
 * of only at exit, so a long command narrates itself. The full text is still
 * captured and returned.
 */
export async function streamProcess(
  command: string[],
  options: StreamProcessOptions,
): Promise<StreamedCommandResult> {
  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("timeout");
  }, options.timeoutMs);
  const onAbort = () => {
    aborted = true;
    controller.abort("cancelled");
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
      env: options.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      pump(proc.stdout, "stdout", options.onChunk),
      pump(proc.stderr, "stderr", options.onChunk),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut, aborted };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  onChunk: StreamProcessOptions["onChunk"],
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  const take = (piece: string) => {
    if (!piece) return;
    text += piece;
    onChunk?.({ stream: name, text: piece });
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      take(decoder.decode(value, { stream: true }));
    }
    take(decoder.decode());
  } catch {
    // A killed child (timeout or ^C) tears the pipe down mid-read; whatever was
    // already decoded is still worth returning.
  }
  return text;
}

/** The transcript rendering of one command run: header, exit code, streams. */
export function commandText(name: string, result: CommandResult): string {
  const lines = [
    `$ ${name}`,
    `exit=${result.code}`,
    result.stdout ? `\nstdout:\n${result.stdout}` : "",
    result.stderr ? `\nstderr:\n${result.stderr}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export function commandOutput(name: string, result: CommandResult) {
  return [textBlock(commandText(name, result))];
}
