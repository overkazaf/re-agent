// A live, in-place terminal HUD: one box carrying the routing chain, task
// list, streamed reasoning, and token telemetry. Lines printed while the pane
// is active are "committed" above it, so tool activity and thinking stay
// readable without the dashboard scrolling away.
//
// This file owns the redraw and the state; ./hud owns the pixels. The redraw is
// a cursor walk back over exactly the number of lines last written, so the one
// invariant that matters is that the walk length always matches what was drawn.
// `renderHud` guarantees both halves of that: every line fits the terminal
// width (no soft wrap inflating the real line count) and the body never exceeds
// the height budget (no scroll shifting the rows out from under the cursor).

import type { PlanSnapshot } from "../types";
import { renderFlow } from "./flow";
import type { FlowState } from "./flow";
import { HUD_MAX_WIDTH, renderHud } from "./hud";
import type { HudModel, HudRoute, HudStats } from "./hud";
import { c, formatDuration, terminalColumns } from "./theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINK_GLYPH = "✻";
const THINK_WINDOW = 3;
const FRAME_MS = 90;
/** Rows kept clear below the pane so the terminal never scrolls under it. */
const HEIGHT_MARGIN = 2;

/** Throughput sampling: a ~6s window of output-token deltas. */
const SPARK_SAMPLES = 16;
const SAMPLE_MS = 400;

export interface LiveStats extends HudStats {}

export interface LivePaneOptions {
  /**
   * The dual-model chain to show in the header. `active` names the side
   * currently answering; omit it to show the chain without highlighting.
   */
  route?: { planner: string; executor: string; active?: string };
  /**
   * Live dataflow diagram drawn above the HUD. The pane reads this object every
   * frame, so the caller mutates it through the flow model instead of pushing
   * updates here.
   */
  flow?: FlowState;
  /** Called once per animation frame, before the redraw (advances `flow`). */
  onFrame?: () => void;
}

export interface LivePane {
  /** Set the short phase label shown next to the spinner (e.g. "thinking"). */
  setPhase(phase: string): void;
  /** Replace the live token counters. */
  setStats(stats: LiveStats): void;
  /** Append streamed reasoning text to the rolling thinking window. */
  pushThinking(delta: string): void;
  /** Show a plan box above the thinking window; `undefined` hides it. */
  setPlan(snapshot: PlanSnapshot | undefined): void;
  /** Advance the dataflow animation; no-op when no flow state was supplied. */
  tickFlow(): void;
  /** Print a line permanently above the pane. */
  commit(line: string): void;
  /**
   * Stop drawing and give the terminal back (cursor visible, no repaint), so
   * something else can own the screen — an approval prompt, for instance.
   */
  pause(): void;
  /** Resume drawing after `pause()`. */
  resume(): void;
  /** Tear down the pane; returns the total elapsed milliseconds. */
  stop(): number;
  readonly interactive: boolean;
  readonly thinkingChars: number;
  /** The last plan shown, so the caller can archive it after the pane stops. */
  readonly plan?: PlanSnapshot;
}

/**
 * Smallest HUD that still shows the *in-progress* task. Measured, not guessed:
 * renderHud collapses to a one-liner below 4 rows, shows only a completed step
 * at 4, adds a "… N more" marker at 5, and first reveals the active step at 6.
 * The task list is the point of the box, so 6 is the floor the diagram has to
 * leave behind.
 */
const HUD_FLOOR_ROWS = 6;

/**
 * Composes one frame: the dataflow diagram on top, the HUD box below, inside a
 * single height budget.
 *
 * The budget is the invariant this whole file rests on — `clear()` walks back
 * exactly as many lines as were drawn, so drawing more than the terminal can
 * hold desynchronises the erase. The diagram is therefore clipped to whatever
 * is left after the HUD's floor, rather than being allowed to push the box out.
 * Exported so the arithmetic can be tested without a terminal.
 */
export function composePane(input: {
  now: number;
  width: number;
  budget: number;
  flow?: FlowState;
  hud: Omit<HudModel, "maxRows"> & { maxRows: number };
}): string[] {
  const raw = input.flow ? renderFlow(input.flow, input.width, input.now) : [];
  const affordable = Number.isFinite(input.budget) ? Math.max(0, input.budget - HUD_FLOOR_ROWS) : raw.length;
  // All of the diagram or none of it: half a diagram is worse than no diagram.
  const flowLines = raw.length <= affordable ? raw : [];
  // The floor is spent above, on deciding whether the diagram fits at all — it
  // is not imposed here, because a terminal with 3 usable rows must still get
  // renderHud's one-line fallback rather than a 4-row box it cannot hold.
  const hudRows = Number.isFinite(input.budget)
    ? Math.max(1, input.budget - flowLines.length)
    : input.hud.maxRows || Number.POSITIVE_INFINITY;
  return [...flowLines, ...renderHud({ ...input.hud, maxRows: hudRows })];
}

