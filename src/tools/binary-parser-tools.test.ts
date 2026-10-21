// Regression tests for the binary-parser-tools.ts / yara-tools.ts bug fixes.
// Assertions are engine-agnostic: they hold whether the Rust backend
// (bin/oxaf-parse) is present or the pure-JS fallback parsers run.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createBinaryParserTools } from "./binary-parser-tools";
import { createYaraTools } from "./yara-tools";
import type { ToolContext } from "../types";

const binTools = createBinaryParserTools();
const yaraTools = createYaraTools();

const getTool = (tools: typeof binTools, name: string) => {
  const found = tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map(block => block.text ?? "").join("");

async function tempContext(): Promise<ToolContext> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-parser-fix-"));
  return {
    workspace,
    sessionDir: workspace,
    policy: {
      allowWrites: false, allowNetwork: false, allowSensitive: false,
      commandTimeoutMs: 5000, maxReadBytes: 64 * 1024, maxToolOutputChars: 24_000,
      approvalMode: "safe", approvals: {},
    },
  };
}

describe("macho_parse endianness", () => {
  test("big-endian (PowerPC-era) Mach-O resolves its segment", async () => {
    const context = await tempContext();
    const header = Buffer.alloc(28);
    header.writeUInt32BE(0xfeedface, 0); // MH_MAGIC stored big-endian
    header.writeUInt32BE(18, 4);         // CPU_TYPE_POWERPC
    header.writeUInt32BE(0, 8);
    header.writeUInt32BE(2, 12);         // MH_EXECUTE
    header.writeUInt32BE(1, 16);         // ncmds
    header.writeUInt32BE(56, 20);        // sizeofcmds
    header.writeUInt32BE(0, 24);
    const seg = Buffer.alloc(56);
    seg.writeUInt32BE(0x01, 0);          // LC_SEGMENT
    seg.writeUInt32BE(56, 4);
    seg.write("__TEXT", 8, "ascii");
    seg.writeUInt32BE(0x1000, 24);       // vmaddr
    seg.writeUInt32BE(0x2000, 28);       // vmsize
    seg.writeUInt32BE(0, 32);
    seg.writeUInt32BE(0x2000, 36);
    seg.writeUInt32BE(7, 40);
    seg.writeUInt32BE(5, 44);
    seg.writeUInt32BE(0, 48);
    const file = path.join(context.workspace, "be.macho");
    await fs.writeFile(file, Buffer.concat([header, seg]));

    const result = await getTool(binTools, "macho_parse").execute({ path: "be.macho" }, context);
    const out = text(result);
    // Byte-swapped fields must not leak garbage: the segment (and its vmaddr,
    // in either the 0x00001000 or 0x0000000000001000 rendering) must appear.
    expect(out).toContain("__TEXT");
    expect(out).toMatch(/0x0*1000/);
    expect(out).not.toContain("0x12000000"); // byte-swapped cputype garbage
  });

  test("little-endian x86_64 Mach-O parses natively", async () => {
    const context = await tempContext();
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64 stored little-endian
    header.writeUInt32LE(0x01000007, 4); // CPU_TYPE_X86_64
    header.writeUInt32LE(3, 8);
    header.writeUInt32LE(2, 12);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(0, 20);
    header.writeUInt32LE(0x200000, 24);  // MH_PIE
    header.writeUInt32LE(0, 28);
    const file = path.join(context.workspace, "le.macho");
    await fs.writeFile(file, header);

    const result = await getTool(binTools, "macho_parse").execute({ path: "le.macho" }, context);
    const out = text(result);
    expect(out).toContain("x86_64");
    expect(out).not.toContain("byte-swapped");
  });
});

describe("elf_parse malformed program headers", () => {
  test("an undersized e_phentsize fails gracefully instead of throwing", async () => {
    const context = await tempContext();
    const data = Buffer.alloc(72);
    data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // \x7fELF, ELF64, LE
    data.writeUInt16LE(2, 16);   // ET_EXEC
    data.writeUInt16LE(62, 18);  // EM_X86_64
    data.writeUInt32LE(64, 32);  // e_phoff
    data.writeUInt16LE(64, 52);  // e_ehsize
    data.writeUInt16LE(8, 54);   // e_phentsize = 8 (a Phdr64 needs 56)
    data.writeUInt16LE(1, 56);   // e_phnum
    const file = path.join(context.workspace, "bad-phentsize.elf");
    await fs.writeFile(file, data);

    const result = await getTool(binTools, "elf_parse").execute({ path: "bad-phentsize.elf" }, context);
    expect(result.content.length).toBeGreaterThan(0);
    expect(text(result)).not.toContain("RangeError");
  });
});

