// The HUD: one boxed dashboard that carries the whole live pane — routing,
// progress, the task list, and telemetry — instead of three loose stripes.
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
const ACTIVE_GLYPH = "▸";
const ARROW = "→";

/**
 * Deliberately avoids characters with `Emoji_Presentation=Yes` (⏱ ⏺ and
 * friends): terminals render those double-width while this codebase's width
 * table calls them narrow, which breaks the box by one column per glyph.
 */
export const HUD_TITLE = "0xAF·RE";

/** Below this many columns the two-column layout stops being readable. */
export const NARROW_COLUMNS = 60;
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
const RIGHT_MIN = 18;
const RIGHT_MAX = 32;
const LEFT_MIN = 14;
const SPARK_MAX = 16;
const BAR_CELLS = 8;
const DEFAULT_COLLAPSE = 8;
const DEFAULT_THINK_WINDOW = 3;
/** `◷ elapsed` and `▸ phase` are the two telemetry rows never shed. */
const TELEMETRY_FLOOR = 2;

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

// --- telemetry ---------------------------------------------------------------

interface Cell {
  chip: Chip;
  /** Lower survives shedding longer. */
  priority: number;
}

/**
 * The right-hand column. Ordered for reading (throughput, counters, clock,
 * activity) but shed by priority, so a short terminal loses token counters
 * before it loses what the agent is doing right now.
 */
