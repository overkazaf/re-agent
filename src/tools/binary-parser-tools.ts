import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, ToolContext } from "../types";
import { asNumber, asString, clip, resolveInside, textBlock } from "../utils";
import { validatePathRead } from "../security/policy";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

import { runProcess } from "./process";
import { fileURLToPath } from "node:url";

export function createBinaryParserTools(): AgentTool[] {
  return [
    elfParseTool,
    peParseTool,
    machoParseTool,
    binarySectionsTool,
  ];
}

// ===========================================================================
// Rust backend bridge — calls `oxaf-parse` for fast, robust parsing.
// Falls back to the JS parser below when the Rust binary is unavailable.
// ===========================================================================

function oxafParseBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "bin", "oxaf-parse");
}

async function rustParse(
  subcommand: string,
  target: string,
  context: ToolContext,
  extraArgs: string[] = [],
): Promise<Record<string, unknown> | null> {
  const bin = oxafParseBin();
  try {
    await fs.access(bin);
  } catch {
    return null; // Rust binary not built — fall through to JS
  }
  try {
    const result = await runProcess(
      [bin, subcommand, ...extraArgs, target],
      { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal },
    );
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !parsed.error) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/** Format JSON from the Rust backend into the structured text the agent consumes. */
function formatRustElfOutput(json: Record<string, unknown>): string {
  const lines: string[] = [
    "ELF DEEP PARSE (rust/goblin)",
    `path: ${json.path}`,
    `size: ${json.size} bytes`,
    `sha256: ${json.sha256}`,
    `class: ${json.class}`,
    `encoding: ${json.encoding}`,
    `type: ${json.type}`,
    `machine: ${json.machine}`,
    `entry: ${json.entry}`,
    `stripped: ${json.is_stripped}`,
  ];

  // Security
  const sec = json.security as Record<string, unknown> | undefined;
  if (sec) {
    lines.push("", "security:");
    for (const [k, v] of Object.entries(sec)) lines.push(`  ${k}: ${v}`);
  }

  // Libraries
  const libs = json.libraries as string[] | undefined;
  if (libs?.length) {
    lines.push("", `linked libraries (${libs.length}):`);
    for (const lib of libs) lines.push(`  ${lib}`);
  }

  // Program headers
  const phdrs = json.program_headers as Array<Record<string, string>> | undefined;
  if (phdrs?.length) {
    lines.push("", `program headers (${phdrs.length}):`);
    for (const ph of phdrs) {
      lines.push(`  ${(ph.type ?? "").padEnd(16)} ${ph.offset}  ${ph.vaddr}  ${ph.flags.padEnd(3)}  ${ph.filesz}`);
    }
  }

  // Section headers
  const shdrs = json.section_headers as Array<Record<string, unknown>> | undefined;
  if (shdrs?.length) {
    lines.push("", `section headers (${shdrs.length}):`);
    for (const sh of shdrs) {
      const name = String(sh.name || "").padEnd(24);
      const type = String(sh.type || "").padEnd(12);
      lines.push(`  ${name} ${type} ${sh.addr}  ${sh.size}  ${sh.flags}  ent=${(sh.entropy as number)?.toFixed(2) ?? "?"}`);
    }
  }

  // Dynamic
  const dyn_entries = json.dynamic as Array<Record<string, string>> | undefined;
  if (dyn_entries?.length) {
    lines.push("", `dynamic section (${dyn_entries.length}):`);
    for (const d of dyn_entries.slice(0, 40)) {
      lines.push(`  ${(d.tag ?? "").padEnd(16)} ${d.value}`);
    }
  }

  // Dynsyms
  const dynsyms = json.dynsyms as Array<Record<string, unknown>> | undefined;
  if (dynsyms?.length) {
    lines.push("", `symbol table (.dynsym, ${json.dynsyms_total ?? dynsyms.length} entries):`);
    for (const sym of dynsyms.slice(0, 60)) {
      lines.push(`  ${sym.value}  ${String(sym.type).padEnd(8)} ${String(sym.bind).padEnd(8)} ${sym.name}`);
    }
  }

  // Relocations
  const relocs = json.relocations as Array<Record<string, unknown>> | undefined;
  if (relocs?.length) {
    lines.push("", `relocations (${json.relocations_total ?? relocs.length} entries):`);
    for (const r of relocs.slice(0, 40)) {
      lines.push(`  ${r.offset}  ${String(r.type).padEnd(26)} ${r.sym}`);
    }
  }

  return lines.join("\n");
}

function formatRustPeOutput(json: Record<string, unknown>): string {
  const lines: string[] = [
    "PE DEEP PARSE (rust/goblin)",
    `path: ${json.path}`,
    `size: ${json.size} bytes`,
    `sha256: ${json.sha256}`,
    `class: ${json.class}`,
    `machine: ${json.machine}`,
    `entry: ${json.entry}`,
    `image_base: ${json.image_base}`,
    `subsystem: ${json.subsystem}`,
    `is_dll: ${json.is_dll}`,
  ];

  const sec = json.security as Record<string, unknown> | undefined;
  if (sec) {
    lines.push("", "security:");
    for (const [k, v] of Object.entries(sec)) lines.push(`  ${k}: ${v}`);
  }

  const sections = json.sections as Array<Record<string, unknown>> | undefined;
  if (sections?.length) {
    lines.push("", `sections (${sections.length}):`);
    for (const s of sections) {
      const chars = Array.isArray(s.characteristics) ? (s.characteristics as string[]).join(",") : "";
      lines.push(`  ${String(s.name).padEnd(12)} vsize=${s.virtual_size}  raw=${s.raw_size}  ${chars}  ent=${(s.entropy as number)?.toFixed(2) ?? "?"}`);
    }
  }

  const dlls = json.import_dlls as Array<Record<string, unknown>> | undefined;
  if (dlls?.length) {
    lines.push("", `imports (${json.imports_total} total, ${dlls.length} DLLs):`);
    for (const d of dlls) {
      const names = (d.names as string[] | undefined)?.slice(0, 10)?.join(", ") ?? "";
      lines.push(`  ${String(d.dll).padEnd(24)} ${d.functions} functions: ${names}`);
    }
  }

  const exports = json.exports as Array<Record<string, unknown>> | undefined;
  if (exports?.length) {
    lines.push("", `exports (${json.exports_total}):`);
    for (const e of exports.slice(0, 40)) {
      lines.push(`  ${e.offset}  ${e.name}`);
    }
  }

  return lines.join("\n");
}

function formatRustMachoOutput(json: Record<string, unknown>): string {
  // Handle fat binaries
  if (json.architectures) {
    const arches = json.architectures as Array<Record<string, unknown>>;
    const parts = [`MACH-O FAT BINARY (rust/goblin)\npath: ${json.path}\nsize: ${json.size}\narchitectures: ${arches.length}\n`];
    for (const arch of arches) parts.push(formatSingleMacho(arch));
    return parts.join("\n---\n");
  }
  return formatSingleMacho(json);
}

function formatSingleMacho(json: Record<string, unknown>): string {
  const lines: string[] = [
    "MACH-O DEEP PARSE (rust/goblin)",
    `path: ${json.path ?? ""}`,
    `class: ${json.class}`,
    `cputype: ${json.cputype}`,
    `filetype: ${json.filetype}`,
    `entry: ${json.entry ?? "none"}`,
    `uuid: ${json.uuid || "none"}`,
    `ncmds: ${json.ncmds}`,
  ];

  const sec = json.security as Record<string, unknown> | undefined;
  if (sec) {
    lines.push("", "security:");
    for (const [k, v] of Object.entries(sec)) lines.push(`  ${k}: ${v}`);
  }

  const segs = json.segments as Array<Record<string, unknown>> | undefined;
  if (segs?.length) {
    lines.push("", `segments (${segs.length}):`);
    for (const seg of segs) {
      lines.push(`  ${String(seg.name).padEnd(16)} ${seg.vmaddr}  ${seg.vmsize}  ${seg.initprot}  ent=${(seg.entropy as number)?.toFixed(2) ?? "?"}`);
      const sects = seg.sections as Array<Record<string, unknown>> | undefined;
      if (sects?.length) {
        for (const s of sects) {
          lines.push(`    ${String(s.name).padEnd(24)} ${s.addr}  ${s.size}  ent=${(s.entropy as number)?.toFixed(2) ?? "?"}`);
        }
      }
    }
  }

  const dylibs = json.dylibs as Array<Record<string, unknown>> | undefined;
  if (dylibs?.length) {
    lines.push("", `linked dylibs (${dylibs.length}):`);
    for (const d of dylibs) lines.push(`  ${d.name}`);
  }

  return lines.join("\n");
}

function formatRustSectionsOutput(json: Record<string, unknown>): string {
  const fmt = json.format ?? "?";
  const lines: string[] = [
    `SECTIONS OVERVIEW (rust/goblin)`,
    `format: ${fmt}`,
    `path: ${json.path}`,
    `machine: ${json.machine ?? ""}`,
    "",
  ];
  const sections = json.sections as Array<Record<string, unknown>> | undefined;
  if (sections?.length) {
    lines.push(`${"name".padEnd(24)} ${"type".padEnd(12)} ${"size".padStart(10)} ${"entropy".padStart(8)}`);
    lines.push("─".repeat(60));
    for (const s of sections) {
      const name = String(s.name || "").padEnd(24);
      const type = String(s.type || "").padEnd(12);
      const size = String(s.size ?? "").padStart(10);
      const ent = typeof s.entropy === "number" ? s.entropy.toFixed(3).padStart(8) : "?".padStart(8);
      lines.push(`${name} ${type} ${size} ${ent}`);
    }
  } else {
    lines.push("(no sections)");
  }
  return lines.join("\n");
}

// ===========================================================================
// Shared helpers (JS fallback)
// ===========================================================================

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

function hex(value: number, width: number): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

function hex64(lo: number, hi: number): string {
  // Combine two uint32 into a hex string (up to 48-bit safe range)
  if (hi === 0) return hex(lo, 8);
  const combined = hi * 0x100000000 + lo;
  return `0x${combined.toString(16).padStart(16, "0")}`;
}

function readU16(buf: Buffer, off: number, le: boolean): number {
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}

function readU32(buf: Buffer, off: number, le: boolean): number {
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

function readI32(buf: Buffer, off: number, le: boolean): number {
  return le ? buf.readInt32LE(off) : buf.readInt32BE(off);
}

/** Read a 64-bit value as {lo, hi} pair of uint32 (JS doesn't have u64). */
function readU64Parts(buf: Buffer, off: number, le: boolean): { lo: number; hi: number } {
  if (le) return { lo: buf.readUInt32LE(off), hi: buf.readUInt32LE(off + 4) };
  return { hi: buf.readUInt32BE(off), lo: buf.readUInt32BE(off + 4) };
}

function u64Hex(buf: Buffer, off: number, le: boolean): string {
  const { lo, hi } = readU64Parts(buf, off, le);
  return hex64(lo, hi);
}

function u64Num(buf: Buffer, off: number, le: boolean): number {
  const { lo, hi } = readU64Parts(buf, off, le);
  return hi * 0x100000000 + lo;
}

function readCString(buf: Buffer, off: number, maxLen = 256): string {
  if (off < 0 || off >= buf.length) return "";
  const end = Math.min(buf.length, off + maxLen);
  let i = off;
  while (i < end && buf[i] !== 0) i++;
  return buf.subarray(off, i).toString("utf8");
}

function readFixedString(buf: Buffer, off: number, len: number): string {
  if (off < 0 || off + len > buf.length) return "";
  const slice = buf.subarray(off, off + len);
  const zero = slice.indexOf(0);
  return (zero >= 0 ? slice.subarray(0, zero) : slice).toString("utf8");
}

function safeSub(buf: Buffer, off: number, len: number): Buffer | undefined {
  if (off < 0 || off + len > buf.length) return undefined;
  return buf.subarray(off, off + len);
}

// ===========================================================================
// ELF constants and maps
// ===========================================================================

const ELF_TYPES: Record<number, string> = {
  0: "NONE", 1: "REL (Relocatable)", 2: "EXEC (Executable)",
  3: "DYN (Position-Independent Executable)", 4: "CORE",
};

const ELF_MACHINES: Record<number, string> = {
  0: "None", 2: "SPARC", 3: "Intel 80386", 6: "Intel 80486",
  8: "MIPS", 20: "PowerPC", 21: "PowerPC64", 22: "S390",
  40: "ARM", 43: "SPARC V9", 50: "IA-64", 62: "AMD x86-64",
  183: "AArch64", 243: "RISC-V", 247: "eBPF",
};

const PT_TYPES: Record<number, string> = {
  0: "NULL", 1: "LOAD", 2: "DYNAMIC", 3: "INTERP", 4: "NOTE",
  5: "SHLIB", 6: "PHDR", 7: "TLS",
  0x6474e550: "GNU_EH_FRAME", 0x6474e551: "GNU_STACK",
  0x6474e552: "GNU_RELRO", 0x6474e553: "GNU_PROPERTY",
};

const SHT_TYPES: Record<number, string> = {
  0: "NULL", 1: "PROGBITS", 2: "SYMTAB", 3: "STRTAB", 4: "RELA",
  5: "HASH", 6: "DYNAMIC", 7: "NOTE", 8: "NOBITS", 9: "REL",
  10: "SHLIB", 11: "DYNSYM", 14: "INIT_ARRAY", 15: "FINI_ARRAY",
  16: "PREINIT_ARRAY", 17: "GROUP", 18: "SYMTAB_SHNDX",
  0x6ffffff6: "GNU_HASH", 0x6ffffffd: "VERDEF",
  0x6ffffffe: "VERNEED", 0x6fffffff: "VERSYM",
};

const STT_TYPES: Record<number, string> = {
  0: "NOTYPE", 1: "OBJECT", 2: "FUNC", 3: "SECTION", 4: "FILE",
  5: "COMMON", 6: "TLS", 10: "GNU_IFUNC",
};

const STB_TYPES: Record<number, string> = {
  0: "LOCAL", 1: "GLOBAL", 2: "WEAK", 10: "GNU_UNIQUE",
};

const STV_TYPES: Record<number, string> = {
  0: "DEFAULT", 1: "INTERNAL", 2: "HIDDEN", 3: "PROTECTED",
};

const DT_NAMES: Record<number, string> = {
  0: "NULL", 1: "NEEDED", 2: "PLTRELSZ", 3: "PLTGOT", 4: "HASH",
  5: "STRTAB", 6: "SYMTAB", 7: "RELA", 8: "RELASZ", 9: "RELAENT",
  10: "STRSZ", 11: "SYMENT", 12: "INIT", 13: "FINI",
  14: "SONAME", 15: "RPATH", 16: "SYMBOLIC", 17: "REL",
  18: "RELSZ", 19: "RELENT", 20: "PLTREL", 21: "DEBUG",
  22: "TEXTREL", 23: "JMPREL", 24: "BIND_NOW", 25: "INIT_ARRAY",
  26: "FINI_ARRAY", 27: "INIT_ARRAYSZ", 28: "FINI_ARRAYSZ",
  29: "RUNPATH", 30: "FLAGS",
  0x6ffffef5: "GNU_HASH", 0x6ffffff0: "VERSYM",
  0x6ffffffb: "FLAGS_1", 0x6ffffffe: "VERNEED",
  0x6fffffff: "VERNEEDNUM",
};

const R_X86_64_TYPES: Record<number, string> = {
  0: "R_X86_64_NONE", 1: "R_X86_64_64", 2: "R_X86_64_PC32",
  5: "R_X86_64_COPY", 6: "R_X86_64_GLOB_DAT", 7: "R_X86_64_JUMP_SLOT",
  8: "R_X86_64_RELATIVE", 10: "R_X86_64_32", 11: "R_X86_64_32S",
  37: "R_X86_64_IRELATIVE",
};

const R_AARCH64_TYPES: Record<number, string> = {
  0: "R_AARCH64_NONE", 257: "R_AARCH64_ABS64",
  1024: "R_AARCH64_COPY", 1025: "R_AARCH64_GLOB_DAT",
  1026: "R_AARCH64_JUMP_SLOT", 1027: "R_AARCH64_RELATIVE",
  1028: "R_AARCH64_TLS_DTPMOD", 1029: "R_AARCH64_TLS_DTPREL",
  1030: "R_AARCH64_TLS_TPREL", 1031: "R_AARCH64_TLSDESC",
  1032: "R_AARCH64_IRELATIVE",
};

function elfRelocType(machine: number, type: number): string {
  if (machine === 62) return R_X86_64_TYPES[type] ?? `R_X86_64_${type}`;
  if (machine === 183) return R_AARCH64_TYPES[type] ?? `R_AARCH64_${type}`;
  return `RELOC_${type}`;
}

function elfPhdrFlags(flags: number): string {
  let s = "";
  if (flags & 4) s += "R";
  if (flags & 2) s += "W";
  if (flags & 1) s += "E";
  return s || "-";
}

function elfShdrFlags(flags: number): string {
  let s = "";
  if (flags & 2) s += "A";   // SHF_ALLOC
  if (flags & 1) s += "W";   // SHF_WRITE
  if (flags & 4) s += "X";   // SHF_EXECINSTR
  if (flags & 0x40) s += "M"; // SHF_MERGE
  if (flags & 0x20) s += "S"; // SHF_STRINGS
  if (flags & 0x200) s += "T"; // SHF_TLS
  return s || "-";
}

// ===========================================================================
// ELF parser
// ===========================================================================

interface ElfParsed {
  bits: 32 | 64;
  le: boolean;
  type: string;
  machine: string;
  machineNum: number;
  entry: string;
  phdrCount: number;
  shdrCount: number;
  phdrs: string[];
  shdrs: string[];
  dynamics: string[];
  symbols: string[];
  relocations: string[];
  interp: string;
}

function parseElf(data: Buffer): ElfParsed | string {
  if (data.length < 64) return "File too small for ELF header.";
  if (data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) {
    return "Not an ELF file (bad magic).";
  }

  const elfClass = data[4]; // 1 = 32-bit, 2 = 64-bit
  const bits: 32 | 64 = elfClass === 2 ? 64 : 32;
  const le = data[5] === 1;

  const e_type = readU16(data, 16, le);
  const e_machine = readU16(data, 18, le);

  let e_entry: string;
  let e_phoff: number;
  let e_shoff: number;
  let e_phentsize: number;
  let e_phnum: number;
  let e_shentsize: number;
  let e_shnum: number;
  let e_shstrndx: number;

  if (bits === 64) {
    if (data.length < 64) return "Truncated ELF64 header.";
    e_entry = u64Hex(data, 24, le);
    e_phoff = u64Num(data, 32, le);
    e_shoff = u64Num(data, 40, le);
    e_phentsize = readU16(data, 54, le);
    e_phnum = readU16(data, 56, le);
    e_shentsize = readU16(data, 58, le);
    e_shnum = readU16(data, 60, le);
    e_shstrndx = readU16(data, 62, le);
  } else {
    if (data.length < 52) return "Truncated ELF32 header.";
    e_entry = hex(readU32(data, 24, le), 8);
    e_phoff = readU32(data, 28, le);
    e_shoff = readU32(data, 32, le);
    e_phentsize = readU16(data, 42, le);
    e_phnum = readU16(data, 44, le);
    e_shentsize = readU16(data, 46, le);
    e_shnum = readU16(data, 48, le);
    e_shstrndx = readU16(data, 50, le);
  }

  // --- Section header string table ---
  let shstrtab: Buffer | undefined;
  if (e_shstrndx < e_shnum && e_shoff > 0) {
    const shstrOff = e_shoff + e_shstrndx * e_shentsize;
    if (bits === 64 && shstrOff + 64 <= data.length) {
      const off = u64Num(data, shstrOff + 24, le);
      const sz = u64Num(data, shstrOff + 32, le);
      shstrtab = safeSub(data, off, Math.min(sz, 0x100000));
    } else if (bits === 32 && shstrOff + 40 <= data.length) {
      const off = readU32(data, shstrOff + 16, le);
      const sz = readU32(data, shstrOff + 20, le);
      shstrtab = safeSub(data, off, Math.min(sz, 0x100000));
    }
  }

  const secName = (nameIdx: number): string => {
    if (!shstrtab || nameIdx < 0 || nameIdx >= shstrtab.length) return `<${nameIdx}>`;
    return readCString(shstrtab, nameIdx, 128);
  };

  // --- Program headers ---
  const phdrs: string[] = [];
  let interp = "";
  for (let i = 0; i < e_phnum; i++) {
    const off = e_phoff + i * e_phentsize;
    if (off + e_phentsize > data.length) break;
    if (bits === 64) {
      if (e_phentsize < 56) break; // entry too small to hold a Phdr64
      const p_type = readU32(data, off, le);
      const p_flags = readU32(data, off + 4, le);
      const p_offset = u64Hex(data, off + 8, le);
      const p_vaddr = u64Hex(data, off + 16, le);
      const p_filesz = u64Hex(data, off + 32, le);
      const typeName = PT_TYPES[p_type] ?? hex(p_type, 8);
      const flags = elfPhdrFlags(p_flags);
      let extra = "";
      if (p_type === 3 /* PT_INTERP */) {
        const interpOff = u64Num(data, off + 8, le);
        const interpSz = u64Num(data, off + 32, le);
        interp = readCString(data, interpOff, Math.min(interpSz, 256));
        extra = `  ${interp}`;
      }
      phdrs.push(`  ${typeName.padEnd(16)} ${p_offset}  ${p_vaddr}  ${flags.padEnd(4)}  ${p_filesz}${extra}`);
    } else {
      if (e_phentsize < 32) break; // entry too small to hold a Phdr32
      const p_type = readU32(data, off, le);
      const p_offset = hex(readU32(data, off + 4, le), 8);
      const p_vaddr = hex(readU32(data, off + 8, le), 8);
      const p_filesz = hex(readU32(data, off + 16, le), 8);
      const p_flags = readU32(data, off + 24, le);
      const typeName = PT_TYPES[p_type] ?? hex(p_type, 8);
      const flags = elfPhdrFlags(p_flags);
      let extra = "";
      if (p_type === 3) {
        const interpOff = readU32(data, off + 4, le);
        const interpSz = readU32(data, off + 16, le);
        interp = readCString(data, interpOff, Math.min(interpSz, 256));
        extra = `  ${interp}`;
      }
      phdrs.push(`  ${typeName.padEnd(16)} ${p_offset}  ${p_vaddr}  ${flags.padEnd(4)}  ${p_filesz}${extra}`);
    }
  }

  // --- Section headers ---
  interface SecInfo {
    name: string;
    type: number;
    flags: number;
    addr: string;
    offset: number;
    size: number;
    link: number;
    entsize: number;
  }
  const sections: SecInfo[] = [];
  const shdrs: string[] = [];

  for (let i = 0; i < e_shnum; i++) {
    const off = e_shoff + i * e_shentsize;
    if (off + e_shentsize > data.length) break;
    if (bits === 64 && e_shentsize >= 64) {
      const sh_name = readU32(data, off, le);
      const sh_type = readU32(data, off + 4, le);
      const sh_flags = u64Num(data, off + 8, le);
      const sh_addr = u64Hex(data, off + 16, le);
      const sh_offset = u64Num(data, off + 24, le);
      const sh_size = u64Num(data, off + 32, le);
      const sh_link = readU32(data, off + 40, le);
      const sh_entsize = u64Num(data, off + 56, le);
      const name = secName(sh_name);
      const typeName = SHT_TYPES[sh_type] ?? hex(sh_type, 8);
      const flags = elfShdrFlags(sh_flags);
      sections.push({ name, type: sh_type, flags: sh_flags, addr: sh_addr, offset: sh_offset, size: sh_size, link: sh_link, entsize: sh_entsize });
      shdrs.push(`  ${name.padEnd(20)} ${typeName.padEnd(14)} ${sh_addr}  ${hex(sh_size, 6).padEnd(10)} ${flags}`);
    } else if (bits === 32 && e_shentsize >= 40) {
      const sh_name = readU32(data, off, le);
      const sh_type = readU32(data, off + 4, le);
      const sh_flags = readU32(data, off + 8, le);
      const sh_addr = hex(readU32(data, off + 12, le), 8);
      const sh_offset = readU32(data, off + 16, le);
      const sh_size = readU32(data, off + 20, le);
      const sh_link = readU32(data, off + 24, le);
      const sh_entsize = readU32(data, off + 36, le);
      const name = secName(sh_name);
      const typeName = SHT_TYPES[sh_type] ?? hex(sh_type, 8);
      const flags = elfShdrFlags(sh_flags);
      sections.push({ name, type: sh_type, flags: sh_flags, addr: sh_addr, offset: sh_offset, size: sh_size, link: sh_link, entsize: sh_entsize });
      shdrs.push(`  ${name.padEnd(20)} ${typeName.padEnd(14)} ${sh_addr}  ${hex(sh_size, 6).padEnd(10)} ${flags}`);
    } else {
      // Entries too small (or wrong class) cannot be parsed; a partial list
      // would shift every sh_link index below.
      break;
    }
  }

  // Helper: load string table for a section's sh_link
  const loadStrtab = (linkIdx: number): Buffer | undefined => {
    if (linkIdx <= 0 || linkIdx >= sections.length) return undefined;
    const s = sections[linkIdx];
    return safeSub(data, s.offset, Math.min(s.size, 0x200000));
  };

  // --- Dynamic section ---
  const dynamics: string[] = [];
  for (const sec of sections) {
    if (sec.type !== 6 /* SHT_DYNAMIC */) continue;
    const strtab = loadStrtab(sec.link);
    const entSize = sec.entsize || (bits === 64 ? 16 : 8);
    const count = Math.min(Math.floor(sec.size / entSize), 500);
    for (let i = 0; i < count; i++) {
      const off = sec.offset + i * entSize;
      if (off + entSize > data.length) break;
      let d_tag: number;
      let d_val: number;
      if (bits === 64) {
        d_tag = u64Num(data, off, le);
        d_val = u64Num(data, off + 8, le);
      } else {
        d_tag = readI32(data, off, le);
        d_val = readU32(data, off + 4, le);
      }
      if (d_tag === 0) break; // DT_NULL
      const tagName = DT_NAMES[d_tag] ?? hex(d_tag, 8);
      if (d_tag === 1 /* DT_NEEDED */ || d_tag === 14 /* DT_SONAME */ || d_tag === 15 /* DT_RPATH */ || d_tag === 29 /* DT_RUNPATH */) {
        const name = strtab ? readCString(strtab, d_val, 256) : hex(d_val, 8);
        dynamics.push(`  ${tagName.padEnd(16)} ${name}`);
      } else if (d_tag === 24 /* DT_BIND_NOW */) {
        dynamics.push(`  BIND_NOW`);
      } else {
        dynamics.push(`  ${tagName.padEnd(16)} ${hex(d_val, bits === 64 ? 16 : 8)}`);
      }
    }
  }

  // --- Symbol tables ---
  const symbols: string[] = [];
  for (const sec of sections) {
    if (sec.type !== 2 /* SHT_SYMTAB */ && sec.type !== 11 /* SHT_DYNSYM */) continue;
    const strtab = loadStrtab(sec.link);
    const entSize = sec.entsize || (bits === 64 ? 24 : 16);
    const count = Math.min(Math.floor(sec.size / entSize), 2000);
    symbols.push(`  symbol table (${sec.name}, ${count} entries):`);
    const maxShow = 200;
    for (let i = 0; i < count && i < maxShow; i++) {
      const off = sec.offset + i * entSize;
      if (off + entSize > data.length) break;
      if (bits === 64) {
        const st_name = readU32(data, off, le);
        const st_info = data[off + 4];
        const st_other = data[off + 5];
        const st_shndx = readU16(data, off + 6, le);
        const st_value = u64Hex(data, off + 8, le);
        const bind = STB_TYPES[(st_info >> 4) & 0xf] ?? `BIND_${(st_info >> 4) & 0xf}`;
        const type = STT_TYPES[st_info & 0xf] ?? `TYPE_${st_info & 0xf}`;
        const vis = STV_TYPES[st_other & 3] ?? `VIS_${st_other & 3}`;
        const shndx = st_shndx === 0 ? "UND" : st_shndx === 0xfff1 ? "ABS" : String(st_shndx);
        const name = strtab ? readCString(strtab, st_name, 256) : "";
        symbols.push(`    ${st_value}  ${type.padEnd(8)} ${bind.padEnd(8)} ${vis.padEnd(10)} ${shndx.padEnd(5)} ${name}`);
      } else {
        const st_name = readU32(data, off, le);
        const st_value = hex(readU32(data, off + 4, le), 8);
        const st_info = data[off + 12];
        const st_other = data[off + 13];
        const st_shndx = readU16(data, off + 14, le);
        const bind = STB_TYPES[(st_info >> 4) & 0xf] ?? `BIND_${(st_info >> 4) & 0xf}`;
        const type = STT_TYPES[st_info & 0xf] ?? `TYPE_${st_info & 0xf}`;
        const vis = STV_TYPES[st_other & 3] ?? `VIS_${st_other & 3}`;
        const shndx = st_shndx === 0 ? "UND" : st_shndx === 0xfff1 ? "ABS" : String(st_shndx);
        const name = strtab ? readCString(strtab, st_name, 256) : "";
        symbols.push(`    ${st_value}  ${type.padEnd(8)} ${bind.padEnd(8)} ${vis.padEnd(10)} ${shndx.padEnd(5)} ${name}`);
      }
    }
    if (count > maxShow) symbols.push(`    ... ${count - maxShow} more entries`);
  }

  // --- Relocations ---
  const relocations: string[] = [];
  for (const sec of sections) {
    if (sec.type !== 4 /* SHT_RELA */ && sec.type !== 9 /* SHT_REL */) continue;
    const isRela = sec.type === 4;
    // The symbol table referenced by this relocation section
    const symSec = sec.link < sections.length ? sections[sec.link] : undefined;
    const symStrtab = symSec ? loadStrtab(symSec.link) : undefined;
    const symEntSize = symSec ? (symSec.entsize || (bits === 64 ? 24 : 16)) : 0;
    const symCount = symSec ? Math.floor(symSec.size / (symEntSize || 1)) : 0;

    const entSize = sec.entsize || (bits === 64 ? (isRela ? 24 : 16) : (isRela ? 12 : 8));
    const count = Math.min(Math.floor(sec.size / entSize), 500);
    relocations.push(`  relocations (${sec.name}, ${count} entries):`);
    const maxShow = 100;
    for (let i = 0; i < count && i < maxShow; i++) {
      const off = sec.offset + i * entSize;
      if (off + entSize > data.length) break;
      if (bits === 64) {
        const r_offset = u64Hex(data, off, le);
        const r_info_lo = readU32(data, off + 8, le);
        const r_info_hi = readU32(data, off + 12, le);
        const r_type = r_info_lo;
        const r_sym = r_info_hi;
        const typeName = elfRelocType(e_machine, r_type);
        // Resolve symbol name
        let symName = "";
        if (r_sym > 0 && r_sym < symCount && symSec) {
          const symOff = symSec.offset + r_sym * symEntSize;
          if (symOff + symEntSize <= data.length) {
            const st_name = readU32(data, symOff, le);
            symName = symStrtab ? readCString(symStrtab, st_name, 128) : "";
          }
        }
        relocations.push(`    ${r_offset}  ${typeName.padEnd(26)} ${symName}`);
      } else {
        const r_offset = hex(readU32(data, off, le), 8);
        const r_info = readU32(data, off + 4, le);
        const r_type = r_info & 0xff;
        const r_sym = r_info >> 8;
        const typeName = elfRelocType(e_machine, r_type);
        let symName = "";
        if (r_sym > 0 && r_sym < symCount && symSec) {
          const symOff = symSec.offset + r_sym * (symSec.entsize || 16);
          if (symOff + 16 <= data.length) {
            const st_name = readU32(data, symOff, le);
            symName = symStrtab ? readCString(symStrtab, st_name, 128) : "";
          }
        }
        relocations.push(`    ${r_offset}  ${typeName.padEnd(26)} ${symName}`);
      }
    }
    if (count > maxShow) relocations.push(`    ... ${count - maxShow} more entries`);
  }

  return {
    bits,
    le,
    type: ELF_TYPES[e_type] ?? hex(e_type, 4),
    machine: ELF_MACHINES[e_machine] ?? hex(e_machine, 4),
    machineNum: e_machine,
    entry: e_entry,
    phdrCount: e_phnum,
    shdrCount: e_shnum,
    phdrs,
    shdrs,
    dynamics,
    symbols,
    relocations,
    interp,
  };
}

// ===========================================================================
// PE constants and maps
// ===========================================================================

const PE_MACHINES: Record<number, string> = {
  0x0: "Unknown", 0x14c: "i386", 0x166: "MIPS R4000",
  0x1a2: "Hitachi SH3", 0x1a6: "Hitachi SH4",
  0x1c0: "ARM", 0x1c4: "ARM Thumb-2 (ARMv7)",
  0x5064: "RISC-V (64-bit)", 0x8664: "AMD64",
  0xaa64: "ARM64 (AArch64)", 0xebc: "EFI Byte Code",
};

const PE_SUBSYSTEMS: Record<number, string> = {
  0: "Unknown", 1: "Native", 2: "Windows GUI", 3: "Windows CUI",
  5: "OS/2 CUI", 7: "POSIX CUI", 9: "Windows CE GUI",
  10: "EFI Application", 11: "EFI Boot Service Driver",
  12: "EFI Runtime Driver", 13: "EFI ROM", 14: "Xbox", 16: "Windows Boot",
};

const PE_DATA_DIRS = [
  "Export", "Import", "Resource", "Exception",
  "Certificate", "BaseReloc", "Debug", "Architecture",
  "GlobalPtr", "TLS", "LoadConfig", "BoundImport",
  "IAT", "DelayImport", "CLR", "Reserved",
];

function peCharacteristicsFlags(chars: number): string[] {
  const flags: string[] = [];
  if (chars & 0x0002) flags.push("EXECUTABLE_IMAGE");
  if (chars & 0x0020) flags.push("LARGE_ADDRESS_AWARE");
  if (chars & 0x0100) flags.push("32BIT_MACHINE");
  if (chars & 0x2000) flags.push("DLL");
  if (chars & 0x0200) flags.push("DEBUG_STRIPPED");
  if (chars & 0x1000) flags.push("SYSTEM");
  return flags;
}

function peDllCharacteristics(chars: number): string[] {
  const flags: string[] = [];
  if (chars & 0x0020) flags.push("HIGH_ENTROPY_VA");
  if (chars & 0x0040) flags.push("DYNAMIC_BASE (ASLR)");
  if (chars & 0x0080) flags.push("FORCE_INTEGRITY");
  if (chars & 0x0100) flags.push("NX_COMPAT (DEP)");
  if (chars & 0x0200) flags.push("NO_ISOLATION");
  if (chars & 0x0400) flags.push("NO_SEH");
  if (chars & 0x0800) flags.push("NO_BIND");
  if (chars & 0x1000) flags.push("APPCONTAINER");
  if (chars & 0x2000) flags.push("WDM_DRIVER");
  if (chars & 0x4000) flags.push("GUARD_CF (CFG)");
  if (chars & 0x8000) flags.push("TERMINAL_SERVER_AWARE");
  return flags;
}

function peSectionFlags(chars: number): string {
  let s = "";
  if (chars & 0x00000020) s += "C"; // code
  if (chars & 0x00000040) s += "I"; // initialized data
  if (chars & 0x00000080) s += "U"; // uninitialized data
  if (chars & 0x20000000) s += "X"; // execute
  if (chars & 0x40000000) s += "R"; // read
  if (chars & 0x80000000) s += "W"; // write
  return s || "-";
}

// ===========================================================================
// PE parser
// ===========================================================================

interface PeParsed {
  machine: string;
  pe32Plus: boolean;
  characteristics: string[];
  dllCharacteristics: string[];
  entryPoint: string;
  imageBase: string;
  subsystem: string;
  sections: string[];
  dataDirs: string[];
  imports: string[];
  exports: string[];
  securitySummary: string[];
  timestamp: string;
}

function parsePe(data: Buffer): PeParsed | string {
  if (data.length < 64) return "File too small for PE header.";
  if (data[0] !== 0x4d || data[1] !== 0x5a) return "Not a PE file (no MZ magic).";

  const e_lfanew = readU32(data, 60, true);
  if (e_lfanew + 24 > data.length) return "Truncated PE: e_lfanew points past end.";

  // PE signature
  if (data[e_lfanew] !== 0x50 || data[e_lfanew + 1] !== 0x45 || data[e_lfanew + 2] !== 0 || data[e_lfanew + 3] !== 0) {
    return "Invalid PE signature (expected PE\\0\\0).";
  }

  const coffOff = e_lfanew + 4;
  if (coffOff + 20 > data.length) return "Truncated COFF header.";

  const machine = readU16(data, coffOff, true);
  const numberOfSections = readU16(data, coffOff + 2, true);
  const timeDateStamp = readU32(data, coffOff + 4, true);
  const sizeOfOptionalHeader = readU16(data, coffOff + 16, true);
  const characteristics = readU16(data, coffOff + 18, true);

  const optOff = coffOff + 20;
  if (optOff + sizeOfOptionalHeader > data.length) return "Truncated optional header.";

  const optMagic = readU16(data, optOff, true);
  const pe32Plus = optMagic === 0x20b;

  let entryPoint: string;
  let imageBase: string;
  let subsystem: number;
  let dllChars: number;
  let numberOfRvaAndSizes: number;
  let dataDirOff: number;

  if (pe32Plus) {
    if (sizeOfOptionalHeader < 112) return "Optional header too small for PE32+.";
    entryPoint = hex(readU32(data, optOff + 16, true), 8);
    imageBase = u64Hex(data, optOff + 24, true);
    subsystem = readU16(data, optOff + 68, true);
    dllChars = readU16(data, optOff + 70, true);
    numberOfRvaAndSizes = readU32(data, optOff + 108, true);
    dataDirOff = optOff + 112;
  } else {
    if (sizeOfOptionalHeader < 96) return "Optional header too small for PE32.";
    entryPoint = hex(readU32(data, optOff + 16, true), 8);
    imageBase = hex(readU32(data, optOff + 28, true), 8);
    subsystem = readU16(data, optOff + 68, true);
    dllChars = readU16(data, optOff + 70, true);
    numberOfRvaAndSizes = readU32(data, optOff + 92, true);
    dataDirOff = optOff + 96;
  }

  // Data directories
  const dataDirs: string[] = [];
  const numDirs = Math.min(numberOfRvaAndSizes, 16);
  const dataDirEntries: Array<{ rva: number; size: number }> = [];
  for (let i = 0; i < numDirs; i++) {
    const off = dataDirOff + i * 8;
    if (off + 8 > data.length) break;
    const rva = readU32(data, off, true);
    const size = readU32(data, off + 4, true);
    dataDirEntries.push({ rva, size });
    const name = PE_DATA_DIRS[i] ?? `Dir_${i}`;
    if (rva > 0 || size > 0) {
      dataDirs.push(`  ${name.padEnd(16)} rva=${hex(rva, 8)}  size=${hex(size, 8)}`);
    }
  }

  // Section table
  const secTableOff = optOff + sizeOfOptionalHeader;
  const sectionsParsed: Array<{ name: string; virtualSize: number; virtualAddress: number; sizeOfRawData: number; pointerToRawData: number; characteristics: number }> = [];
  const sectionsStr: string[] = [];

  for (let i = 0; i < numberOfSections; i++) {
    const off = secTableOff + i * 40;
    if (off + 40 > data.length) break;
    const name = readFixedString(data, off, 8);
    const virtualSize = readU32(data, off + 8, true);
    const virtualAddress = readU32(data, off + 12, true);
    const sizeOfRawData = readU32(data, off + 16, true);
    const pointerToRawData = readU32(data, off + 20, true);
    const secChars = readU32(data, off + 36, true);
    sectionsParsed.push({ name, virtualSize, virtualAddress, sizeOfRawData, pointerToRawData, characteristics: secChars });
    const flags = peSectionFlags(secChars);
    sectionsStr.push(`  ${name.padEnd(10)} va=${hex(virtualAddress, 8)}  vsize=${hex(virtualSize, 8)}  rsize=${hex(sizeOfRawData, 8)}  ${flags}`);
  }

  // Resolve RVA to file offset
  const rvaToOffset = (rva: number): number | undefined => {
    for (const sec of sectionsParsed) {
      if (rva >= sec.virtualAddress && rva < sec.virtualAddress + sec.sizeOfRawData) {
        return sec.pointerToRawData + (rva - sec.virtualAddress);
      }
    }
    return undefined;
  };

  // --- Imports ---
  const imports: string[] = [];
  const importDir = dataDirEntries[1]; // Import Directory
  if (importDir && importDir.rva > 0 && importDir.size > 0) {
    const importOff = rvaToOffset(importDir.rva);
    if (importOff !== undefined) {
      const maxDescriptors = Math.min(Math.floor(importDir.size / 20), 200);
      for (let i = 0; i < maxDescriptors; i++) {
        const descOff = importOff + i * 20;
        if (descOff + 20 > data.length) break;
        const originalRva = readU32(data, descOff, true);
        const nameRva = readU32(data, descOff + 12, true);
        if (originalRva === 0 && nameRva === 0) break;
        // Some PEs (bound images, certain linkers) leave OriginalFirstThunk at
        // zero and only fill the IAT; fall back to FirstThunk then.
        const iltRva = originalRva !== 0 ? originalRva : readU32(data, descOff + 16, true);
        const nameOff = rvaToOffset(nameRva);
        const dllName = nameOff !== undefined ? readCString(data, nameOff, 256) : hex(nameRva, 8);
        const funcs: string[] = [];
        const iltOff = rvaToOffset(iltRva);
        if (iltOff !== undefined) {
          const entSize = pe32Plus ? 8 : 4;
          for (let j = 0; j < 50; j++) {
            const eltOff = iltOff + j * entSize;
            if (eltOff + entSize > data.length) break;
            const entry = pe32Plus ? u64Num(data, eltOff, true) : readU32(data, eltOff, true);
            if (entry === 0) break;
            const isOrdinal = pe32Plus ? (entry >= 0x8000000000000000) : (entry >= 0x80000000);
            if (isOrdinal) {
              funcs.push(`ordinal ${entry & 0xffff}`);
            } else {
              const hintOff = rvaToOffset(entry & 0x7fffffff);
              if (hintOff !== undefined && hintOff + 2 < data.length) {
                const funcName = readCString(data, hintOff + 2, 128);
                funcs.push(funcName || `hint_${hex(entry, 8)}`);
              }
            }
          }
        }
        imports.push(`  ${dllName}`);
        for (const fn of funcs.slice(0, 30)) imports.push(`    ${fn}`);
        if (funcs.length > 30) imports.push(`    ... ${funcs.length - 30} more`);
      }
    }
  }

  // --- Exports ---
  const exports: string[] = [];
  const exportDir = dataDirEntries[0]; // Export Directory
  if (exportDir && exportDir.rva > 0 && exportDir.size > 0) {
    const exportOff = rvaToOffset(exportDir.rva);
    if (exportOff !== undefined && exportOff + 40 <= data.length) {
      const nameRva = readU32(data, exportOff + 12, true);
      const numberOfFunctions = readU32(data, exportOff + 20, true);
      const numberOfNames = readU32(data, exportOff + 24, true);
      const addressOfFunctions = readU32(data, exportOff + 28, true);
      const addressOfNames = readU32(data, exportOff + 32, true);
      const addressOfNameOrdinals = readU32(data, exportOff + 36, true);
      const dllNameOff = rvaToOffset(nameRva);
      const dllName = dllNameOff !== undefined ? readCString(data, dllNameOff, 128) : "?";
      exports.push(`  DLL: ${dllName}  functions: ${numberOfFunctions}  names: ${numberOfNames}`);

      const namesOff = rvaToOffset(addressOfNames);
      const ordinalsOff = rvaToOffset(addressOfNameOrdinals);
      const functionsOff = rvaToOffset(addressOfFunctions);
      if (namesOff !== undefined && ordinalsOff !== undefined && functionsOff !== undefined) {
        const maxShow = Math.min(numberOfNames, 100);
        for (let i = 0; i < maxShow; i++) {
          if (namesOff + i * 4 + 4 > data.length) break;
          if (ordinalsOff + i * 2 + 2 > data.length) break;
          const fnNameRva = readU32(data, namesOff + i * 4, true);
          const ordinal = readU16(data, ordinalsOff + i * 2, true);
          let fnRva = 0;
          if (functionsOff + ordinal * 4 + 4 <= data.length) {
            fnRva = readU32(data, functionsOff + ordinal * 4, true);
          }
          const fnNameOff = rvaToOffset(fnNameRva);
          const fnName = fnNameOff !== undefined ? readCString(data, fnNameOff, 128) : `name_${i}`;
          exports.push(`    ${hex(fnRva, 8)}  ord=${ordinal}  ${fnName}`);
        }
        if (numberOfNames > maxShow) exports.push(`    ... ${numberOfNames - maxShow} more`);
      }
    }
  }

  // --- Security summary ---
  const securitySummary: string[] = [];
  const dllCharsFlags = peDllCharacteristics(dllChars);
  securitySummary.push(`ASLR:   ${dllChars & 0x0040 ? "enabled (DYNAMIC_BASE)" : "disabled"}`);
  securitySummary.push(`DEP/NX: ${dllChars & 0x0100 ? "enabled (NX_COMPAT)" : "disabled"}`);
  securitySummary.push(`CFG:    ${dllChars & 0x4000 ? "enabled (GUARD_CF)" : "disabled"}`);
  securitySummary.push(`SEH:    ${dllChars & 0x0400 ? "NO_SEH (disabled)" : "enabled"}`);
  securitySummary.push(`HiVA:   ${dllChars & 0x0020 ? "enabled (HIGH_ENTROPY_VA)" : "disabled"}`);
  const certDir = dataDirEntries[4];
  securitySummary.push(`Auth:   ${certDir && certDir.rva > 0 ? "Authenticode signature present" : "no signature"}`);

  const ts = new Date(timeDateStamp * 1000);
  const timestamp = `${timeDateStamp} (${ts.toISOString()})`;

  return {
    machine: PE_MACHINES[machine] ?? hex(machine, 4),
    pe32Plus,
    characteristics: peCharacteristicsFlags(characteristics),
    dllCharacteristics: dllCharsFlags,
    entryPoint,
    imageBase,
    subsystem: PE_SUBSYSTEMS[subsystem] ?? `${subsystem}`,
    sections: sectionsStr,
    dataDirs,
    imports,
    exports,
    securitySummary,
    timestamp,
  };
}

// ===========================================================================
// Mach-O constants and maps
// ===========================================================================

const MACHO_MAGICS: Record<number, { bits: 32 | 64 }> = {
  0xfeedface: { bits: 32 }, // stored big-endian (bytes FE ED FA CE)
  0xcefaedfe: { bits: 32 }, // stored little-endian
  0xfeedfacf: { bits: 64 },
  0xcffaedfe: { bits: 64 },
};

const MACHO_CPUTYPES: Record<number, string> = {
  1: "VAX", 6: "MC680x0", 7: "x86", 0x01000007: "x86_64",
  12: "ARM", 0x0100000c: "ARM64", 14: "SPARC", 18: "PowerPC",
  0x01000012: "PowerPC64",
};

const MACHO_FILETYPES: Record<number, string> = {
  1: "OBJECT", 2: "EXECUTE", 3: "FVMLIB", 4: "CORE",
  5: "PRELOAD", 6: "DYLIB", 7: "DYLINKER", 8: "BUNDLE",
  9: "DYLIB_STUB", 10: "DSYM", 11: "KEXT_BUNDLE", 12: "FILESET",
};

const LC_NAMES: Record<number, string> = {
  0x01: "SEGMENT", 0x02: "SYMTAB", 0x04: "THREAD",
  0x05: "UNIXTHREAD", 0x0b: "DYSYMTAB", 0x0c: "LOAD_DYLIB",
  0x0d: "ID_DYLIB", 0x0e: "LOAD_DYLINKER",
  0x19: "SEGMENT_64", 0x1d: "ID_DYLINKER",
  0x20: "ROUTINES_64", 0x21: "UUID",
  0x22: "RPATH", 0x24: "CODE_SIGNATURE",
  0x25: "SEGMENT_SPLIT_INFO", 0x26: "REEXPORT_DYLIB",
  0x28: "ENCRYPTION_INFO", 0x29: "DYLD_INFO",
  0x2c: "ENCRYPTION_INFO_64",
  // LC_REQ_DYLD variants (0x80000000 | base)
  0x80000002: "LOAD_DYLIB",
  0x80000018: "LOAD_WEAK_DYLIB",
  0x80000022: "RPATH",
  0x80000028: "MAIN",
  0x80000029: "DYLD_INFO_ONLY",
  0x8000002e: "SOURCE_VERSION",
  0x80000032: "BUILD_VERSION",
  0x80000033: "DYLD_EXPORTS_TRIE",
  0x80000034: "DYLD_CHAINED_FIXUPS",
};

function machoFlags(flags: number): string[] {
  const out: string[] = [];
  if (flags & 0x01) out.push("NOUNDEFS");
  if (flags & 0x02) out.push("INCRLINK");
  if (flags & 0x04) out.push("DYLDLINK");
  if (flags & 0x08) out.push("BINDATLOAD");
  if (flags & 0x10) out.push("PREBOUND");
  if (flags & 0x80) out.push("TWOLEVEL");
  if (flags & 0x200000) out.push("PIE");
  if (flags & 0x800000) out.push("HAS_TLV_DESCRIPTORS");
  if (flags & 0x2000000) out.push("NO_HEAP_EXECUTION");
  return out;
}

function machoProtFlags(prot: number): string {
  let s = "";
  if (prot & 1) s += "R";
  if (prot & 2) s += "W";
  if (prot & 4) s += "X";
  return s || "-";
}

// ===========================================================================
// Mach-O parser
// ===========================================================================

interface MachoParsed {
  bits: 32 | 64;
  swap: boolean;
  cputype: string;
  filetype: string;
  flags: string[];
  ncmds: number;
  loadCommands: string[];
  segments: string[];
  dylibs: string[];
  symtabInfo: string;
  securitySummary: string[];
}

function parseMacho(data: Buffer): MachoParsed | string {
  if (data.length < 28) return "File too small for Mach-O header.";
  const magic = data.readUInt32BE(0);
  const magicLE = data.readUInt32LE(0);

  const magicInfo = MACHO_MAGICS[magic] ?? MACHO_MAGICS[magicLE];
  if (!magicInfo) return "Not a Mach-O file (bad magic).";

  // The magic is stored in the file's own byte order: little-endian files start
  // with CE/CF, big-endian files with FE. Load-command fields follow the same
  // byte order, so that decides how every following read is done.
  const le = data[0] === 0xce || data[0] === 0xcf;
  const bits = magicInfo.bits;

  const headerSize = bits === 64 ? 32 : 28;
  if (data.length < headerSize) return "Truncated Mach-O header.";

  const cputype = readU32(data, 4, le);
  const _cpusubtype = readU32(data, 8, le);
  const filetype = readU32(data, 12, le);
  const ncmds = readU32(data, 16, le);
  const sizeofcmds = readU32(data, 20, le);
  const flagsVal = readU32(data, 24, le);

  const loadCommands: string[] = [];
  const segments: string[] = [];
  const dylibs: string[] = [];
  let symtabInfo = "";
  const secSummary: string[] = [];

  let hasCodeSig = false;
  let hasEncryption = false;
  const isPie = (flagsVal & 0x200000) !== 0;

  let cmdOff = headerSize;
  for (let i = 0; i < ncmds && cmdOff + 8 <= data.length; i++) {
    const cmd = readU32(data, cmdOff, le);
    const cmdsize = readU32(data, cmdOff + 4, le);
    if (cmdsize < 8 || cmdOff + cmdsize > data.length) break;

    const cmdName = LC_NAMES[cmd] ?? hex(cmd, 8);
    const cmdBase = cmd & 0x7fffffff; // strip LC_REQ_DYLD

    if (cmdBase === 0x19 /* LC_SEGMENT_64 */ && bits === 64 && cmdsize >= 72) {
      const segname = readFixedString(data, cmdOff + 8, 16);
      const vmaddr = u64Hex(data, cmdOff + 24, le);
      const vmsize = u64Hex(data, cmdOff + 32, le);
      const fileoff = u64Hex(data, cmdOff + 40, le);
      const filesize = u64Hex(data, cmdOff + 48, le);
      const maxprot = readU32(data, cmdOff + 56, le);
      const initprot = readU32(data, cmdOff + 60, le);
      const nsects = readU32(data, cmdOff + 64, le);

      segments.push(`  ${segname.padEnd(20)} ${vmaddr}  ${vmsize}  ${machoProtFlags(initprot)}/${machoProtFlags(maxprot)}  fileoff=${fileoff}  fsize=${filesize}`);

      const sectOff = cmdOff + 72;
      const sectSize = 80; // section_64 is 80 bytes
      for (let s = 0; s < nsects && s < 100; s++) {
        const sOff = sectOff + s * sectSize;
        if (sOff + sectSize > data.length) break;
        const sectname = readFixedString(data, sOff, 16);
        const sectSegname = readFixedString(data, sOff + 16, 16);
        const addr = u64Hex(data, sOff + 32, le);
        const size = u64Hex(data, sOff + 40, le);
        segments.push(`    ${sectSegname},${sectname}`.padEnd(40) + ` ${addr}  ${size}`);
      }

      loadCommands.push(`  ${cmdName.padEnd(24)} ${segname}  vm=${vmaddr}  nsects=${nsects}`);
    } else if (cmdBase === 0x01 /* LC_SEGMENT */ && bits === 32 && cmdsize >= 56) {
      const segname = readFixedString(data, cmdOff + 8, 16);
      const vmaddr = hex(readU32(data, cmdOff + 24, le), 8);
      const vmsize = hex(readU32(data, cmdOff + 28, le), 8);
      const fileoff = hex(readU32(data, cmdOff + 32, le), 8);
      const filesize = hex(readU32(data, cmdOff + 36, le), 8);
      const maxprot = readU32(data, cmdOff + 40, le);
      const initprot = readU32(data, cmdOff + 44, le);
      const nsects = readU32(data, cmdOff + 48, le);

      segments.push(`  ${segname.padEnd(20)} ${vmaddr}  ${vmsize}  ${machoProtFlags(initprot)}/${machoProtFlags(maxprot)}  fileoff=${fileoff}  fsize=${filesize}`);

      const sectOff = cmdOff + 56;
      const sectSz = 68;
      for (let s = 0; s < nsects && s < 100; s++) {
        const sOff = sectOff + s * sectSz;
        if (sOff + sectSz > data.length) break;
        const sectname = readFixedString(data, sOff, 16);
        const sectSegname = readFixedString(data, sOff + 16, 16);
        const addr = hex(readU32(data, sOff + 32, le), 8);
        const size = hex(readU32(data, sOff + 36, le), 8);
        segments.push(`    ${sectSegname},${sectname}`.padEnd(40) + ` ${addr}  ${size}`);
      }

      loadCommands.push(`  ${cmdName.padEnd(24)} ${segname}  vm=${vmaddr}  nsects=${nsects}`);
    } else if (cmdBase === 0x02 /* LC_SYMTAB */ && cmdsize >= 24) {
      const symoff = readU32(data, cmdOff + 8, le);
      const nsyms = readU32(data, cmdOff + 12, le);
      const stroff = readU32(data, cmdOff + 16, le);
      const strsize = readU32(data, cmdOff + 20, le);
      symtabInfo = `symoff=${hex(symoff, 8)}  nsyms=${nsyms}  stroff=${hex(stroff, 8)}  strsize=${strsize}`;
      loadCommands.push(`  ${cmdName.padEnd(24)} nsyms=${nsyms}`);
    } else if ((cmdBase === 0x0c /* LC_LOAD_DYLIB */ || cmdBase === 0x0d /* LC_ID_DYLIB */ || cmd === 0x80000018 /* LC_LOAD_WEAK_DYLIB */ || cmdBase === 0x26 /* LC_REEXPORT_DYLIB */) && cmdsize >= 24) {
      const nameOff = readU32(data, cmdOff + 8, le);
      const libName = nameOff < cmdsize ? readCString(data, cmdOff + nameOff, cmdsize - nameOff) : "?";
      const label = cmdBase === 0x0d ? "ID_DYLIB" : cmd === 0x80000018 ? "WEAK_DYLIB" : cmdBase === 0x26 ? "REEXPORT_DYLIB" : "LOAD_DYLIB";
      dylibs.push(`  ${label.padEnd(18)} ${libName}`);
      loadCommands.push(`  ${cmdName.padEnd(24)} ${libName}`);
    } else if (cmd === 0x80000028 /* LC_MAIN */ && cmdsize >= 24) {
      const entryoff = u64Hex(data, cmdOff + 8, le);
      loadCommands.push(`  ${"MAIN".padEnd(24)} entryoff=${entryoff}`);
    } else if (cmdBase === 0x24 /* LC_CODE_SIGNATURE */) {
      hasCodeSig = true;
      loadCommands.push(`  ${cmdName.padEnd(24)} present`);
    } else if (cmdBase === 0x21 /* LC_UUID */ && cmdsize >= 24) {
      const uuid = Array.from(data.subarray(cmdOff + 8, cmdOff + 24), b => b.toString(16).padStart(2, "0")).join("");
      const formatted = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
      loadCommands.push(`  ${"UUID".padEnd(24)} ${formatted}`);
    } else if ((cmdBase === 0x28 /* LC_ENCRYPTION_INFO */ || cmdBase === 0x2c /* LC_ENCRYPTION_INFO_64 */) && cmdsize >= 20) {
      const cryptid = readU32(data, cmdOff + 16, le);
      hasEncryption = cryptid !== 0;
      loadCommands.push(`  ${cmdName.padEnd(24)} cryptid=${cryptid}${hasEncryption ? " (ENCRYPTED)" : " (decrypted)"}`);
    } else if (cmdBase === 0x22 /* LC_RPATH */ || cmd === 0x80000022) {
      const rpathOff = readU32(data, cmdOff + 8, le);
      const rpathName = rpathOff < cmdsize ? readCString(data, cmdOff + rpathOff, cmdsize - rpathOff) : "?";
      loadCommands.push(`  ${"RPATH".padEnd(24)} ${rpathName}`);
    } else {
      loadCommands.push(`  ${cmdName.padEnd(24)} size=${cmdsize}`);
    }

    cmdOff += cmdsize;
  }

  secSummary.push(`PIE:        ${isPie ? "enabled (MH_PIE)" : "disabled"}`);
  secSummary.push(`CodeSign:   ${hasCodeSig ? "present" : "absent"}`);
  secSummary.push(`Encrypted:  ${hasEncryption ? "YES (cryptid != 0)" : "no"}`);

  return {
    bits,
    swap: !le,
    cputype: MACHO_CPUTYPES[cputype] ?? hex(cputype, 8),
    filetype: MACHO_FILETYPES[filetype] ?? `${filetype}`,
    flags: machoFlags(flagsVal),
    ncmds,
    loadCommands,
    segments,
    dylibs,
    symtabInfo,
    securitySummary: secSummary,
  };
}

// ===========================================================================
// Format detection
// ===========================================================================

function detectFormat(data: Buffer): "elf" | "pe" | "macho" | "unknown" {
  if (data.length < 4) return "unknown";
  if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) return "elf";
  if (data[0] === 0x4d && data[1] === 0x5a) return "pe";
  const magic32 = data.readUInt32BE(0);
  const magicLE32 = data.readUInt32LE(0);
  if (MACHO_MAGICS[magic32] || MACHO_MAGICS[magicLE32]) return "macho";
  return "unknown";
}

// ===========================================================================
// Tool 1: elf_parse
// ===========================================================================

const elfParseTool: AgentTool = {
  name: "elf_parse",
  description:
    "Deep ELF binary analysis in pure JavaScript — no readelf/objdump/radare2 needed. Parses ELF header, program headers, section headers, dynamic section, symbol tables (.dynsym/.symtab), and relocations directly from the raw bytes. Supports both ELF32 and ELF64, little and big endian.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative binary path." },
      maxBytes: { type: "number", default: 16777216, description: "Maximum bytes to read (default 16MB)." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    // Try Rust backend first (faster, handles malformed binaries better)
    const rustResult = await rustParse("elf", target, context);
    if (rustResult) {
      const text = formatRustElfOutput(rustResult);
      const spilled = await spillIfLarge(text, { context, label: `elf-parse-${path.basename(target)}` });
      return { content: [textBlock(spilled.text)], details: { engine: "rust/goblin", artifact: spilled.artifact } };
    }

    // JS fallback
    const stat = await fs.stat(target);
    const maxBytes = Math.min(Math.max(1024, asNumber(args.maxBytes, 16 * 1024 * 1024)), 64 * 1024 * 1024);
    const data = await readPrefix(target, Math.min(stat.size, maxBytes));

    const parsed = parseElf(data);
    if (typeof parsed === "string") {
      return { content: [textBlock(`ELF DEEP PARSE\npath: ${rel}\n\nerror: ${parsed}`)], isError: true };
    }

    const out = [
      "ELF DEEP PARSE",
      `path: ${rel}`,
      `size: ${stat.size} bytes`,
      `class: ELF${parsed.bits}`,
      `encoding: 2's complement, ${parsed.le ? "little endian" : "big endian"}`,
      `type: ${parsed.type}`,
      `machine: ${parsed.machine}`,
      `entry: ${parsed.entry}`,
      ...(parsed.interp ? [`interp: ${parsed.interp}`] : []),
      "",
      `program headers (${parsed.phdrCount}):`,
      ...parsed.phdrs,
      "",
      `section headers (${parsed.shdrCount}):`,
      ...parsed.shdrs,
    ];

    if (parsed.dynamics.length) {
      out.push("", `dynamic section (${parsed.dynamics.length}):`, ...parsed.dynamics);
    }

    if (parsed.symbols.length) {
      out.push("", ...parsed.symbols);
    }

    if (parsed.relocations.length) {
      out.push("", ...parsed.relocations);
    }

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `elf-parse-${path.basename(target)}` });
    return {
      content: [textBlock(spilled.text)],
      details: { bits: parsed.bits, type: parsed.type, machine: parsed.machine, phdrs: parsed.phdrCount, shdrs: parsed.shdrCount, artifact: spilled.artifact },
    };
  },
};

