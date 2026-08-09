import * as crypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, PlanStep, PlanStepStatus, ToolContext, ToolResult } from "../types";
import { findBuiltInSkill, formatSkillList, loadBuiltInSkills } from "../skills";
import { formatKnowledgeDigest, formatKnowledgeMatches, readKnowledgeEntry, readKnowledgeText, searchKnowledge } from "../knowledge";
import { asNumber, asString, clip, resolveInside, textBlock } from "../utils";
import { planCounts } from "../core/plan";
import { commandConcerns, validatePathRead, validateWriteAllowed } from "../security/policy";
import { requestApproval } from "../security/approval";
import { commandOutput, commandText, runProcess } from "./process";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export function createReverseTools(): AgentTool[] {
  return [
    listFilesTool,
    readFileTool,
    writeFileTool,
    grepTool,
    runCommandTool,
    fileInfoTool,
    stringsTool,
    hexdumpTool,
    hashFileTool,
    extractSymbolsTool,
    ctfTriageTool,
    ctfDecodeTool,
    entropyScanTool,
    binaryMitigationsTool,
    findBytesTool,
    carveArtifactsTool,
    apkInspectTool,
    fridaHookTemplateTool,
    listSkillsTool,
    readSkillTool,
    knowledgeSearchTool,
    knowledgeReadTool,
    updatePlanTool,
  ];
}

const listFilesTool: AgentTool = {
  name: "list_files",
  description: "List files under the workspace, optionally recursively. Useful for CTF artifact triage.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative directory path.", default: "." },
    recursive: { type: "boolean", default: false },
    maxEntries: { type: "number", default: 200 },
  }),
  async execute(args, context) {
    const root = resolveInside(context.workspace, asString(args.path, "."));
    validatePathRead(root, context.policy);
    const recursive = args.recursive === true;
    const maxEntries = asNumber(args.maxEntries, 200);
    const entries: string[] = [];
    await walk(root, context.workspace, recursive, maxEntries, entries);
    return { content: [textBlock(entries.join("\n") || "(empty)")], details: { count: entries.length } };
  },
};

const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read a workspace file as UTF-8 text with truncation. For binary files use hexdump or strings.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative file path." },
    maxBytes: { type: "number", default: 65536 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const maxBytes = Math.min(asNumber(args.maxBytes, context.policy.maxReadBytes), context.policy.maxReadBytes);
    const handle = await fs.open(target, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      const stat = await handle.stat();
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const suffix = stat.size > bytesRead ? `\n\n[truncated: ${stat.size - bytesRead} bytes remain]` : "";
      return { content: [textBlock(`${text}${suffix}`)], details: { bytesRead, size: stat.size } };
    } finally {
      await handle.close();
    }
  },
};

const writeFileTool: AgentTool = {
  name: "write_file",
  description: "Write a workspace file. Disabled unless the CLI is started with --write.",
  risk: "write",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative file path." },
    content: { type: "string", description: "Content to write." },
  }, ["path", "content"]),
  async execute(args, context) {
    validateWriteAllowed(context.policy);
    const target = resolveInside(context.workspace, asString(args.path));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const content = asString(args.content);
    await fs.writeFile(target, content, "utf8");
    return { content: [textBlock(`Wrote ${Buffer.byteLength(content)} bytes to ${path.relative(context.workspace, target)}`)] };
  },
};

const grepTool: AgentTool = {
  name: "grep",
  description: "Search text files using ripgrep when available. Falls back to a simple JS recursive scan.",
  risk: "read",
  parameters: objectSchema({
    pattern: { type: "string", description: "Regex or literal pattern." },
    path: { type: "string", default: "." },
    maxMatches: { type: "number", default: 200 },
  }, ["pattern"]),
  async execute(args, context) {
    const searchRoot = resolveInside(context.workspace, asString(args.path, "."));
    validatePathRead(searchRoot, context.policy);
    const pattern = asString(args.pattern);
    const maxMatches = asNumber(args.maxMatches, 200);
    const rg = await runProcess(
      ["rg", "--line-number", "--hidden", "--glob", "!.git", "--max-count", String(maxMatches), pattern, searchRoot],
      { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal },
    ).catch(() => null);
    if (rg) {
      const output = rg.stdout || rg.stderr || "(no matches)";
      const spilled = await spillIfLarge(output, { context, label: `grep-${pattern}` });
      return { content: [textBlock(spilled.text)], details: { engine: "rg", exit: rg.code, artifact: spilled.artifact } };
    }
    const matches = await jsGrep(searchRoot, context.workspace, pattern, maxMatches);
    return { content: [textBlock(matches.join("\n") || "(no matches)")], details: { engine: "js", count: matches.length } };
  },
};

const runCommandTool: AgentTool = {
  name: "run_command",
  description: "Run a local workspace command for CTF/reverse engineering. Network and destructive commands are blocked by default.",
  risk: "execute",
  parameters: objectSchema({
    command: { type: "string", description: "Shell command to run in the workspace." },
    timeoutMs: { type: "number", default: 30000 },
  }, ["command"]),
  async execute(args, context) {
    const command = asString(args.command);
    // The tier gate already ran in the loop; this is the command-specific pass,
    // where a safety pattern turns into a prompt instead of a flat refusal.
    await requestApproval(
      { tool: "run_command", tier: "exec", summary: command, concerns: commandConcerns(command, context.policy) },
      context,
    );
    const timeoutMs = Math.min(asNumber(args.timeoutMs, context.policy.commandTimeoutMs), context.policy.commandTimeoutMs);
    const result = await runProcess(["bash", "-c", command], { cwd: context.workspace, timeoutMs, signal: context.signal });
    // Unbounded here would be a context-eater: `objdump -d` on a real binary is
    // megabytes. Keep head+tail, park the rest in an artifact file.
    const spilled = await spillIfLarge(commandText(command, result), { context, label: command });
    return {
      content: [textBlock(spilled.text)],
      details: { exit: result.code, chars: spilled.originalChars, artifact: spilled.artifact },
    };
  },
};

const fileInfoTool: AgentTool = {
  name: "file_info",
  description: "Run file(1) on a workspace artifact.",
  risk: "read",
  parameters: objectSchema({ path: { type: "string" } }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const result = await runProcess(["file", "-b", target], { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal });
    return { content: commandOutput(`file ${path.relative(context.workspace, target)}`, result), details: { exit: result.code } };
  },
};