function telemetryCells(model: HudModel, width: number, limit: number): Chip[] {
  const cells: Cell[] = [];
  const stats = model.stats;

  if (typeof stats.output === "number") {
    const value = compactNumber(stats.output);
    const room = width - displayWidth(`out  ${value}`);
    const spark = sparkline(model.spark, Math.min(SPARK_MAX, room));
    cells.push({
      priority: 2,
      chip: spark
        ? chip(`out ${spark} ${value}`, `${c.faint("out")} ${c.accent(spark)} ${c.text(value)}`)
        : chip(`out ${value}`, `${c.faint("out")} ${c.text(value)}`),
    });
  }

  for (const line of packChips(counterChips(stats), width)) {
    cells.push({ priority: 3, chip: line });
  }

  const elapsed = formatDuration(model.elapsedMs);
  cells.push({
    priority: 0,
    chip: chip(`${CLOCK_GLYPH} ${elapsed}`, `${c.faint(CLOCK_GLYPH)} ${c.ok(elapsed)}`),
  });

  const phase = truncate(model.phase, Math.max(1, width - 2));
  cells.push({
    priority: 1,
    chip: chip(`${ACTIVE_GLYPH} ${phase}`, `${c.violetDim(ACTIVE_GLYPH)} ${c.violet(phase)}`),
  });

  if (cells.length <= limit) return cells.map(cell => cell.chip);
  // Drop the least important cells while keeping the reading order intact.
  const doomed = new Set(
    [...cells]
      .map((cell, index) => ({ cell, index }))
      .sort((a, b) => b.cell.priority - a.cell.priority || b.index - a.index)
      .slice(0, cells.length - limit)
      .map(entry => entry.index),
  );
  return cells.filter((_, index) => !doomed.has(index)).map(cell => cell.chip);
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

type Layout = "columns" | "stacked" | "compact";

interface Frame {
  layout: Layout;
  leftWidth: number;
  rightWidth: number;
}

function chooseLayout(width: number, hasPlanRows: boolean): Frame {
  const inner = boxInner(width);
  if (width < NARROW_COLUMNS) return { layout: "compact", leftWidth: inner, rightWidth: 0 };
  if (!hasPlanRows) return { layout: "stacked", leftWidth: inner, rightWidth: inner };
  for (const right of [RIGHT_MAX, 28, 24, RIGHT_MIN]) {
    const left = inner - right - 3;
    if (left >= LEFT_MIN) return { layout: "columns", leftWidth: left, rightWidth: Math.min(right, inner) };
  }
  return { layout: "compact", leftWidth: inner, rightWidth: 0 };
}

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

/**
 * Narrow fallback: the whole right column squeezed onto one line, in the same
 * order the column uses. The clock is laid down first and the phase label is
 * sized from what is left, so a long tool invocation cannot crowd out the
 * elapsed time — a runaway step is exactly when you most want to see it.
 */
function compactStatusRow(model: HudModel, inner: number): string {
  const elapsed = formatDuration(model.elapsedMs);
  const chips: Chip[] = [chip(`${CLOCK_GLYPH} ${elapsed}`, `${c.faint(CLOCK_GLYPH)} ${c.ok(elapsed)}`)];
  const room = inner - displayWidth(chips[0].plain) - 4;
  if (room >= 4) {
    const phase = truncate(model.phase, room);
    chips.push(chip(`${ACTIVE_GLYPH} ${phase}`, `${c.violetDim(ACTIVE_GLYPH)} ${c.violet(phase)}`));
  }
  if (typeof model.stats.output === "number") {
    const value = compactNumber(model.stats.output);
    chips.push(chip(`out ${value}`, `${c.faint("out")} ${c.text(value)}`));
  }
  chips.push(...counterChips(model.stats));
  const packed = packChips(chips, inner);
  return packed[0]?.painted ?? "";
}

function thinkingRows(model: HudModel, inner: number, window: number): string[] {
  if (window <= 0) return [];
  const raw = model.thinking?.replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const textWidth = Math.max(4, inner - 2);
  const wrapped = wrapAnsi(raw, textWidth).filter(line => line.trim().length > 0);
  return wrapped
    .slice(-window)
    .map(line => `${c.violetDim(THINK_GLYPH)} ${c.faint(truncate(line, textWidth))}`);
}

interface BuildOptions {
  thinkWindow: number;
  collapseAfter: number;
  telemetryLimit: number;
  note: boolean;
}

function build(model: HudModel, width: number, options: BuildOptions): string[] {
  const inner = boxInner(width);
  const steps = model.plan?.steps ?? [];
  const rows = steps.length > 0
    ? planRows(steps, { collapseAfter: options.collapseAfter, frame: model.frame, now: model.now })
    : [];
  const frame = chooseLayout(width, rows.length > 0);

  const head: Chip[] = [];
  if (model.frame) head.push(chip(model.frame, c.accent(model.frame)));
  head.push(chip(HUD_TITLE, c.bold(c.accent(HUD_TITLE))));

  const lines = [boxTop(width, head), boxRow(statusRow(model, inner), width)];

  if (options.note && model.plan?.note) {
    lines.push(boxRow(c.faint(truncate(model.plan.note, inner)), width));
  }

  if (frame.layout === "columns") {
    const cells = telemetryCells(model, frame.rightWidth, options.telemetryLimit);
    const height = Math.max(rows.length, cells.length);
    for (let index = 0; index < height; index++) {
      const row = rows[index];
      const left = row ? paintPlanRow(row, frame.leftWidth) : " ".repeat(frame.leftWidth);
      const cell = cells[index];
      const right = cell ? padEnd(cell.painted, frame.rightWidth) : " ".repeat(frame.rightWidth);
      lines.push(boxRow(`${left} ${c.rule(BOX.v)} ${right}`, width));
    }
  } else if (frame.layout === "stacked") {
    for (const row of rows) lines.push(boxRow(paintPlanRow(row, inner), width));
    for (const cell of telemetryCells(model, inner, options.telemetryLimit)) {
      lines.push(boxRow(cell.painted, width));
    }
  } else {
    for (const row of rows) lines.push(boxRow(paintPlanRow(row, inner), width));
    lines.push(boxRow(compactStatusRow(model, inner), width));
  }

  for (const line of thinkingRows(model, inner, options.thinkWindow)) lines.push(boxRow(line, width));
  lines.push(boxBottom(width));
  return lines;
}

/**
 * Renders the HUD, shedding content until it fits `maxRows`. The order is
 * reasoning tail, then the plan note, then the task list collapses, then
 * telemetry rows — transient narration goes before state you cannot recover by
 * scrolling. Returns at most `maxRows` lines, each at most `width` columns.
 */
export function renderHud(model: HudModel): string[] {
  // The requested width is honoured exactly — capping is the caller's job, so
  // an explicit width (an archived snapshot, a test) renders at that width.
  const width = Math.max(1, Math.floor(model.width));
  const maxRows = model.maxRows ?? Number.POSITIVE_INFINITY;
  if (width < MIN_BOX_WIDTH || maxRows < 4) return [oneLiner(model, width)];

  const options: BuildOptions = {
    thinkWindow: model.thinkingWindow ?? DEFAULT_THINK_WINDOW,
    collapseAfter: DEFAULT_COLLAPSE,
    telemetryLimit: 8,
    note: true,
  };
  let body = build(model, width, options);
  while (body.length > maxRows && options.thinkWindow > 0) {
    options.thinkWindow--;
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
  while (body.length > maxRows && options.telemetryLimit > TELEMETRY_FLOOR) {
    options.telemetryLimit--;
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
