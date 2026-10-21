import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDiffTools } from "./diff-tools";
import type { ToolContext } from "../types";

const tools = createDiffTools();

function getTool(name: string) {
  const found = tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map(block => block.text ?? "").join("");

async function tempContext(): Promise<{ context: ToolContext; workspace: string }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-diff-tools-"));
  return {
    workspace,
    context: {
      workspace,
      sessionDir: workspace,
      policy: {
        allowWrites: true,
        allowNetwork: false,
        allowSensitive: false,
        commandTimeoutMs: 1000,
        maxReadBytes: 64 * 1024,
        maxToolOutputChars: 24_000,
        approvalMode: "safe",
        approvals: {},
      },
    },
  };
}

describe("binary_diff patch detection", () => {
  test("detects a NOP sled patched at end-of-file (window truncated to minLen)", async () => {
    const { context, workspace } = await tempContext();
    const a = Buffer.alloc(100, 0x41);
    const b = Buffer.from(a);
    for (let i = 92; i < 100; i++) b[i] = 0x90;
    await fs.writeFile(path.join(workspace, "a.bin"), a);
    await fs.writeFile(path.join(workspace, "b.bin"), b);

    const result = await getTool("binary_diff").execute({ pathA: "a.bin", pathB: "b.bin" }, context);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("patched to NOP sled");
  });

  test("detects a NOP patch on a tiny file without a negative subarray end", async () => {
    const { context, workspace } = await tempContext();
    // 6-byte files, contextBytes default 8: the old window end went negative.
    await fs.writeFile(path.join(workspace, "a.bin"), Buffer.from([0x41, 0x41, 0x74, 0x41, 0x41, 0x41]));
    await fs.writeFile(path.join(workspace, "b.bin"), Buffer.from([0x90, 0x90, 0x74, 0x41, 0x41, 0x41]));

    const result = await getTool("binary_diff").execute({ pathA: "a.bin", pathB: "b.bin" }, context);
    expect(text(result)).toContain("patched to NOP sled");
  });

  test("reports CALL redirection with correct absolute targets when the opcode straddles the diff", async () => {
    const { context, workspace } = await tempContext();
    const a = Buffer.alloc(32, 0x41);
    const b = Buffer.from(a);
    // CALL rel32 at offset 8; only the displacement differs (first diff at 10).
    a[8] = 0xe8; a.writeUInt32LE(0x100, 9);
    b[8] = 0xe8; b.writeUInt32LE(0x200, 9);
    await fs.writeFile(path.join(workspace, "a.bin"), a);
    await fs.writeFile(path.join(workspace, "b.bin"), b);

    const result = await getTool("binary_diff").execute({ pathA: "a.bin", pathB: "b.bin" }, context);
    const out = text(result);
    expect(out).toContain("CALL target redirected");
    // window starts at 10-5=5, opcode at window +3, target = 5+3+5+disp
    expect(out).toContain("0x10d");
    expect(out).toContain("0x20d");
  });

  test("JE→JNE single-byte flip is still detected", async () => {
    const { context, workspace } = await tempContext();
    const a = Buffer.alloc(64, 0x41);
    const b = Buffer.from(a);
    a[20] = 0x74; b[20] = 0x75;
    await fs.writeFile(path.join(workspace, "a.bin"), a);
    await fs.writeFile(path.join(workspace, "b.bin"), b);

    const result = await getTool("binary_diff").execute({ pathA: "a.bin", pathB: "b.bin" }, context);
    expect(text(result)).toContain("JE→JNE");
  });
});

// Minimal ELF64 with four section headers, used to exercise the section parser.
function craftElf64(options: { textSize: number; dataSize: number }): Buffer {
  const shoff = 104;
  const buf = Buffer.alloc(shoff + 4 * 64);
  // e_ident
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(buf, 0);
  buf.writeUInt32LE(2, 16);       // e_type = EXEC
  buf.writeUInt32LE(0x3e, 18);    // e_machine = x86-64
  buf.writeUInt32LE(1, 20);       // e_version
  buf.writeBigUInt64LE(0x401000n, 24); // e_entry
  buf.writeBigUInt64LE(0n, 32);   // e_phoff
  buf.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  buf.writeUInt32LE(0, 48);       // e_flags
  buf.writeUInt16LE(64, 52);      // e_ehsize
  buf.writeUInt16LE(64, 58);      // e_shentsize
  buf.writeUInt16LE(4, 60);       // e_shnum
  buf.writeUInt16LE(3, 62);       // e_shstrndx
  // section data: .text at 64 (8 bytes), .data at 72 (4 bytes), shstrtab at 76
  buf.write(".text!", 64, "ascii");
  buf.write("abcd", 72, "ascii");
  const shstrtab = "\0.text\0.data\0.shstrtab\0";
  buf.write(shstrtab, 76, "ascii");

  const header = (index: number, name: number, type: number, addr: number, offset: number, size: number) => {
    const off = shoff + index * 64;
    buf.writeUInt32LE(name, off);
    buf.writeUInt32LE(type, off + 4);
    buf.writeBigUInt64LE(2n, off + 8); // sh_flags = ALLOC+EXEC
    buf.writeBigUInt64LE(BigInt(addr), off + 16);
    buf.writeBigUInt64LE(BigInt(offset), off + 24);
    buf.writeBigUInt64LE(BigInt(size), off + 32);
  };
  header(0, 0, 0, 0, 0, 0);
  header(1, 1, 1, 0x401000, 64, options.textSize);
  header(2, 7, 1, 0x402000, 72, options.dataSize);
  header(3, 13, 3, 0, 76, shstrtab.length);
  return buf;
}

describe("section_diff", () => {
  test("parses crafted ELF sections and renders a negative size delta without '0x-'", async () => {
    const { context, workspace } = await tempContext();
    await fs.writeFile(path.join(workspace, "e1.elf"), craftElf64({ textSize: 6, dataSize: 4 }));
    await fs.writeFile(path.join(workspace, "e2.elf"), craftElf64({ textSize: 6, dataSize: 2 }));

    const result = await getTool("section_diff").execute({ pathA: "e1.elf", pathB: "e2.elf" }, context);
    const out = text(result);
    expect(result.isError).toBeFalsy();
    expect(out).toContain(".text");
    expect(out).toContain(".data");
    expect(out).toContain("-0x2");
    expect(out).not.toContain("0x-");
    expect(result.details).toMatchObject({ formatA: "ELF", formatB: "ELF" });
  });
});

describe("string_diff", () => {
  test("pairs near-duplicate strings and reports the rest as added/removed", async () => {
    const { context, workspace } = await tempContext();
    await fs.writeFile(path.join(workspace, "s1.bin"), Buffer.from("SECRETKEY_AAAA\0ONLY_IN_A_0123456789\0tail padding"));
    await fs.writeFile(path.join(workspace, "s2.bin"), Buffer.from("SECRETKEY_BBBB\0tail padding"));

    const result = await getTool("string_diff").execute({ pathA: "s1.bin", pathB: "s2.bin" }, context);
    const out = text(result);
    expect(result.isError).toBeFalsy();
    expect(out).toContain("SECRETKEY_AAAA");
    expect(out).toContain("SECRETKEY_BBBB");
    expect(out).toContain("ONLY_IN_A_0123456789");
  });
});