const stringsTool: AgentTool = {
  name: "strings",
  description: "Extract printable strings from a binary artifact.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string" },
    minLength: { type: "number", default: 4 },
    maxBytes: { type: "number", default: 65536 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const minLength = String(Math.max(3, asNumber(args.minLength, 4)));
    const result = await runProcess(["strings", "-a", "-n", minLength, target], {
      cwd: context.workspace,
      timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
    });
    const spilled = await spillIfLarge(result.stdout || result.stderr || "(no strings)", {
      context,
      label: `strings-${path.basename(target)}`,
      maxChars: Math.min(asNumber(args.maxBytes, context.policy.maxToolOutputChars), context.policy.maxReadBytes),
    });
    return { content: [textBlock(spilled.text)], details: { exit: result.code, artifact: spilled.artifact } };
  },
};

const hexdumpTool: AgentTool = {
  name: "hexdump",
  description: "Show a hex dump from a workspace file.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string" },
    offset: { type: "number", default: 0 },
    length: { type: "number", default: 512 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const offset = Math.max(0, asNumber(args.offset, 0));
    const length = Math.min(Math.max(1, asNumber(args.length, 512)), 4096);
    const result = await runProcess(["xxd", "-g", "1", "-s", String(offset), "-l", String(length), target], {
      cwd: context.workspace,
      timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
    }).catch(() =>
      runProcess(["od", "-Ax", "-tx1", "-N", String(length), "-j", String(offset), target], {
        cwd: context.workspace,
        timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
      }),
    );
    return { content: commandOutput(`hexdump ${path.relative(context.workspace, target)}`, result), details: { exit: result.code, offset, length } };
  },
};

const hashFileTool: AgentTool = {
  name: "hash_file",
  description: "Calculate SHA-256 and size for a workspace file.",
  risk: "read",
  parameters: objectSchema({ path: { type: "string" } }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const data = await fs.readFile(target);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    return { content: [textBlock(`sha256  ${sha256}\nsize    ${data.byteLength}`)], details: { sha256, size: data.byteLength } };
  },
};

const extractSymbolsTool: AgentTool = {
  name: "extract_symbols",
  description: "Try common symbol/import table tools: nm, readelf, objdump, and otool.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string" },
    maxBytes: { type: "number", default: 65536 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const attempts: Array<[string, string[]]> = [
      [`nm -an ${rel}`, ["nm", "-an", target]],
      [`readelf -Ws ${rel}`, ["readelf", "-Ws", target]],
      [`objdump -t ${rel}`, ["objdump", "-t", target]],
      [`otool -Iv ${rel}`, ["otool", "-Iv", target]],
    ];
    const chunks: string[] = [];
    for (const [label, command] of attempts) {
      const result = await runProcess(command, { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal }).catch(error => ({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
      if (result.stdout.trim()) {
        chunks.push(`$ ${label}\n${result.stdout}`);
      }
    }
    const spilled = await spillIfLarge(chunks.join("\n\n") || "No symbols/imports extracted by available tools.", {
      context,
      label: `symbols-${path.basename(target)}`,
      maxChars: Math.min(asNumber(args.maxBytes, context.policy.maxToolOutputChars), context.policy.maxReadBytes),
    });
    return { content: [textBlock(spilled.text)], details: { artifact: spilled.artifact } };
  },
};

const ctfTriageTool: AgentTool = {
  name: "ctf_triage",
  description: "Fast offline CTF artifact triage: file type, magic, hash, entropy, string categories, flag/URL/encoding hints, and next-step suggestions.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative file or directory path." },
    maxBytes: { type: "number", default: 1048576, description: "Maximum bytes to sample from a file." },
    maxStrings: { type: "number", default: 40, description: "Maximum interesting strings to show." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const entries: string[] = [];
      await walk(target, context.workspace, true, Math.min(asNumber(args.maxStrings, 40), 200), entries);
      return {
        content: [textBlock(["CTF TRIAGE", `path: ${path.relative(context.workspace, target) || "."}`, "kind: directory", "", "entries:", entries.join("\n") || "(empty)"].join("\n"))],
        details: { kind: "directory", entries: entries.length },
      };
    }

    const maxBytes = Math.min(Math.max(1024, asNumber(args.maxBytes, 1_048_576)), 8 * 1024 * 1024);
    const sample = await readPrefix(target, Math.min(stat.size, maxBytes));
    const rel = path.relative(context.workspace, target);
    const fileType = await runProcess(["file", "-b", target], {
      cwd: context.workspace,
      timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
    }).then(result => (result.stdout || result.stderr).trim()).catch(() => "(file unavailable)");
    const strings = extractPrintableStrings(sample, 4);
    const classified = classifyStrings(strings, Math.min(asNumber(args.maxStrings, 40), 200));
    const hash = await sha256File(target);
    const first = sample.subarray(0, Math.min(sample.length, 16));
    const entropy = shannonEntropy(sample);
    const printable = printableRatio(sample);
    const hints = triageHints(fileType, strings, entropy, printable);

    const out = [
      "CTF TRIAGE",
      `path: ${rel}`,
      `type: ${fileType}`,
      `size: ${stat.size} bytes`,
      `sha256: ${hash}`,
      `magic.hex: ${first.toString("hex") || "(empty)"}`,
      `magic.ascii: ${asciiPreview(first) || "(empty)"}`,
      `sample: ${sample.length}/${stat.size} bytes`,
      `entropy: ${entropy.toFixed(3)} bits/byte`,
      `printable: ${(printable * 100).toFixed(1)}%`,
      "",
      "signals:",
      ...classified.map(item => `- ${item.kind}: ${item.value}`),
      ...(classified.length === 0 ? ["- none found in sample"] : []),
      "",
      "next:",
      ...hints.map(hint => `- ${hint}`),
    ];
    if (stat.size > sample.length) out.splice(8, 0, `note: sampled first ${sample.length} bytes; increase maxBytes for deeper scan`);
    return {
      content: [textBlock(clip(out.join("\n"), context.policy.maxReadBytes))],
      details: { kind: "file", size: stat.size, sha256: hash, entropy, printable, signals: classified.length },
    };
  },
};

const DECODE_MODES = ["auto", "base64", "base64url", "hex", "url", "rot13", "xor", "xor_bruteforce"] as const;
type DecodeMode = (typeof DECODE_MODES)[number];

