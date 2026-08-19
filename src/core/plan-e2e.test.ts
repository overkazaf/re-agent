// End-to-end proof that the plan subsystem actually fires, using the scripted
// mock provider so it runs offline. Before this existed, nothing exercised the
// path: the mock could not emit tool calls, so no test could reach update_plan.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLoop } from "./agent-loop";
import type { LoopEvent } from "./agent-loop";
import { JsonlSession } from "./session";
import { createProvider } from "../providers";
import { createReverseTools } from "../tools/reverse-tools";
import { createFlowModel, renderFlowPlain, traceEvent } from "../ui";
import type { AgentConfig, PlanSnapshot, ProviderConfig, ToolContext } from "../types";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const STEPS = ["triage the artifact", "recover the key", "verify the flag"];

/** Turn 1 opens the list, turn 2 starts step 1, turn 3 completes it, turn 4 answers. */
const SCRIPT: ProviderConfig["mockScript"] = [
  {
    text: "",
    toolCalls: [
      { name: "update_plan", arguments: { plan: STEPS.map(step => ({ step, status: "pending" })) } },
    ],
  },
  {
    text: "",
    toolCalls: [
      {
        name: "update_plan",
        arguments: {
          plan: STEPS.map((step, index) => ({ step, status: index === 0 ? "in_progress" : "pending" })),
        },
      },
    ],
  },
  {
    text: "",
    toolCalls: [
      {
        name: "update_plan",
        arguments: {
          plan: STEPS.map((step, index) => ({
            step,
            status: index === 0 ? "completed" : index === 1 ? "in_progress" : "pending",
          })),
        },
      },
    ],
  },
  { text: "done" },
];

async function loopWithScript(script: ProviderConfig["mockScript"]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-plan-"));
  dirs.push(dir);
  const providerConfig: ProviderConfig = { type: "mock", model: "mock-reasoner", mockScript: script };
  const config: AgentConfig = {
    name: "test",
    plannerProvider: "mock",
    executorProvider: "mock",
    defaultRole: "auto",
    maxTurns: 8,
    providers: { mock: providerConfig },
  };
  const session = new JsonlSession(dir, "plan");
  await session.init({});
  const toolContext: ToolContext = {
    workspace: dir,
    sessionDir: dir,
    policy: {
      allowWrites: false,
      allowNetwork: false,
      allowSensitive: false,
      commandTimeoutMs: 5000,
      maxReadBytes: 4096,
      maxToolOutputChars: 8000,
      approvalMode: "safe",
      approvals: {},
    },
  };
  const loop = new AgentLoop({
    config,
    providers: new Map([["mock", createProvider("mock", providerConfig)]]),
    tools: createReverseTools(),
    toolContext,
    systemPrompt: "sys",
    session,
  });
  return { loop, session, dir };
}

