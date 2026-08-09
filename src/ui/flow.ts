// The live dataflow diagram: where the turn currently is, drawn as nodes with
// packets moving along the wires between them.
//
//   [you]══•══▶[ctx]══•══▶((deepseek))
//    42tok       ▲            ║ thinking 2.1s
//                ║            ▼
//             [tools]◀══•══[calls×1]
//             ⚙ run_command ●●●○
//
// The loop stays the point: tool results flow back up into the context that
// feeds the next request. State comes from LoopEvents; motion comes from
// `tick()`, driven by the pane's frame timer, so this file has no timers of
// its own and renders deterministically for a given state.

import { Canvas } from "./canvas";
import type { CanvasStyle } from "./canvas";
import { compactNumber, formatDuration } from "./theme";
import type { LoopEvent } from "../core/agent-loop";
import type { TokenUsage } from "../types";

/** What the visualization layer draws: both, one, or nothing. */
export type VizMode = "full" | "flow" | "trace" | "off";

export const VIZ_MODES: VizMode[] = ["full", "flow", "trace", "off"];

export function isVizMode(value: string): value is VizMode {
  return (VIZ_MODES as string[]).includes(value);
}

export type FlowStage =
  | "idle"
  | "send"
  | "wait"
  | "think"
  | "calls"
  | "tool"
  | "write"
  | "done"
  | "error";

/** Wires that can carry packets, named after the direction data actually moves. */
type EdgeId = "youToCtx" | "ctxToModel" | "modelToCalls" | "callsToTools" | "toolsToCtx";

const EDGE_IDS: EdgeId[] = ["youToCtx", "ctxToModel", "modelToCalls", "callsToTools", "toolsToCtx"];

const SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const PACKET = "•";
/** Frames between packets. Wide enough that packets read as moving objects, not as a dashed line. */
const SPAWN_EVERY = 7;

export interface FlowState {
  stage: FlowStage;
  turn: number;
  provider: string;
  model?: string;
  endpoint?: string;
  messages: number;
  sentTokens: number;
  toolsAvailable: number;
  usage: TokenUsage;
  pendingCalls: number;
  activeTool?: string;
  toolStartedAt?: number;
  toolMs?: number;
  toolsOk: number;
  toolsFailed: number;
  replyChars: number;
  compacted?: { dropped: number; elided: number };
  /**
   * Counts only. Step text never goes on the Canvas: it addresses UTF-16 code
   * units, and plan steps are routinely CJK, which would overflow the row. The
   * full list with its text lives in the HUD box one line below.
   */
  plan?: { done: number; total: number; source: string };
  /** `frame` when the last plan update landed — drives the flash without a clock. */
  planFrame?: number;
  /** What that update did, so the flash can pick a colour. */
  planKind?: "open" | "write" | "step";
  error?: string;
  frame: number;
  /** Packet offsets (in cells) per wire, oldest first. */
  packets: Record<EdgeId, number[]>;
  since: number;
}

export interface FlowModel {
  readonly state: FlowState;
  apply(event: LoopEvent, now?: number): void;
  /** Advances the animation one frame. */
  tick(now?: number): void;
  /** Resets to the pre-request state at the start of a turn. */
  begin(provider: string, now?: number): void;
  /**
   * Adopts a plan that predates this turn. Deliberately not `apply`: the list
   * did not just change, so it must not flash as though it had.
   */
  seedPlan(snapshot: { steps: Array<{ status: string }>; source: string }): void;
  end(stage: "done" | "error", detail?: string): void;
}