const ctfDecodeTool: AgentTool = {
  name: "ctf_decode",
  description: "Decode common CTF encodings and small XOR layers: auto, base64, base64url, hex, URL, ROT13, XOR with key, or single-byte XOR brute force.",
  risk: "read",
  parameters: objectSchema({
    input: { type: "string", description: "Text to decode." },
    mode: { type: "string", enum: DECODE_MODES, default: "auto" },
    key: { type: "string", description: "XOR key as text, decimal byte, or 0xNN." },
    maxOutputBytes: { type: "number", default: 4096 },
  }, ["input"]),
  async execute(args, context) {
    const input = asString(args.input);
    const rawMode = asString(args.mode, "auto");
    const mode = isDecodeMode(rawMode) ? rawMode : "auto";
    const maxOutputBytes = Math.min(Math.max(128, asNumber(args.maxOutputBytes, 4096)), 64 * 1024);
    const candidates = decodeCandidates(input, mode, asString(args.key), maxOutputBytes);
    const out = [
      "CTF DECODE",
      `mode: ${mode}`,
      "",
      ...candidates.flatMap(candidate => [
        `## ${candidate.label}`,
        `score: ${candidate.score.toFixed(2)}  bytes: ${candidate.bytes.length}`,
        renderBytes(candidate.bytes, maxOutputBytes),
        "",
      ]),
    ];
    if (candidates.length === 0) out.push("No plausible decode candidates.");
    return { content: [textBlock(clip(out.join("\n").trimEnd(), context.policy.maxReadBytes))], details: { mode, candidates: candidates.length } };
  },
};

const entropyScanTool: AgentTool = {
  name: "entropy_scan",
  description: "Scan a file with sliding-window entropy to spot packed, encrypted, compressed, or unusually structured regions.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative file path." },
    window: { type: "number", default: 1024 },
    step: { type: "number", default: 512 },
    top: { type: "number", default: 12 },
    maxBytes: { type: "number", default: 4194304 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("entropy_scan expects a file path.");
    const maxBytes = Math.min(Math.max(1024, asNumber(args.maxBytes, 4 * 1024 * 1024)), 32 * 1024 * 1024);
    const data = await readPrefix(target, Math.min(stat.size, maxBytes));
    const window = Math.min(Math.max(32, asNumber(args.window, 1024)), Math.max(32, data.length));
    const step = Math.min(Math.max(1, asNumber(args.step, Math.floor(window / 2))), window);
    const rows = entropyWindows(data, window, step);
    const top = Math.min(Math.max(1, asNumber(args.top, 12)), 50);
    const sorted = [...rows].sort((a, b) => b.entropy - a.entropy).slice(0, top);
    const avg = rows.reduce((sum, row) => sum + row.entropy, 0) / Math.max(1, rows.length);
    const min = rows.reduce((best, row) => Math.min(best, row.entropy), Number.POSITIVE_INFINITY);
    const max = rows.reduce((best, row) => Math.max(best, row.entropy), 0);
    const out = [
      "ENTROPY SCAN",
      `path: ${path.relative(context.workspace, target)}`,
      `size: ${stat.size} bytes`,
      `sample: ${data.length}/${stat.size} bytes`,
      `window: ${window}  step: ${step}  windows: ${rows.length}`,
      `entropy: min ${min.toFixed(3)}  avg ${avg.toFixed(3)}  max ${max.toFixed(3)}`,
      "",
      "highest windows:",
      ...sorted.map(row => {
        const chunk = data.subarray(row.offset, Math.min(data.length, row.offset + Math.min(16, window)));
        return `- 0x${row.offset.toString(16).padStart(8, "0")}  ${row.entropy.toFixed(3)}  ${chunk.toString("hex")}  ${asciiPreview(chunk)}`;
      }),
    ];
    if (stat.size > data.length) out.splice(4, 0, `note: sampled first ${data.length} bytes; increase maxBytes for deeper scan`);
    return {
      content: [textBlock(clip(out.join("\n"), context.policy.maxReadBytes))],
      details: { size: stat.size, sampled: data.length, window, step, windows: rows.length, min, avg, max },
    };
  },
};

const binaryMitigationsTool: AgentTool = {
  name: "binary_mitigations",
  description: "Summarize binary security posture for ELF/Mach-O/PE artifacts: arch, PIE, NX, canary, RELRO, stripped, and dangerous imports when available.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const fileType = await runProcess(["file", "-b", target], { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal })
      .then(result => (result.stdout || result.stderr).trim())
      .catch(() => "(file unavailable)");
    const symbols = await collectSymbols(target, context);
    const readelfHeaders = await runProcess(["readelf", "-h", "-l", "-d", "-s", target], {
      cwd: context.workspace,
      timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
    }).catch(() => ({ code: 127, stdout: "", stderr: "" }));
    const otoolHeaders = await runProcess(["otool", "-hv", "-l", "-Iv", target], {
      cwd: context.workspace,
      timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
    }).catch(() => ({ code: 127, stdout: "", stderr: "" }));
    const combined = `${fileType}\n${symbols}\n${readelfHeaders.stdout}\n${otoolHeaders.stdout}`;
    const findings = [
      ["format", fileType],
      ["stripped", /stripped/i.test(fileType) ? "yes" : /not stripped/i.test(fileType) ? "no" : "unknown"],
      ["PIE", /\bDYN\b/.test(readelfHeaders.stdout) || /PIE/i.test(fileType) || /MH_PIE/.test(otoolHeaders.stdout) ? "likely yes" : "unknown/no evidence"],
      ["NX", /GNU_STACK[^\n]*RWE/.test(readelfHeaders.stdout) ? "no (executable stack)" : /GNU_STACK/.test(readelfHeaders.stdout) ? "likely yes" : "unknown"],
      ["canary", /__stack_chk_fail|__stack_chk_guard/.test(combined) ? "yes" : "no evidence"],
      ["RELRO", /BIND_NOW|GNU_RELRO/.test(readelfHeaders.stdout) ? (/BIND_NOW/.test(readelfHeaders.stdout) ? "full/strong" : "partial") : "unknown/no evidence"],
    ];
    const dangerous = dangerousImports(symbols);
    const out = [
      "BINARY MITIGATIONS",
      `path: ${rel}`,
      "",
      ...findings.map(([key, value]) => `${key}: ${value}`),
      "",
      "dangerous imports:",
      ...(dangerous.length ? dangerous.map(item => `- ${item}`) : ["- none found in extracted symbols"]),
      "",
      "notes:",
      "- Treat unknown as a prompt for deeper tool-specific analysis, not as absence.",
      "- For ELF, prefer readelf/checksec/r2/Ghidra if installed.",
    ];
    return { content: [textBlock(out.join("\n"))], details: Object.fromEntries(findings) };
  },
};

