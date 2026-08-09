#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeEntry, KnowledgeIndex } from "../src/knowledge";

const DEFAULT_ROOTS = [
  "/Users/nongjiawu/frida/reverse-engineering/android_reversing/docs",
  "/Users/nongjiawu/frida/reverse-engineering/web_reversing/docs",
  "/Users/nongjiawu/frida/reverse-engineering/README.md",
  "/Users/nongjiawu/frida/reverse-engineering/QUICK_START.md",
  "/Users/nongjiawu/frida/reverse_engineering/android_reversing/docs",
  "/Users/nongjiawu/frida/reverse_engineering/web_reversing/docs",
  "/Users/nongjiawu/frida/reverse_engineering/README.md",
  "/Users/nongjiawu/frida/reverse_engineering/QUICK_START.md",
];

const SKIP_PARTS = new Set([".git", ".claude", ".agents", "node_modules", "venv", "__pycache__", "output", "public", "site"]);

async function main(): Promise<void> {
  const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS;
  const files: string[] = [];
  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => undefined);
    if (!stat) continue;
    if (stat.isFile() && isMarkdown(root)) files.push(root);
    else if (stat.isDirectory()) await walk(root, files);
  }
  const entries = (await Promise.all(files.sort().map(file => entryFor(file)))).filter((entry): entry is KnowledgeEntry => Boolean(entry));
  const index: KnowledgeIndex = {
    generatedAt: new Date().toISOString(),
    sourceRoots: roots,
    entries,
  };
  const out = path.join(projectRoot(), "knowledge", "reverse-index.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  process.stdout.write(`indexed ${entries.length} documents -> ${out}\n`);
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_PARTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && isMarkdown(full)) out.push(full);
  }
}

async function entryFor(file: string): Promise<KnowledgeEntry | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined);
  if (!text) return undefined;
  const title = titleOf(text) || path.basename(file, path.extname(file));
  const relative = relativeKnowledgePath(file);
  const tags = tagsFor(file, text);
  return {
    id: slug(relative),
    title,
    path: file,
    source: file.includes("/frida/reverse-engineering/") ? "frida/reverse-engineering" : "frida/reverse_engineering",
    kind: "markdown",
    tags,
    summary: summarize(text),
    preview: stripMarkdown(text).slice(0, 2400),
  };
}

function isMarkdown(file: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(file);
}

function titleOf(text: string): string | undefined {
  const frontmatterTitle = /^---[\s\S]*?\ntitle:\s*["']?(.+?)["']?\n[\s\S]*?---/m.exec(text)?.[1];
  if (frontmatterTitle) return frontmatterTitle.trim();
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
}

function summarize(text: string): string {
  const clean = stripMarkdown(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("```"))
    .join(" ");
  return clean.length > 700 ? `${clean.slice(0, 697)}...` : clean;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^---[\s\S]*?\n---\s*/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[#>*_`|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagsFor(file: string, text: string): string[] {
  const parts = relativeKnowledgePath(file).toLowerCase().split(/[\/_.\-\s]+/);
  const bag = new Set(parts.filter(part => part.length > 2));
  const lower = text.toLowerCase();
  const keywords = [
    "android", "frida", "unidbg", "xposed", "magisk", "jni", "dex", "apk", "so", "web",
    "wasm", "javascript", "crypto", "tls", "webrtc", "anti-debug", "hook", "root", "emulator",
    "drm", "flutter", "unity", "native", "proxy", "captcha", "fingerprint",
  ];
  for (const keyword of keywords) {
    if (lower.includes(keyword)) bag.add(keyword);
  }
  return [...bag].slice(0, 16);
}

function relativeKnowledgePath(file: string): string {
  for (const marker of ["/frida/reverse-engineering/", "/frida/reverse_engineering/"]) {
    const index = file.indexOf(marker);
    if (index >= 0) return file.slice(index + marker.length);
  }
  return file;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
