import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, ToolContext } from "../types";
import { asNumber, asString, clip, resolveInside, textBlock } from "../utils";
import { validatePathRead, validateWriteAllowed } from "../security/policy";
import { runProcess } from "./process";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export function createYaraTools(): AgentTool[] {
  return [
    yaraGenerateTool,
    yaraScanTool,
  ];
}

// ---------------------------------------------------------------------------
// Crypto constant signatures (subset for YARA rule generation)
// ---------------------------------------------------------------------------

interface CryptoSigShort {
  name: string;
  yaraId: string;
  bytes: Buffer;
  comment: string;
}

const CRYPTO_SIGS: CryptoSigShort[] = [
  {
    name: "AES S-Box",
    yaraId: "crypto_aes_sbox",
    bytes: Buffer.from([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76]),
    comment: "AES S-Box (first 16 bytes)",
  },
  {
    name: "AES Inv S-Box",
    yaraId: "crypto_aes_inv_sbox",
    bytes: Buffer.from([0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb]),
    comment: "AES Inverse S-Box (first 16 bytes)",
  },
  {
    name: "SHA-256 K (BE)",
    yaraId: "crypto_sha256_k",
    bytes: Buffer.from([0x42, 0x8a, 0x2f, 0x98, 0x71, 0x37, 0x44, 0x91, 0xb5, 0xc0, 0xfb, 0xcf, 0xe9, 0xb5, 0xdb, 0xa5]),
    comment: "SHA-256 K constants (first 4, big-endian)",
  },
  {
    name: "MD5 T-table",
    yaraId: "crypto_md5_t",
    bytes: Buffer.from([0x78, 0xa4, 0x6a, 0xd7, 0x56, 0xb7, 0xc7, 0xe8, 0xdb, 0x70, 0x20, 0x24, 0xee, 0xce, 0xbd, 0xc1]),
    comment: "MD5 T-table (first 4 constants, LE)",
  },
  {
    name: "ChaCha20/Salsa20",
    yaraId: "crypto_chacha",
    bytes: Buffer.from("expand 32-byte k", "ascii"),
    comment: "ChaCha20/Salsa20 constant string",
  },
  {
    name: "Blowfish P-array",
    yaraId: "crypto_blowfish_p",
    bytes: Buffer.from([0x24, 0x3f, 0x6a, 0x88, 0x85, 0xa3, 0x08, 0xd3, 0x13, 0x19, 0x8a, 0x2e, 0x03, 0x70, 0x73, 0x44]),
    comment: "Blowfish P-array (first 4, BE)",
  },
  {
    name: "TEA delta",
    yaraId: "crypto_tea_delta",
    bytes: Buffer.from([0x9e, 0x37, 0x79, 0xb9]),
    comment: "TEA/XTEA delta constant 0x9e3779b9 (BE)",
  },
  {
    name: "SM4 S-Box",
    yaraId: "crypto_sm4_sbox",
    bytes: Buffer.from([0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05]),
    comment: "SM4 S-Box (first 16 bytes)",
  },
];

// ---------------------------------------------------------------------------
// Magic number conditions for YARA
// ---------------------------------------------------------------------------

interface MagicCondition {
  pattern: Buffer;
  condition: string;
  comment: string;
}

const MAGIC_CONDITIONS: MagicCondition[] = [
  { pattern: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), condition: "uint32(0) == 0x464c457f", comment: "ELF" },
  { pattern: Buffer.from("MZ", "ascii"), condition: 'uint16(0) == 0x5a4d', comment: "PE/MZ" },
  { pattern: Buffer.from("dex\n", "ascii"), condition: 'uint32(0) == 0x0a786564', comment: "DEX" },
  { pattern: Buffer.from([0x50, 0x4b, 0x03, 0x04]), condition: "uint32(0) == 0x04034b50", comment: "ZIP/APK" },
  { pattern: Buffer.from([0xce, 0xfa, 0xed, 0xfe]), condition: "uint32(0) == 0xfeedface", comment: "Mach-O 32" },
  { pattern: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), condition: "uint32(0) == 0xfeedfacf", comment: "Mach-O 64" },
  { pattern: Buffer.from([0x00, 0x61, 0x73, 0x6d]), condition: "uint32(0) == 0x6d736100", comment: "WASM" },
];