const findBytesTool: AgentTool = {
  name: "find_bytes",
  description: "Find text, hex, or regex byte/string patterns in a workspace file and report offsets with hex/ascii context.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string" },
    needle: { type: "string", description: "Text, hex bytes, or regex depending on mode." },
    mode: { type: "string", enum: ["text", "hex", "regex"], default: "text" },
    maxMatches: { type: "number", default: 30 },
    context: { type: "number", default: 16 },
  }, ["path", "needle"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const data = await fs.readFile(target);
    const needle = asString(args.needle);
    const mode = asString(args.mode, "text");
    const maxMatches = Math.min(Math.max(1, asNumber(args.maxMatches, 30)), 200);
    const contextBytes = Math.min(Math.max(0, asNumber(args.context, 16)), 128);
    const matches = findPatternOffsets(data, needle, mode, maxMatches);
    const out = [
      "FIND BYTES",
      `path: ${path.relative(context.workspace, target)}`,
      `mode: ${mode}`,
      `matches: ${matches.length}${matches.length === maxMatches ? " (limit reached)" : ""}`,
      "",
      ...matches.map(offset => {
        const start = Math.max(0, offset - contextBytes);
        const end = Math.min(data.length, offset + contextBytes + Math.max(1, patternLength(needle, mode)));
        const chunk = data.subarray(start, end);
        return `- 0x${offset.toString(16).padStart(8, "0")}  ${chunk.toString("hex")}  ${asciiPreview(chunk)}`;
      }),
    ];
    return { content: [textBlock(out.join("\n"))], details: { matches: matches.length } };
  },
};

const carveArtifactsTool: AgentTool = {
  name: "carve_artifacts",
  description: "Locate embedded file signatures such as ELF, PE, ZIP, DEX, PNG, JPEG, PDF, SQLite, gzip, Mach-O; optionally extract slices with --write enabled.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string" },
    extract: { type: "boolean", default: false },
    outDir: { type: "string", default: "carved" },
    maxArtifacts: { type: "number", default: 50 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const data = await fs.readFile(target);
    const maxArtifacts = Math.min(Math.max(1, asNumber(args.maxArtifacts, 50)), 200);
    const hits = carveHits(data).slice(0, maxArtifacts);
    const extract = args.extract === true;
    const written: string[] = [];
    if (extract) {
      validateWriteAllowed(context.policy);
      const outDir = resolveInside(context.workspace, asString(args.outDir, "carved"));
      await fs.mkdir(outDir, { recursive: true });
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const nextOffset = hits[i + 1]?.offset ?? data.length;
        const ext = hit.extension;
        const outPath = path.join(outDir, `${String(i).padStart(2, "0")}_0x${hit.offset.toString(16)}.${ext}`);
        await fs.writeFile(outPath, data.subarray(hit.offset, nextOffset));
        written.push(path.relative(context.workspace, outPath));
      }
    }
    const out = [
      "CARVE ARTIFACTS",
      `path: ${path.relative(context.workspace, target)}`,
      `hits: ${hits.length}`,
      "",
      ...hits.map(hit => `- 0x${hit.offset.toString(16).padStart(8, "0")}  ${hit.kind}  ${hit.signature}`),
      ...(written.length ? ["", "written:", ...written.map(file => `- ${file}`)] : []),
    ];
    return { content: [textBlock(out.join("\n"))], details: { hits: hits.length, written } };
  },
};

const apkInspectTool: AgentTool = {
  name: "apk_inspect",
  description: "Inspect APK/ZIP structure for DEX files, native libraries, packer signatures, frameworks, manifest/resources, and likely Android reverse targets.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string" },
    maxEntries: { type: "number", default: 200 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const entries = await zipEntries(target, context);
    const maxEntries = Math.min(Math.max(20, asNumber(args.maxEntries, 200)), 1000);
    const packers = detectApkPackers(entries);
    const frameworks = detectApkFrameworks(entries);
    const dex = entries.filter(entry => /(^|\/)classes.*\.dex$/i.test(entry));
    const libs = entries.filter(entry => /^lib\/.*\.so$/i.test(entry));
    const assets = entries.filter(entry => /^assets\//i.test(entry)).slice(0, 50);
    const out = [
      "APK INSPECT",
      `path: ${path.relative(context.workspace, target)}`,
      `entries: ${entries.length}`,
      `dex: ${dex.length}`,
      `native libs: ${libs.length}`,
      `packers: ${packers.join(", ") || "none detected"}`,
      `frameworks: ${frameworks.join(", ") || "native/unknown"}`,
      "",
      "dex files:",
      ...(dex.length ? dex.map(entry => `- ${entry}`) : ["- none"]),
      "",
      "native libs:",
      ...(libs.length ? libs.slice(0, maxEntries).map(entry => `- ${entry}`) : ["- none"]),
      "",
      "interesting assets:",
      ...(assets.length ? assets.map(entry => `- ${entry}`) : ["- none"]),
      "",
      "next:",
      "- Use jadx/apktool for decompile when available.",
      "- Search for crypto/sign/token/root/frida/debug keywords.",
      "- Run ctf_triage/extract_symbols on interesting native libraries after extraction.",
    ];
    return { content: [textBlock(clip(out.join("\n"), context.policy.maxReadBytes))], details: { entries: entries.length, dex: dex.length, libs: libs.length, packers, frameworks } };
  },
};

const fridaHookTemplateTool: AgentTool = {
  name: "frida_hook_template",
  description: "Generate a Frida hook scaffold for Android Java, Android native export/address, or iOS Objective-C targets. Writes only when outputPath is provided and --write is enabled.",
  risk: "read",
  parameters: objectSchema({
    platform: { type: "string", enum: ["android_java", "android_native", "ios_objc"], default: "android_java" },
    target: { type: "string", description: "Class name, module!export, module+offset, or ObjC class." },
    method: { type: "string", description: "Method name for Java/ObjC targets." },
    signature: { type: "string", description: "Optional comma-separated Java overload types." },
    includeStack: { type: "boolean", default: true },
    outputPath: { type: "string", description: "Optional workspace-relative path to write the hook script." },
  }, ["target"]),
  async execute(args, context) {
    const platform = asString(args.platform, "android_java");
    const script = generateFridaHook({
      platform,
      target: asString(args.target),
      method: asString(args.method),
      signature: asString(args.signature),
      includeStack: args.includeStack !== false,
    });
    const outputPath = asString(args.outputPath).trim();
    if (outputPath) {
      validateWriteAllowed(context.policy);
      const target = resolveInside(context.workspace, outputPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, script, "utf8");
      return { content: [textBlock(`Wrote ${path.relative(context.workspace, target)}\n\n${script}`)] };
    }
    return { content: [textBlock(script)] };
  },
};

const listSkillsTool: AgentTool = {
  name: "list_skills",
  description: "List project-local built-in reverse engineering skills available to this agent.",
  risk: "read",
  parameters: objectSchema({}),
  async execute() {
    const skills = await loadBuiltInSkills();
    return { content: [textBlock(formatSkillList(skills))], details: { count: skills.length } };
  },
};

