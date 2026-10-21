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

export function createPwnTools(): AgentTool[] {
  return [
    ropGadgetsTool,
    oneGadgetTool,
    checksecDetailTool,
    patchBinaryTool,
    asmEncodeTool,
    asmDecodeTool,
    patternCreateTool,
    patternOffsetTool,
  ];
}

// ---------------------------------------------------------------------------
// rop_gadgets
// ---------------------------------------------------------------------------

const ropGadgetsTool: AgentTool = {
  name: "rop_gadgets",
  description: "Find ROP gadgets in a binary using ROPgadget or ropper. Optionally filter by instruction pattern.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    filter: { type: "string", description: "Grep pattern to filter gadgets, e.g. 'pop rdi'." },
    depth: { type: "number", default: 5, description: "Maximum gadget instruction count." },
    maxGadgets: { type: "number", default: 200 },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const depth = Math.max(1, asNumber(args.depth, 5));
    const maxGadgets = Math.min(Math.max(1, asNumber(args.maxGadgets, 200)), 2000);
    const filter = asString(args.filter).trim();

    const ropgadget = await runProcess(
      ["ROPgadget", "--binary", target, "--depth", String(depth)],
      { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal },
    ).catch(() => null);

    let engine = "ROPgadget";
    let raw = ropgadget?.stdout?.trim() || "";

    if (!raw) {
      const ropper = await runProcess(
        ["ropper", "--file", target, "--depth", String(depth)],
        { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal },
      ).catch(() => null);
      engine = "ropper";
      raw = ropper?.stdout?.trim() || "";
    }

    if (!raw) {
      return {
        content: [textBlock(`No ROP gadgets found — neither ROPgadget nor ropper is available or produced output for ${rel}.`)],
        isError: true,
      };
    }

    let lines = raw.split(/\r?\n/);
    if (filter) {
      const re = new RegExp(filter, "i");
      lines = lines.filter(l => re.test(l));
    }
    const total = lines.length;
    lines = lines.slice(0, maxGadgets);

    const out = [
      "ROP GADGETS",
      `path: ${rel}`,
      `engine: ${engine}`,
      `depth: ${depth}`,
      ...(filter ? [`filter: ${filter}`] : []),
      `showing: ${lines.length}/${total}`,
      "",
      ...lines,
    ];

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `rop-${path.basename(target)}` });
    return { content: [textBlock(spilled.text)], details: { engine, total, shown: lines.length, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// one_gadget
// ---------------------------------------------------------------------------

const oneGadgetTool: AgentTool = {
  name: "one_gadget",
  description: "Find one-shot RCE gadgets in libc using the one_gadget tool. Shows address, constraints, and instructions.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative path to libc.so." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    const result = await runProcess(
      ["one_gadget", target],
      { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal },
    ).catch(() => null);

    if (!result || (!result.stdout.trim() && result.code !== 0)) {
      return {
        content: [textBlock(`one_gadget not available or no gadgets found for ${rel}.\nInstall: gem install one_gadget`)],
        isError: true,
      };
    }

    const out = [
      "ONE_GADGET",
      `path: ${rel}`,
      "",
      result.stdout.trim(),
    ];
    if (result.stderr.trim()) out.push("", "stderr:", result.stderr.trim());

    return { content: [textBlock(out.join("\n"))], details: { exit: result.code } };
  },
};

// ---------------------------------------------------------------------------
// checksec_detail
// ---------------------------------------------------------------------------

const checksecDetailTool: AgentTool = {
  name: "checksec_detail",
  description: "Detailed binary security check using checksec, pwntools, or manual readelf analysis. Reports RELRO, stack canary, NX, PIE, FORTIFY, and RPATH/RUNPATH.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };

    const checksec = await runProcess(["checksec", `--file=${target}`], opts).catch(() => null);
    if (checksec && (checksec.stdout.trim() || checksec.stderr.trim())) {
      const text = (checksec.stdout || checksec.stderr).trim();
      return { content: [textBlock(`CHECKSEC\npath: ${rel}\nengine: checksec\n\n${text}`)], details: { engine: "checksec" } };
    }

    const pwn = await runProcess(
      ["python3", "-c", `from pwn import ELF; e = ELF(${JSON.stringify(target)}); print(e.checksec())`],
      opts,
    ).catch(() => null);
    if (pwn && pwn.stdout.trim()) {
      return { content: [textBlock(`CHECKSEC\npath: ${rel}\nengine: pwntools\n\n${pwn.stdout.trim()}`)], details: { engine: "pwntools" } };
    }

    const [readelfHL, readelfD, readelfS, readelfH] = await Promise.all([
      runProcess(["readelf", "-l", target], opts).catch(() => ({ code: 127, stdout: "", stderr: "" })),
      runProcess(["readelf", "-d", target], opts).catch(() => ({ code: 127, stdout: "", stderr: "" })),
      runProcess(["readelf", "-s", target], opts).catch(() => ({ code: 127, stdout: "", stderr: "" })),
      runProcess(["readelf", "-h", target], opts).catch(() => ({ code: 127, stdout: "", stderr: "" })),
    ]);

    if (readelfH.code === 127) {
      return { content: [textBlock(`No checksec, pwntools, or readelf available for ${rel}.`)], isError: true };
    }

    const hasGnuRelro = /GNU_RELRO/.test(readelfHL.stdout);
    const hasBindNow = /BIND_NOW/.test(readelfD.stdout);
    const relro = hasGnuRelro ? (hasBindNow ? "Full RELRO" : "Partial RELRO") : "No RELRO";

    const canary = /__stack_chk_fail/.test(readelfS.stdout) ? "Canary found" : "No canary found";

    const gnuStackMatch = readelfHL.stdout.match(/GNU_STACK[^\n]*/);
    const nx = gnuStackMatch
      ? (/RWE/.test(gnuStackMatch[0]) ? "NX disabled (executable stack)" : "NX enabled")
      : "Unknown (no GNU_STACK segment)";

    const pie = /Type:\s+DYN\b/.test(readelfH.stdout) ? "PIE enabled" : "No PIE";

    const fortifySymbols = (readelfS.stdout.match(/__\w+_chk\b/g) || []);
    const fortify = fortifySymbols.length > 0
      ? `FORTIFY enabled (${fortifySymbols.length} fortified functions: ${[...new Set(fortifySymbols)].slice(0, 10).join(", ")})`
      : "No FORTIFY";

    const rpathMatch = readelfD.stdout.match(/RPATH\s+Library rpath:\s*\[([^\]]+)\]/);
    const runpathMatch = readelfD.stdout.match(/RUNPATH\s+Library runpath:\s*\[([^\]]+)\]/);

    const out = [
      "CHECKSEC",
      `path: ${rel}`,
      "engine: readelf (manual)",
      "",
      `RELRO:    ${relro}`,
      `Canary:   ${canary}`,
      `NX:       ${nx}`,
      `PIE:      ${pie}`,
      `FORTIFY:  ${fortify}`,
      ...(rpathMatch ? [`RPATH:    ${rpathMatch[1]}`] : []),
      ...(runpathMatch ? [`RUNPATH:  ${runpathMatch[1]}`] : []),
    ];

    return { content: [textBlock(out.join("\n"))], details: { engine: "readelf", relro, canary, nx, pie } };
  },
};

