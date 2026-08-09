import { describe, expect, test } from "bun:test";
import { PlanTracker, planCounts } from "./plan";
import type { PlanStep } from "../types";

const meta = { source: "update_plan" };

/** Junk arrives from CLIs and models alike, so tests feed it unchecked. */
const loose = (steps: unknown): PlanStep[] => steps as PlanStep[];

const ESC = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);

describe("PlanTracker.update", () => {
  test("returns a snapshot for the first update", () => {
    const tracker = new PlanTracker();
    const snapshot = tracker.update([{ text: "triage binary", status: "in_progress" }], meta);
    expect(snapshot).toBeDefined();
    expect(snapshot?.steps).toMatchObject([{ text: "triage binary", status: "in_progress" }]);
    // An in_progress step is stamped as started so the HUD can time it.
    expect(snapshot?.steps[0].startedAt).toBeNumber();
    expect(snapshot?.steps[0].completedAt).toBeUndefined();
    expect(snapshot?.source).toBe("update_plan");
    expect(snapshot?.note).toBeUndefined();
    expect(tracker.current).toBe(snapshot);
  });

  test("debounces an identical repeat update", () => {
    const tracker = new PlanTracker();
    const steps: PlanStep[] = [
      { text: "triage binary", status: "completed" },
      { text: "find flag", status: "pending" },
    ];
    const first = tracker.update(steps, meta);
    expect(first).toBeDefined();
    expect(tracker.update([...steps], meta)).toBeUndefined();
    expect(tracker.current).toBe(first);
  });

  test("emits a snapshot when only a status changed", () => {
    const tracker = new PlanTracker();
    tracker.update([{ text: "triage binary", status: "pending" }], meta);
    const changed = tracker.update([{ text: "triage binary", status: "completed" }], meta);
    expect(changed).toBeDefined();
    expect(changed?.steps[0].status).toBe("completed");
  });

  test("emits a snapshot when only the note changed", () => {
    const tracker = new PlanTracker();
    const steps: PlanStep[] = [{ text: "triage binary", status: "pending" }];
    tracker.update(steps, meta);
    const renoted = tracker.update([...steps], { source: "update_plan", note: "waiting on unpack" });
    expect(renoted).toBeDefined();
    expect(renoted?.note).toBe("waiting on unpack");
  });

  test("drops blank and text-less steps", () => {
    const tracker = new PlanTracker();
    const snapshot = tracker.update(
      loose([
        { text: "keep me", status: "pending" },
        { text: "   ", status: "pending" },
        { text: "", status: "completed" },
        { status: "pending" },
        { text: 42, status: "pending" },
        null,
      ]),
      meta,
    );
    expect(snapshot?.steps).toEqual([{ text: "keep me", status: "pending" }]);
  });

  test("ignores an all-blank list and leaves current untouched", () => {
    const tracker = new PlanTracker();
    const first = tracker.update([{ text: "triage binary", status: "pending" }], meta);
    expect(tracker.update(loose([{ text: "  ", status: "pending" }, { text: "" }]), meta)).toBeUndefined();
    expect(tracker.update([], meta)).toBeUndefined();
    expect(tracker.current).toBe(first);
  });

  test("coerces an unknown status to pending", () => {
    const tracker = new PlanTracker();
    const snapshot = tracker.update(
      loose([
        { text: "bogus status", status: "in-progress" },
        { text: "missing status" },
        { text: "numeric status", status: 3 },
      ]),
      meta,
    );
    expect(snapshot?.steps.map(step => step.status)).toEqual(["pending", "pending", "pending"]);
  });

  test("strips ANSI escapes and control characters from step text", () => {
    const tracker = new PlanTracker();
    const noisy = `${ESC}[31mdump${ESC}[0m${BELL} the${NUL}flag`;
    const snapshot = tracker.update([{ text: noisy, status: "pending" }], meta);
    expect(snapshot?.steps[0].text).toBe("dump the flag");
  });

  test("truncates over-long step text", () => {
    const tracker = new PlanTracker();
    const snapshot = tracker.update([{ text: "A".repeat(500), status: "pending" }], meta);
    const text = snapshot?.steps[0].text ?? "";
    expect(text.length).toBe(200);
    expect(text.endsWith("…")).toBe(true);
    expect(text.startsWith("AAA")).toBe(true);
  });

  test("clamps the list at 64 steps and says how many were dropped", () => {
    const tracker = new PlanTracker();
    const steps: PlanStep[] = Array.from({ length: 100 }, (_, i) => ({ text: `step ${i}`, status: "pending" }));
    const snapshot = tracker.update(steps, meta);
    // 64 real steps plus one marker row, so a truncated plan never reads as complete.
    expect(snapshot?.steps).toHaveLength(65);
    expect(snapshot?.steps[63].text).toBe("step 63");
    expect(snapshot?.steps[64].text).toBe("… 36 more steps not shown");
  });

  test("does not add the dropped marker at exactly the clamp", () => {
    const tracker = new PlanTracker();
    const steps: PlanStep[] = Array.from({ length: 64 }, (_, i) => ({ text: `step ${i}`, status: "pending" }));
    expect(tracker.update(steps, meta)?.steps).toHaveLength(64);
  });

  test("carries step timings across updates instead of restamping them", async () => {
    const tracker = new PlanTracker();
    tracker.update([{ text: "triage", status: "in_progress" }, { text: "solve", status: "pending" }], meta);
    const startedAt = tracker.current?.steps[0].startedAt;
    expect(startedAt).toBeNumber();
    expect(tracker.current?.steps[1].startedAt).toBeUndefined();

    await Bun.sleep(5);
    tracker.update([{ text: "triage", status: "completed" }, { text: "solve", status: "in_progress" }], meta);
    // The original start survives, so a completed step can report real elapsed time.
    expect(tracker.current?.steps[0].startedAt).toBe(startedAt!);
    expect(tracker.current?.steps[0].completedAt).toBeNumber();
    expect(tracker.current?.steps[0].completedAt! - startedAt!).toBeGreaterThanOrEqual(4);
    expect(tracker.current?.steps[1].startedAt).toBeNumber();
    expect(tracker.current?.steps[1].completedAt).toBeUndefined();
  });

  test("matches steps by provider id, so a renamed step keeps its timing", () => {
    const tracker = new PlanTracker();
    tracker.update([{ id: "1", text: "triage", status: "in_progress" }], meta);
    const startedAt = tracker.current?.steps[0].startedAt;
    tracker.update([{ id: "1", text: "triage the ELF", status: "in_progress" }], meta);
    expect(tracker.current?.steps[0].text).toBe("triage the ELF");
    expect(tracker.current?.steps[0].startedAt).toBe(startedAt!);
  });

  test("reset clears the current snapshot", () => {
    const tracker = new PlanTracker();
    tracker.update([{ text: "triage binary", status: "pending" }], meta);
    tracker.reset();
    expect(tracker.current).toBeUndefined();
    // A repeat of the pre-reset plan is no longer a no-op.
    expect(tracker.update([{ text: "triage binary", status: "pending" }], meta)).toBeDefined();
  });
});

describe("planCounts", () => {
  test("returns zeroes for an undefined snapshot", () => {
    expect(planCounts(undefined)).toEqual({ done: 0, total: 0 });
  });

  test("counts only completed steps", () => {
    const tracker = new PlanTracker();
    const snapshot = tracker.update(
      [
        { text: "triage", status: "completed" },
        { text: "unpack", status: "completed" },
        { text: "solve", status: "in_progress" },
        { text: "write up", status: "pending" },
      ],
      meta,
    );
    expect(planCounts(snapshot)).toEqual({ done: 2, total: 4 });
  });
});