const readSkillTool: AgentTool = {
  name: "read_skill",
  description: "Read one project-local built-in skill by name or tag.",
  risk: "read",
  parameters: objectSchema({
    name: { type: "string", description: "Skill name or tag." },
  }, ["name"]),
  async execute(args, context) {
    const skills = await loadBuiltInSkills();
    const skill = findBuiltInSkill(skills, asString(args.name));
    if (!skill) return { content: [textBlock(`Skill not found: ${asString(args.name)}`)], isError: true };
    return { content: [textBlock(clip(skill.body, context.policy.maxReadBytes))], details: { name: skill.name, path: skill.path } };
  },
};

const knowledgeSearchTool: AgentTool = {
  name: "knowledge_search",
  description: "Search the local reverse-engineering knowledge index and return an agent-ready digest. After calling it, synthesize a structured answer with conclusion, steps, pitfalls, and cited entry ids instead of dumping raw hits.",
  risk: "read",
  parameters: objectSchema({
    query: { type: "string", description: "Search terms, e.g. frida ssl pinning, wasm crypto, unidbg jni." },
    limit: { type: "number", default: 8 },
    raw: { type: "boolean", default: false, description: "Return the old raw hit list for debugging instead of the structured digest." },
  }, ["query"]),
  async execute(args, context) {
    const query = asString(args.query);
    const matches = await searchKnowledge(query, asNumber(args.limit, 8));
    const raw = args.raw === true;
    const text = raw ? formatKnowledgeMatches(matches) : formatKnowledgeDigest(query, matches);
    return {
      content: [textBlock(clip(text, context.policy.maxReadBytes))],
      details: { count: matches.length, mode: raw ? "raw" : "digest" },
    };
  },
};

const knowledgeReadTool: AgentTool = {
  name: "knowledge_read",
  description: "Read one entry from the local reverse-engineering knowledge index by id.",
  risk: "read",
  parameters: objectSchema({
    id: { type: "string", description: "Knowledge entry id from knowledge_search." },
    maxBytes: { type: "number", default: 24000 },
  }, ["id"]),
  async execute(args, context) {
    const entry = await readKnowledgeEntry(asString(args.id));
    if (!entry) return { content: [textBlock(`Knowledge entry not found: ${asString(args.id)}`)], isError: true };
    const text = await readKnowledgeText(entry, Math.min(asNumber(args.maxBytes, 24_000), context.policy.maxReadBytes));
    return { content: [textBlock(`# ${entry.title}\n\nsource: ${entry.path}\n\n${text}`)], details: { id: entry.id, path: entry.path } };
  },
};

const PLAN_STATUSES: PlanStepStatus[] = ["pending", "in_progress", "completed"];

const PLAN_MARKERS: Record<PlanStepStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

const updatePlanTool: AgentTool = {
  name: "update_plan",
  description:
    "Publish or update the task list the operator sees. Call it once up front for any multi-step task, then again whenever a step changes status. Always send the whole list, not a delta.",
  risk: "read",
  parameters: objectSchema({
    plan: {
      type: "array",
      description: "The complete ordered step list.",
      items: objectSchema({
        step: { type: "string", description: "Short imperative description of the step." },
        status: { type: "string", enum: PLAN_STATUSES, description: "Keep at most one step in_progress." },
      }, ["step", "status"]),
    },
    explanation: { type: "string", description: "Optional one-line reason for this update." },
  }, ["plan"]),
  async execute(args, context) {
    const steps = coercePlanSteps(args.plan);
    if (steps.length === 0) {
      return {
        content: [textBlock("update_plan requires at least one step with non-empty text.")],
        isError: true,
      };
    }
    const explanation = asString(args.explanation).trim() || undefined;
    context.onPlan?.(steps, { source: "update_plan", note: explanation });
    const { done, total } = planCounts({ steps, source: "update_plan", note: explanation, updatedAt: Date.now() });
    const listing = steps.map(step => `${PLAN_MARKERS[step.status]} ${step.text}`).join("\n");
    return { content: [textBlock(`Plan updated: ${done}/${total} done\n${listing}`)], details: { total, done } };
  },
};

// The model owns this payload, so every field is untrusted: drop stepless
// entries and fall back to "pending" for anything that is not a known status.
function coercePlanSteps(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return [];
  const out: PlanStep[] = [];
  for (const entry of value) {
    // Models routinely flatten a task list to bare strings; accept that rather
    // than reject the whole plan over a schema detail.
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) out.push({ text, status: "pending" });
      continue;
    }
    const record = entry as Record<string, unknown> | null | undefined;
    const text = asString(record?.step).trim();
    if (!text) continue;
    const status = record?.status;
    out.push({ text, status: isPlanStatus(status) ? status : "pending" });
  }
  return out;
}

