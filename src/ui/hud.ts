// The HUD: one boxed dashboard that carries the whole live pane — routing,
// progress, the dataflow strip, the task list, streamed reasoning, and
// telemetry — as labeled sections instead of loose stripes.
//
// Everything here is pure composition: a `HudModel` in, `string[]` out, with no
// timers, no cursor moves, and no I/O. The caller (live.ts) owns the redraw, so
// the only hard contract this file has to honour is that *every* returned line
// renders in exactly `width` columns or fewer, measured with `displayWidth`.
// A single soft-wrapped line permanently desynchronises the caller's erase walk,
// which is why width math here is done on plain text and painted afterwards —
// `truncate` is not ANSI-safe and silently drops colour when it clips.

import { planCounts } from "../core/plan";
import type { PlanSnapshot, PlanStep } from "../types";
import { c, compactNumber, displayWidth, formatDuration, padEnd, truncate, wrapAnsi } from "./theme";

type Painter = (value: string) => string;

/** Text plus its painted form. Width math always runs on `plain`. */
export interface Chip {
  plain: string;
  painted: string;
}

export function chip(plain: string, painted?: string): Chip {
  return { plain, painted: painted ?? plain };
}

// --- glyphs ------------------------------------------------------------------

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } as const;

const SPARK = "▁▂▃▄▅▆▇█";
const BAR_ON = "▰";
const BAR_OFF = "▱";
const DONE_GLYPH = "✔";
const PENDING_GLYPH = "○";
const SPIN_GLYPH = "⠿";
const MORE_GLYPH = "…";
const THINK_GLYPH = "┊";
const CLOCK_GLYPH = "◷";
const ARROW = "→";

/**
 * Deliberately avoids characters with `Emoji_Presentation=Yes` (⏱ ⏺ and
 * friends): terminals render those double-width while this codebase's width
 * table calls them narrow, which breaks the box by one column per glyph.
 */
export const HUD_TITLE = "0xAF·RE";

/**
 * Past this the box stops being a dashboard and becomes a wall: the task column
 * fills with whitespace and the eye has to travel to reach the telemetry. Also
 * keeps the HUD aligned with `termWidth()`, which caps committed lines at 110.
 */
export const HUD_MAX_WIDTH = 120;
/**
 * Narrower than this and the box costs more columns than it organises, so the
 * HUD drops to a single unboxed status line. Never clamp *up* to reach it: a
 * box wider than the terminal soft-wraps, and one wrapped line desynchronises
 * the caller's erase walk for the rest of the session.
 */
export const MIN_BOX_WIDTH = 20;
const SPARK_MAX = 16;
const BAR_CELLS = 8;
const DEFAULT_COLLAPSE = 8;
const DEFAULT_THINK_WINDOW = 3;

// --- model -------------------------------------------------------------------

export interface HudStats {
  input?: number;
  output?: number;
  thinking?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
}

/** The planner → executor chain, with the side currently answering marked. */
export interface HudRoute {
  planner: string;
  executor: string;
  /** Provider name of the active side; unmatched or absent highlights neither. */
  active?: string;
}

export interface HudModel {
  /** Route label used when no dual-model `route` is supplied. */
  label: string;
  phase: string;
  /** Spinner frame; empty renders a static glyph (for archived snapshots). */
  frame: string;
  elapsedMs: number;
  /** Clock reading for this frame, so live step timings tick coherently. */
  now: number;
  width: number;
  stats: HudStats;
  /** Output-token deltas sampled on a fixed cadence, oldest first. */
  spark: readonly number[];
  /**
   * Rendered dataflow lines from ./flow — the request path and, when tools are
   * in play, the tool path. Drawn as the FLOW / TOOLS sections.
   */
  flowLines?: string[];
  route?: HudRoute;
  plan?: PlanSnapshot;
  /** Raw streamed reasoning; the HUD wraps and tails it to the box width. */
  thinking?: string;
  thinkingWindow?: number;
  /** Hard ceiling on returned lines. The HUD sheds content to respect it. */
  maxRows?: number;
}

