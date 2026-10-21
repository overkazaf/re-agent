import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFridaRuntimeTools } from "./frida-runtime-tools";
import type { ToolContext } from "../types";

const tools = createFridaRuntimeTools();

function getTool(name: string) {
  const found = tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function tempContext(approvalMode: ToolContext["policy"]["approvalMode"] = "safe"): Promise<ToolContext> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-frida-"));
  return {
    workspace,
    sessionDir: workspace,
    policy: { allowWrites: false, allowNetwork: false, allowSensitive: false, commandTimeoutMs: 5000, maxReadBytes: 64 * 1024, maxToolOutputChars: 24_000, approvalMode, approvals: {} },
  };
}

// Every assertion below fires before frida would be spawned, so these tests
// stay deterministic with no device, and whether or not the machine happens to
// have a (working or broken) frida on PATH.

describe("frida_spawn", () => {
  test("refuses hook scripts outside the workspace", async () => {
    const context = await tempContext();
    expect(getTool("frida_spawn").execute({ package: "com.example.app", script: "../outside.js" }, context))
      .rejects.toThrow("Path escapes workspace");
  });

  test("reports a missing hook script by its workspace-relative name", async () => {
    const context = await tempContext();
    expect(getTool("frida_spawn").execute({ package: "com.example.app", script: "hooks/nope.js" }, context))
      .rejects.toThrow("Hook script not found: hooks/nope.js");
  });
});

describe("frida_run_snippet", () => {
  test("runs the safety-pattern pass over the target package in safe mode", async () => {
    // `safe` auto-approves exec calls only when they are unremarkable; a
    // package tripping a sensitive pattern must be blocked, not waved through.
    const context = await tempContext("safe");
    expect(getTool("frida_run_snippet").execute({ package: "com.app.password", code: "x();" }, context))
      .rejects.toThrow(/Blocked by policy/);
  });

  test("keeps a clean package free of concerns", async () => {
    // always-ask with no operator attached refuses every call, but the refusal
    // message distinguishes "needs approval" from "Blocked by policy" — a
    // false concern would phrase this as the latter.
    const context = await tempContext("always-ask");
    expect(getTool("frida_run_snippet").execute({ package: "com.example.app", code: "x();" }, context))
      .rejects.toThrow(/needs approval/);
  });
});