// ---------------------------------------------------------------------------
// String classification for YARA
// ---------------------------------------------------------------------------

interface YaraString {
  id: string;
  value: string;
  type: "ascii" | "wide" | "hex";
  comment?: string;
}

function classifyStringsForYara(data: Buffer, maxStrings: number): YaraString[] {
  const strings = extractPrintable(data, 6);
  const out: YaraString[] = [];
  const seen = new Set<string>();

  const add = (id: string, value: string, comment?: string) => {
    if (seen.has(value) || out.length >= maxStrings) return;
    seen.add(value);
    out.push({ id, value: escapeYaraString(value), type: "ascii", comment });
  };

  let urlIdx = 0;
  let strIdx = 0;
  let pathIdx = 0;

  for (const raw of strings) {
    if (out.length >= maxStrings) break;
    const s = raw.trim();

    // URLs
    const urlMatch = s.match(/https?:\/\/[^\s"'<>`]{8,}/i);
    if (urlMatch) {
      add(`url_${++urlIdx}`, urlMatch[0], "URL");
      continue;
    }

    // Flag patterns
    const flagMatch = s.match(/\b(?:flag|ctf|picoCTF|HTB|DUCTF)\{[^}]{0,80}\}/i);
    if (flagMatch) {
      add(`flag_${++strIdx}`, flagMatch[0], "flag pattern");
      continue;
    }

    // File paths
    if (/^\/(?:etc|tmp|proc|bin|usr|home|var)\/\S{3,}/.test(s) || /^\.\/\S{3,}/.test(s)) {
      add(`path_${++pathIdx}`, s.slice(0, 120), "file path");
      continue;
    }

    // Crypto / security keywords
    if (/\b(AES|DES|RSA|SHA|MD5|HMAC|CBC|ECB|GCM|PKCS|X509|certificate|private.key|public.key)\b/i.test(s)) {
      add(`crypto_str_${++strIdx}`, s.slice(0, 120), "crypto keyword");
      continue;
    }

    // Error/debug messages (likely unique to this binary)
    if (/\b(error|failed|invalid|denied|unauthorized|exception|assert|panic|abort)\b/i.test(s) && s.length >= 12 && s.length <= 120) {
      add(`err_${++strIdx}`, s.slice(0, 120), "error/debug string");
      continue;
    }

    // API endpoints
    if (/^\/api\/|^\/v[12]\//.test(s)) {
      add(`api_${++strIdx}`, s.slice(0, 120), "API endpoint");
      continue;
    }

    // Custom/unique strings (longer, likely unique identifiers)
    if (s.length >= 16 && s.length <= 80 && /[a-z].*[A-Z]|[A-Z].*[a-z]/.test(s) && !/^\s/.test(s)) {
      add(`str_${++strIdx}`, s, "unique string");
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Code pattern extraction for YARA hex rules
// ---------------------------------------------------------------------------

interface CodePattern {
  id: string;
  hex: string;
  comment: string;
}

function extractCodePatterns(data: Buffer, maxPatterns: number): CodePattern[] {
  const patterns: CodePattern[] = [];

  // x86_64 function prologues
  const prologues: Array<{ name: string; pattern: Buffer; mask: Buffer }> = [
    {
      name: "x64 prologue (push rbp; mov rbp, rsp; sub rsp, N)",
      pattern: Buffer.from([0x55, 0x48, 0x89, 0xe5, 0x48, 0x83, 0xec, 0x00]),
      mask: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]),
    },
    {
      name: "x64 prologue (push rbp; mov rbp, rsp)",
      pattern: Buffer.from([0x55, 0x48, 0x89, 0xe5]),
      mask: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    },
    {
      name: "x86 prologue (push ebp; mov ebp, esp)",
      pattern: Buffer.from([0x55, 0x89, 0xe5]),
      mask: Buffer.from([0xff, 0xff, 0xff]),
    },
  ];

  // Find unique function-like code sequences around notable offsets
  const seen = new Set<string>();
  for (const prologue of prologues) {
    if (patterns.length >= maxPatterns) break;
    let offset = 0;
    let count = 0;
    while (offset <= data.length - prologue.pattern.length && count < 3) {
      const idx = findMasked(data, prologue.pattern, prologue.mask, offset);
      if (idx < 0) break;

      // Grab 12 bytes from the match point, wildcard the variable parts
      const end = Math.min(idx + 12, data.length);
      const slice = data.subarray(idx, end);
      const yaraHex = toYaraHex(slice, prologue.mask.length);
      if (!seen.has(yaraHex)) {
        seen.add(yaraHex);
        patterns.push({
          id: `code_${patterns.length + 1}`,
          hex: yaraHex,
          comment: `${prologue.name} at 0x${idx.toString(16)}`,
        });
        count++;
      }
      offset = idx + prologue.pattern.length;
    }
  }

  return patterns.slice(0, maxPatterns);
}

function findMasked(data: Buffer, pattern: Buffer, mask: Buffer, startOffset: number): number {
  for (let i = startOffset; i <= data.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if ((data[i + j] & mask[j]) !== (pattern[j] & mask[j])) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** Convert raw bytes to YARA hex, wildcarding bytes after the known mask length. */
function toYaraHex(slice: Buffer, knownLen: number): string {
  const parts: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    if (i < knownLen) {
      parts.push(slice[i].toString(16).padStart(2, "0"));
    } else {
      // Heuristic: keep bytes that are likely opcode/register, wildcard likely operands
      const b = slice[i];
      if (b === 0x00 || (b >= 0x80 && b <= 0xff && i > knownLen + 1)) {
        parts.push("??");
      } else {
        parts.push(slice[i].toString(16).padStart(2, "0"));
      }
    }
  }
  return `{ ${parts.join(" ")} }`;
}

// ---------------------------------------------------------------------------
// YARA rule assembly
// ---------------------------------------------------------------------------

function buildYaraRule(
  ruleName: string,
  meta: Record<string, string>,
  yaraStrings: YaraString[],
  cryptoHits: Array<{ id: string; hex: string; comment: string }>,
  codePatterns: CodePattern[],
  magicCondition?: string,
  magicComment?: string,
): string {
  const lines: string[] = [];

  lines.push(`rule ${ruleName} {`);

  // Meta
  lines.push("    meta:");
  for (const [k, v] of Object.entries(meta)) {
    lines.push(`        ${k} = ${JSON.stringify(v)}`);
  }

  // Strings
  const hasStrings = yaraStrings.length > 0 || cryptoHits.length > 0 || codePatterns.length > 0;
  if (hasStrings) {
    lines.push("");
    lines.push("    strings:");

    for (const s of yaraStrings) {
      const comment = s.comment ? `  // ${s.comment}` : "";
      lines.push(`        $${s.id} = "${s.value}" ascii${comment}`);
    }

    for (const c of cryptoHits) {
      lines.push(`        $${c.id} = ${c.hex}  // ${c.comment}`);
    }

    for (const p of codePatterns) {
      lines.push(`        $${p.id} = ${p.hex}  // ${p.comment}`);
    }
  }

  // Condition
  lines.push("");
  lines.push("    condition:");
  const conditions: string[] = [];

  if (magicCondition) {
    conditions.push(`${magicCondition}  // ${magicComment}`);
  }

  const strCount = yaraStrings.length;
  const cryptoCount = cryptoHits.length;
  const codeCount = codePatterns.length;

  if (strCount > 0) {
    const threshold = Math.max(1, Math.min(3, Math.ceil(strCount * 0.4)));
    conditions.push(`${threshold} of ($url_*, $flag_*, $str_*, $err_*, $path_*, $api_*, $crypto_str_*)`);
  }
  if (cryptoCount > 0) {
    conditions.push(`1 of ($${cryptoHits.map(c => c.id).join(", $")})`);
  }
  if (codeCount > 0) {
    conditions.push(`1 of ($${codePatterns.map(p => p.id).join(", $")})`);
  }

  if (conditions.length === 0) {
    conditions.push("filesize > 0");
  }

  const joined = conditions.join("\n        and ");
  lines.push(`        ${joined}`);

  lines.push("}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPrintable(data: Buffer, minLen: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const byte of data) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLen) out.push(current);
      current = "";
    }
  }
  if (current.length >= minLen) out.push(current);
  return out;
}

function escapeYaraString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sanitizeRuleName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^[0-9]/, "_$&")
    .replace(/_+/g, "_")
    .slice(0, 60) || "auto_rule";
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
  const data = await fs.readFile(file);
  return crypto.createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Tool 1: yara_generate
// ---------------------------------------------------------------------------

const yaraGenerateTool: AgentTool = {
  name: "yara_generate",
  description:
    "Auto-generate a YARA rule from a binary: extracts unique strings (URLs, flags, API paths, crypto keywords, error messages), finds cryptographic constants, identifies file format magic, and captures code patterns (function prologues). Produces a complete, ready-to-use .yar rule.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative file path." },
      ruleName: { type: "string", description: "Optional YARA rule name. Auto-generated from filename if omitted." },
      maxStrings: { type: "number", default: 20, description: "Maximum number of string patterns to include." },
      maxCodePatterns: { type: "number", default: 5, description: "Maximum number of code patterns to include." },
      outputPath: { type: "string", description: "Optional workspace-relative path to write the .yar file." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("yara_generate expects a file path.");

    const maxStrings = Math.min(Math.max(1, asNumber(args.maxStrings, 20)), 50);
    const maxCodePatterns = Math.min(Math.max(0, asNumber(args.maxCodePatterns, 5)), 15);
    const maxBytes = Math.min(stat.size, 8 * 1024 * 1024);
    const data = await readPrefix(target, maxBytes);
    const sha256 = await sha256File(target);

    // Rule name
    const baseName = path.basename(target, path.extname(target));
    const rawRuleName = asString(args.ruleName).trim() || `generated_${baseName}`;
    const ruleName = sanitizeRuleName(rawRuleName);

    // Detect magic / file format
    const magic4 = data.subarray(0, 4);
    let magicCondition: string | undefined;
    let magicComment: string | undefined;
    for (const mc of MAGIC_CONDITIONS) {
      if (magic4.length >= mc.pattern.length && magic4.subarray(0, mc.pattern.length).equals(mc.pattern)) {
        magicCondition = mc.condition;
        magicComment = mc.comment;
        break;
      }
    }

    // Extract strings
    const yaraStrings = classifyStringsForYara(data, maxStrings);

    // Find crypto constants
    const cryptoHits: Array<{ id: string; hex: string; comment: string }> = [];
    for (const sig of CRYPTO_SIGS) {
      if (data.indexOf(sig.bytes) >= 0) {
        const hex = `{ ${Array.from(sig.bytes, b => b.toString(16).padStart(2, "0")).join(" ")} }`;
        cryptoHits.push({ id: sig.yaraId, hex, comment: sig.comment });
      }
    }

    // Extract code patterns
    const codePatterns = extractCodePatterns(data, maxCodePatterns);

    // Build the rule
    const today = new Date().toISOString().slice(0, 10);
    const meta: Record<string, string> = {
      description: `Auto-generated rule for ${baseName}`,
      author: "0xAF-Re Agent",
      date: today,
      sha256,
    };
    if (stat.size > 0) meta.filesize = String(stat.size);

    const rule = buildYaraRule(ruleName, meta, yaraStrings, cryptoHits, codePatterns, magicCondition, magicComment);

    // Optionally write
    const outputPath = asString(args.outputPath).trim();
    if (outputPath) {
      validateWriteAllowed(context.policy);
      const outTarget = resolveInside(context.workspace, outputPath);
      await fs.mkdir(path.dirname(outTarget), { recursive: true });
      await fs.writeFile(outTarget, rule, "utf8");
    }

    const header = [
      "YARA GENERATE",
      `source: ${rel}`,
      `size: ${stat.size} bytes`,
      `sha256: ${sha256}`,
      `rule: ${ruleName}`,
      `strings: ${yaraStrings.length}`,
      `crypto constants: ${cryptoHits.length}`,
      `code patterns: ${codePatterns.length}`,
      ...(magicCondition ? [`format: ${magicComment}`] : []),
      ...(outputPath ? [`written: ${outputPath}`] : []),
      "",
    ];

    const spilled = await spillIfLarge(`${header.join("\n")}\n${rule}`, { context, label: `yara-${baseName}` });
    return {
      content: [textBlock(spilled.text)],
      details: {
        rule: ruleName,
        strings: yaraStrings.length,
        crypto: cryptoHits.length,
        code: codePatterns.length,
        artifact: spilled.artifact,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 2: yara_scan — scan files with a YARA rule
// ---------------------------------------------------------------------------

const yaraScanTool: AgentTool = {
  name: "yara_scan",
  description:
    "Scan files with a YARA rule. Uses the external yara command when available; falls back to a basic pure-JS string matcher for simple rules generated by yara_generate.",
  risk: "read",
  parameters: objectSchema(
    {
      rulePath: { type: "string", description: "Workspace-relative path to the .yar rule file." },
      targetPath: { type: "string", description: "Workspace-relative file or directory to scan." },
      recursive: { type: "boolean", default: false, description: "Recurse into subdirectories when targetPath is a directory." },
      maxMatches: { type: "number", default: 100 },
    },
    ["rulePath", "targetPath"],
  ),
  async execute(args, context) {
    const rulePath = resolveInside(context.workspace, asString(args.rulePath));
    validatePathRead(rulePath, context.policy);
    const targetPath = resolveInside(context.workspace, asString(args.targetPath));
    validatePathRead(targetPath, context.policy);
    const recursive = args.recursive === true;
    const maxMatches = Math.min(Math.max(1, asNumber(args.maxMatches, 100)), 1000);

    const ruleRel = path.relative(context.workspace, rulePath);
    const targetRel = path.relative(context.workspace, targetPath);

    // Try external yara first
    const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };
    const yaraArgs = ["yara", ...(recursive ? ["-r"] : []), rulePath, targetPath];
    const yaraResult = await runProcess(yaraArgs, opts).catch(() => null);

    if (yaraResult && (yaraResult.code === 0 || yaraResult.stdout.trim())) {
      const trimmedOutput = yaraResult.stdout.trim();
      const lines = trimmedOutput ? trimmedOutput.split(/\r?\n/) : [];
      const shown = lines.slice(0, maxMatches);
      const out = [
        "YARA SCAN",
        `rule: ${ruleRel}`,
        `target: ${targetRel}`,
        `engine: yara (external)`,
        `matches: ${lines.length}`,
        "",
        ...(shown.length ? shown : ["(no matches)"]),
      ];
      const spilled = await spillIfLarge(out.join("\n"), { context, label: "yara-scan" });
      return { content: [textBlock(spilled.text)], details: { engine: "yara", matches: lines.length, artifact: spilled.artifact } };
    }

    // Fallback: basic JS string matching
    const ruleText = await fs.readFile(rulePath, "utf8");
    const targets = await collectTargets(targetPath, recursive, 500);
    const ruleStrings = parseSimpleYaraStrings(ruleText);

    if (ruleStrings.length === 0) {
      return {
        content: [textBlock(
          `YARA SCAN\nrule: ${ruleRel}\ntarget: ${targetRel}\nengine: js-fallback\n\nNo simple string patterns found in rule. Install yara for full rule support:\n  brew install yara  /  apt install yara`,
        )],
        details: { engine: "js-fallback", matches: 0 },
      };
    }

    const matches: string[] = [];
    for (const file of targets) {
      if (matches.length >= maxMatches) break;
      const data = await readPrefix(file, 4 * 1024 * 1024);
      for (const rs of ruleStrings) {
        if (matches.length >= maxMatches) break;
        if (rs.type === "hex" && rs.runs && rs.runs.length > 0) {
          const runs = rs.runs;
          const gaps = rs.gapsBefore ?? [];
          let offset = 0;
          while (offset < data.length && matches.length < maxMatches) {
            const idx = findHexPattern(data, runs, gaps, offset);
            if (idx < 0) break;
            matches.push(`${path.relative(context.workspace, file)}:0x${idx.toString(16)} [${rs.id}]`);
            offset = idx + 1;
          }
        } else {
          const needle = rs.type === "hex" ? Buffer.from(rs.value, "hex") : Buffer.from(rs.value, "utf8");
          let offset = 0;
          while (offset < data.length && matches.length < maxMatches) {
            const idx = data.indexOf(needle, offset);
            if (idx < 0) break;
            matches.push(`${path.relative(context.workspace, file)}:0x${idx.toString(16)} [${rs.id}]`);
            offset = idx + Math.max(1, needle.length);
          }
        }
      }
    }

    const out = [
      "YARA SCAN",
      `rule: ${ruleRel}`,
      `target: ${targetRel}`,
      "engine: js-fallback (install yara for full rule support)",
      `files scanned: ${targets.length}`,
      `matches: ${matches.length}`,
      "",
      ...(matches.length ? matches : ["(no matches)"]),
    ];

    const spilled = await spillIfLarge(out.join("\n"), { context, label: "yara-scan" });
    return {
      content: [textBlock(spilled.text)],
      details: { engine: "js-fallback", files: targets.length, matches: matches.length, artifact: spilled.artifact },
    };
  },
};

// ---------------------------------------------------------------------------
// Simple YARA string parser (for JS fallback)
// ---------------------------------------------------------------------------

interface SimpleYaraString {
  id: string;
  value: string;
  type: "ascii" | "hex";
  /** hex only: contiguous byte runs, in order */
  runs?: Buffer[];
  /** hex only: how many wildcard (??) bytes sit right before each run; runs[0] is unconstrained */
  gapsBefore?: number[];
}

/** Strip a trailing // comment, but only outside double-quoted strings. */
function stripYaraComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString && ch === "\\") { i++; continue; } // skip the escaped char
    if (ch === '"') { inString = !inString; continue; }
    if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

function parseSimpleYaraStrings(ruleText: string): SimpleYaraString[] {
  const out: SimpleYaraString[] = [];
  const stringsSection = ruleText.match(/strings\s*:([\s\S]*?)(?:condition\s*:|$)/);
  if (!stringsSection) return out;

  const body = stringsSection[1];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = stripYaraComment(line).trim();

    // ASCII string: $id = "value" ascii — \" must not end the capture
    const asciiMatch = trimmed.match(/^\$([A-Za-z0-9_]+)\s*=\s*"((?:\\.|[^"\\])+)"\s*(ascii|wide)?/);
    if (asciiMatch) {
      out.push({ id: asciiMatch[1], value: asciiMatch[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\"), type: "ascii" });
      continue;
    }

    // Hex string: $id = { aa bb cc ?? dd }
    const hexMatch = trimmed.match(/^\$([A-Za-z0-9_]+)\s*=\s*\{\s*([0-9a-fA-F\s?]+)\s*\}/);
    if (hexMatch) {
      const runs: Buffer[] = [];
      const gapsBefore: number[] = [];
      let current: number[] = [];
      let wildcards = 0;
      const flush = () => {
        if (current.length === 0) return;
        gapsBefore.push(runs.length > 0 ? wildcards : 0);
        runs.push(Buffer.from(current));
        current = [];
        wildcards = 0;
      };
      for (const token of hexMatch[2].match(/\?\?|[0-9a-fA-F]{2}/g) ?? []) {
        if (token === "??") {
          flush();
          wildcards++;
        } else {
          current.push(parseInt(token, 16));
        }
      }
      flush();
      if (runs.reduce((total, run) => total + run.length, 0) >= 2) {
        out.push({ id: hexMatch[1], value: hexMatch[2].replace(/\?\?/g, "").replace(/\s+/g, ""), type: "hex", runs, gapsBefore });
      }
    }
  }

  return out;
}

/** True when data[pos..] starts with `run`. */
function bytesMatchAt(data: Buffer, pos: number, run: Buffer): boolean {
  if (pos + run.length > data.length) return false;
  for (let i = 0; i < run.length; i++) {
    if (data[pos + i] !== run[i]) return false;
  }
  return true;
}

/**
 * Match a hex pattern with `??` wildcards: find the first run, then check the
 * remaining runs at their exact wildcard-offsets. Returns the match start or -1.
 */
function findHexPattern(data: Buffer, runs: Buffer[], gapsBefore: number[], from: number): number {
  if (runs.length === 0) return -1;
  let search = from;
  for (;;) {
    const start = data.indexOf(runs[0], search);
    if (start < 0) return -1;
    let pos = start + runs[0].length;
    let ok = true;
    for (let i = 1; i < runs.length; i++) {
      pos += gapsBefore[i];
      if (!bytesMatchAt(data, pos, runs[i])) {
        ok = false;
        break;
      }
      pos += runs[i].length;
    }
    if (ok) return start;
    search = start + 1;
  }
}

async function collectTargets(targetPath: string, recursive: boolean, max: number): Promise<string[]> {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) return [targetPath];

  const files: string[] = [];
  const visit = async (dir: string) => {
    if (files.length >= max) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= max) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) files.push(full);
      else if (entry.isDirectory() && recursive) await visit(full);
    }
  };
  await visit(targetPath);
  return files;
}
