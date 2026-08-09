// The permanent half of the visualization: one line per event, stamped with an
// offset from the start of the turn, committed into the scrollback while the
// diagram above it animates. Reading a finished turn afterwards should feel
// like reading a packet capture.

import { c, compactNumber, displayWidth, formatDuration, termWidth, truncate } from "./theme";
import type { LoopEvent } from "../core/agent-loop";
import type { PlanSnapshot, PlanStep } from "../types";

const GUTTER = "▏";
/** Host-side task-list tool; its calls are narrated as plan transitions instead. */
const PLAN_TOOL = "update_plan";
const BAR_CELLS = 10;

export interface TraceOptions {
  /** Turn start, so every line carries `t+…` rather than a wall clock. */
  startedAt: number;
  now?: number;
  width?: number;
  /** Longest request seen so far, so the duration bars share one scale. */
  slowestMs?: number;
  /** The plan as it was before this event, so only the transition is printed. */
  previousPlan?: PlanSnapshot;
}

/**
 * Renders one event as trace lines. Returns [] for events that carry no new
 * information worth a permanent line (token counters, partial text).
 */
export function traceEvent(event: LoopEvent, options: TraceOptions): string[] {
  const now = options.now ?? Date.now();
  const stamp = (at = now) => c.faint(`t+${((at - options.startedAt) / 1000).toFixed(3).padStart(6)} `);
  const width = options.width ?? termWidth();
  const line = (mark: string, markStyle: (text: string) => string, body: string) =>
    `${stamp()}${c.rule(GUTTER)}${markStyle(mark)} ${truncate(body, Math.max(20, width - 14))}`;

  switch (event.type) {
    case "turn":
      return event.turn === 1 ? [] : [line("↻", c.faint, `${c.faint("turn")} ${c.text(String(event.turn))}`)];

    case "compaction":
      return [
        line(
          "◈",
          c.warn,
          `${c.faint("context")} ${c.text(`${compactNumber(event.tokensBefore)}→${compactNumber(event.tokensAfter)} tok`)} ${c.faint(
            `${event.droppedMessages} dropped · ${event.elidedToolResults} elided`,
          )}`,
        ),
      ];

    case "wire":
      if (event.phase === "send") {
        return [
          line("⇢", c.accent, `${c.accent("POST")} ${c.text(event.endpoint)}`),
          `${" ".repeat(9)}${c.rule(GUTTER)}  ${c.faint(
            `model=${event.model} in=${compactNumber(event.tokens)} msgs=${event.messages} tools=${event.tools}`,
          )}`,
        ];
      }
      if (!event.ok) {
        return [line("⇠", c.err, `${c.err(event.error ?? "failed")} ${c.faint(formatDuration(event.ms))}`)];
      }
      return [
        line(
          "⇠",
          c.ok,
          [
            c.ok("200"),
            event.usage?.output ? `${c.faint("out=")}${c.text(compactNumber(event.usage.output))}` : "",
            event.usage?.thinking ? `${c.faint("think=")}${c.violet(compactNumber(event.usage.thinking))}` : "",
            event.usage?.cacheRead ? `${c.faint("cache=")}${c.ok(compactNumber(event.usage.cacheRead))}` : "",
            event.toolCalls > 0 ? `${c.faint("calls=")}${c.violet(String(event.toolCalls))}` : "",
            durationBar(event.ms, options.slowestMs ?? event.ms),
          ]
            .filter(Boolean)
            .join(" "),
        ),
      ];

    // The plan tool is narrated by its own `plan` lines below, and its argument
    // is the entire task list as JSON — printing it twice is pure noise. A
    // failure still gets a line, because then nothing else reports it.
    case "tool_start":
      if (event.name === PLAN_TOOL) return [];
      return [line(" ⚙", c.violet, `${c.violet(event.name)} ${c.faint(summarize(event.args))}`)];

    case "tool_end": {
      if (event.name === PLAN_TOOL && event.ok) return [];
      const mark = event.ok ? " ✓" : " ✗";
      const style = event.ok ? c.ok : c.err;
      return [line(mark, style, `${c.faint(formatDuration(event.ms))} ${c.muted(event.preview)}`)];
    }

    case "plan":
      return planLines(event.snapshot, options.previousPlan, line);

    case "reply":
      return [
        line(
          "◆",
          c.accent,
          `${c.faint("reply")} ${c.text(`${compactNumber(event.text.length)} chars`)}${
            event.usage?.output ? ` ${c.faint("·")} ${c.text(`${compactNumber(event.usage.output)} tok`)}` : ""
          }`,
        ),
      ];

    default:
      return [];
  }
}

