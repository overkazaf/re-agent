import * as path from "node:path";
import type { AgentTool, ToolContext } from "../types";
import { asNumber, asString, clip, textBlock } from "../utils";
import { resolveInside } from "../utils";
import { validatePathRead } from "../security/policy";
import { runProcess } from "./process";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const R2_NOT_FOUND = "radare2 not found. Install it with: brew install radare2 (macOS) or apt install radare2 (Linux).";

// scr.color=0 removes SGR color codes, but some r2 builds still emit terminal
// control sequences (e.g. ESC[2K erase-line) that would pollute model-facing
// text, break JSON parsing, and make truly-empty output look non-empty.
const stripAnsi = (text: string) =>
  text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

async function r2(
  args: string[],
  target: string,
  context: ToolContext,
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeout = timeoutMs ?? context.policy.commandTimeoutMs;
  const result = await runProcess(
    ["r2", "-q", "-e", "log.level=0", "-e", "scr.color=0", ...args, target],
    { cwd: context.workspace, timeoutMs: timeout, signal: context.signal },
  ).catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found|spawn/.test(msg)) throw new Error(R2_NOT_FOUND);
    throw error;
  });
  const stdout = stripAnsi(result.stdout);
  const stderr = stripAnsi(result.stderr);
  const openFailed = stderr.includes("Cannot open file")
    || stderr.includes("No such file")
    // Some r2 builds exit non-zero and print nothing when the target is missing.
    || (result.code !== 0 && !stdout.trim());
  if (openFailed) {
    throw new Error(`r2: cannot open target file — ${stderr.trim() || `exit code ${result.code}`}`);
  }
  return { code: result.code, stdout, stderr };
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function createR2Tools(): AgentTool[] {
  return [
    r2FunctionsTool,
    r2DisassembleTool,
    r2DecompileTool,
    r2XrefsTool,
    r2ImportsTool,
    r2StringsIndexedTool,
    r2InfoTool,
  ];
}

// ---------------------------------------------------------------------------
// r2_functions — list functions
// ---------------------------------------------------------------------------

