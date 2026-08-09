import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { previewOf, spillIfLarge } from "./output";
import { createReverseTools } from "./reverse-tools";
import type { ToolContext } from "../types";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function context(maxToolOutputChars: number): Promise<ToolContext> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-spill-"));
  dirs.push(dir);
  return {
    workspace: dir,
    sessionDir: dir,
    policy: {
      allowWrites: false,
      allowNetwork: false,
      allowSensitive: false,
      commandTimeoutMs: 10_000,
      maxReadBytes: 128 * 1024,
      maxToolOutputChars,
      approvalMode: "safe",
      approvals: {},
    },
  };
}

describe("previewOf", () => {
  test("passes short text through untouched", () => {
    expect(previewOf("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  test("keeps head and tail around the elision", () => {
    const preview = previewOf(`START${"x".repeat(200)}END`, 40);
    expect(preview.truncated).toBe(true);
    expect(preview.text.startsWith("START")).toBe(true);
    expect(preview.text.endsWith("END")).toBe(true);
    expect(preview.text).toContain("chars elided");
    expect(preview.text.length).toBeLessThan(120);
  });
});

describe("spillIfLarge", () => {
  test("leaves output within budget alone", async () => {
    const result = await spillIfLarge("small", { context: await context(1000), label: "ls" });
    expect(result.artifact).toBeUndefined();
    expect(result.text).toBe("small");
  });

  test("writes the full text to an artifact and points at it", async () => {
    const ctx = await context(200);
    const full = "line\n".repeat(500);
    const result = await spillIfLarge(full, { context: ctx, label: "objdump -d ./chall" });

    expect(result.artifact).toBeTruthy();
    expect(result.originalChars).toBe(full.length);
    expect(result.text).toContain("full output:");
    expect(result.text.length).toBeLessThan(500);
    expect(await fs.readFile(result.artifact!, "utf8")).toBe(full);
    expect(path.dirname(result.artifact!)).toBe(path.join(ctx.sessionDir, "artifacts"));
    expect(path.basename(result.artifact!)).toContain("objdump-d-chall");
  });
});

describe("run_command budget", () => {
  const runCommand = createReverseTools().find(tool => tool.name === "run_command")!;

  test("a noisy command no longer floods the transcript", async () => {
    const ctx = await context(2000);
    const result = await runCommand.execute({ command: "seq 1 20000" }, ctx);
    const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");

    expect(text.length).toBeLessThan(2500);
    const artifact = (result.details as { artifact?: string }).artifact;
    expect(artifact).toBeTruthy();
    expect((await fs.readFile(artifact!, "utf8")).trimEnd().endsWith("20000")).toBe(true);
    // The head/tail preview still shows both ends of the real output.
    expect(text).toContain("\n1\n");
    expect(text).toContain("20000");
  });
});