function isPlanStatus(value: unknown): value is PlanStepStatus {
  return PLAN_STATUSES.includes(value as PlanStepStatus);
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

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = nodeFs.createReadStream(file);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
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

function printableRatio(data: Buffer): number {
  if (data.length === 0) return 0;
  let printable = 0;
  for (const byte of data) {
    if (isPrintableByte(byte) || byte === 0x0a || byte === 0x0d || byte === 0x09) printable++;
  }
  return printable / data.length;
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

function isPrintableByte(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

function asciiPreview(data: Buffer): string {
  return Array.from(data, byte => (isPrintableByte(byte) ? String.fromCharCode(byte) : ".")).join("");
}

interface ClassifiedString {
  kind: string;
  value: string;
}

function classifyStrings(strings: string[], limit: number): ClassifiedString[] {
  const out: ClassifiedString[] = [];
  const seen = new Set<string>();
  const add = (kind: string, value: string) => {
    const clean = value.trim();
    if (!clean) return;
    const rendered = clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
    const key = `${kind}\0${rendered}`;
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push({ kind, value: rendered });
  };

  for (const raw of strings) {
    const value = raw.trim();
    if (!value) continue;
    for (const match of value.matchAll(/\b(?:flag|ctf|picoCTF|HTB|DUCTF|N1CTF|hxp|uiuctf|0xaf)\{[^}\r\n]{0,160}\}/gi)) {
      add("flag-like", match[0]);
    }
    for (const match of value.matchAll(/\bhttps?:\/\/[^\s"'<>`]+/gi)) add("url", match[0]);
    for (const match of value.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) add("email", match[0]);
    for (const match of value.matchAll(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g)) {
      add("ipv4", match[0]);
    }
    if (/\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\b/i.test(value)) add("secret-keyword", value);
    if (/\b(?:xor|base64|rot13|aes|des|rsa|ecb|cbc|md5|sha1|sha256|crc32|zlib|gzip)\b/i.test(value)) add("crypto-codec", value);
    if (/(?:\bsystem\b|\bexecve\b|\bpopen\b|\bgets\b|\bstrcpy\b|\bsprintf\b|\bmprotect\b|\bptrace\b|\bseccomp\b|\bcanary\b|\/bin\/sh)/i.test(value)) add("pwn-re", value);
    if (/\b(?:UPX!|pyinstaller|nuitka|packed|obfuscat|vmprotect|themida)\b/i.test(value)) add("packer", value);
    if (/^(?:[A-Za-z0-9+/]{24,}={0,2}|[A-Za-z0-9_-]{24,})$/.test(value) && value.length % 4 !== 1) add("base64-like", value);
    if (/^(?:0x)?[0-9a-fA-F]{24,}$/.test(value) && value.replace(/^0x/i, "").length % 2 === 0) add("hex-like", value);
    if (out.length >= limit) break;
  }
  return out;
}

function triageHints(fileType: string, strings: string[], entropy: number, printable: number): string[] {
  const lowerType = fileType.toLowerCase();
  const joined = strings.slice(0, 200).join("\n").toLowerCase();
  const hints: string[] = [];
  if (lowerType.includes("elf")) hints.push("ELF: run extract_symbols, strings, and targeted /run readelf/objdump checks.");
  if (lowerType.includes("mach-o")) hints.push("Mach-O: run extract_symbols, strings, and otool/lldb checks if needed.");
  if (lowerType.includes("pe32") || lowerType.includes("ms-dos executable")) hints.push("PE: inspect imports, resources, and packer indicators.");
  if (lowerType.includes("zip") || lowerType.includes("archive") || lowerType.includes("gzip")) hints.push("Archive/compressed: list contents before extraction and watch for nested files.");
  if (lowerType.includes("image") || lowerType.includes("png") || lowerType.includes("jpeg")) hints.push("Forensics image: inspect metadata, trailing bytes, chunks, and embedded strings.");
  if (entropy >= 7.4) hints.push("High entropy: suspect compression, encryption, packing, or embedded ciphertext; run entropy_scan.");
  if (printable >= 0.75) hints.push("Mostly printable: grep for flags, endpoints, scripts, encodings, and protocol grammar.");
  if (joined.includes("base64") || joined.includes("xor") || joined.includes("rot13")) hints.push("Codec keyword found: try ctf_decode on nearby candidate strings.");
  if (joined.includes("/bin/sh") || joined.includes("system") || joined.includes("gets")) hints.push("Exploit primitive hint: check mitigations and xrefs around dangerous calls.");
  if (hints.length === 0) hints.push("Start with strings, hexdump around magic/offsets, and entropy_scan for hidden structure.");
  return hints.slice(0, 6);
}

interface DecodeCandidate {
  label: string;
  bytes: Buffer;
  score: number;
}

function isDecodeMode(value: string): value is DecodeMode {
  return (DECODE_MODES as readonly string[]).includes(value);
}

function decodeCandidates(input: string, mode: DecodeMode, key: string, maxBytes: number): DecodeCandidate[] {
  const candidates: DecodeCandidate[] = [];
  const add = (label: string, bytes: Buffer) => {
    if (bytes.length === 0) return;
    const clipped = bytes.subarray(0, maxBytes);
    if (candidates.some(candidate => candidate.bytes.equals(clipped))) return;
    candidates.push({ label, bytes: clipped, score: scoreBytes(clipped) });
  };

  const tryBase64 = (variant: "base64" | "base64url") => {
    const decoded = decodeBase64(input, variant);
    if (decoded) add(variant, decoded);
  };
  const tryHex = () => {
    const decoded = decodeHex(input);
    if (decoded) add("hex", decoded);
  };
  const tryUrl = () => {
    const decoded = decodeUrl(input);
    if (decoded !== undefined && decoded !== input) add("url", Buffer.from(decoded, "utf8"));
  };
  const tryRot13 = () => add("rot13", Buffer.from(rot13(input), "utf8"));
  const tryXor = () => {
    const keyBytes = parseXorKey(key);
    if (!keyBytes) throw new Error("ctf_decode mode=xor requires key as text, decimal byte, 0xNN, or hex:...");
    add(`xor key=${key}`, xorBytes(inputBytesForXor(input), keyBytes));
  };
  const tryXorBrute = () => {
    for (const candidate of singleByteXorCandidates(inputBytesForXor(input), 8)) add(candidate.label, candidate.bytes);
  };

  if (mode === "auto") {
    tryBase64("base64");
    tryBase64("base64url");
    tryHex();
    tryUrl();
    tryRot13();
    for (const candidate of singleByteXorCandidates(inputBytesForXor(input), 3)) {
      if (candidate.score >= 1.4) add(candidate.label, candidate.bytes);
    }
  } else if (mode === "base64") tryBase64("base64");
  else if (mode === "base64url") tryBase64("base64url");
  else if (mode === "hex") tryHex();
  else if (mode === "url") tryUrl();
  else if (mode === "rot13") tryRot13();
  else if (mode === "xor") tryXor();
  else if (mode === "xor_bruteforce") tryXorBrute();

  return candidates.sort((a, b) => b.score - a.score);
}

function decodeBase64(input: string, variant: "base64" | "base64url"): Buffer | undefined {
  let normalized = input.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 === 1) return undefined;
  if (variant === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return undefined;
  } else {
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(normalized)) return undefined;
    normalized = normalized.replace(/-/g, "+").replace(/_/g, "/");
  }
  while (normalized.length % 4 !== 0) normalized += "=";
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") === "") return undefined;
  return decoded;
}

function decodeHex(input: string): Buffer | undefined {
  const normalized = input
    .trim()
    .replace(/\\x/gi, "")
    .replace(/^0x/i, "")
    .replace(/[\s:_-]+/g, "");
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) return undefined;
  return Buffer.from(normalized, "hex");
}

function decodeUrl(input: string): string | undefined {
  try {
    return decodeURIComponent(input.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

function rot13(input: string): string {
  return input.replace(/[a-zA-Z]/g, char => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function parseXorKey(value: string): Buffer | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^0x[0-9a-f]{1,2}$/i.test(trimmed)) return Buffer.from([Number.parseInt(trimmed.slice(2), 16)]);
  if (/^\d{1,3}$/.test(trimmed)) {
    const byte = Number.parseInt(trimmed, 10);
    if (byte >= 0 && byte <= 255) return Buffer.from([byte]);
  }
  if (/^hex:/i.test(trimmed)) return decodeHex(trimmed.slice(4));
  return Buffer.from(trimmed, "utf8");
}

function inputBytesForXor(input: string): Buffer {
  return decodeHex(input) ?? Buffer.from(input, "utf8");
}

function xorBytes(input: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] ^ key[i % key.length];
  return out;
}

function singleByteXorCandidates(input: Buffer, limit: number): DecodeCandidate[] {
  const candidates: DecodeCandidate[] = [];
  for (let key = 0; key <= 255; key++) {
    const bytes = xorBytes(input, Buffer.from([key]));
    candidates.push({ label: `xor_bruteforce key=0x${key.toString(16).padStart(2, "0")}`, bytes, score: scoreBytes(bytes) });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

function scoreBytes(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  const printable = printableRatio(bytes);
  const text = bytes.toString("utf8").toLowerCase();
  let bonus = 0;
  if (/\b(flag|ctf|password|secret|token)\b/.test(text)) bonus += 1.0;
  if (/[a-z]{3,}\{[^}]{2,}\}/.test(text)) bonus += 1.2;
  if (/https?:\/\//.test(text)) bonus += 0.5;
  if (/^[\t\r\n -~]+$/.test(bytes.toString("latin1"))) bonus += 0.3;
  return printable + bonus;
}

function renderBytes(bytes: Buffer, maxBytes: number): string {
  const clipped = bytes.subarray(0, maxBytes);
  const suffix = bytes.length > clipped.length ? `\n[truncated ${bytes.length - clipped.length} bytes]` : "";
  if (printableRatio(clipped) >= 0.75) {
    return `${clipped.toString("utf8").replace(/\p{C}/gu, char => (char === "\n" || char === "\r" || char === "\t" ? char : "."))}${suffix}`;
  }
  const hex = clipped.toString("hex").replace(/(.{32})/g, "$1\n").trim();
  return `hex:\n${hex}\nascii:\n${asciiPreview(clipped)}${suffix}`;
}

interface EntropyWindow {
  offset: number;
  entropy: number;
}

function entropyWindows(data: Buffer, window: number, step: number): EntropyWindow[] {
  if (data.length === 0) return [{ offset: 0, entropy: 0 }];
  if (data.length <= window) return [{ offset: 0, entropy: shannonEntropy(data) }];
  const out: EntropyWindow[] = [];
  for (let offset = 0; offset + window <= data.length; offset += step) {
    out.push({ offset, entropy: shannonEntropy(data.subarray(offset, offset + window)) });
  }
  const finalOffset = data.length - window;
  if (out[out.length - 1]?.offset !== finalOffset) {
    out.push({ offset: finalOffset, entropy: shannonEntropy(data.subarray(finalOffset, finalOffset + window)) });
  }
  return out;
}

async function collectSymbols(target: string, context: ToolContext): Promise<string> {
  const attempts: string[][] = [
    ["nm", "-an", target],
    ["readelf", "-Ws", target],
    ["objdump", "-T", target],
    ["otool", "-Iv", target],
  ];
  const chunks: string[] = [];
  for (const command of attempts) {
    const result = await runProcess(command, { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal }).catch(() => undefined);
    if (result?.stdout.trim()) chunks.push(result.stdout);
  }
  return chunks.join("\n");
}

function dangerousImports(symbolText: string): string[] {
  const patterns = [
    "gets", "strcpy", "strcat", "sprintf", "vsprintf", "scanf", "sscanf", "printf",
    "system", "popen", "execve", "mprotect", "mmap", "read", "recv", "memcpy", "strncpy",
  ];
  const found = new Set<string>();
  for (const name of patterns) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(symbolText)) found.add(name);
  }
  return [...found].sort();
}

function findPatternOffsets(data: Buffer, needle: string, mode: string, maxMatches: number): number[] {
  if (!needle) return [];
  if (mode === "regex") {
    const text = data.toString("latin1");
    const regex = new RegExp(needle, "g");
    const out: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) && out.length < maxMatches) {
      out.push(match.index);
      if (match[0].length === 0) regex.lastIndex++;
    }
    return out;
  }
  const pattern = mode === "hex" ? decodeHex(needle) : Buffer.from(needle, "utf8");
  if (!pattern || pattern.length === 0) return [];
  const out: number[] = [];
  let offset = 0;
  while (out.length < maxMatches) {
    const hit = data.indexOf(pattern, offset);
    if (hit < 0) break;
    out.push(hit);
    offset = hit + Math.max(1, pattern.length);
  }
  return out;
}

function patternLength(needle: string, mode: string): number {
  if (mode === "hex") return decodeHex(needle)?.length ?? 1;
  return Math.max(1, Buffer.byteLength(needle));
}

interface CarveHit {
  offset: number;
  kind: string;
  signature: string;
  extension: string;
}

const MAGIC_SIGNATURES: Array<{ kind: string; signature: Buffer; extension: string }> = [
  { kind: "ELF", signature: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), extension: "elf" },
  { kind: "PE/MZ", signature: Buffer.from("MZ", "ascii"), extension: "exe" },
  { kind: "DEX", signature: Buffer.from("dex\n", "ascii"), extension: "dex" },
  { kind: "ZIP/APK/JAR", signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]), extension: "zip" },
  { kind: "PNG", signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), extension: "png" },
  { kind: "JPEG", signature: Buffer.from([0xff, 0xd8, 0xff]), extension: "jpg" },
  { kind: "GIF", signature: Buffer.from("GIF8", "ascii"), extension: "gif" },
  { kind: "PDF", signature: Buffer.from("%PDF-", "ascii"), extension: "pdf" },
  { kind: "gzip", signature: Buffer.from([0x1f, 0x8b, 0x08]), extension: "gz" },
  { kind: "SQLite", signature: Buffer.from("SQLite format 3", "ascii"), extension: "sqlite" },
  { kind: "Mach-O 64 LE", signature: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), extension: "macho" },
  { kind: "Mach-O 64 BE", signature: Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), extension: "macho" },
  { kind: "WASM", signature: Buffer.from([0x00, 0x61, 0x73, 0x6d]), extension: "wasm" },
];

