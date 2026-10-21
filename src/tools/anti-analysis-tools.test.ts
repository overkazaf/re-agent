import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAntiAnalysisTools } from "./anti-analysis-tools";
import type { ToolContext } from "../types";

const anti = createAntiAnalysisTools().find(candidate => candidate.name === "detect_anti_analysis")!;

// A 1ms command timeout kills the rust/oxaf-parse bridge before it can answer,
// so these tests exercise the pure-JS scanner deterministically.
async function tempContext(): Promise<ToolContext> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-anti-"));
  return {
    workspace,
    sessionDir: workspace,
    policy: { allowWrites: false, allowNetwork: false, allowSensitive: false, commandTimeoutMs: 1, maxReadBytes: 1024 * 1024, maxToolOutputChars: 24_000, approvalMode: "safe", approvals: {} },
  };
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map(block => block.text ?? "").join("");

describe("detect_anti_analysis (JS fallback)", () => {
  test("flags the Frida default port 27042 (0x69A2) in both byte orders", async () => {
    const context = await tempContext();
    await fs.writeFile(path.join(context.workspace, "le.bin"), Buffer.concat([Buffer.alloc(64, 0x41), Buffer.from([0xa2, 0x69])]));
    await fs.writeFile(path.join(context.workspace, "be.bin"), Buffer.concat([Buffer.from([0x69, 0xa2]), Buffer.alloc(64, 0x42)]));
    for (const file of ["le.bin", "be.bin"]) {
      const result = await anti.execute({ path: file }, context);
      expect(result.isError).toBeFalsy();
      const categories = (result.details as { categories: Record<string, number> }).categories;
      expect(categories["ANTI-FRIDA"]).toBe(1);
      expect(text(result)).toContain("port 27042");
    }
  });

  test("does not flag 0x69B2, which is not the Frida port", async () => {
    const context = await tempContext();
    await fs.writeFile(path.join(context.workspace, "other.bin"), Buffer.concat([Buffer.alloc(64, 0x41), Buffer.from([0xb2, 0x69])]));
    const result = await anti.execute({ path: "other.bin" }, context);
    const categories = (result.details as { categories: Record<string, number> }).categories;
    expect(categories["ANTI-FRIDA"]).toBe(0);
  });
});