export function createLivePane(label: string, options?: LivePaneOptions): LivePane {
  const start = Date.now();
  const interactive = Boolean(process.stdout.isTTY);
  const stats: LiveStats = {};
  const route: HudRoute | undefined = options?.route ? { ...options.route } : undefined;
  let phase = "working";
  let thinkingBuffer = "";
  let thinkingChars = 0;
  let plan: PlanSnapshot | undefined;
  let drawn = 0;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let paused = false;

  if (!interactive) {
    // Non-TTY (pipes, --print, CI): emit one static line, no animation.
    process.stdout.write(`${c.faint(`[..] ${label} ${phase}`)}\n`);
    return {
      setPhase: value => {
        phase = value;
      },
      setStats: value => Object.assign(stats, value),
      pushThinking: delta => {
        thinkingChars += delta.length;
      },
      // Nothing is redrawn here, so the plan is only recorded for the caller.
      setPlan: snapshot => {
        plan = snapshot;
      },
      commit: line => process.stdout.write(`${line}\n`),
      tickFlow: () => {},
      pause: () => {},
      resume: () => {},
      stop: () => Date.now() - start,
      interactive: false,
      get thinkingChars() {
        return thinkingChars;
      },
      get plan() {
        return plan;
      },
    };
  }

  // `- 1` leaves the last column empty: writing into it makes some terminals
  // wrap eagerly, which would desynchronise the erase walk. There is no lower
  // clamp for the same reason — a terminal narrower than the HUD's box gets a
  // status line from `renderHud`, never a box that wraps.
  const width = () => Math.min(HUD_MAX_WIDTH, Math.max(1, terminalColumns() - 1));

  // --- throughput sampling ---------------------------------------------------
  // `setStats` arrives in bursts (several updates inside one streaming chunk,
  // then nothing for a second), so sampling per call would draw the shape of
  // the transport rather than of the model. The frame timer drives a fixed
  // cadence instead, and each bar is the output-token delta over that window.
  const spark: number[] = [];
  let sawStats = false;
  let sampledOutput = 0;
  let sampledAt = 0;

  const sampleThroughput = (now: number) => {
    if (!sawStats) return;
    if (sampledAt === 0) {
      sampledAt = now;
      sampledOutput = stats.output ?? 0;
      return;
    }
    // Bounded: a long stall (a suspended process, a slow tool) must not push a
    // thousand zero bars through the ring buffer.
    for (let guard = 0; guard < SPARK_SAMPLES && now - sampledAt >= SAMPLE_MS; guard++) {
      const current = stats.output ?? 0;
      spark.push(Math.max(0, current - sampledOutput));
      sampledOutput = current;
      sampledAt += SAMPLE_MS;
      if (spark.length > SPARK_SAMPLES) spark.shift();
    }
    if (now - sampledAt >= SAMPLE_MS) sampledAt = now;
  };

  const clear = () => {
    if (drawn === 0) return;
    let seq = "\r";
    for (let i = 0; i < drawn; i++) seq += i === 0 ? "\x1b[2K" : "\x1b[1A\x1b[2K";
    process.stdout.write(seq);
    drawn = 0;
  };

  /** Lines the pane may occupy, or Infinity when the terminal height is unknown. */
  const heightBudget = (): number => {
    const rows = process.stdout.rows;
    if (typeof rows !== "number" || rows <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(1, rows - HEIGHT_MARGIN);
  };

  const bodyLines = (): string[] =>
    composePane({
      now: Date.now(),
      width: width(),
      budget: heightBudget(),
      flow: options?.flow,
      hud: {
        label,
        phase,
        frame: FRAMES[tick % FRAMES.length],
        elapsedMs: Date.now() - start,
        now: Date.now(),
        width: width(),
        stats,
        spark,
        route,
        plan,
        thinking: thinkingBuffer,
        thinkingWindow: THINK_WINDOW,
        maxRows: 0, // replaced by composePane
      },
    });

  const render = () => {
    if (stopped || paused) return;
    clear();
    // `clear()` erases exactly the line count it last drew, so the body is free
    // to grow and shrink between frames.
    const body = bodyLines();
    process.stdout.write(body.join("\n"));
    drawn = body.length;
  };

  process.stdout.write("\x1b[?25l"); // hide cursor
  render();
  timer = setInterval(() => {
    tick++;
    options?.onFrame?.();
    sampleThroughput(Date.now());
    render();
  }, FRAME_MS);

  return {
    setPhase: value => {
      phase = value;
      render();
    },
    setStats: value => {
      Object.assign(stats, value);
      sawStats = true;
      render();
    },
    pushThinking: delta => {
      thinkingChars += delta.length;
      thinkingBuffer += delta;
      if (thinkingBuffer.length > 4000) thinkingBuffer = thinkingBuffer.slice(-2000);
      render();
    },
    setPlan: snapshot => {
      plan = snapshot;
      render();
    },
    tickFlow: () => {
      if (options?.flow) render();
    },
    commit: line => {
      clear();
      process.stdout.write(`${line}\n`);
      render();
    },
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      clear();
      process.stdout.write("\x1b[?25h"); // the prompt needs a visible cursor
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      process.stdout.write("\x1b[?25l");
      render();
      timer = setInterval(() => {
        tick++;
        options?.onFrame?.();
        sampleThroughput(Date.now());
        render();
      }, FRAME_MS);
    },
    stop: () => {
      if (stopped) return Date.now() - start;
      stopped = true;
      if (timer) clearInterval(timer);
      clear();
      process.stdout.write("\x1b[?25h"); // show cursor
      return Date.now() - start;
    },
    interactive: true,
    get thinkingChars() {
      return thinkingChars;
    },
    get plan() {
      return plan;
    },
  };
}

/** One-line summary printed after a reasoning phase completes. */
export function thinkingSummary(ms: number, tokens?: number, chars?: number): string {
  const bits = [c.violet(THINK_GLYPH), c.faint("thought for"), c.violet(formatDuration(ms))];
  if (tokens) bits.push(c.faint("·"), c.violet(`${tokens} tokens`));
  else if (chars) bits.push(c.faint("·"), c.violet(`${chars} chars`));
  return bits.join(" ");
}