// ===========================================================================
// Tool 2: pe_parse
// ===========================================================================

const peParseTool: AgentTool = {
  name: "pe_parse",
  description:
    "Deep PE/COFF binary analysis in pure JavaScript — no dumpbin/objdump needed. Parses DOS header, COFF header, optional header (PE32/PE32+), data directories, section table, import table (with function names), export table, and security flags (ASLR, DEP, CFG, Authenticode). Works on .exe, .dll, .sys, .ocx files.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative PE file path." },
      maxBytes: { type: "number", default: 16777216, description: "Maximum bytes to read (default 16MB)." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    // Try Rust backend first
    const rustResult = await rustParse("pe", target, context);
    if (rustResult) {
      const text = formatRustPeOutput(rustResult);
      const spilled = await spillIfLarge(text, { context, label: `pe-parse-${path.basename(target)}` });
      return { content: [textBlock(spilled.text)], details: { engine: "rust/goblin", artifact: spilled.artifact } };
    }

    // JS fallback
    const stat = await fs.stat(target);
    const maxBytes = Math.min(Math.max(1024, asNumber(args.maxBytes, 16 * 1024 * 1024)), 64 * 1024 * 1024);
    const data = await readPrefix(target, Math.min(stat.size, maxBytes));

    const parsed = parsePe(data);
    if (typeof parsed === "string") {
      return { content: [textBlock(`PE DEEP PARSE\npath: ${rel}\n\nerror: ${parsed}`)], isError: true };
    }

    const out = [
      "PE DEEP PARSE",
      `path: ${rel}`,
      `size: ${stat.size} bytes`,
      `machine: ${parsed.machine}`,
      `format: ${parsed.pe32Plus ? "PE32+ (64-bit)" : "PE32 (32-bit)"}`,
      `timestamp: ${parsed.timestamp}`,
      `entry point: ${parsed.entryPoint}`,
      `image base: ${parsed.imageBase}`,
      `subsystem: ${parsed.subsystem}`,
      `characteristics: ${parsed.characteristics.join(", ") || "none"}`,
      `dll characteristics: ${parsed.dllCharacteristics.join(", ") || "none"}`,
      "",
      "security:",
      ...parsed.securitySummary.map(s => `  ${s}`),
      "",
      `data directories (${parsed.dataDirs.length}):`,
      ...parsed.dataDirs,
      "",
      `sections (${parsed.sections.length}):`,
      ...parsed.sections,
    ];

    if (parsed.imports.length) {
      out.push("", `imports (${parsed.imports.filter(l => !l.startsWith("    ")).length} DLLs):`, ...parsed.imports);
    }

    if (parsed.exports.length) {
      out.push("", "exports:", ...parsed.exports);
    }

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `pe-parse-${path.basename(target)}` });
    return {
      content: [textBlock(spilled.text)],
      details: { machine: parsed.machine, pe32Plus: parsed.pe32Plus, artifact: spilled.artifact },
    };
  },
};