export function createFlowModel(provider = "auto"): FlowModel {
  const state: FlowState = blankState(provider);

  const spawn = (edge: EdgeId) => {
    if (state.frame % SPAWN_EVERY === 0) state.packets[edge].push(0);
  };

  return {
    state,
    begin(name, now = Date.now()) {
      // The task list deliberately outlives a turn (see core/plan.ts), so it is
      // carried over rather than reset with everything else.
      Object.assign(state, blankState(name), { turn: state.turn, since: now, plan: state.plan });
      state.stage = "send";
    },
    seedPlan(snapshot) {
      const done = snapshot.steps.filter(step => step.status === "completed").length;
      state.plan = { done, total: snapshot.steps.length, source: snapshot.source };
      state.planFrame = undefined;
      state.planKind = undefined;
    },
    end(stage, detail) {
      state.stage = stage;
      if (detail) state.error = detail;
      for (const edge of EDGE_IDS) state.packets[edge] = [];
    },
    apply(event, now = Date.now()) {
      switch (event.type) {
        case "turn":
          state.turn = event.turn;
          state.provider = event.provider;
          state.stage = "send";
          state.since = now;
          break;
        case "compaction":
          state.compacted = { dropped: event.droppedMessages, elided: event.elidedToolResults };
          break;
        case "wire":
          if (event.phase === "send") {
            state.stage = "send";
            state.provider = event.provider;
            state.model = event.model;
            state.endpoint = event.endpoint;
            state.messages = event.messages;
            state.sentTokens = event.tokens;
            state.toolsAvailable = event.tools;
            state.since = now;
          } else {
            state.usage = { ...state.usage, ...(event.usage ?? {}) };
            state.pendingCalls = event.toolCalls;
            state.replyChars = event.textChars;
            state.stage = event.ok ? (event.toolCalls > 0 ? "calls" : "write") : "error";
            if (!event.ok) state.error = event.error;
            state.packets.ctxToModel = [];
            state.since = now;
          }
          break;
        case "progress": {
          const progress = event.progress;
          if (progress.kind === "thinking") state.stage = "think";
          else if (progress.kind === "text") state.stage = "write";
          else if (progress.kind === "tool" && progress.tool) {
            state.stage = "tool";
            state.activeTool = progress.tool;
            state.toolStartedAt = now;
          }
          if (progress.usage) state.usage = { ...state.usage, ...progress.usage };
          break;
        }
        case "tool_start":
          state.stage = "tool";
          state.activeTool = event.name;
          state.toolStartedAt = now;
          state.toolMs = undefined;
          state.packets.modelToCalls = [];
          break;
        case "tool_end":
          state.toolMs = event.ms;
          state.toolStartedAt = undefined;
          if (event.ok) state.toolsOk++;
          else state.toolsFailed++;
          state.pendingCalls = Math.max(0, state.pendingCalls - 1);
          // Results feed back into the context for the next request.
          state.stage = state.pendingCalls > 0 ? "tool" : "send";
          break;
        case "plan": {
          const steps = event.snapshot.steps;
          const done = steps.filter(step => step.status === "completed").length;
          const previous = state.plan;
          state.plan = { done, total: steps.length, source: event.snapshot.source };
          state.planFrame = state.frame;
          state.planKind = !previous ? "open" : done !== previous.done ? "step" : "write";
          break;
        }
        case "reply":
          state.stage = "write";
          if (event.usage) state.usage = { ...state.usage, ...event.usage };
          break;
      }
    },
    tick(now = Date.now()) {
      state.frame++;
      // Non-streaming providers report nothing between request and response, so
      // "sending" would otherwise sit there for the whole round trip.
      if (state.stage === "send" && now - state.since > 600) state.stage = "wait";
      for (const edge of EDGE_IDS) {
        state.packets[edge] = state.packets[edge].map(offset => offset + 1).filter(offset => offset < 64);
      }
      switch (state.stage) {
        case "send":
          spawn("youToCtx");
          spawn("ctxToModel");
          break;
        case "wait":
        case "think":
          spawn("ctxToModel");
          break;
        case "calls":
          spawn("modelToCalls");
          spawn("callsToTools");
          break;
        case "tool":
          spawn("callsToTools");
          break;
        case "write":
          spawn("modelToCalls");
          break;
        default:
          break;
      }
    },
  };
}

/**
 * Every field, including the optional ones set to `undefined` — `begin()` resets
 * with `Object.assign`, which can only overwrite keys that are actually present
 * here. A key omitted from this object silently survives into the next turn.
 */
function blankState(provider: string): FlowState {
  return {
    stage: "idle",
    turn: 1,
    provider,
    model: undefined,
    endpoint: undefined,
    messages: 0,
    sentTokens: 0,
    toolsAvailable: 0,
    usage: {},
    pendingCalls: 0,
    activeTool: undefined,
    toolStartedAt: undefined,
    toolMs: undefined,
    toolsOk: 0,
    toolsFailed: 0,
    replyChars: 0,
    compacted: undefined,
    plan: undefined,
    planFrame: undefined,
    planKind: undefined,
    error: undefined,
    frame: 0,
    packets: { youToCtx: [], ctxToModel: [], modelToCalls: [], callsToTools: [], toolsToCtx: [] },
    since: Date.now(),
  };
}

const MIN_WIDTH = 46;