/** Closing line of a turn: the total, so the trace block reads as one unit. */
export function traceEnd(options: { startedAt: number; ms: number; provider: string; interrupted?: boolean }): string {
  const mark = options.interrupted ? c.warn("⊘") : c.accent("■");
  const what = options.interrupted ? c.warn("interrupted") : c.faint("turn complete");
  return `${c.faint(`t+${(options.ms / 1000).toFixed(3).padStart(6)} `)}${c.rule(GUTTER)}${mark} ${what} ${c.faint("via")} ${c.accent(
    options.provider,
  )} ${c.faint(formatDuration(options.ms))}`;
}

/**
 * A plan update as a *transition*, never as a dump — the full list is archived
 * to the scrollback once, at the end of the turn. Pure appends are silent: a
 * list being constructed step by step (Claude sends one TaskCreate per step) is
 * not a timeline event, and would otherwise print a line per step.
 */
function planLines(
  next: PlanSnapshot,
  previous: PlanSnapshot | undefined,
  line: (mark: string, style: (text: string) => string, body: string) => string,
): string[] {
  const counts = `${next.steps.filter(step => step.status === "completed").length}/${next.steps.length}`;
  const head = `${c.faint("plan")} ${c.text(counts)}`;
  const mark = "◇";

  if (!previous) {
    return [line(mark, c.accent, `${head} ${c.faint(`opened via ${next.source}`)}`)];
  }

  // The shared prefix has to line up by text for this to be the same list
  // growing; anything else (a shrink, a reorder, an edit) is a rewrite.
  const prefixIntact = previous.steps.every((step, index) => step.text === next.steps[index]?.text);
  if (!prefixIntact) {
    return [line(mark, c.warn, `${head} ${c.faint(`rewritten (was ${previous.steps.length} steps)`)}`)];
  }

  // Status changes anywhere in the shared prefix, plus any *new* step that did
  // not arrive as plain `pending`. Appending pending steps is list construction
  // and stays silent — but an append that also closes a step is two real
  // transitions, and the whole-list sources (update_plan, codex plan_update)
  // send exactly that shape whenever a model finds work while finishing work.
  const changed = [
    ...previous.steps
      .map((before, index) => ({ before, step: next.steps[index] }))
      .filter(entry => entry.step && entry.before.status !== entry.step.status),
    ...next.steps.slice(previous.steps.length).filter(step => step.status !== "pending").map(step => ({ before: undefined, step })),
  ];
  if (changed.length === 0) return [];
  if (changed.length > 3) {
    return [line(mark, c.accent, `${head} ${c.faint(`${changed.length} steps advanced`)}`)];
  }
  return changed
    .filter((entry): entry is { before: PlanStep | undefined; step: PlanStep } => Boolean(entry.step))
    .map(entry => line(mark, statusStyle(entry.step), `${head} ${stepBody(entry.step)}`));
}

function statusStyle(step: PlanStep): (text: string) => string {
  if (step.status === "completed") return c.ok;
  if (step.status === "in_progress") return c.violet;
  return c.faint;
}

function stepBody(step: PlanStep): string {
  const glyph = step.status === "completed" ? c.ok("✔") : step.status === "in_progress" ? c.violet("▸") : c.faint("○");
  // Same rule as the HUD: only report a duration that was actually elapsed.
  const ran = step.startedAt && step.completedAt && step.completedAt > step.startedAt;
  const took = step.status === "completed" && ran ? ` ${c.faint(formatDuration(step.completedAt! - step.startedAt!))}` : "";
  return `${glyph} ${c.text(step.text)}${took}`;
}

/** Relative duration bar, scaled against the slowest request of the turn. */
function durationBar(ms: number, slowestMs: number): string {
  const ratio = slowestMs > 0 ? Math.min(1, ms / slowestMs) : 0;
  const filled = Math.max(1, Math.round(ratio * BAR_CELLS));
  return `${c.accentDim("█".repeat(filled))}${c.rule("░".repeat(Math.max(0, BAR_CELLS - filled)))} ${c.faint(formatDuration(ms))}`;
}

function summarize(args: Record<string, unknown>): string {
  const rendered = Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return displayWidth(rendered) > 60 ? `${rendered.slice(0, 57)}…` : rendered;
}
