import { describe, expect, test } from "bun:test";
import { APPROVAL_MODES, autoApproves, requestApproval, tierForRisk } from "./approval";
import { commandConcerns } from "./policy";
import type { ApprovalMode, ApprovalRequest, ExecutionPolicy, ToolContext } from "../types";

const policy = (overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  allowWrites: false,
  allowNetwork: false,
  allowSensitive: false,
  commandTimeoutMs: 1000,
  maxReadBytes: 1024,
  maxToolOutputChars: 24_000,
  approvalMode: "safe",
  approvals: {},
  ...overrides,
});

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  tool: "run_command",
  tier: "exec",
  summary: "ls",
  concerns: [],
  ...overrides,
});

function context(policyValue: ExecutionPolicy, answers: string[] = []): ToolContext & { asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    workspace: "/tmp",
    sessionDir: "/tmp",
    policy: policyValue,
    confirm: answers.length
      ? async requestValue => {
          asked.push(requestValue);
          return (answers.shift() ?? "deny") as never;
        }
      : undefined,
  };
}

describe("tiers", () => {
  test("network and execute both land in exec", () => {
    expect(tierForRisk("read")).toBe("read");
    expect(tierForRisk("write")).toBe("write");
    expect(tierForRisk("execute")).toBe("exec");
    expect(tierForRisk("network")).toBe("exec");
  });

  test("each mode auto-approves the documented tiers", () => {
    const table: Record<ApprovalMode, string[]> = {
      yolo: ["read", "write", "exec"],
      safe: ["read", "write", "exec"],
      write: ["read", "write"],
      "always-ask": ["read"],
    };
    for (const mode of APPROVAL_MODES) {
      for (const tier of ["read", "write", "exec"] as const) {
        expect(autoApproves(mode, tier)).toBe(table[mode].includes(tier));
      }
    }
  });
});

describe("requestApproval", () => {
  test("an ordinary command runs unattended in the default mode", async () => {
    await expect(requestApproval(request(), context(policy()))).resolves.toBeUndefined();
  });

  test("a risky command with no approver is refused, with the reason", async () => {
    const concerns = commandConcerns("rm -rf /tmp/x", policy());
    await expect(requestApproval(request({ concerns }), context(policy()))).rejects.toThrow(/destructive pattern/);
  });

  test("a risky command with an approver asks and can be allowed", async () => {
    const ctx = context(policy(), ["allow"]);
    await requestApproval(request({ concerns: commandConcerns("curl https://x.test", policy()) }), ctx);
    expect(ctx.asked).toHaveLength(1);
    expect(ctx.asked[0].concerns[0]).toContain("network command 'curl'");
  });

  test("'always' is remembered for the tier gate but not for safety concerns", async () => {
    const active = policy({ approvalMode: "always-ask" });
    const ctx = context(active, ["allow-always"]);
    await requestApproval(request(), ctx);
    expect(active.approvals.run_command).toBe("allow");

    // Same tool, now with a concern: it asks again despite the remembered allow.
    const ctx2 = context(active, ["deny"]);
    await expect(requestApproval(request({ concerns: ["destructive pattern /rm -rf/"] }), ctx2)).rejects.toThrow(/denied/i);
    expect(ctx2.asked).toHaveLength(1);
  });

  test("a remembered deny blocks without asking", async () => {
    const active = policy({ approvals: { run_command: "deny" } });
    const ctx = context(active, ["allow"]);
    await expect(requestApproval(request(), ctx)).rejects.toThrow(/denied for this session/);
    expect(ctx.asked).toHaveLength(0);
  });

  test("yolo runs even risky commands without asking", async () => {
    const ctx = context(policy({ approvalMode: "yolo" }), ["deny"]);
    await requestApproval(request({ concerns: ["destructive pattern /rm -rf/"] }), ctx);
    expect(ctx.asked).toHaveLength(0);
  });

  test("write mode stops for exec tools even with no concerns", async () => {
    const ctx = context(policy({ approvalMode: "write" }), ["allow"]);
    await requestApproval(request(), ctx);
    expect(ctx.asked).toHaveLength(1);
    await expect(requestApproval(request({ tier: "write", tool: "write_file" }), context(policy({ approvalMode: "write" })))).resolves.toBeUndefined();
  });

  test("allowing network in the policy removes the concern entirely", () => {
    expect(commandConcerns("curl https://x.test", policy())).toHaveLength(1);
    expect(commandConcerns("curl https://x.test", policy({ allowNetwork: true }))).toHaveLength(0);
  });
});