describe("pe_parse import table", () => {
  test("descriptor with OriginalFirstThunk = 0 still lists functions", async () => {
    const context = await tempContext();
    const pe = Buffer.alloc(0x2400);
    pe.write("MZ", 0, "ascii");
    pe.writeUInt32LE(0x40, 0x3c);          // e_lfanew
    pe.write("PE\0\0", 0x40, "ascii");
    pe.writeUInt16LE(0x014c, 0x44);        // i386
    pe.writeUInt16LE(1, 0x46);             // NumberOfSections
    pe.writeUInt16LE(0xe0, 0x54);          // SizeOfOptionalHeader
    pe.writeUInt16LE(0x0102, 0x56);        // Characteristics
    const opt = 0x58;
    pe.writeUInt16LE(0x010b, opt);         // PE32 magic
    pe.writeUInt32LE(0x1000, opt + 16);    // AddressOfEntryPoint
    pe.writeUInt32LE(0x400000, opt + 28);  // ImageBase
    pe.writeUInt16LE(3, opt + 68);         // Subsystem CUI
    pe.writeUInt32LE(16, opt + 92);        // NumberOfRvaAndSizes
    pe.writeUInt32LE(0x2000, opt + 96 + 8);  // Import directory RVA
    pe.writeUInt32LE(0x28, opt + 96 + 12);   // Import directory size
    const sec = opt + 0xe0;
    pe.write(".rdata\0\0\0", sec, "ascii");
    pe.writeUInt32LE(0x2000, sec + 8);     // VirtualSize
    pe.writeUInt32LE(0x1000, sec + 12);    // VirtualAddress
    pe.writeUInt32LE(0x2000, sec + 16);    // SizeOfRawData
    pe.writeUInt32LE(0x400, sec + 20);     // PointerToRawData
    pe.writeUInt32LE(0x40000040, sec + 36);
    const raw = (rva: number) => rva - 0x1000 + 0x400;
    const desc = raw(0x2000);
    pe.writeUInt32LE(0, desc);             // OriginalFirstThunk = 0
    pe.writeUInt32LE(0x2100, desc + 12);   // Name RVA
    pe.writeUInt32LE(0x2200, desc + 16);   // FirstThunk RVA
    pe.write("FOO.dll\0", raw(0x2100), "ascii");
    pe.writeUInt32LE(0x2300, raw(0x2200)); // IAT[0] -> hint/name
    pe.writeUInt32LE(0, raw(0x2204));
    pe.writeUInt16LE(0, raw(0x2300));      // hint
    pe.write("SomeFunc\0", raw(0x2302), "ascii");
    const file = path.join(context.workspace, "oft0.exe");
    await fs.writeFile(file, pe);

    const result = await getTool(binTools, "pe_parse").execute({ path: "oft0.exe" }, context);
    const out = text(result);
    expect(out).toContain("FOO.dll");
    expect(out).toContain("SomeFunc");
  });
});

describe("yara_scan js fallback", () => {
  async function scan(context: ToolContext, rule: string, target: string, bytes: Buffer): Promise<string> {
    await fs.writeFile(path.join(context.workspace, "rule.yar"), rule);
    await fs.writeFile(path.join(context.workspace, target), bytes);
    const result = await getTool(yaraTools, "yara_scan").execute(
      { rulePath: "rule.yar", targetPath: target }, context,
    );
    return text(result);
  }

  test("hex wildcards match exactly one unknown byte", async () => {
    const context = await tempContext();
    const rule = [
      "rule wildcard_test {",
      "    strings:",
      "        $a = { aa bb ?? cc }",
      "    condition:",
      "        1 of ($a*)",
      "}",
    ].join("\n");
    const hit = await scan(context, rule, "hit.bin", Buffer.from([0xaa, 0xbb, 0xff, 0xcc]));
    expect(hit).toContain("matches: 1");
    const miss = await scan(context, rule, "miss.bin", Buffer.from([0xaa, 0xbb, 0xcc]));
    expect(miss).toContain("matches: 0");
  });

  test("escaped quotes inside a rule string do not truncate it", async () => {
    const context = await tempContext();
    const rule = [
      "rule quoted {",
      "    strings:",
      "        $a = \"say \\\"hi\\\" now\" ascii",
      "    condition:",
      "        $a",
      "}",
    ].join("\n");
    const out = await scan(context, rule, "q.bin", Buffer.from("junk say \"hi\" now junk", "ascii"));
    expect(out).toContain("matches: 1");
  });

  test("a URL string containing // is not eaten by comment stripping", async () => {
    const context = await tempContext();
    const rule = [
      "rule has_url {",
      "    strings:",
      "        $a = \"https://evil.invalid/payload\" ascii  // c2 url",
      "    condition:",
      "        $a",
      "}",
    ].join("\n");
    const out = await scan(context, rule, "u.bin", Buffer.from("see https://evil.invalid/payload here", "ascii"));
    expect(out).toContain("matches: 1");
  });
});

describe("yara_generate code patterns", () => {
  test("a prologue at the very end of the file is found", async () => {
    const context = await tempContext();
    await fs.writeFile(path.join(context.workspace, "tail.bin"), Buffer.from([0x55, 0x48, 0x89, 0xe5]));
    const result = await getTool(yaraTools, "yara_generate").execute({ path: "tail.bin" }, context);
    expect(result.details).toMatchObject({ code: 1 });
  });
});
