import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  KNOWLEDGE_SYSTEM_PROMPT,
  buildKnowledgePrompt,
  formatKnowledgeAnswer,
  formatKnowledgeDigest,
  formatKnowledgeMatches,
  packKnowledgeContext,
  parseKnowledgeAnswer,
} from "./knowledge";
import type { KnowledgeEntry } from "./knowledge";

const SCRATCH = "/private/tmp/claude-501/-Users-nongjiawu-playground-research-0xaf-re-agent/722edefc-85dd-4156-b480-e6875e4f68d4/scratchpad";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function scratchDir(): Promise<string> {
  await fs.mkdir(SCRATCH, { recursive: true });
  const dir = await fs.mkdtemp(path.join(SCRATCH, "knowledge-"));
  dirs.push(dir);
  return dir;
}

function entry(id: string, extra: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id,
    title: `title-${id}`,
    path: `/nonexistent/${id}.md`,
    source: "test",
    kind: "note",
    tags: ["frida", "android"],
    summary: `summary-${id}`,
    ...extra,
  };
}

/** Writes each entry's body to a temp file and points `path` at it. */
async function withFiles(specs: Array<{ id: string; body: string }>): Promise<KnowledgeEntry[]> {
  const dir = await scratchDir();
  return await Promise.all(
    specs.map(async spec => {
      const file = path.join(dir, `${spec.id}.md`);
      await fs.writeFile(file, spec.body, "utf8");
      return entry(spec.id, { path: file });
    }),
  );
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** A metadata-only block big enough to exercise the byte budget (which floors at 256). */
const padded = (id: string) => entry(id, { summary: `summary-${id} `.padEnd(400, "x") });

describe("packKnowledgeContext", () => {
  test("inlines file text only for the top N entries", async () => {
    const entries = await withFiles([
      { id: "a", body: "BODY-A hook art method" },
      { id: "b", body: "BODY-B unpack dex" },
      { id: "c", body: "BODY-C ollvm flattening" },
    ]);
    const packed = await packKnowledgeContext(entries, { fullTextCount: 2 });

    expect(packed.used).toEqual(entries);
    expect(packed.truncated).toEqual([]);
    expect(packed.text).toContain("BODY-A hook art method");
    expect(packed.text).toContain("BODY-B unpack dex");
    // The third entry is present, but as metadata only.
    expect(packed.text).not.toContain("BODY-C");
    expect(packed.text).toContain("summary-c");
  });

  test("labels every packed entry with its id", async () => {
    const entries = await withFiles([
      { id: "alpha", body: "one" },
      { id: "beta", body: "two" },
      { id: "gamma", body: "three" },
      { id: "delta", body: "four" },
    ]);
    const packed = await packKnowledgeContext(entries, { fullTextCount: 1 });

    for (const item of packed.used) {
      expect(packed.text).toContain(`<<< ENTRY [${item.id}] >>>`);
      expect(packed.text).toContain(`<<< END [${item.id}] >>>`);
    }
    expect(packed.used).toHaveLength(4);
  });

  test("stays under maxBytes and reports what was left out", async () => {
    const entries = ["e1", "e2", "e3", "e4"].map(padded);
    // Every block is the same shape, so two of them plus the separator is a precise budget.
    const one = await packKnowledgeContext([entries[0]], { fullTextCount: 0 });
    const budget = byteLength(one.text) * 2 + 2;

    const packed = await packKnowledgeContext(entries, { fullTextCount: 0, maxBytes: budget });
    expect(byteLength(packed.text)).toBeLessThanOrEqual(budget);
    expect(packed.used.map(item => item.id)).toEqual(["e1", "e2"]);
    expect(packed.truncated.map(item => item.id)).toEqual(["e3", "e4"]);
    // used + truncated always accounts for every hit handed in.
    expect([...packed.used, ...packed.truncated]).toEqual(entries);
  });

  test("keeps packing cheap entries after skipping an oversized one", async () => {
    const files = await withFiles([{ id: "huge", body: "Z".repeat(30_000) }]);
    const entries = [files[0], padded("small-1"), padded("small-2")];
    const packed = await packKnowledgeContext(entries, { fullTextCount: 1, maxBytes: 2000 });

    // The 30KB body blows the budget, but the two summary blocks behind it still fit.
    expect(packed.used.map(item => item.id)).toEqual(["small-1", "small-2"]);
    expect(packed.truncated.map(item => item.id)).toEqual(["huge"]);
    expect(byteLength(packed.text)).toBeLessThanOrEqual(2000);
    expect(packed.text).not.toContain("ZZZ");
  });

  test("truncates everything when even the first entry does not fit", async () => {
    const entries = ["e1", "e2"].map(padded);
    const packed = await packKnowledgeContext(entries, { fullTextCount: 0, maxBytes: 256 });
    expect(packed.text).toBe("");
    expect(packed.used).toEqual([]);
    expect(packed.truncated).toEqual(entries);
  });

  test("clips an oversized body instead of blowing the budget", async () => {
    const entries = await withFiles([{ id: "big", body: "X".repeat(50_000) }]);
    const packed = await packKnowledgeContext(entries, { fullTextCount: 1, maxEntryBytes: 1024 });
    expect(packed.used).toHaveLength(1);
    expect(packed.text).toContain("[truncated");
    expect(byteLength(packed.text)).toBeLessThan(4000);
  });

  test("falls back to the preview when the file is unreadable", async () => {
    const packed = await packKnowledgeContext([entry("ghost", { preview: "PREVIEW-TEXT" })], { fullTextCount: 1 });
    expect(packed.text).toContain("PREVIEW-TEXT");
    expect(packed.used).toHaveLength(1);
  });

  test("handles an empty hit list", async () => {
    const packed = await packKnowledgeContext([]);
    expect(packed).toEqual({ text: "", used: [], truncated: [] });
  });
});

describe("buildKnowledgePrompt", () => {
  test("carries the query, the entries, and the citable ids", async () => {
    const entries = ["a", "b"].map(id => entry(id));
    const packed = await packKnowledgeContext(entries, { fullTextCount: 0 });
    const prompt = buildKnowledgePrompt("  怎么绕过 frida 检测  ", packed);

    expect(prompt).toContain("怎么绕过 frida 检测");
    expect(prompt).toContain("<<< ENTRY [a] >>>");
    expect(prompt).toContain("可引用的 id：[a] [b]");
    expect(prompt).not.toContain("因上下文预算被略去");
  });

  test("warns about dropped entries and never lists them as citable", async () => {
    const entries = ["a", "b", "c"].map(padded);
    const one = await packKnowledgeContext([entries[0]], { fullTextCount: 0 });
    const packed = await packKnowledgeContext(entries, {
      fullTextCount: 0,
      maxBytes: byteLength(one.text),
    });
    const prompt = buildKnowledgePrompt("q", packed);

    expect(packed.truncated).toHaveLength(2);
    expect(prompt).toContain("另有 2 条命中因上下文预算被略去");
    expect(prompt).toContain("可引用的 id：[a]");
    expect(prompt).not.toContain("[b]");
  });

  test("says so when nothing was found", () => {
    const prompt = buildKnowledgePrompt("q", { text: "", used: [], truncated: [] });
    expect(prompt).toContain("(检索没有命中任何条目)");
    expect(prompt).toContain("可引用的 id：(无)");
  });
});

describe("KNOWLEDGE_SYSTEM_PROMPT", () => {
  test("states the four markers and the citation rules", () => {
    for (const marker of ["### 结论", "### 步骤", "### 坑", "### 出处"]) {
      expect(KNOWLEDGE_SYSTEM_PROMPT).toContain(marker);
    }
    expect(KNOWLEDGE_SYSTEM_PROMPT).toContain("`- 无`");
    expect(KNOWLEDGE_SYSTEM_PROMPT).toContain("Never invent an id");
  });
});

const catalog = ["frida-bypass", "art-hook", "dex-unpack"].map(id => entry(id));

const WELL_FORMED = [
  "### 结论",
  "直接用 frida-bypass 里的 ptrace 反检测方案，别自己写。",
  "### 步骤",
  "1. 拉起进程：`frida -U -f com.demo --no-pause`",
  "2. 注入 art-hook 里的脚本",
  "### 坑",
  "- frida-server 版本必须和客户端一致",
  "- SELinux enforcing 下 attach 会静默失败",
  "### 出处",
  "[frida-bypass] [art-hook]",
].join("\n");

describe("parseKnowledgeAnswer", () => {
  test("parses a well-formed answer into all four sections", () => {
    const answer = parseKnowledgeAnswer(WELL_FORMED, catalog);

    expect(answer.parsed).toBe(true);
    expect(answer.conclusion).toBe("直接用 frida-bypass 里的 ptrace 反检测方案，别自己写。");
    expect(answer.steps).toEqual([
      "拉起进程：`frida -U -f com.demo --no-pause`",
      "注入 art-hook 里的脚本",
    ]);
    expect(answer.pitfalls).toEqual([
      "frida-server 版本必须和客户端一致",
      "SELinux enforcing 下 attach 会静默失败",
    ]);
    expect(answer.citations.map(item => item.id)).toEqual(["frida-bypass", "art-hook"]);
    expect(answer.inventedCitations).toEqual([]);
    expect(answer.raw).toBe(WELL_FORMED);
  });

  test("accepts any heading level and surrounding whitespace", () => {
    const text = [
      "#   结论  ",
      "  收工。",
      "  ##  步骤",
      "1. 跑起来",
      "###### 坑",
      "- 无",
      "  # 出处 ",
      "  [art-hook]  ",
    ].join("\n");
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.parsed).toBe(true);
    expect(answer.conclusion).toBe("收工。");
    expect(answer.steps).toEqual(["跑起来"]);
    expect(answer.pitfalls).toEqual(["无"]);
    expect(answer.citations.map(item => item.id)).toEqual(["art-hook"]);
  });

  test("accepts the English aliases and bold headings", () => {
    const text = [
      "**Conclusion**",
      "Use the documented unpacker.",
      "## Steps",
      "1. run it",
      "## Pitfalls",
      "* it is slow",
      "## Sources",
      "[dex-unpack]",
    ].join("\n");
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.parsed).toBe(true);
    expect(answer.conclusion).toBe("Use the documented unpacker.");
    expect(answer.steps).toEqual(["run it"]);
    expect(answer.pitfalls).toEqual(["it is slow"]);
    expect(answer.citations.map(item => item.id)).toEqual(["dex-unpack"]);
  });

  test("accepts every bullet style and wrapped continuation lines", () => {
    const text = [
      "### 步骤",
      "1) first",
      "2、second",
      "(3) third",
      "- fourth",
      "• fifth",
      "  wrapped onto the next line",
      "### 坑",
      "· only one",
    ].join("\n");
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.steps).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth wrapped onto the next line",
    ]);
    expect(answer.pitfalls).toEqual(["only one"]);
  });

  test("takes sections out of order and tolerates missing ones", () => {
    const text = ["### 出处", "[art-hook]", "### 结论", "先看 art-hook。"].join("\n");
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.parsed).toBe(true);
    expect(answer.conclusion).toBe("先看 art-hook。");
    expect(answer.steps).toEqual([]);
    expect(answer.pitfalls).toEqual([]);
    expect(answer.citations.map(item => item.id)).toEqual(["art-hook"]);
  });

  test("reads content placed on the heading line itself", () => {
    const answer = parseKnowledgeAnswer("### 结论：用 art-hook\n### 出处: [art-hook]", catalog);
    expect(answer.conclusion).toBe("用 art-hook");
    expect(answer.citations.map(item => item.id)).toEqual(["art-hook"]);
  });

  test("does not treat ordinary prose as a section heading", () => {
    const text = [
      "### 结论",
      "先做静态分析：",
      "注意：frida-server 要对版本。",
      "hook: 用 art-hook 的脚本。",
      "### 出处",
      "[art-hook]",
    ].join("\n");
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.conclusion).toContain("注意：frida-server 要对版本。");
    expect(answer.conclusion).toContain("hook: 用 art-hook 的脚本。");
    expect(answer.pitfalls).toEqual([]);
    expect(answer.citations.map(item => item.id)).toEqual(["art-hook"]);
  });

  test("sends ids that do not exist to inventedCitations, never to citations", () => {
    const text = ["### 结论", "x", "### 出处", "[frida-bypass] [made-up-entry] [also-fake]"].join("\n");
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.citations.map(item => item.id)).toEqual(["frida-bypass"]);
    expect(answer.inventedCitations).toEqual(["made-up-entry", "also-fake"]);
    // Nothing invented ever leaks into the resolved list.
    expect(answer.citations.some(item => item.id === "made-up-entry")).toBe(false);
  });

  test("de-duplicates citations and keeps first-seen order", () => {
    const text = [
      "### 出处",
      "[dex-unpack] [art-hook] [dex-unpack] [DEX-UNPACK] [nope] [nope]",
    ].join("\n");
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.citations.map(item => item.id)).toEqual(["dex-unpack", "art-hook"]);
    expect(answer.inventedCitations).toEqual(["nope"]);
  });

  test("accepts comma-separated and bare id lists in 出处", () => {
    const commas = parseKnowledgeAnswer("### 出处\n[art-hook, dex-unpack]", catalog);
    expect(commas.citations.map(item => item.id)).toEqual(["art-hook", "dex-unpack"]);

    const bare = parseKnowledgeAnswer("### 出处\nart-hook, frida-bypass", catalog);
    expect(bare.citations.map(item => item.id)).toEqual(["art-hook", "frida-bypass"]);
    expect(bare.inventedCitations).toEqual([]);
  });

  test("falls back when no marker is present but still recovers bracketed ids", () => {
    const text = "Just prose about hooking, see [art-hook] and [ghost-entry] for details.";
    const answer = parseKnowledgeAnswer(text, catalog);

    expect(answer.parsed).toBe(false);
    expect(answer.raw).toBe(text);
    expect(answer.conclusion).toBe("");
    expect(answer.steps).toEqual([]);
    expect(answer.pitfalls).toEqual([]);
    expect(answer.citations.map(item => item.id)).toEqual(["art-hook"]);
    expect(answer.inventedCitations).toEqual(["ghost-entry"]);
  });

  test("does not mistake a markdown link for a citation", () => {
    const answer = parseKnowledgeAnswer("see [the docs](https://example.com) and [art-hook]", catalog);
    expect(answer.parsed).toBe(false);
    expect(answer.citations.map(item => item.id)).toEqual(["art-hook"]);
    expect(answer.inventedCitations).toEqual([]);
  });

  test("handles empty input", () => {
    const answer = parseKnowledgeAnswer("", catalog);
    expect(answer.parsed).toBe(false);
    expect(answer.raw).toBe("");
    expect(answer.citations).toEqual([]);
    expect(answer.inventedCitations).toEqual([]);
  });

  test("resolves nothing when the entry list is empty", () => {
    const answer = parseKnowledgeAnswer("### 出处\n[art-hook]", []);
    expect(answer.citations).toEqual([]);
    expect(answer.inventedCitations).toEqual(["art-hook"]);
  });
});