// ===========================================================================
// Tool 3: macho_parse
// ===========================================================================

const machoParseTool: AgentTool = {
  name: "macho_parse",
  description:
    "Deep Mach-O binary analysis in pure JavaScript — no otool/MachOView needed. Parses header, load commands, segments and sections, dylib dependencies, symbol table info, UUID, code signature, encryption info, and security flags (PIE). Supports both 32-bit and 64-bit, native and byte-swapped.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative Mach-O file path." },
      maxBytes: { type: "number", default: 16777216, description: "Maximum bytes to read (default 16MB)." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    // Try Rust backend first
    const rustResult = await rustParse("macho", target, context);
    if (rustResult) {
      const text = formatRustMachoOutput(rustResult);
      const spilled = await spillIfLarge(text, { context, label: `macho-parse-${path.basename(target)}` });
      return { content: [textBlock(spilled.text)], details: { engine: "rust/goblin", artifact: spilled.artifact } };
    }

    // JS fallback
    const stat = await fs.stat(target);
    const maxBytes = Math.min(Math.max(1024, asNumber(args.maxBytes, 16 * 1024 * 1024)), 64 * 1024 * 1024);
    const data = await readPrefix(target, Math.min(stat.size, maxBytes));

    const parsed = parseMacho(data);
    if (typeof parsed === "string") {
      return { content: [textBlock(`MACH-O DEEP PARSE\npath: ${rel}\n\nerror: ${parsed}`)], isError: true };
    }

    const out = [
      "MACH-O DEEP PARSE",
      `path: ${rel}`,
      `size: ${stat.size} bytes`,
      `class: Mach-O ${parsed.bits}-bit${parsed.swap ? " (byte-swapped)" : ""}`,
      `cputype: ${parsed.cputype}`,
      `filetype: ${parsed.filetype}`,
      `flags: ${parsed.flags.join(", ") || "none"}`,
      `ncmds: ${parsed.ncmds}`,
      "",
      "security:",
      ...parsed.securitySummary.map(s => `  ${s}`),
      "",
      `load commands (${parsed.loadCommands.length}):`,
      ...parsed.loadCommands,
    ];

    if (parsed.segments.length) {
      out.push("", "segments and sections:", ...parsed.segments);
    }

    if (parsed.dylibs.length) {
      out.push("", `dylibs (${parsed.dylibs.length}):`, ...parsed.dylibs);
    }

    if (parsed.symtabInfo) {
      out.push("", `symtab: ${parsed.symtabInfo}`);
    }

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `macho-parse-${path.basename(target)}` });
    return {
      content: [textBlock(spilled.text)],
      details: { bits: parsed.bits, cputype: parsed.cputype, filetype: parsed.filetype, artifact: spilled.artifact },
    };
  },
};