function carveHits(data: Buffer): CarveHit[] {
  const hits: CarveHit[] = [];
  for (const magic of MAGIC_SIGNATURES) {
    let offset = 0;
    while (offset < data.length) {
      const hit = data.indexOf(magic.signature, offset);
      if (hit < 0) break;
      hits.push({ offset: hit, kind: magic.kind, signature: magic.signature.toString("hex"), extension: magic.extension });
      offset = hit + Math.max(1, magic.signature.length);
    }
  }
  return hits.sort((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
}

async function zipEntries(target: string, context: ToolContext): Promise<string[]> {
  const unzip = await runProcess(["unzip", "-Z", "-1", target], {
    cwd: context.workspace,
    timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
  }).catch(() => undefined);
  if (unzip?.stdout.trim()) return unzip.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const zipinfo = await runProcess(["zipinfo", "-1", target], {
    cwd: context.workspace,
    timeoutMs: context.policy.commandTimeoutMs,
      signal: context.signal,
  }).catch(() => undefined);
  if (zipinfo?.stdout.trim()) return zipinfo.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  throw new Error("Could not list APK/ZIP entries. Install unzip or zipinfo, or inspect with run_command.");
}

function detectApkPackers(entries: string[]): string[] {
  const text = entries.join("\n").toLowerCase();
  const checks: Array<[string, RegExp]> = [
    ["360 jiagu", /libjiagu|qihoo|360/],
    ["Tencent Legu", /libshell|libtup|libexecmain|tencent/],
    ["Bangcle", /libsecexe|libsecmain|libdexhelper|bangcle/],
    ["Ijiami", /ijiami|libexec\.so/],
    ["SecNeo", /secneo|libDexHelper/i],
    ["NetEase Yidun", /libnesec|netease|yidun/],
    ["DexGuard/obfuscation", /dexguard|proguard/],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function detectApkFrameworks(entries: string[]): string[] {
  const text = entries.join("\n").toLowerCase();
  const checks: Array<[string, RegExp]> = [
    ["React Native", /assets\/index\.android\.bundle|libreactnativejni\.so/],
    ["Flutter", /libflutter\.so|libapp\.so|flutter_assets/],
    ["Unity", /libunity\.so|assets\/bin\/data/],
    ["Cordova", /assets\/www\/|cordova\.js/],
    ["Xamarin", /assemblies\/|libmonodroid|libmonosgen/],
    ["Cocos2d", /libcocos2d/],
    ["UniApp", /assets\/apps\/|__uni__/],
    ["WeChat Mini Program", /\.wxapkg|wxapkg/],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function generateFridaHook(options: {
  platform: string;
  target: string;
  method: string;
  signature: string;
  includeStack: boolean;
}): string {
  if (options.platform === "android_native") return androidNativeHook(options.target);
  if (options.platform === "ios_objc") return iosObjcHook(options.target, options.method);
  return androidJavaHook(options.target, options.method, options.signature, options.includeStack);
}

function androidJavaHook(className: string, method: string, signature: string, includeStack: boolean): string {
  if (!className || !method) throw new Error("android_java requires target=<class> and method=<method>.");
  const overload = signature
    ? `.overload(${signature.split(",").map(part => JSON.stringify(part.trim())).join(", ")})`
    : "";
  const stack = includeStack
    ? [
        "      const Log = Java.use(\"android.util.Log\");",
        "      const Exception = Java.use(\"java.lang.Exception\");",
        "      console.log(Log.getStackTraceString(Exception.$new()));",
      ].join("\n")
    : "";
  return [
    "Java.perform(function () {",
    `  const Target = Java.use(${JSON.stringify(className)});`,
    `  const overloads = ${overload ? `[Target[${JSON.stringify(method)}]${overload}]` : `Target[${JSON.stringify(method)}].overloads`};`,
    "  overloads.forEach(function (overload) {",
    "    overload.implementation = function () {",
    `      console.log("[+] ${className}.${method} called");`,
    "      for (let i = 0; i < arguments.length; i++) console.log('  arg' + i + ':', arguments[i]);",
    stack,
    "      const ret = overload.apply(this, arguments);",
    "      console.log('  ret:', ret);",
    "      return ret;",
    "    };",
    "  });",
    "});",
  ].filter(Boolean).join("\n");
}

function androidNativeHook(target: string): string {
  if (!target) throw new Error("android_native requires target=lib.so!export or lib.so+0xoffset.");
  const exportMatch = /^([^!+]+)!([^!+]+)$/.exec(target);
  const offsetMatch = /^([^!+]+)\+(.+)$/.exec(target);
  const addressExpr = exportMatch
    ? `Module.findExportByName(${JSON.stringify(exportMatch[1])}, ${JSON.stringify(exportMatch[2])})`
    : offsetMatch
      ? `Module.findBaseAddress(${JSON.stringify(offsetMatch[1])}).add(${offsetMatch[2]})`
      : `Module.findExportByName(null, ${JSON.stringify(target)})`;
  return [
    `const target = ${addressExpr};`,
    "if (target === null) throw new Error('target not found');",
    "Interceptor.attach(target, {",
    "  onEnter(args) {",
    `    console.log("[+] native ${target} enter");`,
    "    for (let i = 0; i < 6; i++) console.log('  arg' + i + ':', args[i]);",
    "  },",
    "  onLeave(retval) {",
    "    console.log('  ret:', retval);",
    "  }",
    "});",
  ].join("\n");
}

function iosObjcHook(className: string, method: string): string {
  if (!className || !method) throw new Error("ios_objc requires target=<ObjCClass> and method=<selector>.");
  return [
    `const cls = ObjC.classes[${JSON.stringify(className)}];`,
    "if (!cls) throw new Error('class not found');",
    `const impl = cls[${JSON.stringify(method)}].implementation;`,
    "Interceptor.attach(impl, {",
    "  onEnter(args) {",
    `    console.log("[+] ${className} ${method}");`,
    "    console.log('  self:', new ObjC.Object(args[0]));",
    "    console.log('  selector:', ObjC.selectorAsString(args[1]));",
    "  },",
    "  onLeave(retval) {",
    "    console.log('  ret:', retval);",
    "  }",
    "});",
  ].join("\n");
}

async function walk(dir: string, workspace: string, recursive: boolean, max: number, out: string[]): Promise<void> {
  if (out.length >= max) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= max) return;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    out.push(`${entry.isDirectory() ? "d" : "-"} ${path.relative(workspace, full)}`);
    if (recursive && entry.isDirectory()) {
      await walk(full, workspace, recursive, max, out);
    }
  }
}

async function jsGrep(root: string, workspace: string, pattern: string, maxMatches: number): Promise<string[]> {
  const regex = new RegExp(pattern, "i");
  const out: string[] = [];
  const visit = async (target: string): Promise<void> => {
    if (out.length >= maxMatches) return;
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target)) {
        if (entry === ".git" || entry === "node_modules") continue;
        await visit(path.join(target, entry));
      }
      return;
    }
    if (stat.size > 1024 * 1024) return;
    const text = await fs.readFile(target, "utf8").catch(() => "");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < maxMatches; i++) {
      if (regex.test(lines[i])) {
        out.push(`${path.relative(workspace, target)}:${i + 1}:${lines[i]}`);
      }
    }
  };
  await visit(root);
  return out;
}