const r2FunctionsTool: AgentTool = {
  name: "r2_functions",
  description: "List functions in a binary using radare2. Returns address, size, and name for each function. Use filter to narrow by name substring.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    filter: { type: "string", description: "Optional substring to filter function names." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    const result = await r2(["-c", "aaa;aflj"], target, context);
    const parsed = tryParseJson(result.stdout);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { content: [textBlock(`R2 FUNCTIONS\npath: ${rel}\n\nNo functions found (r2 aaa;aflj returned no results).`)] };
    }

    const filter = asString(args.filter).toLowerCase();
    let functions = parsed as Array<Record<string, unknown>>;
    if (filter) {
      functions = functions.filter((f) => {
        const name = asString(f.name as unknown).toLowerCase();
        return name.includes(filter);
      });
    }

    const lines = functions.map((f) => {
      const addr = typeof f.offset === "number" ? `0x${f.offset.toString(16).padStart(8, "0")}` : String(f.offset ?? "?");
      const size = typeof f.size === "number" ? String(f.size) : "?";
      const name = asString(f.name as unknown, "(unnamed)");
      return `${addr}  ${size.padStart(6)}  ${name}`;
    });

    const header = [
      "R2 FUNCTIONS",
      `path: ${rel}`,
      `total: ${(parsed as unknown[]).length}${filter ? `, filtered: ${functions.length} (filter: "${filter}")` : ""}`,
      "",
      "address     size  name",
      "─".repeat(60),
    ];

    const output = [...header, ...lines].join("\n");
    const spilled = await spillIfLarge(output, { context, label: `r2-functions-${path.basename(target)}` });
    return { content: [textBlock(spilled.text)], details: { total: (parsed as unknown[]).length, shown: functions.length, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// r2_disassemble — disassemble a function or N bytes at address
// ---------------------------------------------------------------------------

const r2DisassembleTool: AgentTool = {
  name: "r2_disassemble",
  description: "Disassemble a function by name or address using radare2. Optionally disassemble N raw bytes at an address instead of a full function.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    function: { type: "string", description: "Function name (e.g. main, sym.check) or address (e.g. 0x401000)." },
    bytes: { type: "number", description: "If set, disassemble this many bytes at the address with pD instead of pdf." },
  }, ["path", "function"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const func = asString(args.function);
    const bytes = args.bytes !== undefined ? asNumber(args.bytes, 0) : 0;

    const disasmCmd = bytes > 0 ? `pD ${bytes}` : "pdf";
    // Address with @ instead of `s`: a failed `s <name>` silently keeps the old
    // seek and the command then reports on the wrong function; a failed @ seek
    // produces no output, which the not-found branch below catches.
    const result = await r2(["-c", `aaa;${disasmCmd} @ ${func}`], target, context);
    const output = (result.stdout || result.stderr).trim();

    if (!output || /Cannot find function|Invalid address/i.test(output)) {
      return {
        content: [textBlock(`R2 DISASSEMBLE\npath: ${rel}\ntarget: ${func}\n\nFunction/address not found. Use r2_functions to list available functions.`)],
        isError: true,
      };
    }

    const header = [
      "R2 DISASSEMBLE",
      `path: ${rel}`,
      `target: ${func}`,
      `mode: ${bytes > 0 ? `pD ${bytes} bytes` : "pdf (full function)"}`,
      "",
    ];

    const full = [...header, output].join("\n");
    const spilled = await spillIfLarge(full, { context, label: `r2-disasm-${func}` });
    return { content: [textBlock(spilled.text)], details: { function: func, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// r2_decompile — decompile with r2ghidra (pdg), fallback to r2dec (pdd)
// ---------------------------------------------------------------------------

const r2DecompileTool: AgentTool = {
  name: "r2_decompile",
  description: "Decompile a function using radare2 with r2ghidra (pdg). Falls back to r2dec (pdd) if r2ghidra is not installed.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    function: { type: "string", description: "Function name or address to decompile." },
  }, ["path", "function"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const func = asString(args.function);

    const ghidra = await r2(["-c", `aaa;pdg @ ${func}`], target, context).catch(() => undefined);
    const ghidraOut = ghidra?.stdout.trim() ?? "";
    const ghidraOk = ghidraOut.length > 20 && !/Unknown command|Cannot find|plugin/.test(ghidraOut);

    let decompiled: string;
    let engine: string;

    if (ghidraOk) {
      decompiled = ghidraOut;
      engine = "r2ghidra (pdg)";
    } else {
      const dec = await r2(["-c", `aaa;pdd @ ${func}`], target, context).catch(() => undefined);
      const decOut = dec?.stdout.trim() ?? "";
      const decOk = decOut.length > 20 && !/Unknown command|Cannot find|plugin/.test(decOut);
      if (decOk) {
        decompiled = decOut;
        engine = "r2dec (pdd)";
      } else {
        return {
          content: [textBlock([
            "R2 DECOMPILE",
            `path: ${rel}`,
            `target: ${func}`,
            "",
            "Decompilation failed. Neither r2ghidra (pdg) nor r2dec (pdd) produced output.",
            "Install a decompiler plugin: r2pm -ci r2ghidra  or  r2pm -ci r2dec",
            ghidraOut ? `\nr2ghidra output: ${ghidraOut}` : "",
            decOut ? `\nr2dec output: ${decOut}` : "",
          ].filter(Boolean).join("\n"))],
          isError: true,
        };
      }
    }

    const header = [
      "R2 DECOMPILE",
      `path: ${rel}`,
      `target: ${func}`,
      `engine: ${engine}`,
      "",
    ];

    const full = [...header, decompiled].join("\n");
    const spilled = await spillIfLarge(full, { context, label: `r2-decompile-${func}` });
    return { content: [textBlock(spilled.text)], details: { function: func, engine, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// r2_xrefs — cross-references to a target
// ---------------------------------------------------------------------------

const r2XrefsTool: AgentTool = {
  name: "r2_xrefs",
  description: "Find cross-references to a function or address using radare2. Shows where the target is called/referenced from.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    target: { type: "string", description: "Function name or address to find references to." },
  }, ["path", "target"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const xrefTarget = asString(args.target);

    const result = await r2(["-c", `aaa;axtj @ ${xrefTarget}`], target, context);
    const parsed = tryParseJson(result.stdout);

    const header = [
      "R2 XREFS",
      `path: ${rel}`,
      `target: ${xrefTarget}`,
    ];

    if (!Array.isArray(parsed) || parsed.length === 0) {
      const fallback = result.stdout.trim();
      if (fallback && !fallback.startsWith("[")) {
        const full = [...header, "", fallback].join("\n");
        return { content: [textBlock(full)], details: { count: 0 } };
      }
      return { content: [textBlock([...header, "", "No cross-references found."].join("\n"))], details: { count: 0 } };
    }

    const xrefs = parsed as Array<Record<string, unknown>>;
    const lines = xrefs.map((x) => {
      const from = typeof x.from === "number" ? `0x${x.from.toString(16).padStart(8, "0")}` : String(x.from ?? "?");
      const type = asString(x.type as unknown, "?");
      const opcode = asString(x.opcode as unknown, "");
      const fcnName = asString((x.fcn_name ?? x.name) as unknown, "");
      return `${from}  ${type.padEnd(5)}  ${fcnName.padEnd(30)}  ${opcode}`;
    });

    const full = [
      ...header,
      `refs: ${xrefs.length}`,
      "",
      "from        type   function                        opcode",
      "─".repeat(80),
      ...lines,
    ].join("\n");

    const spilled = await spillIfLarge(full, { context, label: `r2-xrefs-${xrefTarget}` });
    return { content: [textBlock(spilled.text)], details: { count: xrefs.length, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// r2_imports — list imports
// ---------------------------------------------------------------------------

const r2ImportsTool: AgentTool = {
  name: "r2_imports",
  description: "List binary imports using radare2. Use filter to narrow by name substring.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    filter: { type: "string", description: "Optional substring to filter import names." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    const result = await r2(["-c", "aaa;iij"], target, context);
    const parsed = tryParseJson(result.stdout);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { content: [textBlock(`R2 IMPORTS\npath: ${rel}\n\nNo imports found.`)] };
    }

    const filter = asString(args.filter).toLowerCase();
    let imports = parsed as Array<Record<string, unknown>>;
    if (filter) {
      imports = imports.filter((i) => {
        const name = asString(i.name as unknown).toLowerCase();
        return name.includes(filter);
      });
    }

    const lines = imports.map((i) => {
      const plt = typeof i.plt === "number" ? `0x${i.plt.toString(16).padStart(8, "0")}` : (typeof i.addr === "number" ? `0x${i.addr.toString(16).padStart(8, "0")}` : "?");
      const ordinal = typeof i.ordinal === "number" ? String(i.ordinal).padStart(4) : "   ?";
      const name = asString(i.name as unknown, "(unnamed)");
      const lib = asString(i.libname as unknown, "");
      return `${plt}  ${ordinal}  ${name}${lib ? `  (${lib})` : ""}`;
    });

    const header = [
      "R2 IMPORTS",
      `path: ${rel}`,
      `total: ${(parsed as unknown[]).length}${filter ? `, filtered: ${imports.length} (filter: "${filter}")` : ""}`,
      "",
      "address      ord  name",
      "─".repeat(60),
    ];

    const full = [...header, ...lines].join("\n");
    const spilled = await spillIfLarge(full, { context, label: `r2-imports-${path.basename(target)}` });
    return { content: [textBlock(spilled.text)], details: { total: (parsed as unknown[]).length, shown: imports.length, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// r2_strings_indexed — strings with address/section info
// ---------------------------------------------------------------------------

const r2StringsIndexedTool: AgentTool = {
  name: "r2_strings_indexed",
  description: "Extract strings from a binary using radare2 with address, section, size, and type info. Richer than the basic strings tool — includes virtual address and section placement.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
    minLength: { type: "number", default: 5, description: "Minimum string length." },
    filter: { type: "string", description: "Optional substring to filter strings." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);
    const minLength = Math.max(2, asNumber(args.minLength, 5));

    const result = await r2(["-c", `aaa;izj`], target, context);
    const parsed = tryParseJson(result.stdout);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { content: [textBlock(`R2 STRINGS\npath: ${rel}\n\nNo strings found by r2 izj.`)] };
    }

    const filter = asString(args.filter).toLowerCase();
    let strings = (parsed as Array<Record<string, unknown>>).filter((s) => {
      const str = asString(s.string as unknown);
      return str.length >= minLength;
    });
    if (filter) {
      strings = strings.filter((s) => {
        const str = asString(s.string as unknown).toLowerCase();
        return str.includes(filter);
      });
    }

    const lines = strings.map((s) => {
      const vaddr = typeof s.vaddr === "number" ? `0x${s.vaddr.toString(16).padStart(8, "0")}` : "?";
      const section = asString(s.section as unknown, "?");
      const length = typeof s.length === "number" ? String(s.length).padStart(4) : "   ?";
      const type = asString(s.type as unknown, "?");
      const str = asString(s.string as unknown, "").slice(0, 120);
      return `${vaddr}  ${section.padEnd(16)}  ${length}  ${type.padEnd(5)}  ${str}`;
    });

    const header = [
      "R2 STRINGS",
      `path: ${rel}`,
      `total: ${(parsed as unknown[]).length}, shown: ${strings.length} (minLength=${minLength}${filter ? `, filter="${filter}"` : ""})`,
      "",
      "address     section           len  type   string",
      "─".repeat(90),
    ];

    const full = [...header, ...lines].join("\n");
    const spilled = await spillIfLarge(full, { context, label: `r2-strings-${path.basename(target)}` });
    return { content: [textBlock(spilled.text)], details: { total: (parsed as unknown[]).length, shown: strings.length, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// r2_info — binary metadata
// ---------------------------------------------------------------------------

const r2InfoTool: AgentTool = {
  name: "r2_info",
  description: "Show binary metadata using radare2: architecture, bits, endianness, OS, format, security features (canary, NX, PIC), compiler, and more.",
  risk: "read",
  parameters: objectSchema({
    path: { type: "string", description: "Workspace-relative binary path." },
  }, ["path"]),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    const result = await r2(["-c", "iIj"], target, context);
    const parsed = tryParseJson(result.stdout);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const fallback = (result.stdout || result.stderr).trim();
      return { content: [textBlock(`R2 INFO\npath: ${rel}\n\n${fallback || "No info returned by r2 iIj."}`)] };
    }

    const info = parsed as Record<string, unknown>;
    const fields: Array<[string, unknown]> = [
      ["format", info.bintype ?? info.type],
      ["arch", info.arch],
      ["bits", info.bits],
      ["endian", info.endian],
      ["os", info.os],
      ["machine", info.machine],
      ["class", info.class],
      ["language", info.lang],
      ["compiler", info.compiler],
      ["stripped", info.stripped],
      ["static", info.static],
      ["canary", info.canary],
      ["NX", info.nx],
      ["PIC", info.pic],
      ["relocs", info.relocs],
      ["crypto", info.crypto],
      // Key names differ across r2 versions: modern builds emit "sanitize"/"subsys".
      ["sanitize", info.sanitize ?? info.sanitiz],
      ["subsystem", info.subsys_name ?? info.subsystem ?? info.subsys],
      ["intrp", info.intrp],
      ["dbg_file", info.dbg_file],
    ];

    const lines = fields
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k.padEnd(14)} ${String(v)}`);

    const full = [
      "R2 INFO",
      `path: ${rel}`,
      "",
      ...lines,
    ].join("\n");

    return { content: [textBlock(full)], details: info };
  },
};
