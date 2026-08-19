import { describe, expect, test } from "bun:test";
import { composePane } from "./live";
import { createFlowModel } from "./flow";
import type { HudModel } from "./hud";
import type { PlanSnapshot } from "../types";

const plan: PlanSnapshot = {
  source: "codex",
  updatedAt: 0,
  steps: [
    { text: "locate the check function", status: "completed", startedAt: 1000, completedAt: 9200 },
    { text: "dump the key schedule", status: "in_progress", startedAt: 9200 },
    { text: "verify the flag", status: "pending" },
  ],
};

function hud(overrides: Partial<HudModel> = {}): HudModel {
  return {
    label: "deepseek",
    phase: "working",
    frame: "⠋",
    elapsedMs: 2500,
    now: 1_000_000,
    width: 100,
    stats: { output: 120 },
    spark: [],
    plan,
    thinking: "",
    thinkingWindow: 3,
    maxRows: 0,
    ...overrides,
  };
}

function flowState() {
  const flow = createFlowModel("deepseek");
  flow.begin("deepseek", 1_000_000);
  flow.apply(
    {
      type: "wire",
      phase: "send",
      provider: "deepseek",
      model: "deepseek-chat",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      messages: 3,
      tokens: 3600,
      tools: 23,
    },
    1_000_000,
  );
  return flow.state;
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const hasPlanRow = (rows: string[]) => rows.some(row => /locate the check function/.test(strip(row)));

describe("composePane height budget", () => {
  // The erase walk in live.ts steps back exactly as many lines as were drawn,
  // so overflowing the budget desynchronises the whole pane permanently.
  test("never draws more lines than the budget, at any terminal height", () => {
    for (let budget = 1; budget <= 30; budget++) {
      const rows = composePane({ now: 1_000_000, width: 100, budget, flow: flowState(), hud: hud() });
      expect({ budget, lines: rows.length }).toEqual({ budget, lines: Math.min(rows.length, budget) });
    }
  });

  test("drops the diagram rather than the task list when space is tight", () => {
    // 9 rows: 5 for the diagram would leave 4 for the HUD — the floor, but the
    // plan would be squeezed. The diagram goes instead.
    const tight = composePane({ now: 1_000_000, width: 100, budget: 8, flow: flowState(), hud: hud() });
    expect(tight.some(row => strip(row).includes("[you]"))).toBe(false);
    expect(hasPlanRow(tight)).toBe(true);

    const roomy = composePane({ now: 1_000_000, width: 100, budget: 20, flow: flowState(), hud: hud() });
    expect(roomy.some(row => strip(row).includes("[you]"))).toBe(true);
    expect(hasPlanRow(roomy)).toBe(true);
  });

  test("keeps showing the task list on a short terminal", () => {
    for (const budget of [8, 10, 12, 16]) {
      const rows = composePane({ now: 1_000_000, width: 100, budget, flow: flowState(), hud: hud() });
      expect({ budget, plan: hasPlanRow(rows) }).toEqual({ budget, plan: true });
    }
  });

  test("an unknown terminal height keeps both layers", () => {
    const rows = composePane({
      now: 1_000_000,
      width: 100,
      budget: Number.POSITIVE_INFINITY,
      flow: flowState(),
      hud: hud({ maxRows: 40 }),
    });
    expect(rows.some(row => strip(row).includes("[you]"))).toBe(true);
    expect(hasPlanRow(rows)).toBe(true);
  });

  test("works with no flow layer at all", () => {
    const rows = composePane({ now: 1_000_000, width: 100, budget: 12, hud: hud() });
    expect(rows.length).toBeLessThanOrEqual(12);
    expect(hasPlanRow(rows)).toBe(true);
  });

  test("labels the dashboard sections FLOW / TOOLS / PLAN / THINK / TELE", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek", 1_000_000);
    flow.apply(
      {
        type: "wire",
        phase: "send",
        provider: "deepseek",
        model: "deepseek-chat",
        endpoint: "https://api.deepseek.com/v1/chat/completions",
        messages: 1,
        tokens: 10,
        tools: 3,
      },
      1_000_000,
    );
    flow.apply(
      { type: "wire", phase: "recv", provider: "deepseek", ms: 10, ok: true, usage: {}, toolCalls: 1, textChars: 0 },
      1_000_000,
    );
    flow.apply({ type: "tool_start", name: "run_command", args: { command: "strings ./chall" } }, 1_000_000);
    const rows = composePane({
      now: 1_000_000,
      width: 100,
      budget: 30,
      flow: flow.state,
      hud: hud({ thinking: "working through the key schedule" }),
    });
    const text = rows.map(strip).join("\n");
    expect(text).toContain("FLOW");
    expect(text).toContain("TOOLS");
    expect(text).toContain("PLAN");
    expect(text).toContain("THINK");
    expect(text).toContain("TELE");
  });

  test("omits the TOOLS section until a tool is actually in play", () => {
    const flow = createFlowModel("deepseek");
    flow.begin("deepseek", 1_000_000);
    flow.apply(
      {
        type: "wire",
        phase: "send",
        provider: "deepseek",
        model: "deepseek-chat",
        endpoint: "https://api.deepseek.com/v1/chat/completions",
        messages: 1,
        tokens: 10,
        tools: 3,
      },
      1_000_000,
    );
    const rows = composePane({ now: 1_000_000, width: 100, budget: 30, flow: flow.state, hud: hud() });
    const text = rows.map(strip).join("\n");
    expect(text).toContain("FLOW");
    expect(text).not.toContain("TOOLS");
  });
});
