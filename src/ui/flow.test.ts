import { describe, expect, test } from "bun:test";
import { Canvas } from "./canvas";
import { createFlowModel, isVizMode, renderFlowPlain, VIZ_MODES } from "./flow";
import { traceEnd, traceEvent } from "./trace";
import { displayWidth } from "./theme";
import type { LoopEvent } from "../core/agent-loop";

const WIDTH = 72;

const send: LoopEvent = {
  type: "wire",
  phase: "send",
  provider: "deepseek",
  model: "deepseek-chat",
  endpoint: "https://api.deepseek.com/v1/chat/completions",
  messages: 3,
  tokens: 3600,
  tools: 23,
};

const recvWithCalls: LoopEvent = {
  type: "wire",
  phase: "recv",
  provider: "deepseek",
  ms: 2100,
  ok: true,
  usage: { output: 96, cacheRead: 3500 },
  toolCalls: 1,
  textChars: 0,
};

describe("Canvas", () => {
  test("places text and clips at the edges instead of wrapping", () => {
    const canvas = new Canvas(10, 2);
    canvas.put(0, 2, "abc");
    canvas.put(0, 8, "xyz"); // runs past the right edge
    canvas.put(5, 0, "dropped"); // past the bottom
    expect(canvas.plain()).toEqual(["  abc   xy", ""]);
  });

  test("render emits the same characters as plain", () => {
    const canvas = new Canvas(12, 1);
    canvas.put(0, 0, "[you]", "accent", true);
    canvas.put(0, 6, "▶", "rule");
    // Colour is environment-dependent; the glyphs are not.
    expect(stripAnsi(canvas.render()[0])).toBe(canvas.plain()[0]);
  });
});

describe("flow model", () => {
  test("stays silent until a turn starts", () => {
    const flow = createFlowModel("deepseek");
    expect(renderFlowPlain(flow.state, WIDTH)).toEqual([]);
  });

  test("draws the request path once a request is on the wire", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    const rows = renderFlowPlain(flow.state, WIDTH);

    expect(rows[0]).toContain("[you]");
    expect(rows[0]).toContain("[ctx]");
    expect(rows[0]).toContain("((deepseek))");
    expect(rows[1]).toContain("3msg");
    expect(rows[1]).toContain("3.6ktok");
    expect(rows[1]).toContain("sending");
    // No tools have happened yet, so the lower half is not drawn.
    expect(rows.slice(2).join("")).toBe("");
  });

  test("opens the tool path when the model asks for calls", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    flow.apply(recvWithCalls);
    flow.apply({ type: "tool_start", name: "run_command", args: { command: "strings ./chall" } });
    const rows = renderFlowPlain(flow.state, WIDTH);

    expect(rows[2]).toContain("▼");
    expect(rows[3]).toContain("[tools]");
    expect(rows[3]).toContain("[calls×1]");
    expect(rows[4]).toContain("run_command");
  });

  test("marks the feedback leg once a tool result comes back", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    flow.apply(recvWithCalls);
    flow.apply({ type: "tool_start", name: "run_command", args: {} });
    flow.apply({ type: "tool_end", name: "run_command", ok: true, ms: 420, preview: "ok" });

    expect(flow.state.toolsOk).toBe(1);
    expect(flow.state.pendingCalls).toBe(0);
    // Results feed the next request, so the loop is back at "send".
    expect(flow.state.stage).toBe("send");
    const rows = renderFlowPlain(flow.state, WIDTH);
    expect(rows[2]).toContain("▲");
    expect(rows[4]).toContain("✓1");
  });

  test("packets advance on tick and are cleared when the leg goes quiet", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    for (let i = 0; i < 12; i++) flow.tick(flow.state.since + i * 90);
    expect(flow.state.packets.ctxToModel.length).toBeGreaterThan(0);
    expect(Math.max(...flow.state.packets.ctxToModel)).toBeGreaterThan(0);

    flow.apply(recvWithCalls);
    expect(flow.state.packets.ctxToModel).toEqual([]);
  });

  test("a non-streaming provider still shows progress: send becomes wait", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek", 1000);
    flow.apply(send, 1000);
    flow.tick(1100);
    expect(flow.state.stage).toBe("send");
    flow.tick(2000);
    expect(flow.state.stage).toBe("wait");
  });

  test("a failed request shows the reason", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    flow.apply({ type: "wire", phase: "recv", provider: "deepseek", ms: 300, ok: false, toolCalls: 0, textChars: 0, error: "401" });
    expect(flow.state.stage).toBe("error");
    expect(renderFlowPlain(flow.state, WIDTH)[1]).toContain("401");
  });

  test("hides itself on a terminal too narrow for the diagram", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    expect(renderFlowPlain(flow.state, 40)).toEqual([]);
    expect(renderFlowPlain(flow.state, 46).length).toBeGreaterThan(0);
  });

  test("viz modes are validated", () => {
    expect(VIZ_MODES).toContain("full");
    expect(isVizMode("trace")).toBe(true);
    expect(isVizMode("sparkle")).toBe(false);
  });
});