/** Five rows of diagram. Returns [] when the terminal is too narrow to be honest about it. */
export function renderFlow(state: FlowState, width: number, now = Date.now()): string[] {
  const canvas = paintFlow(state, width, now);
  return canvas ? canvas.render() : [];
}

/** Same layout, without the escape sequences — used by the tests. */
export function renderFlowPlain(state: FlowState, width: number, now = Date.now()): string[] {
  const canvas = paintFlow(state, width, now);
  return canvas ? canvas.plain() : [];
}

function paintFlow(state: FlowState, width: number, now: number): Canvas | undefined {
  if (width < MIN_WIDTH || state.stage === "idle") return undefined;

  const modelName = state.provider;
  const youBox = "[you]";
  const ctxBox = "[ctx]";
  const modelBox = `((${modelName}))`;
  const toolsBox = "[tools]";

  // Wires take whatever is left after the boxes, split evenly and clamped so a
  // wide terminal does not turn into a mostly-empty diagram.
  const fixed = youBox.length + ctxBox.length + modelBox.length;
  const wire = Math.max(3, Math.min(16, Math.floor((width - fixed - 4) / 2)));
  const colYou = 1;
  const colCtx = colYou + youBox.length + wire;
  const colModel = colCtx + ctxBox.length + wire;
  const canvas = new Canvas(width, 5);

  const active = (stage: FlowStage[]) => stage.includes(state.stage);
  const nodeStyle = (on: boolean): CanvasStyle => (on ? "accent" : "faint");

  // --- row 0: the request path ----------------------------------------------
  canvas.put(0, colYou, youBox, nodeStyle(active(["send"])), active(["send"]));
  drawWire(canvas, 0, colYou + youBox.length, wire, state.packets.youToCtx, "right", "accent");
  canvas.put(0, colCtx, ctxBox, nodeStyle(active(["send"])), active(["send"]));
  drawWire(canvas, 0, colCtx + ctxBox.length, wire, state.packets.ctxToModel, "right", "accent");
  const modelHot = active(["send", "wait", "think", "write", "calls"]);
  canvas.put(0, colModel, modelBox, modelHot ? "violet" : "faint", modelHot);

  // --- row 1: what each node is carrying ------------------------------------
  canvas.put(1, colYou + 1, `${state.messages}msg`, "faint");
  const ctxLabel = `${compactNumber(state.sentTokens)}tok`;
  canvas.put(1, colCtx, ctxLabel, "muted");
  if (state.compacted) {
    canvas.put(1, colCtx + ctxLabel.length + 1, `⇣${state.compacted.dropped}`, "warn");
  }
  canvas.put(1, colModel + 1, phaseLabel(state, now), state.stage === "error" ? "err" : "violet");

  // --- the plan node ---------------------------------------------------------
  // It lives in the left gutter (rows 2-4, left of colCtx) — the only region
  // that is free at every width — and is painted outside the tool block, since
  // a plan is routinely published before any tool runs.
  paintPlan(canvas, state, colYou, colCtx);

  // --- row 2: the vertical legs ----------------------------------------------
  // Row 1 belongs to the labels; the verticals get row 2 to themselves so an
  // arrowhead never lands on top of a token count.
  const feedbackCol = colCtx + 2;
  const returnCol = colModel + 2;
  const bottomActive = active(["calls", "tool", "write"]);
  const toolsRan = state.toolsOk + state.toolsFailed > 0;
  if (bottomActive || toolsRan) {
    canvas.put(2, returnCol, "▼", bottomActive ? "violet" : "faint", bottomActive);
    canvas.put(2, feedbackCol, "▲", toolsRan ? "ok" : "faint", toolsRan);

    // --- row 3: the return path ---------------------------------------------
    const rightBox =
      state.stage === "write" || (state.pendingCalls === 0 && state.replyChars > 0)
        ? `[reply ${compactNumber(state.usage.output ?? 0)}tok]`
        : `[calls×${Math.max(state.pendingCalls, 1)}]`;
    // Hang the box off the model's vertical, and never let it collide with the
    // tools box on a narrow terminal.
    const colRight = Math.max(returnCol - 1, colCtx + toolsBox.length + 3);
    canvas.put(3, colCtx, toolsBox, active(["tool"]) ? "ok" : "faint", active(["tool"]));
    const gap = colRight - (colCtx + toolsBox.length);
    if (gap > 2) {
      drawWire(canvas, 3, colCtx + toolsBox.length, gap, state.packets.callsToTools, "left", "violet");
    }
    canvas.put(3, colRight, rightBox, bottomActive ? "violet" : "faint");

    // --- row 4: the tool currently doing the work ---------------------------
    if (state.activeTool) {
      const elapsed = state.toolStartedAt ? now - state.toolStartedAt : state.toolMs ?? 0;
      const mark = state.toolStartedAt ? SPINNER[state.frame % SPINNER.length] : state.toolsFailed > 0 ? "✗" : "✓";
      const label = `${mark} ${state.activeTool}`;
      canvas.put(4, colCtx, label, state.toolStartedAt ? "ok" : state.toolsFailed > 0 ? "err" : "faint");
      const timing = formatDuration(elapsed);
      canvas.put(4, colCtx + label.length + 1, timing, "faint");
      if (toolsRan) {
        const tally = `✓${state.toolsOk}${state.toolsFailed ? ` ✗${state.toolsFailed}` : ""}`;
        canvas.put(4, colCtx + label.length + timing.length + 3, tally, state.toolsFailed ? "err" : "faint");
      }
    }
  }

  return canvas;
}

