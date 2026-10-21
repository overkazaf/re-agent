import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, ToolContext } from "../types";
import { asNumber, asString, clip, resolveInside, textBlock } from "../utils";
import { validatePathRead } from "../security/policy";
import { runProcess } from "./process";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export function createDiffTools(): AgentTool[] {
  return [
    binaryDiffTool,
    functionDiffTool,
    stringDiffTool,
    sectionDiffTool,
  ];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isPrintableByte(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

function asciiPreview(data: Buffer): string {
  return Array.from(data, byte => (isPrintableByte(byte) ? String.fromCharCode(byte) : ".")).join("");
}

function hexRow(data: Buffer): string {
  return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join(" ");
}

function shannonEntropy(data: Buffer): number {
  if (data.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const byte of data) counts[byte]++;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / data.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

async function readPrefix(file: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function extractPrintableStrings(data: Buffer, minLength: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const byte of data) {
    if (isPrintableByte(byte)) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= minLength) out.push(current);
    current = "";
  }
  if (current.length >= minLength) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// Tool 1: binary_diff — Byte-level binary comparison
// ---------------------------------------------------------------------------

interface DiffRegion {
  offset: number;
  length: number;
  bytesA: Buffer;
  bytesB: Buffer;
  notes: string[];
}

/** Detect common patch patterns in a diff region. */
function detectPatchPatterns(
  bytesA: Buffer,
  bytesB: Buffer,
  offset: number,
  changedStart = 0,
  changedEnd = bytesA.length,
): string[] {
  const notes: string[] = [];

  // NOP sled detection — changed bytes replaced entirely with NOPs
  // (bytes outside [changedStart, changedEnd) are unchanged context, e.g. the
  // opcode of a straddled instruction or bytes of the next instruction, and
  // must not veto the check)
  const isNopRun = (bytes: Buffer) => bytes.every((b, idx) => idx < changedStart || idx >= changedEnd || b === 0x90);
  const allNopsB = isNopRun(bytesB);
  const allNopsA = isNopRun(bytesA);
  if (allNopsB && !allNopsA) notes.push("patched to NOP sled");
  if (allNopsA && !allNopsB) notes.push("NOP sled replaced with code");

  // Single-byte conditional branch flips (x86)
  if (bytesA.length >= 1 && bytesB.length >= 1) {
    const branchFlips: Record<number, [number, string, string]> = {
      0x74: [0x75, "JE", "JNE"],
      0x75: [0x74, "JNE", "JE"],
      0x76: [0x77, "JBE", "JA"],
      0x77: [0x76, "JA", "JBE"],
      0x78: [0x79, "JS", "JNS"],
      0x79: [0x78, "JNS", "JS"],
      0x7c: [0x7d, "JL", "JGE"],
      0x7d: [0x7c, "JGE", "JL"],
      0x7e: [0x7f, "JLE", "JG"],
      0x7f: [0x7e, "JG", "JLE"],
      0xeb: [0x90, "JMP", "NOP"],
    };
    for (let i = 0; i < Math.min(bytesA.length, bytesB.length); i++) {
      const flip = branchFlips[bytesA[i]];
      if (flip && bytesB[i] === flip[0]) {
        notes.push(`${flip[1]}→${flip[2]} — conditional branch flip at +${i}`);
      }
    }
  }

  // Two-byte conditional branch flips (0F 8x)
  if (bytesA.length >= 2 && bytesB.length >= 2) {
    for (let i = 0; i < Math.min(bytesA.length, bytesB.length) - 1; i++) {
      if (bytesA[i] === 0x0f && bytesB[i] === 0x0f) {
        const twoByteFlips: Record<number, [number, string, string]> = {
          0x84: [0x85, "JE (near)", "JNE (near)"],
          0x85: [0x84, "JNE (near)", "JE (near)"],
          0x86: [0x87, "JBE (near)", "JA (near)"],
          0x87: [0x86, "JA (near)", "JBE (near)"],
          0x8c: [0x8d, "JL (near)", "JGE (near)"],
          0x8d: [0x8c, "JGE (near)", "JL (near)"],
          0x8e: [0x8f, "JLE (near)", "JG (near)"],
          0x8f: [0x8e, "JG (near)", "JLE (near)"],
        };
        const flip2 = twoByteFlips[bytesA[i + 1]];
        if (flip2 && bytesB[i + 1] === flip2[0]) {
          notes.push(`${flip2[1]}→${flip2[2]} — near conditional branch flip at +${i}`);
        }
      }
    }
  }

  // Call/jump target redirection (E8/E9 opcode with different displacement)
  if (bytesA.length >= 5 && bytesB.length >= 5) {
    for (let i = 0; i < Math.min(bytesA.length, bytesB.length) - 4; i++) {
      if ((bytesA[i] === 0xe8 || bytesA[i] === 0xe9) && bytesA[i] === bytesB[i]) {
        const dispA = bytesA.readInt32LE(i + 1);
        const dispB = bytesB.readInt32LE(i + 1);
        if (dispA !== dispB) {
          const opName = bytesA[i] === 0xe8 ? "CALL" : "JMP";
          const targetA = offset + i + 5 + dispA;
          const targetB = offset + i + 5 + dispB;
          notes.push(`${opName} target redirected: 0x${targetA.toString(16)} → 0x${targetB.toString(16)} at +${i}`);
        }
      }
    }
  }

  // Zeroed-out region
  const isZeroRun = (bytes: Buffer) => bytes.every((b, idx) => idx < changedStart || idx >= changedEnd || b === 0x00);
  if (isZeroRun(bytesB) && !isZeroRun(bytesA)) {
    notes.push("region zeroed out");
  }

  return notes;
}

function collectDiffRegions(
  dataA: Buffer,
  dataB: Buffer,
  maxDiffs: number,
  contextBytes: number,
): DiffRegion[] {
  const minLen = Math.min(dataA.length, dataB.length);
  const regions: DiffRegion[] = [];
  let i = 0;

  while (i < minLen && regions.length < maxDiffs) {
    // Skip matching bytes
    while (i < minLen && dataA[i] === dataB[i]) i++;
    if (i >= minLen) break;

    // Found a diff start
    const regionStart = Math.max(0, i - contextBytes);
    let regionEnd = i;
    let lastDiff = i;

    // Extend through the diff, merging across small matching gaps
    let matchRun = 0;
    while (regionEnd < minLen && matchRun < contextBytes) {
      if (dataA[regionEnd] === dataB[regionEnd]) {
        matchRun++;
      } else {
        matchRun = 0;
        lastDiff = regionEnd + 1;
      }
      regionEnd++;
    }
    // Back off the trailing match run and add trailing context
    const diffEnd = lastDiff;
    if (matchRun >= contextBytes) {
      regionEnd -= matchRun;
    }
    regionEnd = Math.min(minLen, regionEnd + contextBytes);

    const bytesA = dataA.subarray(regionStart, regionEnd);
    const bytesB = dataB.subarray(regionStart, regionEnd);
    // Pattern window: a few unchanged bytes of lead-in (so E8/E9 and 0F 8x
    // opcodes straddling the diff boundary are seen) plus a few trailing bytes
    // (so a rel32 displacement reaching past the last changed byte is fully
    // readable), clamped to the file — never a negative subarray end.
    const noteStart = Math.max(0, i - 5);
    const noteEnd = Math.min(minLen, diffEnd + 5);
    const notes = detectPatchPatterns(
      dataA.subarray(noteStart, noteEnd),
      dataB.subarray(noteStart, noteEnd),
      noteStart,
      i - noteStart,
      diffEnd - noteStart,
    );

    regions.push({
      offset: regionStart,
      length: regionEnd - regionStart,
      bytesA: Buffer.from(bytesA),
      bytesB: Buffer.from(bytesB),
      notes,
    });

    i = regionEnd;
  }

  return regions;
}

function renderDiffRegion(region: DiffRegion, index: number): string[] {
  const lines: string[] = [];
  lines.push(`region ${index + 1}: offset 0x${region.offset.toString(16).padStart(8, "0")}, length ${region.length} bytes`);

  // Render in rows of 16 bytes
  const rowSize = 16;
  for (let off = 0; off < region.length; off += rowSize) {
    const end = Math.min(off + rowSize, region.length);
    const chunkA = region.bytesA.subarray(off, end);
    const chunkB = region.bytesB.subarray(off, end);

    lines.push(`  A: ${hexRow(chunkA)}  ${asciiPreview(chunkA)}`);
    lines.push(`  B: ${hexRow(chunkB)}  ${asciiPreview(chunkB)}`);

    // Delta line: mark changed bytes
    const delta = Array.from(chunkA, (byte, i) => (i < chunkB.length && byte !== chunkB[i] ? "^^" : ".."));
    lines.push(`  Δ: ${delta.join(" ")}`);
  }

  for (const note of region.notes) {
    lines.push(`  note: ${note}`);
  }
  return lines;
}

const binaryDiffTool: AgentTool = {
  name: "binary_diff",
  description:
    "Byte-level binary comparison of two files. Reports diff regions with hex/ASCII context, matching percentage, and auto-detects common patch patterns (NOP sleds, branch flips, call redirections). Essential for patch analysis and vulnerability research.",
  risk: "read",
  parameters: objectSchema(
    {
      pathA: { type: "string", description: "Workspace-relative path to the first (original) file." },
      pathB: { type: "string", description: "Workspace-relative path to the second (patched/new) file." },
      maxDiffs: { type: "number", default: 100, description: "Maximum diff regions to report." },
      contextBytes: { type: "number", default: 8, description: "Context bytes around each diff (also gap merge threshold)." },
    },
    ["pathA", "pathB"],
  ),
  async execute(args, context) {
    const targetA = resolveInside(context.workspace, asString(args.pathA));
    const targetB = resolveInside(context.workspace, asString(args.pathB));
    validatePathRead(targetA, context.policy);
    validatePathRead(targetB, context.policy);

    const maxDiffs = Math.min(Math.max(1, asNumber(args.maxDiffs, 100)), 500);
    const contextBytes = Math.min(Math.max(1, asNumber(args.contextBytes, 8)), 64);

    const [dataA, dataB, statA, statB] = await Promise.all([
      fs.readFile(targetA),
      fs.readFile(targetB),
      fs.stat(targetA),
      fs.stat(targetB),
    ]);

    const relA = path.relative(context.workspace, targetA);
    const relB = path.relative(context.workspace, targetB);
    const sameSize = statA.size === statB.size;
    const compareLen = Math.min(dataA.length, dataB.length);

    let matchingBytes = 0;
    for (let i = 0; i < compareLen; i++) {
      if (dataA[i] === dataB[i]) matchingBytes++;
    }
    const matchPct = compareLen > 0 ? ((matchingBytes / compareLen) * 100).toFixed(2) : "N/A";

    const regions = collectDiffRegions(dataA, dataB, maxDiffs, contextBytes);

    const lines: string[] = [
      "BINARY DIFF",
      `A: ${relA} (${statA.size} bytes)`,
      `B: ${relB} (${statB.size} bytes)`,
      `same size: ${sameSize ? "yes" : `no (delta: ${statB.size - statA.size > 0 ? "+" : ""}${statB.size - statA.size} bytes)`}`,
      `matching bytes: ${matchingBytes}/${compareLen} (${matchPct}%)`,
      `diff regions: ${regions.length}${regions.length >= maxDiffs ? " (limit reached)" : ""}`,
    ];

    if (!sameSize) {
      lines.push(`note: compared first ${compareLen} bytes (shorter file); ${Math.abs(statA.size - statB.size)} bytes only in ${statA.size > statB.size ? "A" : "B"}`);
    }

    if (regions.length === 0 && sameSize) {
      lines.push("", "files are identical");
    } else {
      lines.push("");
      for (let i = 0; i < regions.length; i++) {
        lines.push(...renderDiffRegion(regions[i], i));
        if (i < regions.length - 1) lines.push("");
      }
    }

    // Summary of detected patterns across all regions
    const allNotes = regions.flatMap(r => r.notes);
    if (allNotes.length > 0) {
      lines.push("", "detected patterns:", ...allNotes.map(n => `- ${n}`));
    }

    const spilled = await spillIfLarge(lines.join("\n"), { context, label: "binary-diff" });
    return {
      content: [textBlock(spilled.text)],
      details: {
        sizeA: statA.size,
        sizeB: statB.size,
        matching: matchingBytes,
        compared: compareLen,
        regions: regions.length,
        patterns: allNotes.length,
        artifact: spilled.artifact,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 2: function_diff — Function-level comparison via r2
// ---------------------------------------------------------------------------

const R2_NOT_FOUND = "radare2 not found. Install it with: brew install radare2 (macOS) or apt install radare2 (Linux).";

async function r2json(
  args: string[],
  target: string,
  context: ToolContext,
): Promise<unknown | undefined> {
  const result = await runProcess(
    ["r2", "-q", "-e", "log.level=0", ...args, target],
    { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal },
  ).catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found|spawn/.test(msg)) throw new Error(R2_NOT_FOUND);
    throw error;
  });
  // r2 exits non-zero with no output when the target cannot be opened; without
  // this check a missing file silently reports as "0 functions".
  if (result.code !== 0 && !result.stdout.trim()) {
    const reason = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`r2: cannot open target file — ${reason}`);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

interface R2Function {
  name: string;
  offset: number;
  size: number;
}

function parseR2Functions(parsed: unknown): R2Function[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((f): f is Record<string, unknown> => f && typeof f === "object")
    .map(f => ({
      name: typeof f.name === "string" ? f.name : "(unnamed)",
      offset: typeof f.offset === "number" ? f.offset : 0,
      size: typeof f.size === "number" ? f.size : 0,
    }))
    .filter(f => f.name !== "(unnamed)");
}

const functionDiffTool: AgentTool = {
  name: "function_diff",
  description:
    "Compare function lists between two binaries using radare2. Reports added, removed, and modified functions with size changes. Useful for patch diffing and vulnerability research.",
  risk: "read",
  parameters: objectSchema(
    {
      pathA: { type: "string", description: "Workspace-relative path to the original binary." },
      pathB: { type: "string", description: "Workspace-relative path to the patched/new binary." },
      filter: { type: "string", description: "Optional substring to filter function names." },
    },
    ["pathA", "pathB"],
  ),
  async execute(args, context) {
    const targetA = resolveInside(context.workspace, asString(args.pathA));
    const targetB = resolveInside(context.workspace, asString(args.pathB));
    validatePathRead(targetA, context.policy);
    validatePathRead(targetB, context.policy);

    const relA = path.relative(context.workspace, targetA);
    const relB = path.relative(context.workspace, targetB);

    const [parsedA, parsedB] = await Promise.all([
      r2json(["-c", "aaa;aflj"], targetA, context),
      r2json(["-c", "aaa;aflj"], targetB, context),
    ]);

    let funcsA = parseR2Functions(parsedA);
    let funcsB = parseR2Functions(parsedB);

    const filter = asString(args.filter).toLowerCase();
    if (filter) {
      funcsA = funcsA.filter(f => f.name.toLowerCase().includes(filter));
      funcsB = funcsB.filter(f => f.name.toLowerCase().includes(filter));
    }

    const mapA = new Map(funcsA.map(f => [f.name, f]));
    const mapB = new Map(funcsB.map(f => [f.name, f]));

    const added: R2Function[] = [];
    const removed: R2Function[] = [];
    const modified: Array<{ name: string; a: R2Function; b: R2Function; sizeDelta: number }> = [];
    let unchanged = 0;

    for (const [name, func] of mapB) {
      const counterpart = mapA.get(name);
      if (!counterpart) {
        added.push(func);
      } else if (counterpart.size !== func.size) {
        modified.push({ name, a: counterpart, b: func, sizeDelta: func.size - counterpart.size });
      } else {
        unchanged++;
      }
    }
    for (const [name, func] of mapA) {
      if (!mapB.has(name)) removed.push(func);
    }

    // Also check for same-size but different code (for functions present in both)
    // by comparing bytes at the function offset if sizes match
    const sameCodeModified: Array<{ name: string; a: R2Function; b: R2Function }> = [];
    if (modified.length === 0) {
      // Only if there are no size-based modifications, check byte content for same-size functions.
      // r2 offsets are vaddrs — translate to file offsets before reading bytes.
      const dataA = await fs.readFile(targetA);
      const dataB = await fs.readFile(targetB);
      const sectionsA = parseSections(dataA).sections;
      const sectionsB = parseSections(dataB).sections;
      for (const [name, funcA] of mapA) {
        const funcB = mapB.get(name);
        if (!funcB || funcA.size !== funcB.size) continue;
        if (funcA.size === 0) continue;
        const offA = vaddrToFileOffset(sectionsA, funcA.offset, dataA.length);
        const offB = vaddrToFileOffset(sectionsB, funcB.offset, dataB.length);
        if (offA === undefined || offB === undefined) continue;
        const endA = Math.min(offA + funcA.size, dataA.length);
        const endB = Math.min(offB + funcB.size, dataB.length);
        const sliceA = dataA.subarray(offA, endA);
        const sliceB = dataB.subarray(offB, endB);
        if (!sliceA.equals(sliceB)) {
          sameCodeModified.push({ name, a: funcA, b: funcB });
          unchanged--;
        }
      }
    }

    const fmtAddr = (offset: number) => `0x${offset.toString(16).padStart(8, "0")}`;

    const lines: string[] = [
      "FUNCTION DIFF",
      `A: ${relA} (${funcsA.length} functions)`,
      `B: ${relB} (${funcsB.length} functions)`,
      ...(filter ? [`filter: "${filter}"`] : []),
    ];

    if (added.length > 0) {
      lines.push("", `added (${added.length}):`);
      for (const f of added.slice(0, 50)) {
        lines.push(`  ${fmtAddr(f.offset)}  ${f.name}  (size: ${f.size})`);
      }
      if (added.length > 50) lines.push(`  ... and ${added.length - 50} more`);
    }

    if (removed.length > 0) {
      lines.push("", `removed (${removed.length}):`);
      for (const f of removed.slice(0, 50)) {
        lines.push(`  ${fmtAddr(f.offset)}  ${f.name}  (size: ${f.size})`);
      }
      if (removed.length > 50) lines.push(`  ... and ${removed.length - 50} more`);
    }

    if (modified.length > 0) {
      lines.push("", `modified (${modified.length}):`);
      for (const m of modified.slice(0, 50)) {
        const delta = m.sizeDelta > 0 ? `+${m.sizeDelta}` : String(m.sizeDelta);
        lines.push(
          `  ${m.name.padEnd(30)}  A: ${fmtAddr(m.a.offset)} size=${m.a.size}  B: ${fmtAddr(m.b.offset)} size=${m.b.size}  (${delta} bytes)`,
        );
      }
      if (modified.length > 50) lines.push(`  ... and ${modified.length - 50} more`);
    }

    if (sameCodeModified.length > 0) {
      lines.push("", `modified (same size, different code) (${sameCodeModified.length}):`);
      for (const m of sameCodeModified.slice(0, 50)) {
        lines.push(
          `  ${m.name.padEnd(30)}  A: ${fmtAddr(m.a.offset)} size=${m.a.size}  B: ${fmtAddr(m.b.offset)} size=${m.b.size}  (same size, different code)`,
        );
      }
      if (sameCodeModified.length > 50) lines.push(`  ... and ${sameCodeModified.length - 50} more`);
    }

    if (added.length === 0 && removed.length === 0 && modified.length === 0 && sameCodeModified.length === 0) {
      lines.push("", "no function-level differences detected");
    }

    lines.push("", `unchanged: ${unchanged} functions`);

    const spilled = await spillIfLarge(lines.join("\n"), { context, label: "function-diff" });
    return {
      content: [textBlock(spilled.text)],
      details: {
        functionsA: funcsA.length,
        functionsB: funcsB.length,
        added: added.length,
        removed: removed.length,
        modified: modified.length + sameCodeModified.length,
        unchanged,
        artifact: spilled.artifact,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 3: string_diff — String table comparison
// ---------------------------------------------------------------------------

/** Levenshtein distance, bounded by a max for early exit. */
function levenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  const lenA = a.length;
  const lenB = b.length;
  let prev = new Array<number>(lenB + 1);
  let curr = new Array<number>(lenB + 1);

  for (let j = 0; j <= lenB; j++) prev[j] = j;

  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lenB];
}

/** Relevance score for sorting: higher = more interesting to a reverse engineer. */
function stringRelevance(s: string): number {
  const lower = s.toLowerCase();
  let score = 0;
  if (/\b(api|endpoint|url|host|server|domain)\b/i.test(lower)) score += 10;
  if (/\b(key|secret|password|token|credential|auth)\b/i.test(lower)) score += 10;
  if (/\b(encrypt|decrypt|aes|rsa|sha|md5|hmac|sign|verify|cipher)\b/i.test(lower)) score += 8;
  if (/\b(version|build|release|debug)\b/i.test(lower)) score += 5;
  if (/https?:\/\//i.test(lower)) score += 7;
  if (/\b(flag|ctf)\b/i.test(lower)) score += 12;
  if (/\b(root|admin|sudo|privilege)\b/i.test(lower)) score += 6;
  if (/\b(frida|xposed|substrate|hook)\b/i.test(lower)) score += 8;
  return score;
}

const stringDiffTool: AgentTool = {
  name: "string_diff",
  description:
    "Compare extracted strings between two binary files. Reports added, removed, and likely-changed strings (matched by edit distance). Sorts by relevance (crypto, endpoints, keys, versions first). Essential for version comparison and patch analysis.",
  risk: "read",
  parameters: objectSchema(
    {
      pathA: { type: "string", description: "Workspace-relative path to the original file." },
      pathB: { type: "string", description: "Workspace-relative path to the new file." },
      minLength: { type: "number", default: 4, description: "Minimum string length to extract." },
      maxStrings: { type: "number", default: 200, description: "Maximum strings to show per category." },
    },
    ["pathA", "pathB"],
  ),
  async execute(args, context) {
    const targetA = resolveInside(context.workspace, asString(args.pathA));
    const targetB = resolveInside(context.workspace, asString(args.pathB));
    validatePathRead(targetA, context.policy);
    validatePathRead(targetB, context.policy);

    const relA = path.relative(context.workspace, targetA);
    const relB = path.relative(context.workspace, targetB);
    const minLength = Math.max(3, asNumber(args.minLength, 4));
    const maxStrings = Math.min(Math.max(10, asNumber(args.maxStrings, 200)), 1000);

    const maxBytes = 16 * 1024 * 1024;
    const [dataA, dataB] = await Promise.all([
      readPrefix(targetA, maxBytes),
      readPrefix(targetB, maxBytes),
    ]);

    const stringsA = extractPrintableStrings(dataA, minLength);
    const stringsB = extractPrintableStrings(dataB, minLength);

    const setA = new Set(stringsA);
    const setB = new Set(stringsB);

    const onlyA = stringsA.filter(s => !setB.has(s));
    const onlyB = stringsB.filter(s => !setA.has(s));

    // Deduplicate
    const uniqueOnlyA = [...new Set(onlyA)];
    const uniqueOnlyB = [...new Set(onlyB)];

    // Find likely changed pairs using edit distance
    interface StringPair {
      a: string;
      b: string;
      distance: number;
    }

    const changed: StringPair[] = [];
    const usedB = new Set<string>();
    const maxPairs = Math.min(maxStrings, 100);

    // Sort removed strings by relevance so we match interesting ones first
    const sortedRemoved = [...uniqueOnlyA].sort((x, y) => stringRelevance(y) - stringRelevance(x));

    for (const strA of sortedRemoved) {
      if (changed.length >= maxPairs) break;
      const maxDist = Math.max(2, Math.floor(strA.length * 0.3));
      let bestMatch: string | undefined;
      let bestDist = maxDist + 1;

      for (const strB of uniqueOnlyB) {
        if (usedB.has(strB)) continue;
        if (Math.abs(strA.length - strB.length) > maxDist) continue;
        const dist = levenshtein(strA, strB, maxDist);
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = strB;
        }
      }

      if (bestMatch !== undefined && bestDist <= maxDist) {
        changed.push({ a: strA, b: bestMatch, distance: bestDist });
        usedB.add(bestMatch);
      }
    }

    // Filter out matched pairs from added/removed
    const pairedA = new Set(changed.map(c => c.a));
    const pairedB = new Set(changed.map(c => c.b));
    const finalRemoved = uniqueOnlyA.filter(s => !pairedA.has(s));
    const finalAdded = uniqueOnlyB.filter(s => !pairedB.has(s));

    // Sort by relevance
    finalRemoved.sort((a, b) => stringRelevance(b) - stringRelevance(a));
    finalAdded.sort((a, b) => stringRelevance(b) - stringRelevance(a));

    const clampStr = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

    const lines: string[] = [
      "STRING DIFF",
      `A: ${relA} (${stringsA.length} strings, ${new Set(stringsA).size} unique)`,
      `B: ${relB} (${stringsB.length} strings, ${new Set(stringsB).size} unique)`,
    ];

    if (changed.length > 0) {
      lines.push("", `changed (likely pairs) (${changed.length}):`);
      for (const pair of changed.slice(0, maxStrings)) {
        lines.push(`  A: ${clampStr(JSON.stringify(pair.a), 80)}  →  B: ${clampStr(JSON.stringify(pair.b), 80)}`);
      }
    }

    if (finalAdded.length > 0) {
      lines.push("", `added (${finalAdded.length}):`);
      for (const s of finalAdded.slice(0, maxStrings)) {
        lines.push(`  ${clampStr(JSON.stringify(s), 120)}`);
      }
      if (finalAdded.length > maxStrings) lines.push(`  ... and ${finalAdded.length - maxStrings} more`);
    }

    if (finalRemoved.length > 0) {
      lines.push("", `removed (${finalRemoved.length}):`);
      for (const s of finalRemoved.slice(0, maxStrings)) {
        lines.push(`  ${clampStr(JSON.stringify(s), 120)}`);
      }
      if (finalRemoved.length > maxStrings) lines.push(`  ... and ${finalRemoved.length - maxStrings} more`);
    }

    if (finalAdded.length === 0 && finalRemoved.length === 0 && changed.length === 0) {
      lines.push("", "string tables are identical");
    }

    const spilled = await spillIfLarge(lines.join("\n"), { context, label: "string-diff" });
    return {
      content: [textBlock(spilled.text)],
      details: {
        stringsA: stringsA.length,
        stringsB: stringsB.length,
        added: finalAdded.length,
        removed: finalRemoved.length,
        changed: changed.length,
        artifact: spilled.artifact,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 4: section_diff — Section/segment comparison
// ---------------------------------------------------------------------------

interface SectionInfo {
  name: string;
  size: number;
  /** File offset of the section data. */
  offset: number;
  /** Virtual address the section is mapped at (0 when unknown, e.g. PE). */
  addr: number;
  type: string;
  entropy: number;
}

type BinaryFormat = "ELF" | "PE" | "Mach-O" | "unknown";

function detectFormat(data: Buffer): BinaryFormat {
  if (data.length < 4) return "unknown";
  // ELF: 7f 45 4c 46
  if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) return "ELF";
  // PE/MZ: 4d 5a
  if (data[0] === 0x4d && data[1] === 0x5a) return "PE";
  // Mach-O 64 LE: cf fa ed fe
  if (data[0] === 0xcf && data[1] === 0xfa && data[2] === 0xed && data[3] === 0xfe) return "Mach-O";
  // Mach-O 64 BE: fe ed fa cf
  if (data[0] === 0xfe && data[1] === 0xed && data[2] === 0xfa && data[3] === 0xcf) return "Mach-O";
  // Mach-O 32 LE: ce fa ed fe
  if (data[0] === 0xce && data[1] === 0xfa && data[2] === 0xed && data[3] === 0xfe) return "Mach-O";
  // Mach-O 32 BE: fe ed fa ce
  if (data[0] === 0xfe && data[1] === 0xed && data[2] === 0xfa && data[3] === 0xce) return "Mach-O";
  return "unknown";
}

function parseElfSections(data: Buffer): SectionInfo[] {
  if (data.length < 64) return [];
  const is64 = data[4] === 2;
  const isLE = data[5] === 1;

  const readU16 = (offset: number) => isLE ? data.readUInt16LE(offset) : data.readUInt16BE(offset);
  const readU32 = (offset: number) => isLE ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  const readU64 = (offset: number) => {
    if (isLE) {
      const lo = data.readUInt32LE(offset);
      const hi = data.readUInt32LE(offset + 4);
      return hi * 0x100000000 + lo;
    }
    const hi = data.readUInt32BE(offset);
    const lo = data.readUInt32BE(offset + 4);
    return hi * 0x100000000 + lo;
  };

  let shoff: number, shentsize: number, shnum: number, shstrndx: number;

  if (is64) {
    shoff = Number(readU64(0x28));
    shentsize = readU16(0x3a);
    shnum = readU16(0x3c);
    shstrndx = readU16(0x3e);
  } else {
    shoff = readU32(0x20);
    shentsize = readU16(0x2e);
    shnum = readU16(0x30);
    shstrndx = readU16(0x32);
  }

  if (shoff === 0 || shnum === 0 || shoff + shnum * shentsize > data.length) return [];

  // Read section name string table
  const strtabEntry = shoff + shstrndx * shentsize;
  if (strtabEntry + shentsize > data.length) return [];
  const strtabOffset = is64 ? Number(readU64(strtabEntry + 0x18)) : readU32(strtabEntry + 0x10);
  const strtabSize = is64 ? Number(readU64(strtabEntry + 0x20)) : readU32(strtabEntry + 0x14);

  const readSectionName = (nameOffset: number): string => {
    const start = strtabOffset + nameOffset;
    if (start >= data.length) return "(invalid)";
    const end = Math.min(data.indexOf(0, start), strtabOffset + strtabSize);
    if (end < start || end > data.length) return "(invalid)";
    return data.subarray(start, end).toString("ascii");
  };

  const sectionTypes: Record<number, string> = {
    0: "NULL", 1: "PROGBITS", 2: "SYMTAB", 3: "STRTAB", 4: "RELA",
    5: "HASH", 6: "DYNAMIC", 7: "NOTE", 8: "NOBITS", 9: "REL",
    11: "DYNSYM", 14: "INIT_ARRAY", 15: "FINI_ARRAY",
  };

  const sections: SectionInfo[] = [];
  for (let i = 0; i < shnum; i++) {
    const entryOff = shoff + i * shentsize;
    if (entryOff + shentsize > data.length) break;

    const nameIdx = readU32(entryOff);
    const shType = readU32(entryOff + 4);
    let addr: number, offset: number, size: number;

    if (is64) {
      addr = Number(readU64(entryOff + 0x10));
      offset = Number(readU64(entryOff + 0x18));
      size = Number(readU64(entryOff + 0x20));
    } else {
      addr = readU32(entryOff + 0xc);
      offset = readU32(entryOff + 0x10);
      size = readU32(entryOff + 0x14);
    }

    const name = readSectionName(nameIdx);
    if (!name || name === "(invalid)") continue;

    const sectionData = (shType !== 8 && size > 0 && offset + size <= data.length)
      ? data.subarray(offset, offset + size)
      : Buffer.alloc(0);

    sections.push({
      name,
      size,
      offset,
      addr,
      type: sectionTypes[shType] ?? `0x${shType.toString(16)}`,
      entropy: sectionData.length > 0 ? shannonEntropy(sectionData) : 0,
    });
  }

  return sections.filter(s => s.name && s.name !== "");
}

function parsePeSections(data: Buffer): SectionInfo[] {
  if (data.length < 64) return [];

  // Read PE offset from DOS header at 0x3c
  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset + 24 > data.length) return [];

  // Verify PE signature
  if (data.readUInt32LE(peOffset) !== 0x00004550) return []; // "PE\0\0"

  const numberOfSections = data.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = data.readUInt16LE(peOffset + 20);
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize;

  const sections: SectionInfo[] = [];
  const sectionEntrySize = 40;

  for (let i = 0; i < numberOfSections; i++) {
    const entryOff = sectionTableOffset + i * sectionEntrySize;
    if (entryOff + sectionEntrySize > data.length) break;

    // Section name: 8 bytes, null-padded
    let name = "";
    for (let j = 0; j < 8; j++) {
      const c = data[entryOff + j];
      if (c === 0) break;
      name += String.fromCharCode(c);
    }

    const virtualSize = data.readUInt32LE(entryOff + 8);
    const rawSize = data.readUInt32LE(entryOff + 16);
    const rawOffset = data.readUInt32LE(entryOff + 20);

    const size = rawSize || virtualSize;
    const sectionData = (rawSize > 0 && rawOffset + rawSize <= data.length)
      ? data.subarray(rawOffset, rawOffset + rawSize)
      : Buffer.alloc(0);

    sections.push({
      name: name || `section_${i}`,
      size,
      offset: rawOffset,
      // VirtualAddress is an RVA; without the image base a vaddr→file mapping
      // is not derivable here, so leave addr at 0 (translation skipped).
      addr: 0,
      type: rawSize > 0 ? "DATA" : "BSS",
      entropy: sectionData.length > 0 ? shannonEntropy(sectionData) : 0,
    });
  }

  return sections;
}

function parseMachOSections(data: Buffer): SectionInfo[] {
  if (data.length < 32) return [];

  const magic = data.readUInt32LE(0);
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const isLE = magic === 0xfeedface || magic === 0xfeedfacf;

  const readU32 = (offset: number) => isLE ? data.readUInt32LE(offset) : data.readUInt32BE(offset);

  const ncmds = readU32(16);
  let cmdOffset = is64 ? 32 : 28;

  const sections: SectionInfo[] = [];

  for (let i = 0; i < ncmds && cmdOffset + 8 <= data.length; i++) {
    const cmd = readU32(cmdOffset);
    const cmdSize = readU32(cmdOffset + 4);

    // LC_SEGMENT (1) or LC_SEGMENT_64 (0x19)
    if (cmd === 1 || cmd === 0x19) {
      // Read segment name
      let segName = "";
      for (let j = 0; j < 16; j++) {
        const c = data[cmdOffset + 8 + j];
        if (c === 0) break;
        segName += String.fromCharCode(c);
      }

      // Parse sections within the segment
      let nsects: number, secStart: number, secSize: number;
      if (cmd === 0x19) {
        // 64-bit
        nsects = readU32(cmdOffset + 64);
        secStart = cmdOffset + 72;
        secSize = 80;
      } else {
        nsects = readU32(cmdOffset + 48);
        secStart = cmdOffset + 56;
        secSize = 68;
      }

      for (let s = 0; s < nsects; s++) {
        const secOff = secStart + s * secSize;
        if (secOff + secSize > data.length) break;

        let secName = "";
        for (let j = 0; j < 16; j++) {
          const c = data[secOff + j];
          if (c === 0) break;
          secName += String.fromCharCode(c);
        }

        let addr: number, size: number, offset: number;
        if (cmd === 0x19) {
          // 64-bit: addr at +32 (8 bytes), size at +40 (8 bytes), offset at +48 (4 bytes)
          const addrLo = readU32(secOff + 32);
          const addrHi = readU32(secOff + 36);
          addr = addrHi * 0x100000000 + addrLo;
          const sizeLo = readU32(secOff + 40);
          const sizeHi = readU32(secOff + 44);
          size = sizeHi * 0x100000000 + sizeLo;
          offset = readU32(secOff + 48);
        } else {
          addr = readU32(secOff + 32);
          size = readU32(secOff + 36);
          offset = readU32(secOff + 40);
        }

        const sectionData = (size > 0 && offset + size <= data.length)
          ? data.subarray(offset, offset + size)
          : Buffer.alloc(0);

        sections.push({
          name: `${segName},${secName}`,
          size,
          offset,
          addr,
          type: segName,
          entropy: sectionData.length > 0 ? shannonEntropy(sectionData) : 0,
        });
      }
    }

    cmdOffset += cmdSize;
  }

  return sections;
}

function parseSections(data: Buffer): { format: BinaryFormat; sections: SectionInfo[] } {
  const format = detectFormat(data);
  switch (format) {
    case "ELF": return { format, sections: parseElfSections(data) };
    case "PE": return { format, sections: parsePeSections(data) };
    case "Mach-O": return { format, sections: parseMachOSections(data) };
    default: return { format, sections: [] };
  }
}

/**
 * Map a virtual address to a file offset through the section table. Function
 * offsets from r2 are vaddrs; comparing them as raw file offsets silently
 * compares empty slices on every PIE binary. Returns undefined when the vaddr
 * does not sit in a file-backed section (unknown format, BSS, or out of range).
 */
function vaddrToFileOffset(sections: SectionInfo[], vaddr: number, fileSize: number): number | undefined {
  if (!(vaddr > 0)) return undefined;
  for (const section of sections) {
    if (section.addr <= 0 || section.offset <= 0 || section.size <= 0) continue;
    if (section.type === "NOBITS") continue;
    if (vaddr >= section.addr && vaddr < section.addr + section.size) {
      const offset = section.offset + (vaddr - section.addr);
      if (offset >= 0 && offset < fileSize) return offset;
    }
  }
  return undefined;
}

const sectionDiffTool: AgentTool = {
  name: "section_diff",
  description:
    "Compare sections/segments between two ELF, PE, or Mach-O binaries. Reports size changes, entropy differences, and added/removed sections. Parses headers directly (no external tools needed). Useful for detecting packed/encrypted regions and structural changes.",
  risk: "read",
  parameters: objectSchema(
    {
      pathA: { type: "string", description: "Workspace-relative path to the original binary." },
      pathB: { type: "string", description: "Workspace-relative path to the new binary." },
    },
    ["pathA", "pathB"],
  ),
  async execute(args, context) {
    const targetA = resolveInside(context.workspace, asString(args.pathA));
    const targetB = resolveInside(context.workspace, asString(args.pathB));
    validatePathRead(targetA, context.policy);
    validatePathRead(targetB, context.policy);

    const relA = path.relative(context.workspace, targetA);
    const relB = path.relative(context.workspace, targetB);

    const [dataA, dataB] = await Promise.all([
      fs.readFile(targetA),
      fs.readFile(targetB),
    ]);

    const resultA = parseSections(dataA);
    const resultB = parseSections(dataB);

    if (resultA.format === "unknown" && resultB.format === "unknown") {
      return {
        content: [textBlock(`SECTION DIFF\nA: ${relA}\nB: ${relB}\n\nNeither file is a recognized ELF, PE, or Mach-O binary.`)],
        isError: true,
      };
    }

    const mapA = new Map(resultA.sections.map(s => [s.name, s]));
    const mapB = new Map(resultB.sections.map(s => [s.name, s]));

    const allNames = new Set([...mapA.keys(), ...mapB.keys()]);

    const fmtSize = (size: number) => `0x${size.toString(16)}`;
    const fmtEntropy = (e: number) => e.toFixed(3);

    const lines: string[] = [
      "SECTION DIFF",
      `A: ${relA} (format: ${resultA.format}, ${resultA.sections.length} sections)`,
      `B: ${relB} (format: ${resultB.format}, ${resultB.sections.length} sections)`,
      "",
      `${"section".padEnd(24)} ${"A.size".padEnd(10)} ${"B.size".padEnd(10)} ${"delta".padEnd(10)} ${"entropy.A".padEnd(10)} ${"entropy.B".padEnd(10)}`,
      "─".repeat(78),
    ];

    const added: string[] = [];
    const removed: string[] = [];
    let changed = 0;
    let same = 0;

    for (const name of allNames) {
      const secA = mapA.get(name);
      const secB = mapB.get(name);

      if (secA && secB) {
        const sizeDelta = secB.size - secA.size;
        const deltaStr = sizeDelta === 0 ? "same" : `${sizeDelta > 0 ? "+" : "-"}0x${Math.abs(sizeDelta).toString(16)}`;
        const entropyChanged = Math.abs(secA.entropy - secB.entropy) > 0.1;

        lines.push(
          `${(entropyChanged ? "⚠ " : "  ") + name.padEnd(22)} ${fmtSize(secA.size).padEnd(10)} ${fmtSize(secB.size).padEnd(10)} ${deltaStr.padEnd(10)} ${fmtEntropy(secA.entropy).padEnd(10)} ${fmtEntropy(secB.entropy).padEnd(10)}`,
        );

        if (sizeDelta !== 0 || entropyChanged) changed++;
        else same++;
      } else if (secB) {
        lines.push(
          `${"[new] " + name.padEnd(18)} ${"-".padEnd(10)} ${fmtSize(secB.size).padEnd(10)} ${("+" + fmtSize(secB.size)).padEnd(10)} ${"-".padEnd(10)} ${fmtEntropy(secB.entropy).padEnd(10)}`,
        );
        added.push(name);
      } else if (secA) {
        lines.push(
          `${"[del] " + name.padEnd(18)} ${fmtSize(secA.size).padEnd(10)} ${"-".padEnd(10)} ${("-" + fmtSize(secA.size)).padEnd(10)} ${fmtEntropy(secA.entropy).padEnd(10)} ${"-".padEnd(10)}`,
        );
        removed.push(name);
      }
    }

    lines.push(
      "",
      `summary: ${added.length} added, ${removed.length} removed, ${changed} changed, ${same} unchanged`,
    );

    // Flag high-entropy new sections (possible packing/encryption)
    const suspiciousNew = resultB.sections.filter(
      s => !mapA.has(s.name) && s.entropy > 7.0 && s.size > 64,
    );
    if (suspiciousNew.length > 0) {
      lines.push(
        "",
        "warnings:",
        ...suspiciousNew.map(s => `- ${s.name}: high entropy (${fmtEntropy(s.entropy)}) in new section — possible encryption/packing`),
      );
    }

    // Flag large entropy shifts in existing sections
    const entropyShifts = resultA.sections
      .filter(sa => {
        const sb = mapB.get(sa.name);
        return sb && Math.abs(sb.entropy - sa.entropy) > 1.0;
      })
      .map(sa => ({
        name: sa.name,
        before: sa.entropy,
        after: mapB.get(sa.name)!.entropy,
        delta: mapB.get(sa.name)!.entropy - sa.entropy,
      }));

    if (entropyShifts.length > 0) {
      if (suspiciousNew.length === 0) lines.push("", "warnings:");
      for (const shift of entropyShifts) {
        const direction = shift.delta > 0 ? "increased" : "decreased";
        lines.push(
          `- ${shift.name}: entropy ${direction} by ${Math.abs(shift.delta).toFixed(2)} (${fmtEntropy(shift.before)} → ${fmtEntropy(shift.after)})${shift.after > 7.0 ? " — possible encryption/packing" : ""}`,
        );
      }
    }

    const spilled = await spillIfLarge(lines.join("\n"), { context, label: "section-diff" });
    return {
      content: [textBlock(spilled.text)],
      details: {
        formatA: resultA.format,
        formatB: resultB.format,
        sectionsA: resultA.sections.length,
        sectionsB: resultB.sections.length,
        added: added.length,
        removed: removed.length,
        changed,
        same,
        artifact: spilled.artifact,
      },
    };
  },
};