// --- box primitives ----------------------------------------------------------

/** Columns available between the `│ ` and ` │` of a content row. */
export function boxInner(width: number): number {
  return Math.max(1, width - 4);
}

/**
 * A content row. `content` must already measure at most `boxInner(width)`;
 * anything longer is clipped as a last-resort safety valve, which costs its
 * colour but keeps the caller's erase walk in sync.
 */
export function boxRow(content: string, width: number): string {
  const inner = boxInner(width);
  const body = displayWidth(content) > inner ? truncate(content, inner) : content;
  return `${c.rule(BOX.v)} ${padEnd(body, inner)} ${c.rule(BOX.v)}`;
}

/** `╭─ chip chip ──────╮`, dropping trailing head chips that do not fit. */
export function boxTop(width: number, head: Chip[]): string {
  const used = head.filter(item => item.plain.length > 0);
  while (used.length > 1 && 5 + joinedWidth(used) > width) used.pop();
  let plain = used.map(item => item.plain).join(" ");
  let painted = used.map(item => item.painted).join(" ");
  if (5 + displayWidth(plain) > width) {
    plain = truncate(plain, Math.max(0, width - 5));
    painted = c.faint(plain);
  }
  const fill = Math.max(0, width - 5 - displayWidth(plain));
  const lead = c.rule(`${BOX.tl}${BOX.h}`);
  const tail = c.rule(`${BOX.h.repeat(fill)}${BOX.tr}`);
  return plain ? `${lead} ${painted} ${tail}` : `${lead}${c.rule(`${BOX.h.repeat(Math.max(0, width - 3))}${BOX.tr}`)}`;
}

export function boxBottom(width: number): string {
  return c.rule(`${BOX.bl}${BOX.h.repeat(Math.max(0, width - 2))}${BOX.br}`);
}

function joinedWidth(chips: Chip[]): number {
  return displayWidth(chips.map(item => item.plain).join(" "));
}

// --- plan rows ---------------------------------------------------------------

/** One task-list line, before it is fitted to a column. */
export interface PlanRow {
  glyph: string;
  glyphPaint: Painter;
  text: string;
  paint: Painter;
  /** Elapsed label, right-aligned inside the row when there is room. */
  timing?: string;
}

export interface PlanRowOptions {
  collapseAfter?: number;
  /** Spinner glyph for the in-progress row; empty falls back to a static one. */
  frame?: string;
  /** Clock reading used for the live elapsed on the in-progress step. */
  now?: number;
  /** Set false to drop every elapsed label. Defaults to on. */
  timings?: boolean;
  /**
   * Whether the in-progress step shows a running elapsed. Off for archived
   * output, where a duration measured against "whenever this was printed" says
   * more about the reader's clock than about the run.
   */
  live?: boolean;
}

/**
 * Bounds the step list to at most `collapseAfter` rows. The finished head folds
 * into one `✔ N done` counter, since what matters live is the current step and
 * what is still ahead; anything still over budget is clipped from the tail with
 * a `… N more` marker.
 */