// ---------------------------------------------------------------------------
// patch_binary
// ---------------------------------------------------------------------------

const patchBinaryTool: AgentTool = {
  name: "patch_binary",
  description: "Patch bytes in a binary file at a given offset. Write to a copy by default. Shows before/after hex context.",
  risk: "write",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    offset: { type: ["number", "string"], description: "Byte offset — number or hex string like '0x401234'." },
    bytes: { type: "string", description: "Replacement bytes as a hex string, e.g. '9090' for two NOPs." },
    outPath: { type: "string", description: "Output path for the patched copy. Defaults to <basename>.patched." },
  }, ["path", "offset", "bytes"]),
  async execute(args, context) {
    validateWriteAllowed(context.policy);
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    const rawOffset = args.offset;
    let offset: number;
    if (typeof rawOffset === "number") {
      offset = rawOffset;
    } else {
      const s = asString(rawOffset).trim();
      offset = s.startsWith("0x") || s.startsWith("0X") ? parseInt(s, 16) : parseInt(s, 10);
    }
    if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
      throw new Error(`Invalid offset: ${args.offset}`);
    }

    const hexBytes = asString(args.bytes).replace(/[\s:-]/g, "");
    if (!/^[0-9a-fA-F]+$/.test(hexBytes) || hexBytes.length % 2 !== 0) {
      throw new Error(`Invalid hex bytes: ${asString(args.bytes)}`);
    }
    const patchBuf = Buffer.from(hexBytes, "hex");
    if (patchBuf.length === 0) throw new Error("Patch bytes are empty.");

    const data = await fs.readFile(target);
    if (offset + patchBuf.length > data.length) {
      throw new Error(`Patch at offset 0x${offset.toString(16)} + ${patchBuf.length} bytes exceeds file size ${data.length}.`);
    }

    const contextBytes = 16;
    const beforeStart = Math.max(0, offset - contextBytes);
    const afterEnd = Math.min(data.length, offset + patchBuf.length + contextBytes);
    const beforeHex = data.subarray(beforeStart, afterEnd).toString("hex");

    patchBuf.copy(data, offset);

    const afterHex = data.subarray(beforeStart, afterEnd).toString("hex");

    const defaultOut = path.join(
      path.dirname(target),
      `${path.basename(target, path.extname(target))}.patched${path.extname(target)}`,
    );
    const outPath = resolveInside(context.workspace, asString(args.outPath, path.relative(context.workspace, defaultOut)));
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, data);

    const out = [
      "PATCH BINARY",
      `source: ${rel}`,
      `output: ${path.relative(context.workspace, outPath)}`,
      `offset: 0x${offset.toString(16)} (${offset})`,
      `patch:  ${hexBytes} (${patchBuf.length} bytes)`,
      "",
      `before (0x${beforeStart.toString(16)}): ${beforeHex}`,
      `after  (0x${beforeStart.toString(16)}): ${afterHex}`,
    ];

    return { content: [textBlock(out.join("\n"))], details: { offset, patchLength: patchBuf.length, outPath: path.relative(context.workspace, outPath) } };
  },
};

