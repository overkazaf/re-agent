// The static plan box: the same task list the live HUD draws, minus the parts
// that only make sense while something is running. The CLI archives one of
// these into the scrollback after the pane stops, and `/plan` reprints it, so
// it carries no spinner frame and no live counters — just the list, its
// completion bar, and how long each finished step took.
//
// All the box and row primitives live in ./hud, so the archived snapshot and
// the live pane cannot drift apart visually.

import { planCounts } from "../core/plan";
import type { PlanSnapshot } from "../types";
import {
  boxBottom,
  boxInner,
  boxRow,
  boxTop,
  chip,
  HUD_MAX_WIDTH,
  MIN_BOX_WIDTH,
  paintPlanRow,
  planRows,
  progressChip,
} from "./hud";
import type { Chip } from "./hud";
import { c, terminalColumns, truncate } from "./theme";

const COLLAPSE_AFTER = 8;

export interface RenderPlanOptions {
  /**
   * Total columns the box may occupy. Defaults to `terminalColumns() - 1`,
   * capped so the archived box matches the width the live HUD used. An explicit
   * value is honoured as given.
   */
  width?: number;
  /** Current spinner glyph for the in-progress row; falls back to a static one. */
  frame?: string;
  /** Step rows to show before the list starts collapsing. Defaults to 8. */
  collapseAfter?: number;
  /** Set false to omit per-step elapsed labels. Defaults to on. */
  timings?: boolean;
  /**
   * Show a running elapsed on the in-progress step, measured against `now`.
   * Off by default here: this box is printed once, so a duration that keeps
   * growing after the frame was captured would be a lie the reader cannot see.
   */
  live?: boolean;
}

/**
 * Renders a plan snapshot as box-drawn lines (no trailing newlines):
 *
 * ```
 * ╭─ PLAN 2/4 ▰▰▰▰▱▱▱▱ 50% ────────────╮
 * │ ✔ triage: file/arch/packer    1.2s  │
 * │ ⠿ 定位校验函数                 4.0s │
 * │ ○ 复现 flag 路径                    │
 * ╰─────────────────────────────────────╯
 * ```
 *
 * Never emits more than `collapseAfter + 3` lines, so callers can budget the
 * height of an in-place redraw up front. Every line measures at most `width`
 * columns via `displayWidth`, which is what keeps the live redraw from wrapping.
 */
export function renderPlan(snapshot: PlanSnapshot, options: RenderPlanOptions = {}): string[] {
  const steps = snapshot.steps ?? [];
  if (steps.length === 0) return [];

  const fallback = Math.min(HUD_MAX_WIDTH, terminalColumns() - 1);
  const width = Math.max(MIN_BOX_WIDTH, Math.floor(options.width ?? fallback));
  const inner = boxInner(width);
  const { done, total } = planCounts(snapshot);

  const head: Chip[] = [chip("PLAN", c.bold(c.accent("PLAN")))];
  head.push(chip(`${done}/${total}`, `${c.ok(String(done))}${c.faint("/")}${c.text(String(total))}`));
  const progress = progressChip(done, total);
  if (progress) head.push(progress);

  const lines = [boxTop(width, head)];
  if (snapshot.note) lines.push(boxRow(c.faint(truncate(snapshot.note, inner)), width));

  const rows = planRows(steps, {
    collapseAfter: options.collapseAfter ?? COLLAPSE_AFTER,
    frame: options.frame,
    timings: options.timings,
    live: options.live === true,
  });
  for (const row of rows) lines.push(boxRow(paintPlanRow(row, inner), width));

  lines.push(boxBottom(width));
  return lines;
}