describe("formatKnowledgeAnswer", () => {
  test("renders the four sections with markers, numbers, and bullets", () => {
    const out = formatKnowledgeAnswer(parseKnowledgeAnswer(WELL_FORMED, catalog));

    expect(out).toContain("▸ 结论");
    expect(out).toContain("▸ 步骤");
    expect(out).toContain("▸ 坑");
    expect(out).toContain("▸ 出处");
    expect(out).toContain("  1. 拉起进程：`frida -U -f com.demo --no-pause`");
    expect(out).toContain("  2. 注入 art-hook 里的脚本");
    expect(out).toContain("  • frida-server 版本必须和客户端一致");
    expect(out).toContain("  [frida-bypass] title-frida-bypass");
    expect(out).toContain("  [art-hook] title-art-hook");
    // No ANSI: coloring belongs to the call site.
    expect(out).not.toContain(String.fromCharCode(0x1b));
    expect(out).not.toContain("警告");
  });

  test("surfaces invented citations in a warning line", () => {
    const text = ["### 结论", "x", "### 出处", "[art-hook] [made-up] [also-fake]"].join("\n");
    const out = formatKnowledgeAnswer(parseKnowledgeAnswer(text, catalog));

    expect(out).toContain("! 警告：");
    expect(out).toContain("[made-up]");
    expect(out).toContain("[also-fake]");
    expect(out).toContain("[art-hook] title-art-hook");
  });

  test("notes the format miss and prints the raw reply", () => {
    const out = formatKnowledgeAnswer(parseKnowledgeAnswer("freeform blah [art-hook]", catalog));

    expect(out).toContain("! 模型未按要求的格式输出");
    expect(out).toContain("freeform blah [art-hook]");
    expect(out).toContain("▸ 出处");
    expect(out).not.toContain("▸ 结论");
  });

  test("omits sections the model left out", () => {
    const out = formatKnowledgeAnswer(parseKnowledgeAnswer("### 结论\n就这样。", catalog));
    expect(out).toBe("▸ 结论\n  就这样。");
  });
});

