// The live dataflow strip: where the turn currently is, drawn as a compact
// two-line pipeline that lives inside the HUD box. The request path is one
// line, the tool path a second line that only appears when tools are in play.
//
//   [you]═•═▶[ctx]▲═•═▶((deepseek))     ⣻ thinking 2.1s
//   [tools]◀═•═[calls×1]   ⚙ run_command 0.2s  ✓3 ✗1
//
// The loop stays the point: the ▲ on the ctx end of the model wire marks tool
// results flowing back into the context that feeds the next request. State
// comes from LoopEvents; motion comes from `tick()`, driven by the pane's
// frame timer, so this file has no timers of its own and renders
// deterministically for a given state.

import { Canvas } from "./canvas";
import type { CanvasStyle } from "./canvas";
import { compactNumber, displayWidth, formatDuration } from "./theme";
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

/** Narrower than this the strip cannot be honest about the flow. */
const MIN_WIDTH = 46;

/**
 * One or two lines of diagram. The caller (the HUD) labels the lines FLOW /
 * TOOLS, so this renders the bare strip and returns [] when the terminal is
 * too narrow to be honest about it.
 */
export function renderFlow(state: FlowState, width: number, now = Date.now()): string[] {
  const canvas = paintFlow(state, width, now);
  if (!canvas) return [];
  const rows = canvas.render();
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  return rows;
}

/** Same layout, without the escape sequences — used by the tests. */
export function renderFlowPlain(state: FlowState, width: number, now = Date.now()): string[] {
  const canvas = paintFlow(state, width, now);
  if (!canvas) return [];
  const rows = canvas.plain();
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  return rows;
}

function paintFlow(state: FlowState, width: number, now: number): Canvas | undefined {
  if (width < MIN_WIDTH || state.stage === "idle") return undefined;

  const youBox = "[you]";
  const ctxBox = "[ctx]";
  const modelBox = `((${state.provider}))`;
  const toolsBox = "[tools]";

  // Wires take whatever is left after the boxes, split evenly and clamped so a
  // wide terminal does not turn into a mostly-empty strip — the HUD owns the
  // rest of the row.
  const fixed = youBox.length + ctxBox.length + modelBox.length;
  const wire = Math.max(2, Math.min(14, Math.floor((width - fixed - 3) / 2)));
  const colYou = 0;
  const colCtx = colYou + youBox.length + wire;
  const colModel = colCtx + ctxBox.length + wire;
  const canvas = new Canvas(width, 2);

  const active = (stages: FlowStage[]) => stages.includes(state.stage);
  const nodeStyle = (on: boolean): CanvasStyle => (on ? "accent" : "faint");

  // --- row 0: the request path ----------------------------------------------
  canvas.put(0, colYou, youBox, nodeStyle(active(["send"])), active(["send"]));
  drawWire(canvas, 0, colYou + youBox.length, wire, state.packets.youToCtx, "right", "accent");
  canvas.put(0, colCtx, ctxBox, nodeStyle(active(["send"])), active(["send"]));
  drawWire(canvas, 0, colCtx + ctxBox.length, wire, state.packets.ctxToModel, "right", "accent");
  // Tool results flow back into the context: a lit ▲ on the ctx end of the
  // model wire once any tool has returned.
  const toolsRan = state.toolsOk + state.toolsFailed > 0;
  if (toolsRan) canvas.put(0, colCtx + ctxBox.length, "▲", "ok", true);
  const modelHot = active(["send", "wait", "think", "write", "calls"]);
  canvas.put(0, colModel, modelBox, modelHot ? "violet" : "faint", modelHot);
  const phase = phaseLabel(state, now);
  const phaseStyle = state.stage === "error" ? "err" : "violet";
  // The phase label rides the right edge when there is room, so the strip
  // reads as a dashboard instead of a left-heavy diagram with dead space.
  const phaseRoom = width - (colModel + modelBox.length + 2);
  const phaseCol = phaseRoom >= displayWidth(phase) + 1 ? width - displayWidth(phase) - 1 : colModel + modelBox.length + 2;
  canvas.put(0, phaseCol, phase, phaseStyle);

  // --- row 1: the tool path --------------------------------------------------
  const bottomActive = active(["calls", "tool"]);
  if (bottomActive || toolsRan) {
    const rightBox =
      state.stage === "write" || (state.pendingCalls === 0 && state.replyChars > 0)
        ? `[reply ${compactNumber(state.usage.output ?? 0)}tok]`
        : `[calls×${Math.max(state.pendingCalls, 1)}]`;
    canvas.put(1, 0, toolsBox, active(["tool"]) ? "ok" : "faint", active(["tool"]));
    if (wire > 1) {
      drawWire(canvas, 1, toolsBox.length, wire, state.packets.callsToTools, "left", "violet");
    }
    canvas.put(1, toolsBox.length + wire, rightBox, bottomActive ? "violet" : "faint");

    if (state.activeTool) {
      const elapsed = state.toolStartedAt ? now - state.toolStartedAt : state.toolMs ?? 0;
      const mark = state.toolStartedAt ? SPINNER[state.frame % SPINNER.length] : state.toolsFailed > 0 ? "✗" : "✓";
      const label = `${mark} ${state.activeTool} ${formatDuration(elapsed)}`;
      const tally = toolsRan ? `✓${state.toolsOk}${state.toolsFailed ? ` ✗${state.toolsFailed}` : ""}` : "";
      const block = tally ? `${label}  ${tally}` : label;
      const blockWidth = displayWidth(block);
      const leftCol = toolsBox.length + wire + rightBox.length + 2;
      const toolStyle = state.toolStartedAt ? "ok" : state.toolsFailed > 0 ? "err" : "faint";
      // Same right-edge treatment as the phase label; only falls back to
      // left-adjacent when the block would not fit on its own.
      const col = width - leftCol >= blockWidth + 1 ? width - blockWidth - 1 : leftCol;
      canvas.put(1, col, label, toolStyle);
      if (tally) canvas.put(1, col + displayWidth(label) + 2, tally, state.toolsFailed ? "err" : "faint");
    }
  }

  return canvas;
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
