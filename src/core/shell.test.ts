import { describe, expect, test } from "bun:test";
import { parseShellEscape, isShellEscape, runShellCommand, shellContextMessage } from "./shell";
import { createShellStreamWriter } from "../ui";
import type { ExecutionPolicy } from "../types";

const policy = (overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  allowWrites: false,
  allowNetwork: false,
  allowSensitive: false,
  commandTimeoutMs: 5000,
  maxReadBytes: 1024,
  maxToolOutputChars: 24_000,
  approvalMode: "safe",
  approvals: {},
  ...overrides,
});

describe("shell escape parsing", () => {
  test("recognizes and strips the marker", () => {
    expect(isShellEscape("!ls -la")).toBe(true);
    expect(isShellEscape("/help")).toBe(false);
    expect(parseShellEscape("!  ls -la  ")).toBe("ls -la");
    expect(parseShellEscape("!")).toBe("");
  });
});

describe("runShellCommand", () => {
  test("captures and streams stdout, keeping the exit code", async () => {
    const chunks: string[] = [];
    const result = await runShellCommand("printf 'a\\nb\\n'", {
      workspace: process.cwd(),
      policy: policy(),
      onChunk: chunk => chunks.push(`${chunk.stream}:${chunk.text}`),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("a\nb\n");
    expect(chunks.join("")).toContain("stdout:a\nb\n");
    expect(result.timedOut).toBe(false);
  });

  test("reports a non-zero exit and stderr instead of throwing", async () => {
    const result = await runShellCommand("echo boom >&2; exit 3", { workspace: process.cwd(), policy: policy() });
    expect(result.code).toBe(3);
    expect(result.stderr.trim()).toBe("boom");
  });

  test("refuses risky commands when nobody is there to approve them", async () => {
    await expect(runShellCommand("curl https://example.com", { workspace: process.cwd(), policy: policy() })).rejects.toThrow(
      /network command 'curl'/,
    );
    await expect(runShellCommand("rm -rf /tmp/x", { workspace: process.cwd(), policy: policy() })).rejects.toThrow(
      /destructive pattern/,
    );
  });

  test("asks instead of refusing when an approver is attached", async () => {
    const asked: string[] = [];
    const result = await runShellCommand("echo my-secret-token", {
      workspace: process.cwd(),
      policy: policy(),
      confirm: async request => {
        asked.push(request.summary);
        return "allow";
      },
    });
    expect(asked).toEqual(["echo my-secret-token"]);
    expect(result.stdout.trim()).toBe("my-secret-token");
  });

  test("a denied command never runs", async () => {
    await expect(
      runShellCommand("rm -rf /tmp/definitely-not", {
        workspace: process.cwd(),
        policy: policy(),
        confirm: async () => "deny",
      }),
    ).rejects.toThrow(/denied/i);
  });

  test("kills a command that outruns the policy timeout", async () => {
    const result = await runShellCommand("sleep 5", { workspace: process.cwd(), policy: policy({ commandTimeoutMs: 200 }) });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  test("stops on an abort signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runShellCommand("sleep 5", {
      workspace: process.cwd(),
      policy: policy(),
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  });
});

describe("shellContextMessage", () => {
  test("attributes the run to the operator and includes the output", () => {
    const text = shellContextMessage({
      command: "ls",
      code: 0,
      stdout: "chall.bin\n",
      stderr: "",
      ms: 12,
      timedOut: false,
      aborted: false,
    });
    expect(text).toContain("[operator shell]");
    expect(text).toContain("$ ls");
    expect(text).toContain("exit=0");
    expect(text).toContain("chall.bin");
    expect(text).not.toContain("stderr:");
  });

  test("truncates noisy output and notes a kill", () => {
    const text = shellContextMessage(
      { command: "yes", code: 143, stdout: "x".repeat(500), stderr: "", ms: 200, timedOut: true, aborted: false },
      64,
    );
    expect(text).toContain("killed: timed out");
    expect(text).toContain("[truncated 436 chars]");
  });

  test("says so when a command printed nothing", () => {
    const text = shellContextMessage({ command: "true", code: 0, stdout: "", stderr: "", ms: 1, timedOut: false, aborted: false });
    expect(text).toContain("(no output)");
  });
});

describe("createShellStreamWriter", () => {
  test("holds partial lines until their newline arrives", () => {
    const out: string[] = [];
    const writer = createShellStreamWriter(text => out.push(text));
    writer.push("stdout", "he");
    expect(out).toEqual([]);
    writer.push("stdout", "llo\nwor");
    expect(out).toEqual(["│ hello\n"]);
    writer.flush();
    expect(out).toEqual(["│ hello\n", "│ wor\n"]);
    writer.flush();
    expect(out).toHaveLength(2); // nothing buffered, nothing re-emitted
  });

  test("keeps stdout and stderr on separate line buffers", () => {
    const out: string[] = [];
    const writer = createShellStreamWriter(text => out.push(text));
    writer.push("stdout", "one");
    writer.push("stderr", "bad\n");
    writer.push("stdout", "\n");
    expect(out).toEqual(["│ bad\n", "│ one\n"]);
  });
});