// ===========================================================================
// Tool 4: binary_sections — cross-format section overview
// ===========================================================================

const binarySectionsTool: AgentTool = {
  name: "binary_sections",
  description:
    "Auto-detect binary format (ELF/PE/Mach-O) and show a compact section/segment overview with addresses, sizes, and permissions. No external tools needed — pure JavaScript parsing. Useful for quick orientation before deeper analysis.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative binary path." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const rel = path.relative(context.workspace, target);

    // Try Rust backend first
    const rustResult = await rustParse("sections", target, context);
    if (rustResult) {
      const text = formatRustSectionsOutput(rustResult);
      const spilled = await spillIfLarge(text, { context, label: `sections-${path.basename(target)}` });
      return { content: [textBlock(spilled.text)], details: { engine: "rust/goblin", artifact: spilled.artifact } };
    }

    // JS fallback
    const stat = await fs.stat(target);
    const data = await readPrefix(target, Math.min(stat.size, 16 * 1024 * 1024));
    const format = detectFormat(data);

    if (format === "unknown") {
      return {
        content: [textBlock(`BINARY SECTIONS\npath: ${rel}\nsize: ${stat.size} bytes\n\nUnrecognized format (not ELF, PE, or Mach-O). Try ctf_triage or hexdump.`)],
        isError: true,
      };
    }

    const out = [
      "BINARY SECTIONS",
      `path: ${rel}`,
      `size: ${stat.size} bytes`,
      `format: ${format.toUpperCase()}`,
      "",
    ];

    if (format === "elf") {
      const parsed = parseElf(data);
      if (typeof parsed === "string") {
        out.push(`error: ${parsed}`);
      } else {
        out.push(`class: ELF${parsed.bits}  ${parsed.le ? "LE" : "BE"}  ${parsed.machine}  ${parsed.type}`);
        out.push(`entry: ${parsed.entry}`);
        out.push("");
        out.push("section                  type            address             size       flags");
        out.push("─".repeat(85));
        out.push(...parsed.shdrs);
      }
    } else if (format === "pe") {
      const parsed = parsePe(data);
      if (typeof parsed === "string") {
        out.push(`error: ${parsed}`);
      } else {
        out.push(`${parsed.pe32Plus ? "PE32+" : "PE32"}  ${parsed.machine}  base=${parsed.imageBase}  entry=${parsed.entryPoint}`);
        out.push("");
        out.push("section      va           vsize        rsize        flags");
        out.push("─".repeat(72));
        out.push(...parsed.sections);
      }
    } else if (format === "macho") {
      const parsed = parseMacho(data);
      if (typeof parsed === "string") {
        out.push(`error: ${parsed}`);
      } else {
        out.push(`Mach-O ${parsed.bits}-bit  ${parsed.cputype}  ${parsed.filetype}  flags: ${parsed.flags.join(", ") || "none"}`);
        out.push("");
        out.push(...parsed.segments);
      }
    }

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `sections-${path.basename(target)}` });
    return {
      content: [textBlock(spilled.text)],
      details: { format, artifact: spilled.artifact },
    };
  },
};
