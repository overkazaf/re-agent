// Tool output budgeting. Reverse engineering commands are exactly the kind that
// emit megabytes (`objdump -d`, `strings` on a fat binary), and a raw dump into
// the transcript costs the whole context window. Anything over budget is spilled
// to a file next to the session log; the model gets head+tail plus the path, and
// can read the rest deliberately with read_file/grep.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolContext } from "../types";

export interface SpillResult {
  text: string;
  /** Absolute path of the full output, when it did not fit the budget. */
  artifact?: string;
  originalChars: number;
}

/** Head/tail split of the budget: an error usually lands at the end, a header at the start. */
const HEAD_SHARE = 0.6;

export function previewOf(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.max(1, Math.floor(maxChars * HEAD_SHARE));
  const tail = Math.max(1, maxChars - head);
  return {
    text: `${text.slice(0, head)}\n\n… [${text.length - head - tail} chars elided] …\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

/**
 * Caps `text` at the policy budget. When it overflows, the full text is written
 * to `<sessionDir>/artifacts/` and referenced from the returned preview.
 */
export async function spillIfLarge(
  text: string,
  options: { context: ToolContext; label: string; maxChars?: number },
): Promise<SpillResult> {
  const maxChars = options.maxChars ?? options.context.policy.maxToolOutputChars;
  if (text.length <= maxChars) return { text, originalChars: text.length };

  const preview = previewOf(text, maxChars);
  const artifact = await writeArtifact(text, options.context, options.label).catch(() => undefined);
  const note = artifact
    ? `\n\n[full output: ${text.length} chars saved to ${artifact} — read_file/grep it for the rest]`
    : `\n\n[full output was ${text.length} chars; could not save an artifact copy]`;
  return { text: `${preview.text}${note}`, artifact, originalChars: text.length };
}

async function writeArtifact(text: string, context: ToolContext, label: string): Promise<string> {
  const dir = path.join(context.sessionDir, "artifacts");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${slug(label)}.txt`);
  await fs.writeFile(file, text, "utf8");
  return file;
}

function slug(label: string): string {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "output").slice(0, 40);
}