// ---------------------------------------------------------------------------
// asm_encode
// ---------------------------------------------------------------------------

const asmEncodeTool: AgentTool = {
  name: "asm_encode",
  description: "Assemble instructions to machine code bytes using rasm2 (radare2) or keystone (Python). Supports x86, arm, mips, etc.",
  risk: "read",
  parameters: objectSchema({
    instruction: { type: "string", description: "Assembly instruction(s), e.g. 'nop', 'mov rax, 0', 'push rbp; mov rbp, rsp'." },
    arch: { type: "string", default: "x86", description: "Architecture: x86, arm, mips, ppc, etc." },
    bits: { type: "number", default: 64, description: "Bitness: 16, 32, or 64." },
  }, ["instruction"]),
  async execute(args, context) {
    const instruction = asString(args.instruction);
    const arch = asString(args.arch, "x86");
    const bits = String(Math.max(16, asNumber(args.bits, 64)));
    const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };

    const rasm2 = await runProcess(
      ["rasm2", "-a", arch, "-b", bits, instruction],
      opts,
    ).catch(() => null);

    if (rasm2 && rasm2.code === 0 && rasm2.stdout.trim()) {
      const hex = rasm2.stdout.trim();
      const formatted = hex.match(/.{1,2}/g)?.join(" ") ?? hex;
      return {
        content: [textBlock(`ASM ENCODE\narch: ${arch}  bits: ${bits}\ninstruction: ${instruction}\nhex: ${hex}\nbytes: ${formatted}\nengine: rasm2`)],
        details: { engine: "rasm2", hex },
      };
    }

    const pyScript = [
      "from keystone import Ks, KS_ARCH_X86, KS_MODE_64, KS_MODE_32, KS_MODE_16, KS_ARCH_ARM, KS_ARCH_MIPS",
      `arch_map = {"x86": KS_ARCH_X86, "arm": KS_ARCH_ARM, "mips": KS_ARCH_MIPS}`,
      `mode_map = {"16": KS_MODE_16, "32": KS_MODE_32, "64": KS_MODE_64}`,
      `ks = Ks(arch_map.get("${arch}", KS_ARCH_X86), mode_map.get("${bits}", KS_MODE_64))`,
      `encoding, count = ks.asm(${JSON.stringify(instruction)})`,
      `print("".join(f"{b:02x}" for b in encoding))`,
    ].join("; ");

    const keystone = await runProcess(
      ["python3", "-c", pyScript],
      opts,
    ).catch(() => null);

    if (keystone && keystone.code === 0 && keystone.stdout.trim()) {
      const hex = keystone.stdout.trim();
      const formatted = hex.match(/.{1,2}/g)?.join(" ") ?? hex;
      return {
        content: [textBlock(`ASM ENCODE\narch: ${arch}  bits: ${bits}\ninstruction: ${instruction}\nhex: ${hex}\nbytes: ${formatted}\nengine: keystone`)],
        details: { engine: "keystone", hex },
      };
    }

    return {
      content: [textBlock(`Neither rasm2 nor keystone is available.\nInstall radare2 for rasm2, or: pip install keystone-engine`)],
      isError: true,
    };
  },
};