export function planRows(steps: PlanStep[], options: PlanRowOptions = {}): PlanRow[] {
  const collapseAfter = Math.max(1, Math.floor(options.collapseAfter ?? DEFAULT_COLLAPSE));
  const frame = options.frame && options.frame.length > 0 ? options.frame : SPIN_GLYPH;
  const now = options.now ?? Date.now();
  const timings = options.timings !== false;
  const live = options.live !== false;
  const row = (step: PlanStep) => stepRow(step, frame, live ? now : undefined, timings);

  let rows = steps.map(row);
  if (steps.length <= collapseAfter) return rows;

  const active = steps.findIndex(step => step.status !== "completed");
  let folded = false;
  if (active < 0) {
    // Everything is done: the list has nothing left to say but the count.
    rows = [summaryRow(DONE_GLYPH, `${steps.length} done`, c.ok, spanOf(steps, timings))];
    folded = true;
  } else if (active > 1) {
    // Folding a single completed row into a counter would save no space.
    rows = [
      summaryRow(DONE_GLYPH, `${active} done`, c.ok, spanOf(steps.slice(0, active), timings)),
      ...steps.slice(active).map(row),
    ];
    folded = true;
  }
  if (rows.length <= collapseAfter) return rows;

  // One row is reserved for the `… N more` marker. When that leaves room for a
  // single row only, the step being worked on beats the finished-count header.
  const keep = Math.max(1, collapseAfter - 1);
  const start = folded && keep < 2 ? 1 : 0;
  const shown = rows.slice(start, start + keep);
  return [...shown, summaryRow(MORE_GLYPH, `${rows.length - start - keep} more`, c.faint)];
}

function stepRow(step: PlanStep, frame: string, now: number | undefined, timings: boolean): PlanRow {
  if (step.status === "completed") {
    return {
      glyph: DONE_GLYPH,
      glyphPaint: c.ok,
      text: step.text,
      paint: c.faint,
      timing: timings ? elapsedLabel(step.startedAt, step.completedAt) : undefined,
    };
  }
  if (step.status === "in_progress") {
    return {
      glyph: frame,
      glyphPaint: c.accent,
      text: step.text,
      paint: value => c.bold(c.text(value)),
      timing: timings ? elapsedLabel(step.startedAt, now) : undefined,
    };
  }
  return { glyph: PENDING_GLYPH, glyphPaint: c.faint, text: step.text, paint: c.faint };
}

function summaryRow(glyph: string, text: string, glyphPaint: Painter, timing?: string): PlanRow {
  return { glyph, glyphPaint, text, paint: c.faint, timing };
}

function elapsedLabel(from?: number, to?: number): string | undefined {
  if (typeof from !== "number" || typeof to !== "number") return undefined;
  const ms = to - from;
  // A step that was created and completed by the same update never actually
  // ran; reporting "0ms" implies a measurement that was never taken.
  return ms > 0 ? formatDuration(ms) : undefined;
}

/** Wall time a folded run of completed steps took, first start to last finish. */
function spanOf(steps: PlanStep[], timings: boolean): string | undefined {
  if (!timings) return undefined;
  const starts = steps.map(step => step.startedAt).filter((value): value is number => typeof value === "number");
  const ends = steps.map(step => step.completedAt).filter((value): value is number => typeof value === "number");
  if (starts.length === 0 || ends.length === 0) return undefined;
  return elapsedLabel(Math.min(...starts), Math.max(...ends));
}

/**
 * Fits a row to exactly `width` columns: glyph, text, then the elapsed label
 * pushed to the right edge. The timing is dropped rather than allowed to crowd
 * the text out — a step you cannot read is worse than one you cannot time.
 */
export function paintPlanRow(row: PlanRow, width: number): string {
  const glyphWidth = displayWidth(row.glyph);
  const available = width - glyphWidth - 1;
  if (available <= 0) return row.glyphPaint(row.glyph);

  let timing = row.timing;
  let textMax = available;
  if (timing) {
    const need = displayWidth(timing) + 1;
    if (available - need >= 4) textMax = available - need;
    else timing = undefined;
  }
  const text = truncate(row.text, textMax);
  const gap = available - displayWidth(text) - (timing ? displayWidth(timing) : 0);
  const tail = timing
    ? `${" ".repeat(Math.max(1, gap))}${c.faint(timing)}`
    : " ".repeat(Math.max(0, gap));
  return `${row.glyphPaint(row.glyph)} ${row.paint(text)}${tail}`;
}

// --- meters ------------------------------------------------------------------

/**
 * Output-token throughput as block glyphs, normalised to the window maximum.
 * Renders nothing below two samples or while nothing is flowing: a flat row of
 * `▁` would read as measured-and-idle rather than not-yet-measured.
 */
