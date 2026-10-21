import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createPwnTools } from "./pwn-tools";
import type { ToolContext } from "../types";

const tools = createPwnTools();

function getTool(name: string) {
  const found = tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map(block => block.text ?? "").join("");

async function tempContext(): Promise<{ context: ToolContext; workspace: string }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "0afx-pwn-tools-"));
  return {
    workspace,
    context: {
      workspace,
      sessionDir: workspace,
      policy: {
        allowWrites: true,
        allowNetwork: false,
        allowSensitive: false,
        commandTimeoutMs: 1000,
        maxReadBytes: 64 * 1024,
        maxToolOutputChars: 24_000,
        approvalMode: "safe",
        approvals: {},
      },
    },
  };
}

describe("patch_binary", () => {
  test("writes a patched copy and leaves the source untouched", async () => {
    const { context, workspace } = await tempContext();
    const src = path.join(workspace, "prog.bin");
    await fs.writeFile(src, Buffer.from("AAAABBBBCCCC", "ascii"));

    const result = await getTool("patch_binary").execute(
      { path: "prog.bin", offset: 4, bytes: "9090" },
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("offset: 0x4 (4)");

    const patched = await fs.readFile(path.join(workspace, "prog.patched.bin"));
    expect(patched.toString("hex")).toBe("414141419090424243434343");
    const original = await fs.readFile(src);
    expect(original.toString("ascii")).toBe("AAAABBBBCCCC");
  });

  test("rejects a fractional offset with a clear error instead of a raw RangeError", async () => {
    const { context, workspace } = await tempContext();
    await fs.writeFile(path.join(workspace, "prog.bin"), Buffer.from("AAAABBBBCCCC", "ascii"));

    let message = "";
    try {
      await getTool("patch_binary").execute({ path: "prog.bin", offset: 4.5, bytes: "90" }, context);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Invalid offset: 4.5");
  });

  test("rejects negative and non-finite offsets", async () => {
    const { context, workspace } = await tempContext();
    await fs.writeFile(path.join(workspace, "prog.bin"), Buffer.from("AAAABBBBCCCC", "ascii"));

    for (const offset of [-1, "0x-10"]) {
      let message = "";
      try {
        await getTool("patch_binary").execute({ path: "prog.bin", offset, bytes: "90" }, context);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Invalid offset");
    }
  });
});

describe("pattern_create / pattern_offset", () => {
  test("round-trips an ASCII needle back to its offset", async () => {
    const created = await getTool("pattern_create").execute({ length: 500 }, { workspace: "/tmp", sessionDir: "/tmp", policy: { allowWrites: false, allowNetwork: false, allowSensitive: false, commandTimeoutMs: 1000, maxReadBytes: 1024, maxToolOutputChars: 24_000, approvalMode: "safe", approvals: {} } });
    const patternText = text(created);
    const patternLine = patternText.split("\n").find(line => line.startsWith("Aa0"));
    expect(patternLine).toBeDefined();
    const needle = patternLine!.slice(100, 104);

    const found = await getTool("pattern_offset").execute({ value: needle, length: 500 }, { workspace: "/tmp", sessionDir: "/tmp", policy: { allowWrites: false, allowNetwork: false, allowSensitive: false, commandTimeoutMs: 1000, maxReadBytes: 1024, maxToolOutputChars: 24_000, approvalMode: "safe", approvals: {} } });
    expect(text(found)).toContain("offset = 100 (0x64)");
  });
});