describe("plan node", () => {
  const snapshot = (statuses: Array<"pending" | "in_progress" | "completed">) => ({
    source: "update_plan",
    updatedAt: 0,
    steps: statuses.map((status, index) => ({ text: `step ${index}`, status })),
  });

  test("shows counts and a bar, never step text", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    flow.apply({ type: "plan", snapshot: snapshot(["completed", "in_progress", "pending"]) });
    const rows = renderFlowPlain(flow.state, WIDTH);
    expect(rows[3]).toContain("[plan 1/3]");
    expect(rows[4].trim()).toMatch(/^[▰▱]+$/);
    expect(rows.join("")).not.toContain("step 0");
  });

  test("never collides with the tools box at the narrowest supported width", () => {
    for (const provider of ["p", "deepseek", "claude-code-cli-long"]) {
      for (const width of [46, 47, 60, 80, 100, 120]) {
        const flow = createFlowModel(provider);
        flow.begin(provider);
        flow.apply({ ...send, provider });
        flow.apply({ type: "plan", snapshot: snapshot(Array(65).fill("completed")) });
        flow.apply({ type: "tool_start", name: "run_command", args: {} });
        const rows = renderFlowPlain(flow.state, width);
        for (const row of rows) {
          expect({ provider, width, len: row.length }).toEqual({ provider, width, len: Math.min(row.length, width) });
        }
        // The plan label must end before the tools box starts.
        const tools = rows[3].indexOf("[tools]");
        const plan = rows[3].indexOf("[", 0);
        if (tools > 0 && plan >= 0 && plan < tools) {
          expect(rows[3].slice(0, tools)).toMatch(/\]\s*$/);
        }
      }
    }
  });

  test("a seeded plan does not flash as newly opened", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.seedPlan(snapshot(["completed", "pending"]));
    expect(flow.state.plan).toEqual({ done: 1, total: 2, source: "update_plan" });
    expect(flow.state.planFrame).toBeUndefined();
    expect(flow.state.planKind).toBeUndefined();
  });

  test("begin() carries the plan and clears everything else", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    flow.apply({ type: "plan", snapshot: snapshot(["completed"]) });
    flow.apply({ type: "tool_start", name: "run_command", args: {} });
    flow.apply({ type: "compaction", tokensBefore: 100, tokensAfter: 50, droppedMessages: 2, elidedToolResults: 1 });
    for (let i = 0; i < 20; i++) flow.tick(flow.state.since + i * 90);

    flow.begin("deepseek");
    // Carried: the task list outlives the turn.
    expect(flow.state.plan).toEqual({ done: 1, total: 1, source: "update_plan" });
    // Cleared: everything else, including the flash bookkeeping that would
    // otherwise make frame - planFrame negative and light the node forever.
    expect(flow.state.planFrame).toBeUndefined();
    expect(flow.state.planKind).toBeUndefined();
    expect(flow.state.activeTool).toBeUndefined();
    expect(flow.state.toolMs).toBeUndefined();
    expect(flow.state.compacted).toBeUndefined();
    expect(flow.state.error).toBeUndefined();
    expect(flow.state.frame).toBe(0);
  });

  test("a wide-character tool name cannot overflow the row", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek");
    flow.apply(send);
    flow.apply({ type: "plan", snapshot: snapshot(["in_progress"]) });
    flow.apply({ type: "tool_start", name: "定位校验函数并导出符号表内容", args: {} });
    const rows = renderFlowPlain(flow.state, 60);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(60);
  });
});

describe("trace lines", () => {
  const options = { startedAt: 1_000_000, now: 1_000_004, width: 100 };

  test("a request shows where it is going and what is on it", () => {
    const lines = traceEvent(send, options).map(stripAnsi);
    expect(lines[0]).toContain("t+ 0.004");
    expect(lines[0]).toContain("POST https://api.deepseek.com/v1/chat/completions");
    expect(lines[1]).toContain("model=deepseek-chat in=3.6k msgs=3 tools=23");
  });

  test("a response shows tokens, calls, and a scaled duration bar", () => {
    const [line] = traceEvent(recvWithCalls, { ...options, slowestMs: 4200 }).map(stripAnsi);
    expect(line).toContain("200");
    expect(line).toContain("out=96");
    expect(line).toContain("cache=3.5k");
    expect(line).toContain("calls=1");
    // Half of the slowest request → half the bar filled.
    expect(line).toContain("█████░░░░░");
  });

  test("a failed response reports the error instead of a bar", () => {
    const [line] = traceEvent(
      { type: "wire", phase: "recv", provider: "p", ms: 12, ok: false, toolCalls: 0, textChars: 0, error: "boom" },
      options,
    ).map(stripAnsi);
    expect(line).toContain("boom");
    expect(line).not.toContain("█");
  });

  test("tool calls and results each get one line", () => {
    const start = traceEvent({ type: "tool_start", name: "grep", args: { pattern: "flag{" } }, options).map(stripAnsi);
    const end = traceEvent({ type: "tool_end", name: "grep", ok: false, ms: 15, preview: "no matches" }, options).map(stripAnsi);
    expect(start[0]).toContain("⚙ grep");
    expect(start[0]).toContain("pattern=flag{");
    expect(end[0]).toContain("✗");
    expect(end[0]).toContain("no matches");
  });

  test("compaction is visible in the trace", () => {
    const [line] = traceEvent(
      { type: "compaction", tokensBefore: 52000, tokensAfter: 31000, droppedMessages: 12, elidedToolResults: 3 },
      options,
    ).map(stripAnsi);
    expect(line).toContain("52k→31k tok");
    expect(line).toContain("12 dropped");
  });

  test("noisy events produce no permanent line", () => {
    expect(traceEvent({ type: "progress", progress: { kind: "thinking", text: "…" } }, options)).toEqual([]);
    expect(traceEvent({ type: "turn", turn: 1, provider: "p" }, options)).toEqual([]);
    expect(traceEvent({ type: "turn", turn: 2, provider: "p" }, options)).toHaveLength(1);
  });

  test("the closing line reports interruption when the turn was cut short", () => {
    expect(stripAnsi(traceEnd({ startedAt: 0, ms: 4200, provider: "codex" }))).toContain("turn complete");
    expect(stripAnsi(traceEnd({ startedAt: 0, ms: 4200, provider: "codex", interrupted: true }))).toContain("interrupted");
  });
});

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
