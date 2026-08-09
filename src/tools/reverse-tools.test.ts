import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createReverseTools } from "./reverse-tools";
import type { PlanStep, PlanUpdateMeta, ToolContext } from "../types";

const tool = createReverseTools().find(candidate => candidate.name === "update_plan")!;
const tools = createReverseTools();

function contextWithCapture(): { context: ToolContext; captured: Array<{ steps: PlanStep[]; meta: PlanUpdateMeta }> } {
  const captured: Array<{ steps: PlanStep[]; meta: PlanUpdateMeta }> = [];
  return {
    captured,
    context: {
      workspace: "/tmp",
      sessionDir: "/tmp",
      policy: { allowWrites: false, allowNetwork: false, allowSensitive: false, commandTimeoutMs: 1000, maxReadBytes: 1024, maxToolOutputChars: 24_000, approvalMode: "safe", approvals: {} },
      onPlan: (steps, meta) => captured.push({ steps, meta }),
    },
  };
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map(block => block.text ?? "").join("");

async function tempContext(): Promise<ToolContext> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-tools-"));
  return {
    workspace,
    sessionDir: workspace,
    policy: { allowWrites: false, allowNetwork: false, allowSensitive: false, commandTimeoutMs: 1000, maxReadBytes: 64 * 1024, maxToolOutputChars: 24_000, approvalMode: "safe", approvals: {} },
  };
}

function getTool(name: string) {
  const found = tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("update_plan", () => {
  test("publishes the plan and reports progress", async () => {
    const { context, captured } = contextWithCapture();
    const result = await tool.execute(
      {
        plan: [
          { step: "triage", status: "completed" },
          { step: "unpack", status: "in_progress" },
          { step: "solve", status: "pending" },
        ],
        explanation: "static first",
      },
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    expect(captured[0].steps.map(step => step.text)).toEqual(["triage", "unpack", "solve"]);
    expect(captured[0].meta).toEqual({ source: "update_plan", note: "static first" });
    expect(text(result)).toContain("1/3 done");
    expect(result.details).toEqual({ total: 3, done: 1 });
  });

  test("accepts a plan flattened to bare strings", async () => {
    const { context, captured } = contextWithCapture();
    const result = await tool.execute({ plan: ["triage", "  unpack  ", ""] }, context);
    expect(result.isError).toBeFalsy();
    expect(captured[0].steps).toEqual([
      { text: "triage", status: "pending" },
      { text: "unpack", status: "pending" },
    ]);
  });

  test("coerces an unknown status to pending", async () => {
    const { context, captured } = contextWithCapture();
    await tool.execute({ plan: [{ step: "triage", status: "done-ish" }] }, context);
    expect(captured[0].steps[0].status).toBe("pending");
  });

  test("errors when nothing usable survives coercion", async () => {
    const { context, captured } = contextWithCapture();
    for (const plan of [[], [{ step: "   " }], "not-an-array", undefined]) {
      const result = await tool.execute({ plan }, context);
      expect(result.isError).toBe(true);
    }
    expect(captured).toHaveLength(0);
  });

  test("works when the host installed no onPlan sink", async () => {
    const { context } = contextWithCapture();
    const result = await tool.execute({ plan: [{ step: "triage", status: "pending" }] }, { ...context, onPlan: undefined });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("0/1 done");
  });

  test("a blank explanation does not defeat the tracker's note comparison", async () => {
    const { context, captured } = contextWithCapture();
    await tool.execute({ plan: [{ step: "triage", status: "pending" }], explanation: "   " }, context);
    expect(captured[0].meta.note).toBeUndefined();
  });
});

describe("ctf reverse tools", () => {
  test("ctf_decode decodes base64 candidates", async () => {
    const context = await tempContext();
    const result = await getTool("ctf_decode").execute({ input: "ZmxhZ3tkZW1vfQ==", mode: "base64" }, context);
    expect(text(result)).toContain("flag{demo}");
  });

  test("ctf_triage classifies useful CTF strings", async () => {
    const context = await tempContext();
    await fs.writeFile(path.join(context.workspace, "artifact.txt"), "flag{demo}\nAES token\nhttps://ctf.example.invalid\n/bin/sh\n", "utf8");
    const result = await getTool("ctf_triage").execute({ path: "artifact.txt" }, context);
    const output = text(result);
    expect(output).toContain("flag-like");
    expect(output).toContain("crypto-codec");
    expect(output).toContain("pwn-re");
  });

  test("find_bytes reports offsets for text needles", async () => {
    const context = await tempContext();
    await fs.writeFile(path.join(context.workspace, "carrier.bin"), Buffer.from("abc%PDF-1.7xyz"));
    const result = await getTool("find_bytes").execute({ path: "carrier.bin", needle: "%PDF-" }, context);
    expect(text(result)).toContain("0x00000003");
  });

  test("carve_artifacts finds embedded signatures", async () => {
    const context = await tempContext();
    await fs.writeFile(path.join(context.workspace, "carrier.bin"), Buffer.concat([
      Buffer.from("prefix"),
      Buffer.from("%PDF-1.7\n"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    ]));
    const result = await getTool("carve_artifacts").execute({ path: "carrier.bin" }, context);
    const output = text(result);
    expect(output).toContain("PDF");
    expect(output).toContain("ZIP/APK/JAR");
  });

  test("frida_hook_template generates Java hooks", async () => {
    const context = await tempContext();
    const result = await getTool("frida_hook_template").execute(
      { platform: "android_java", target: "com.example.Crypto", method: "sign", signature: "java.lang.String" },
      context,
    );
    const output = text(result);
    expect(output).toContain('Java.use("com.example.Crypto")');
    expect(output).toContain('Target["sign"].overload("java.lang.String")');
  });
});