describe("plan subsystem end to end", () => {
  test("an update_plan tool call becomes a plan event, a snapshot, and a session record", async () => {
    const { loop, session } = await loopWithScript(SCRIPT);
    const events: LoopEvent[] = [];
    await loop.run("solve it", { onEvent: event => events.push(event) });

    const planEvents = events.filter(event => event.type === "plan");
    expect(planEvents.length).toBe(3);

    const snapshot = loop.plan!;
    expect(snapshot.steps.map(step => step.text)).toEqual(STEPS);
    expect(snapshot.steps.map(step => step.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(snapshot.source).toBe("update_plan");
    // The tracker stamps lifecycle timings, which the trace then reports.
    expect(snapshot.steps[0].startedAt).toBeGreaterThan(0);
    expect(snapshot.steps[0].completedAt).toBeGreaterThan(0);

    const log = await fs.readFile(session.file, "utf8");
    const recorded = log
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(entry => entry.type === "event" && entry.data?.type === "plan");
    expect(recorded).toHaveLength(3);
  });

  test("the plan reaches both visualization layers", async () => {
    const { loop } = await loopWithScript(SCRIPT);
    const flow = createFlowModel("mock");
    flow.begin("mock");
    const traced: string[] = [];
    let previousPlan: PlanSnapshot | undefined;

    await loop.run("solve it", {
      onEvent: event => {
        flow.apply(event);
        traced.push(...traceEvent(event, { startedAt: 0, width: 120, previousPlan }));
        if (event.type === "plan") previousPlan = event.snapshot;
      },
    });

    // Diagram: the request path is drawn; plan counts live in the HUD (the ui
    // tests cover that section), so the strip stays diagram-only.
    expect(flow.state.plan).toEqual({ done: 1, total: 3, source: "update_plan" });
    const rows = renderFlowPlain(flow.state, 100);
    expect(rows[0]).toContain("((mock))");
    expect(rows.join("")).not.toContain("[plan");

    // Trace: one line per transition, no dump of the list.
    const planLines = traced.map(strip).filter(line => line.includes("◇"));
    expect(planLines[0]).toContain("opened via update_plan");
    expect(planLines.some(line => line.includes("▸ triage the artifact"))).toBe(true);
    expect(planLines.some(line => line.includes("✔ triage the artifact"))).toBe(true);
    // opened, then ▸step1, then the last update closes step 1 and opens step 2 —
    // two changed steps, so two lines.
    expect(planLines).toHaveLength(4);
    expect(planLines[3]).toContain("▸ recover the key");
    // Whether a *mock* step spans a measurable millisecond is a race, so the
    // duration rendering is asserted directly instead of through the loop.
    const timed = traceEvent(
      {
        type: "plan",
        snapshot: {
          source: "update_plan",
          updatedAt: 0,
          steps: [{ text: "triage the artifact", status: "completed", startedAt: 1000, completedAt: 9200 }],
        },
      },
      {
        startedAt: 0,
        width: 120,
        previousPlan: {
          source: "update_plan",
          updatedAt: 0,
          steps: [{ text: "triage the artifact", status: "in_progress", startedAt: 1000 }],
        },
      },
    ).map(strip);
    expect(timed[0]).toContain("✔ triage the artifact 8.2s");
    // The raw update_plan tool call is not printed twice.
    expect(traced.map(strip).some(line => line.includes("⚙ update_plan"))).toBe(false);
  });

  test("a plan that survives into the next turn is not re-announced", async () => {
    const { loop } = await loopWithScript(SCRIPT);
    await loop.run("solve it");
    const carried = loop.plan!;

    // Second turn: seeded from the surviving plan, exactly as runTurn does.
    const flow = createFlowModel("mock");
    flow.begin("mock");
    flow.apply({ type: "plan", snapshot: carried });
    let previousPlan: PlanSnapshot | undefined = carried;
    const traced: string[] = [];
    await loop.run("keep going", {
      onEvent: event => {
        traced.push(...traceEvent(event, { startedAt: 0, width: 120, previousPlan }));
        if (event.type === "plan") previousPlan = event.snapshot;
      },
    });

    expect(traced.map(strip).some(line => line.includes("opened via"))).toBe(false);
    // The strip still draws the loop; the plan itself is carried in state.
    expect(renderFlowPlain(flow.state, 100)[0]).toContain("((mock))");
  });


  test("an update that closes a step AND appends one reports both, not neither", async () => {
    // The whole-list sources (update_plan, codex plan_update) send exactly this
    // shape when a model finds new work while finishing current work. Treating
    // it as "the list is still being written" silently lost both transitions.
    const discover: ProviderConfig["mockScript"] = [
      {
        toolCalls: [
          {
            name: "update_plan",
            arguments: { plan: [{ step: "triage", status: "in_progress" }, { step: "recover", status: "pending" }] },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "update_plan",
            arguments: {
              plan: [
                { step: "triage", status: "completed" },
                { step: "recover", status: "in_progress" },
                { step: "verify", status: "pending" },
              ],
            },
          },
        ],
      },
      { text: "done" },
    ];
    const { loop } = await loopWithScript(discover);
    const traced: string[] = [];
    let previousPlan: PlanSnapshot | undefined;
    await loop.run("go", {
      onEvent: event => {
        traced.push(...traceEvent(event, { startedAt: 0, width: 120, previousPlan }));
        if (event.type === "plan") previousPlan = event.snapshot;
      },
    });

    const planLines = traced.map(strip).filter(line => line.includes("◇"));
    expect(planLines.some(line => line.includes("✔ triage"))).toBe(true);
    expect(planLines.some(line => line.includes("▸ recover"))).toBe(true);
    expect(loop.plan!.steps.map(step => step.status)).toEqual(["completed", "in_progress", "pending"]);
  });

  test("a rewritten list is reported as a rewrite, not as transitions", async () => {
    const rewrite: ProviderConfig["mockScript"] = [
      { toolCalls: [{ name: "update_plan", arguments: { plan: [{ step: "old plan", status: "pending" }] } }] },
      {
        toolCalls: [
          { name: "update_plan", arguments: { plan: [{ step: "new plan", status: "in_progress" }] } },
        ],
      },
      { text: "done" },
    ];
    const { loop } = await loopWithScript(rewrite);
    const traced: string[] = [];
    let previousPlan: PlanSnapshot | undefined;
    await loop.run("go", {
      onEvent: event => {
        traced.push(...traceEvent(event, { startedAt: 0, width: 120, previousPlan }));
        if (event.type === "plan") previousPlan = event.snapshot;
      },
    });
    const planLines = traced.map(strip).filter(line => line.includes("◇"));
    expect(planLines.at(-1)).toContain("rewritten (was 1 steps)");
  });

  test("a list being built step by step does not spam the trace", async () => {
    // Claude's stream sends one TaskCreate at a time; each append is a plan
    // event, but only the finished list is worth a line.
    const growing: ProviderConfig["mockScript"] = [
      { toolCalls: [{ name: "update_plan", arguments: { plan: [{ step: "one", status: "pending" }] } }] },
      {
        toolCalls: [
          {
            name: "update_plan",
            arguments: { plan: [{ step: "one", status: "pending" }, { step: "two", status: "pending" }] },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "update_plan",
            arguments: {
              plan: [
                { step: "one", status: "in_progress" },
                { step: "two", status: "pending" },
              ],
            },
          },
        ],
      },
      { text: "done" },
    ];
    const { loop } = await loopWithScript(growing);
    const traced: string[] = [];
    let previousPlan: PlanSnapshot | undefined;
    await loop.run("go", {
      onEvent: event => {
        traced.push(...traceEvent(event, { startedAt: 0, width: 120, previousPlan }));
        if (event.type === "plan") previousPlan = event.snapshot;
      },
    });

    const planLines = traced.map(strip).filter(line => line.includes("◇"));
    // opened + the in_progress transition; the append in between is silent.
    expect(planLines).toHaveLength(2);
    expect(planLines[1]).toContain("▸ one");
  });
});

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