// ---------------------------------------------------------------------------
// asm_decode
// ---------------------------------------------------------------------------

const asmDecodeTool: AgentTool = {
  name: "asm_decode",
  description: "Disassemble raw hex bytes to assembly instructions using rasm2 (radare2).",
  risk: "read",
  parameters: objectSchema({
    bytes: { type: "string", description: "Hex string of machine code bytes, e.g. '554889e5'." },
    arch: { type: "string", default: "x86", description: "Architecture: x86, arm, mips, ppc, etc." },
    bits: { type: "number", default: 64, description: "Bitness: 16, 32, or 64." },
  }, ["bytes"]),
  async execute(args, context) {
    const hexBytes = asString(args.bytes).replace(/[\s:-]/g, "");
    if (!/^[0-9a-fA-F]+$/.test(hexBytes) || hexBytes.length % 2 !== 0) {
      throw new Error(`Invalid hex bytes: ${asString(args.bytes)}`);
    }
    const arch = asString(args.arch, "x86");
    const bits = String(Math.max(16, asNumber(args.bits, 64)));
    const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };

    const rasm2 = await runProcess(
      ["rasm2", "-a", arch, "-b", bits, "-d", hexBytes],
      opts,
    ).catch(() => null);

    if (rasm2 && rasm2.code === 0 && rasm2.stdout.trim()) {
      const out = [
        "ASM DECODE",
        `arch: ${arch}  bits: ${bits}`,
        `bytes: ${hexBytes}`,
        "engine: rasm2",
        "",
        rasm2.stdout.trim(),
      ];
      return { content: [textBlock(out.join("\n"))], details: { engine: "rasm2" } };
    }

    const pyScript = [
      "from capstone import Cs, CS_ARCH_X86, CS_MODE_64, CS_MODE_32, CS_MODE_16, CS_ARCH_ARM, CS_ARCH_MIPS",
      `arch_map = {"x86": CS_ARCH_X86, "arm": CS_ARCH_ARM, "mips": CS_ARCH_MIPS}`,
      `mode_map = {"16": CS_MODE_16, "32": CS_MODE_32, "64": CS_MODE_64}`,
      `md = Cs(arch_map.get("${arch}", CS_ARCH_X86), mode_map.get("${bits}", CS_MODE_64))`,
      `code = bytes.fromhex("${hexBytes}")`,
      `[print(f"0x{i.address:x}: {i.mnemonic} {i.op_str}") for i in md.disasm(code, 0)]`,
    ].join("; ");

    const capstone = await runProcess(["python3", "-c", pyScript], opts).catch(() => null);

    if (capstone && capstone.code === 0 && capstone.stdout.trim()) {
      const out = [
        "ASM DECODE",
        `arch: ${arch}  bits: ${bits}`,
        `bytes: ${hexBytes}`,
        "engine: capstone",
        "",
        capstone.stdout.trim(),
      ];
      return { content: [textBlock(out.join("\n"))], details: { engine: "capstone" } };
    }

    return {
      content: [textBlock(`Neither rasm2 nor capstone is available.\nInstall radare2 for rasm2, or: pip install capstone`)],
      isError: true,
    };
  },
};

