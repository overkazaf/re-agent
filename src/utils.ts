import * as fs from "node:fs/promises";
import * as path from "node:path";

export function textBlock(text: string) {
  return { type: "text" as const, text };
}

export function textFromBlocks(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("\n");
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function safeJsonParseObject(value: string): Record<string, unknown> {
  try {
    return parseJsonObject(value);
  } catch {
    return { raw: value };
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function resolveInside(root: string, inputPath: string): string {
  const resolved = path.resolve(root, inputPath);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  if (!(await fileExists(file))) return undefined;
  return await fs.readFile(file, "utf8");
}

export function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Thrown when the operator interrupts a turn. Named so `isAbortError` matches it. */
export class InterruptedError extends Error {
  constructor(message = "Interrupted by operator.") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * True for every flavour of "we cancelled this": our own InterruptedError, the
 * DOMException `fetch` rejects with, and the bare abort reasons Bun passes
 * through from `AbortSignal.abort(reason)`.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
    return /aborted|abortsignal/i.test(error.message);
  }
  return error === "cancelled" || error === "aborted";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InterruptedError();
}