describe("formatKnowledgeMatches", () => {
  test("still renders raw hits for /know raw", () => {
    expect(formatKnowledgeMatches([])).toBe("No matching reverse-engineering knowledge entries.");
    expect(formatKnowledgeMatches([entry("a")])).toBe(
      ["## a  title-a", "path: /nonexistent/a.md", "tags: frida, android", "summary-a"].join("\n"),
    );
  });
});

describe("formatKnowledgeDigest", () => {
  test("renders an agent-ready synthesis scaffold instead of a raw hit dump", () => {
    const out = formatKnowledgeDigest("frida ssl", [
      entry("ssl-hook", {
        title: "Frida SSL pinning bypass",
        tags: ["frida", "ssl"],
        summary: "Hook TrustManager and certificate checks before attaching.",
      }),
    ]);

    expect(out).toContain("KNOWLEDGE QUERY DIGEST");
    expect(out).toContain("agent contract:");
    expect(out).toContain("### 结论");
    expect(out).toContain("### 步骤");
    expect(out).toContain("### 坑");
    expect(out).toContain("### 出处");
    expect(out).toContain("[ssl-hook] Frida SSL pinning bypass");
    expect(out).toContain("why: title matches frida/ssl");
    expect(out).not.toContain("## ssl-hook");
  });

  test("handles empty results with a structured conclusion slot", () => {
    const out = formatKnowledgeDigest("missing topic", []);
    expect(out).toContain("hits: 0");
    expect(out).toContain("conclusion:");
    expect(out).toContain("No local reverse-engineering knowledge entries matched.");
  });
});