// ---------------------------------------------------------------------------
// pattern_create — De Bruijn / cyclic pattern generator (pure JS)
// ---------------------------------------------------------------------------

function cyclicPattern(length: number): string {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const buf: string[] = [];
  for (let a = 0; a < upper.length && buf.length < length; a++) {
    for (let b = 0; b < lower.length && buf.length < length; b++) {
      for (let c = 0; c < digits.length && buf.length < length; c++) {
        buf.push(upper[a], lower[b], digits[c]);
      }
    }
  }
  return buf.slice(0, length).join("");
}

const patternCreateTool: AgentTool = {
  name: "pattern_create",
  description: "Generate a De Bruijn cyclic pattern for buffer overflow offset finding. Pure JS, no external tools needed.",
  risk: "read",
  parameters: objectSchema({
    length: { type: "number", description: "Pattern length in bytes (max 20000)." },
  }, ["length"]),
  async execute(args) {
    const length = Math.min(Math.max(1, asNumber(args.length, 200)), 20000);
    const pattern = cyclicPattern(length);
    const out = [
      "CYCLIC PATTERN",
      `length: ${pattern.length}`,
      "",
      pattern,
    ];
    return { content: [textBlock(out.join("\n"))], details: { length: pattern.length } };
  },
};

// ---------------------------------------------------------------------------
// pattern_offset — find subsequence in cyclic pattern (pure JS)
// ---------------------------------------------------------------------------

const patternOffsetTool: AgentTool = {
  name: "pattern_offset",
  description: "Find the offset of a value (from a crash register) in a cyclic pattern. Accepts hex (0x41366141) or ASCII. Pure JS.",
  risk: "read",
  parameters: objectSchema({
    value: { type: "string", description: "Value to search for — hex like '0x41366141' or ASCII string." },
    length: { type: "number", default: 20000, description: "Pattern length to search within." },
  }, ["value"]),
  async execute(args) {
    const rawValue = asString(args.value).trim();
    const length = Math.min(Math.max(1, asNumber(args.length, 20000)), 20000);
    const pattern = cyclicPattern(length);

    const needles: Array<{ label: string; needle: string }> = [];

    if (/^(0x)?[0-9a-fA-F]+$/.test(rawValue)) {
      const hex = rawValue.replace(/^0x/i, "").padStart(rawValue.replace(/^0x/i, "").length % 2 === 0 ? rawValue.replace(/^0x/i, "").length : rawValue.replace(/^0x/i, "").length + 1, "0");
      const bytesLE = Buffer.from(hex, "hex").reverse().toString("ascii");
      const bytesBE = Buffer.from(hex, "hex").toString("ascii");
      needles.push({ label: `hex LE (${hex} → "${bytesLE}")`, needle: bytesLE });
      if (bytesBE !== bytesLE) {
        needles.push({ label: `hex BE (${hex} → "${bytesBE}")`, needle: bytesBE });
      }
    }

    needles.push({ label: `ASCII ("${rawValue}")`, needle: rawValue });

    const results: string[] = [];
    for (const { label, needle } of needles) {
      if (!needle || needle.length === 0) continue;
      const idx = pattern.indexOf(needle);
      if (idx >= 0) {
        results.push(`${label}: offset = ${idx} (0x${idx.toString(16)})`);
      }
    }

    const out = [
      "PATTERN OFFSET",
      `value: ${rawValue}`,
      `pattern length: ${length}`,
      "",
      ...(results.length ? results : ["Not found in pattern."]),
    ];

    return { content: [textBlock(out.join("\n"))], details: { value: rawValue, found: results.length > 0 } };
  },
};
