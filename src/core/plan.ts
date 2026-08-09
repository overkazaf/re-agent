// Tracks the task list a provider is working through. Both sources feed this:
// the CLI event streams (codex `plan_update` / `todo_list`, Claude `TodoWrite`)
// and the host-side `update_plan` tool used by the direct-API providers.
//
// The plan deliberately survives across turns: the CLI providers resume one
// native session, so the next turn usually keeps editing the same list.

import type { PlanSnapshot, PlanStep, PlanUpdateMeta } from "../types";

const MAX_STEPS = 64;
const MAX_STEP_CHARS = 200;

export class PlanTracker {
  private snapshot?: PlanSnapshot;

  get current(): PlanSnapshot | undefined {
    return this.snapshot;
  }

  /**
   * Replaces the plan wholesale. Returns the new snapshot, or `undefined` when
   * nothing changed — callers use that to skip a redraw and a session write.
   */
  update(steps: PlanStep[], meta: PlanUpdateMeta): PlanSnapshot | undefined {
    const cleaned = carryTimings(this.snapshot?.steps ?? [], sanitize(steps));
    if (cleaned.length === 0) return undefined;
    if (this.snapshot && sameSteps(this.snapshot.steps, cleaned) && this.snapshot.note === meta.note) {
      // Same list from a different source: record who last claimed it so the
      // snapshot never reports a stale origin, but skip the redraw.
      this.snapshot.source = meta.source;
      return undefined;
    }
    this.snapshot = { steps: cleaned, source: meta.source, note: meta.note, updatedAt: Date.now() };
    return this.snapshot;
  }

  reset(): void {
    this.snapshot = undefined;
  }
}

export function planCounts(snapshot: PlanSnapshot | undefined): { done: number; total: number } {
  const steps = snapshot?.steps ?? [];
  return { done: steps.filter(step => step.status === "completed").length, total: steps.length };
}

// Plans arrive from external CLIs, so treat every field as untrusted: drop
// blank steps, clamp runaway lists, and strip control characters that would
// corrupt the in-place terminal redraw.
function sanitize(steps: PlanStep[]): PlanStep[] {
  if (!Array.isArray(steps)) return [];
  const out: PlanStep[] = [];
  let dropped = 0;
  for (const step of steps) {
    const text = typeof step?.text === "string" ? clean(step.text) : "";
    if (!text) continue;
    if (out.length >= MAX_STEPS) {
      dropped++;
      continue;
    }
    out.push({
      text,
      status: isStatus(step.status) ? step.status : "pending",
      ...(typeof step.id === "string" && step.id ? { id: step.id } : {}),
    });
  }
  // Never let the clamp make a truncated plan look complete.
  if (dropped > 0) out.push({ text: `… ${dropped} more steps not shown`, status: "pending" });
  return out;
}

function isStatus(value: unknown): value is PlanStep["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

const ANSI = new RegExp("\\x1b\\[[0-9;]*m", "g");
const CONTROL = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");

function clean(value: string): string {
  const flat = value.replace(ANSI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_STEP_CHARS ? `${flat.slice(0, MAX_STEP_CHARS - 1)}…` : flat;
}

// Sources re-send the whole list on every change and carry no timing, so the
// tracker is the only place that knows when a step actually started or ended.
// Steps are matched by provider id when there is one, else by text.
function carryTimings(previous: PlanStep[], next: PlanStep[]): PlanStep[] {
  if (previous.length === 0) {
    const now = Date.now();
    return next.map(step => stamp(step, undefined, now));
  }
  const byId = new Map(previous.filter(step => step.id).map(step => [step.id as string, step]));
  const byText = new Map(previous.map(step => [step.text, step]));
  const now = Date.now();
  return next.map(step => stamp(step, (step.id ? byId.get(step.id) : undefined) ?? byText.get(step.text), now));
}

function stamp(step: PlanStep, previous: PlanStep | undefined, now: number): PlanStep {
  const startedAt = previous?.startedAt ?? (step.status === "pending" ? undefined : now);
  const completedAt = previous?.completedAt ?? (step.status === "completed" ? now : undefined);
  return { ...step, startedAt, completedAt };
}

// Timings are derived state, so they are excluded from the change comparison:
// only text and status decide whether the operator sees a redraw.
function sameSteps(a: PlanStep[], b: PlanStep[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (step, index) => step.text === b[index].text && step.status === b[index].status && step.id === b[index].id,
  );
}