export function sparkline(samples: readonly number[], cells: number): string {
  if (cells < 2 || samples.length < 2) return "";
  const window = samples.slice(-cells);
  const max = Math.max(...window);
  if (!(max > 0)) return "";
  return window
    .map(value => {
      const level = Math.round((Math.max(0, value) / max) * (SPARK.length - 1));
      return SPARK[Math.min(SPARK.length - 1, Math.max(0, level))];
    })
    .join("");
}

export function progressChip(done: number, total: number, cells = BAR_CELLS): Chip | undefined {
  if (total <= 0 || cells < 3) return undefined;
  const ratio = Math.min(1, Math.max(0, done / total));
  const filled = Math.min(cells, Math.round(ratio * cells));
  const percent = `${Math.round(ratio * 100)}%`;
  const bar = `${BAR_ON.repeat(filled)}${BAR_OFF.repeat(cells - filled)}`;
  const paintedBar = `${c.accent(BAR_ON.repeat(filled))}${c.rule(BAR_OFF.repeat(cells - filled))}`;
  return chip(`${bar} ${percent}`, `${paintedBar} ${c.faint(percent)}`);
}

/** `planner → executor`, with the answering side lit and the other dimmed. */
export function routeChip(model: HudModel): Chip {
  const route = model.route;
  if (!route) return chip(model.label, c.bold(c.accent(model.label)));
  // A pinned provider (`/agent deepseek`) answers alone: showing the
  // planner → executor chain would name two models that are not being used.
  if (route.active && route.active !== route.planner && route.active !== route.executor) {
    return chip(route.active, c.bold(c.violet(route.active)));
  }
  if (route.planner === route.executor) {
    return chip(route.planner, c.bold(c.accent(route.planner)));
  }
  const paint = (name: string, tone: Painter): string => {
    if (route.active === undefined) return c.text(name);
    return route.active === name ? c.bold(tone(name)) : c.faint(name);
  };
  return chip(
    `${route.planner} ${ARROW} ${route.executor}`,
    `${paint(route.planner, c.accent)} ${c.rule(ARROW)} ${paint(route.executor, c.violet)}`,
  );
}

function costChip(costUsd?: number): Chip | undefined {
  if (!costUsd) return undefined;
  const value = costUsd >= 0.01 ? costUsd.toFixed(2) : costUsd.toFixed(4);
  return chip(`$${value}`, `${c.faint("$")}${c.warn(value)}`);
}

// --- sections ----------------------------------------------------------------

/** Columns taken by a section label plus its gap, for continuation alignment. */
const SECTION_GAP = 2;

function sectionLabel(name: string): string {
  return `${c.faint(name)}${" ".repeat(SECTION_GAP)}`;
}

/**
 * One-line telemetry: throughput with its sparkline, token counters, and the
 * running clock. Everything fits a single section row instead of a side column.
 */
function telemetryLine(model: HudModel, inner: number): Chip | undefined {
  const stats = model.stats;
  const chips: Chip[] = [];
  if (typeof stats.output === "number") {
    const value = compactNumber(stats.output);
    const spark = sparkline(model.spark, Math.min(SPARK_MAX, inner));
    chips.push(
      spark
        ? chip(`out ${spark} ${value}`, `${c.faint("out")} ${c.accent(spark)} ${c.text(value)}`)
        : chip(`out ${value}`, `${c.faint("out")} ${c.text(value)}`),
    );
  }
  chips.push(...counterChips(stats));
  const elapsed = formatDuration(model.elapsedMs);
  chips.push(chip(`${CLOCK_GLYPH} ${elapsed}`, `${c.faint(CLOCK_GLYPH)} ${c.ok(elapsed)}`));
  if (chips.length === 0) return undefined;
  const limit = Math.max(20, inner - displayWidth("TELE") - SECTION_GAP);
  const packed = packChips(chips, limit, " · ");
  return packed[0];
}