/** How long the plan node stays lit after an update: ~1.3s at a 90ms frame. */
const PLAN_FLASH_FRAMES = 14;
const PLAN_BAR_CELLS = 7;

/**
 * The task list as a badge plus a progress bar, hung under `[you]`: the plan is
 * the operator's view of the work, so it belongs on the operator's side of the
 * diagram. Only counts — the steps themselves are in the HUD box below.
 */
function paintPlan(canvas: Canvas, state: FlowState, colYou: number, colCtx: number): void {
  const plan = state.plan;
  if (!plan || plan.total === 0) return;
  const gutter = colCtx - colYou - 1; // columns available before the ctx column
  if (gutter < 7) return;

  const fresh = state.planFrame !== undefined && state.frame - state.planFrame < PLAN_FLASH_FRAMES;
  const complete = plan.done >= plan.total;
  const style: CanvasStyle = complete ? "ok" : fresh && state.planKind === "step" ? "ok" : fresh ? "accent" : "faint";

  // The leg ties the plan to the operator: a packet while it is being written,
  // an arrowhead when a step just closed, a quiet tie otherwise.
  const leg = !fresh ? "║" : state.planKind === "step" ? "▲" : (state.frame - (state.planFrame ?? 0)) % SPAWN_EVERY < 4 ? PACKET : "║";
  canvas.put(2, colYou + 2, leg, style, fresh);

  const label = gutter >= 12 ? `[plan ${plan.done}/${plan.total}]` : `[${plan.done}/${plan.total}]`;
  canvas.put(3, colYou, label, style, fresh || complete);

  if (gutter >= 8) {
    const filled = Math.round((plan.done / plan.total) * PLAN_BAR_CELLS);
    canvas.put(4, colYou, "▰".repeat(filled), complete ? "ok" : "accentDim");
    canvas.put(4, colYou + filled, "▱".repeat(PLAN_BAR_CELLS - filled), "rule");
  }
}

function phaseLabel(state: FlowState, now: number): string {
  const seconds = formatDuration(Math.max(0, now - state.since));
  switch (state.stage) {
    case "send":
      return `⇢ sending ${seconds}`;
    case "wait":
      return `${SPINNER[state.frame % SPINNER.length]} waiting ${seconds}`;
    case "think":
      return `${SPINNER[state.frame % SPINNER.length]} thinking ${seconds}`;
    case "calls":
      return `⇠ ${state.pendingCalls} tool call${state.pendingCalls === 1 ? "" : "s"}`;
    case "tool":
      return "⋯ awaiting tools";
    case "write":
      return `✎ writing ${seconds}`;
    case "done":
      return "✓ done";
    case "error":
      return `✗ ${state.error ?? "failed"}`;
    default:
      return "";
  }
}

/**
 * One horizontal wire with packets on it. `offsets` are cell distances from the
 * wire's own origin; direction decides which end that is.
 */
function drawWire(
  canvas: Canvas,
  row: number,
  col: number,
  length: number,
  offsets: number[],
  direction: "left" | "right",
  style: CanvasStyle,
): void {
  if (length <= 0) return;
  const body = direction === "right" ? `${"═".repeat(Math.max(0, length - 1))}▶` : `◀${"═".repeat(Math.max(0, length - 1))}`;
  canvas.put(row, col, body, "rule");
  for (const offset of offsets) {
    if (offset >= length - 1) continue;
    const at = direction === "right" ? col + offset : col + length - 1 - offset;
    canvas.put(row, at, PACKET, style, true);
  }
}