function counterChips(stats: HudStats): Chip[] {
  const out: Chip[] = [];
  const add = (label: string, value: number | undefined, tone: Painter) => {
    if (!value) return;
    const text = compactNumber(value);
    out.push(chip(`${label} ${text}`, `${c.faint(label)} ${tone(text)}`));
  };
  add("think", stats.thinking, c.violet);
  add("in", stats.input, c.text);
  add("cache", stats.cacheRead, c.ok);
  return out;
}

/** Greedily packs chips onto lines of at most `width` columns. */
export function packChips(chips: Chip[], width: number, gap = "  "): Chip[] {
  const lines: Chip[] = [];
  let current: Chip | undefined;
  for (const item of chips) {
    if (!current) {
      current = item;
      continue;
    }
    const plain = `${current.plain}${gap}${item.plain}`;
    if (displayWidth(plain) <= width) {
      current = chip(plain, `${current.painted}${gap}${item.painted}`);
    } else {
      lines.push(current);
      current = item;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// --- layout ------------------------------------------------------------------

/** Row 1: routing on the left, progress and spend pushed to the right edge. */
function statusRow(model: HudModel, inner: number): string {
  const route = routeChip(model);
  const { done, total } = planCounts(model.plan);
  const tail: Chip[] = [];
  const progress = progressChip(done, total);
  if (progress) tail.push(progress);
  const cost = costChip(model.stats.costUsd);
  if (cost) tail.push(cost);

  while (tail.length > 0) {
    const plain = tail.map(item => item.plain).join("  ");
    if (displayWidth(route.plain) + 2 + displayWidth(plain) <= inner) {
      const gap = inner - displayWidth(route.plain) - displayWidth(plain);
      return `${route.painted}${" ".repeat(gap)}${tail.map(item => item.painted).join("  ")}`;
    }
    tail.pop();
  }
  if (displayWidth(route.plain) <= inner) return route.painted;
  return c.bold(c.accent(truncate(route.plain, inner)));
}

function thinkingRows(model: HudModel, inner: number, window: number, prefix = 0): string[] {
  if (window <= 0) return [];
  const raw = model.thinking?.replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const textWidth = Math.max(4, inner - 2 - prefix);
  const wrapped = wrapAnsi(raw, textWidth).filter(line => line.trim().length > 0);
  return wrapped
    .slice(-window)
    .map(line => `${c.violetDim(THINK_GLYPH)} ${c.faint(truncate(line, textWidth))}`);
}

interface BuildOptions {
  showFlow: boolean;
  thinkWindow: number;
  collapseAfter: number;
  note: boolean;
  showTele: boolean;
}

function build(model: HudModel, width: number, options: BuildOptions): string[] {
  const inner = boxInner(width);
  const steps = model.plan?.steps ?? [];
  const rows = steps.length > 0
    ? planRows(steps, { collapseAfter: options.collapseAfter, frame: model.frame, now: model.now })
    : [];

  const head: Chip[] = [];
  if (model.frame) head.push(chip(model.frame, c.accent(model.frame)));
  head.push(chip(HUD_TITLE, c.bold(c.accent(HUD_TITLE))));

  const lines = [boxTop(width, head), boxRow(statusRow(model, inner), width)];

  // FLOW / TOOLS: the dataflow strip, labelled by which half of the loop it is.
  if (options.showFlow && model.flowLines) {
    const request = model.flowLines[0];
    if (request) lines.push(boxRow(`${sectionLabel("FLOW")}${request}`, width));
    const tools = model.flowLines[1];
    if (tools) lines.push(boxRow(`${sectionLabel("TOOLS")}${tools}`, width));
  }

  // PLAN: one header row (counts + progress bar), then the indented task list.
  if (rows.length > 0) {
    const counts = planCounts(model.plan);
    const chips: Chip[] = [
      chip(`${counts.done}/${counts.total}`, `${c.ok(String(counts.done))}${c.faint("/")}${c.text(String(counts.total))}`),
    ];
    const progress = progressChip(counts.done, counts.total);
    if (progress) chips.push(progress);
    lines.push(boxRow(`${sectionLabel("PLAN")}${chips.map(item => item.painted).join("  ")}`, width));
    for (const row of rows) lines.push(boxRow(`  ${paintPlanRow(row, inner - 2)}`, width));
  }
  if (options.note && model.plan?.note) {
    lines.push(boxRow(c.faint(truncate(model.plan.note, inner)), width));
  }

  // THINK: the label rides on the first wrapped line so the section costs no
  // extra rows; continuation lines align under it.
  const thinkLabel = displayWidth("THINK") + SECTION_GAP;
  const thinking = thinkingRows(model, inner, options.thinkWindow, thinkLabel);
  if (thinking.length > 0) {
    lines.push(boxRow(`${sectionLabel("THINK")}${thinking[0]}`, width));
    for (const tail of thinking.slice(1)) lines.push(boxRow(`${" ".repeat(thinkLabel)}${tail}`, width));
  }

  // TELE: one compact row of counters, last so the box always closes on data.
  if (options.showTele) {
    const tele = telemetryLine(model, inner);
    if (tele) lines.push(boxRow(`${sectionLabel("TELE")}${tele.painted}`, width));
  }

  lines.push(boxBottom(width));
  return lines;
}

/**
 * Renders the HUD, shedding content until it fits `maxRows`. The order is the
 * dataflow strip, then the reasoning tail, then telemetry, then the plan note,
 * then the task list collapses — transient narration goes before state you
 * cannot recover by scrolling. Returns at most `maxRows` lines, each at most
 * `width` columns.
 */
export function renderHud(model: HudModel): string[] {
  // The requested width is honoured exactly — capping is the caller's job, so
  // an explicit width (an archived snapshot, a test) renders at that width.
  const width = Math.max(1, Math.floor(model.width));
  const maxRows = model.maxRows ?? Number.POSITIVE_INFINITY;
  if (width < MIN_BOX_WIDTH || maxRows < 4) return [oneLiner(model, width)];

  const options: BuildOptions = {
    showFlow: true,
    thinkWindow: model.thinkingWindow ?? DEFAULT_THINK_WINDOW,
    collapseAfter: DEFAULT_COLLAPSE,
    note: true,
    showTele: true,
  };
  let body = build(model, width, options);
  while (body.length > maxRows && options.showFlow) {
    options.showFlow = false;
    body = build(model, width, options);
  }
  while (body.length > maxRows && options.thinkWindow > 0) {
    options.thinkWindow--;
    body = build(model, width, options);
  }
  while (body.length > maxRows && options.showTele) {
    options.showTele = false;
    body = build(model, width, options);
  }
  if (body.length > maxRows && options.note) {
    options.note = false;
    body = build(model, width, options);
  }
  while (body.length > maxRows && options.collapseAfter > 1) {
    options.collapseAfter--;
    body = build(model, width, options);
  }
  if (body.length > maxRows) {
    // A terminal too short even for the tightest box still keeps its head and
    // its closing edge, so the box never reads as truncated mid-draw.
    body = [...body.slice(0, maxRows - 1), body[body.length - 1]];
  }
  return body;
}

/** Absolute fallback for a terminal with room for a line, not a box. */
function oneLiner(model: HudModel, width: number): string {
  const route = routeChip(model);
  const elapsed = formatDuration(model.elapsedMs);
  const bits = [model.frame ? c.accent(model.frame) : c.accent(SPIN_GLYPH), route.painted, c.violet(model.phase), c.ok(elapsed)];
  const plain = [model.frame || SPIN_GLYPH, route.plain, model.phase, elapsed].join(" ");
  return displayWidth(plain) <= width ? bits.join(" ") : c.faint(truncate(plain, width));
}
