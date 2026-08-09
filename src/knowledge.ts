import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clip } from "./utils";
import { projectRoot } from "./skills";

export interface KnowledgeEntry {
  id: string;
  title: string;
  path: string;
  source: string;
  kind: string;
  tags: string[];
  summary: string;
  preview?: string;
}

export interface KnowledgeIndex {
  generatedAt: string;
  sourceRoots: string[];
  entries: KnowledgeEntry[];
}

export function knowledgeIndexPath(): string {
  return path.join(projectRoot(), "knowledge", "reverse-index.json");
}

export async function loadKnowledgeIndex(file = knowledgeIndexPath()): Promise<KnowledgeIndex> {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined);
  if (!raw) return { generatedAt: "", sourceRoots: [], entries: [] };
  const parsed = JSON.parse(raw) as KnowledgeIndex;
  if (!Array.isArray(parsed.entries)) return { generatedAt: "", sourceRoots: [], entries: [] };
  return parsed;
}

export async function searchKnowledge(query: string, limit = 8): Promise<KnowledgeEntry[]> {
  const index = await loadKnowledgeIndex();
  const terms = query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/i).filter(Boolean);
  const scored = index.entries
    .map(entry => ({ entry, score: scoreEntry(entry, terms) }))
    .filter(item => terms.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  return scored.slice(0, Math.max(1, Math.min(limit, 50))).map(item => item.entry);
}

export async function readKnowledgeEntry(idOrPath: string): Promise<KnowledgeEntry | undefined> {
  const index = await loadKnowledgeIndex();
  const needle = idOrPath.toLowerCase();
  return index.entries.find(entry => entry.id.toLowerCase() === needle || entry.path.toLowerCase() === needle);
}

export async function readKnowledgeText(entry: KnowledgeEntry, maxBytes = 24_000): Promise<string> {
  const text = await fs.readFile(entry.path, "utf8").catch(() => entry.preview ?? entry.summary);
  return clip(text, Math.max(1024, maxBytes));
}

export interface PackedContext {
  text: string;
  used: KnowledgeEntry[];
  truncated: KnowledgeEntry[];
}

export interface PackKnowledgeOptions {
  /** Hard ceiling on the packed text, in UTF-8 bytes. */
  maxBytes?: number;
  /** How many leading entries get their file body inlined. */
  fullTextCount?: number;
  /** Ceiling per inlined body, handed to `readKnowledgeText`. */
  maxEntryBytes?: number;
}

const DEFAULT_PACK_BYTES = 40_000;
const DEFAULT_FULL_TEXT_COUNT = 3;
const DEFAULT_ENTRY_BYTES = 12_000;

/**
 * Builds the model-facing context block for a set of search hits.
 *
 * The first `fullTextCount` entries are inlined with their file body; the rest
 * contribute id/title/tags/summary only. Any entry that would push the block past
 * `maxBytes` is skipped and reported in `truncated`, so the caller can tell the
 * operator what was cut. Packing keeps going after a skip: one oversized body must
 * not cost the model the cheap metadata of every hit behind it.
 */
export async function packKnowledgeContext(
  entries: KnowledgeEntry[],
  options: PackKnowledgeOptions = {},
): Promise<PackedContext> {
  const maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_PACK_BYTES);
  const fullTextCount = Math.max(0, options.fullTextCount ?? DEFAULT_FULL_TEXT_COUNT);
  const maxEntryBytes = Math.max(256, options.maxEntryBytes ?? DEFAULT_ENTRY_BYTES);

  const blocks: string[] = [];
  const used: KnowledgeEntry[] = [];
  const truncated: KnowledgeEntry[] = [];
  let size = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const body = i < fullTextCount ? await readKnowledgeText(entry, maxEntryBytes) : undefined;
    const block = renderEntryBlock(entry, body);
    const cost = byteLength(block) + (blocks.length > 0 ? 2 : 0);
    if (size + cost > maxBytes) {
      truncated.push(entry);
      continue;
    }
    blocks.push(block);
    used.push(entry);
    size += cost;
  }

  return { text: blocks.join("\n\n"), used, truncated };
}

export const KNOWLEDGE_SYSTEM_PROMPT = [
  "You are 0xAF-Re's reverse-engineering knowledge assistant.",
  "",
  "You answer ONLY from the knowledge entries supplied in the user message.",
  "The entries are the whole world: do not add tools, flags, versions, APIs, or steps that are",
  "not in them, even when you happen to know them. When the entries do not cover the question,",
  "say so plainly in the 结论 section and state what they do cover instead - never paper over the",
  "gap with your own recollection.",
  "",
  "Answer in the language of the question. Write for an operator at a terminal: terse, decided,",
  "no hedging, no restating the question, no closing summary.",
  "",
  "Reply with exactly these four markers, in this order, nothing before or after:",
  "",
  "### 结论",
  "<2-4 sentences: what to actually do, decided>",
  "### 步骤",
  "1. <actionable step, command inline when there is one>",
  "### 坑",
  "- <known failure mode / gotcha>",
  "### 出处",
  "[entry-id] [entry-id]",
  "",
  "Rules:",
  "- 出处 lists only ids that literally appear in the supplied entries. Never invent an id, never",
  "  cite a file path, URL, or title - ids only, in square brackets, separated by spaces.",
  "- 步骤 is numbered and actionable; put the command inline on the step it belongs to.",
  "- 坑 records failure modes the entries actually document. Write `- 无` when they record none.",
  "- Keep every section short. One line per step, one line per 坑.",
].join("\n");

/** Renders the user-side prompt: the question, the packed entries, and the citable ids. */
export function buildKnowledgePrompt(query: string, packed: PackedContext): string {
  const ids = packed.used.map(entry => `[${entry.id}]`).join(" ");
  const lines = [`# 问题`, query.trim() || "(empty query)", "", "# 知识条目"];
  if (packed.used.length === 0) {
    lines.push("(检索没有命中任何条目)");
  } else {
    lines.push(packed.text);
  }
  lines.push("");
  if (packed.truncated.length > 0) {
    lines.push(`(另有 ${packed.truncated.length} 条命中因上下文预算被略去，不要引用它们)`);
  }
  lines.push(`可引用的 id：${ids || "(无)"}`);
  lines.push("按规定的四个标记回答，出处只写上面出现过的 id。");
  return lines.join("\n");
}

export interface KnowledgeAnswer {
  conclusion: string;
  steps: string[];
  pitfalls: string[];
  /** Cited ids resolved against the supplied entries, de-duplicated, first-seen order. */
  citations: KnowledgeEntry[];
  /** Cited ids that resolve to nothing - surfaced to the operator, never dropped. */
  inventedCitations: string[];
  /** False when no section marker was found and the whole reply fell back to `raw`. */
  parsed: boolean;
  raw: string;
}

type SectionKey = "conclusion" | "steps" | "pitfalls" | "sources";

const SECTION_ALIASES: Record<string, SectionKey> = {
  "结论": "conclusion",
  "总结": "conclusion",
  "conclusion": "conclusion",
  "步骤": "steps",
  "steps": "steps",
  "step": "steps",
  "坑": "pitfalls",
  "坑点": "pitfalls",
  "踩坑": "pitfalls",
  "pitfalls": "pitfalls",
  "pitfall": "pitfalls",
  "gotchas": "pitfalls",
  "出处": "sources",
  "来源": "sources",
  "引用": "sources",
  "sources": "sources",
  "source": "sources",
  "citations": "sources",
  "references": "sources",
};

const HEADING_RE =
  /^[ \t]{0,3}(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*([A-Za-z一-鿿][A-Za-z 一-鿿]{0,18})[ \t]*(?:\*\*|__)?[ \t]*(?:[:：][ \t]*(.*))?$/;
const BULLET_RE = /^[ \t]*(?:[-*+•·]|\(\d{1,3}\)|\d{1,3}[.)、])[ \t]*(.+)$/;
/** `[id]` not followed by `(` so markdown links are not mistaken for citations. */
const CITATION_RE = /\[([^\[\]]{1,200})\](?!\()/g;
const BARE_CITATION_RE = /\[([^\[\]\s]{1,120})\](?!\()/g;
const ID_SHAPE_RE = /^[A-Za-z0-9][A-Za-z0-9._/#:@-]{0,80}$/;

/**
 * Parses a model reply into the four sections and validates every cited id.
 *
 * Forgiving about shape: any heading level, bold headings, English aliases, numbered or
 * bulleted lists, sections out of order or missing. Unforgiving about citations - an id that
 * does not resolve against `entries` lands in `inventedCitations` rather than being dropped,
 * because a knowledge tool that cites entries which do not exist is worse than one that cites
 * nothing.
 */
export function parseKnowledgeAnswer(text: string, entries: KnowledgeEntry[]): KnowledgeAnswer {
  const raw = text ?? "";
  const sections = new Map<SectionKey, string[]>();
  let current: SectionKey | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const heading = matchHeading(line);
    if (heading) {
      current = heading.key;
      const bucket = sections.get(current) ?? [];
      if (heading.rest) bucket.push(heading.rest);
      sections.set(current, bucket);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }

  const parsed = sections.size > 0;
  const sourceLines = sections.get("sources");
  const citationText = sourceLines ? sourceLines.join("\n") : raw;
  const tokens = citationTokens(citationText, entries, sourceLines !== undefined);
  const { citations, inventedCitations } = resolveCitations(tokens, entries);

  return {
    conclusion: parsed ? joinLines(sections.get("conclusion")) : "",
    steps: parsed ? toItems(sections.get("steps")) : [],
    pitfalls: parsed ? toItems(sections.get("pitfalls")) : [],
    citations,
    inventedCitations,
    parsed,
    raw,
  };
}

/** Plain-text rendering; the call site owns any coloring. */
export function formatKnowledgeAnswer(answer: KnowledgeAnswer): string {
  const parts: string[] = [];
  if (!answer.parsed) {
    parts.push("! 模型未按要求的格式输出，以下为原始回答。");
    parts.push(answer.raw.trim() || "(空回答)");
  } else {
    if (answer.conclusion) parts.push(["▸ 结论", indent(answer.conclusion)].join("\n"));
    if (answer.steps.length > 0) {
      parts.push(["▸ 步骤", ...answer.steps.map((step, i) => `  ${i + 1}. ${step}`)].join("\n"));
    }
    if (answer.pitfalls.length > 0) {
      parts.push(["▸ 坑", ...answer.pitfalls.map(pitfall => `  • ${pitfall}`)].join("\n"));
    }
    if (parts.length === 0) parts.push(answer.raw.trim() || "(空回答)");
  }
  if (answer.citations.length > 0) {
    parts.push(["▸ 出处", ...answer.citations.map(entry => `  [${entry.id}] ${entry.title}`)].join("\n"));
  }
  if (answer.inventedCitations.length > 0) {
    const ids = answer.inventedCitations.map(id => `[${id}]`).join(" ");
    parts.push(`! 警告：以下引用在知识索引中不存在，请勿采信：${ids}`);
  }
  return parts.join("\n\n");
}

export function formatKnowledgeMatches(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return "No matching reverse-engineering knowledge entries.";
  return entries.map(entry => [
    `## ${entry.id}  ${entry.title}`,
    `path: ${entry.path}`,
    `tags: ${entry.tags.join(", ") || "-"}`,
    entry.summary,
  ].join("\n")).join("\n\n");
}

export function formatKnowledgeDigest(query: string, entries: KnowledgeEntry[]): string {
  const trimmed = query.trim();
  if (entries.length === 0) {
    return [
      "KNOWLEDGE QUERY DIGEST",
      `query: ${trimmed || "(empty)"}`,
      "hits: 0",
      "",
      "conclusion:",
      "- No local reverse-engineering knowledge entries matched.",
    ].join("\n");
  }

  const lines = [
    "KNOWLEDGE QUERY DIGEST",
    `query: ${trimmed || "(empty)"}`,
    `hits: ${entries.length}`,
    "",
    "agent contract:",
    "- Treat these hits as retrieved local evidence, not as the final answer.",
    "- Synthesize the user-facing reply into: 结论, 步骤, 坑, 出处.",
    "- Cite only ids shown below, formatted like [entry-id].",
    "- If the summaries are not enough, call knowledge_read on the strongest id before answering.",
    "",
    "evidence:",
  ];

  entries.forEach((entry, index) => {
    const reasons = digestReasons(trimmed, entry);
    lines.push(
      `${index + 1}. [${entry.id}] ${entry.title}`,
      `   tags: ${entry.tags.join(", ") || "-"}`,
      `   source: ${entry.source || entry.kind || "-"} · ${entry.path}`,
      `   why: ${reasons.join(", ") || "ranked by local search"}`,
      `   summary: ${oneLine(entry.summary || entry.preview || "(no summary)")}`,
    );
  });

  lines.push(
    "",
    "answer scaffold:",
    "### 结论",
    "- <summarize the operational answer from the evidence>",
    "### 步骤",
    "1. <next action; read a cited entry first when more detail is needed>",
    "### 坑",
    "- <gotcha documented in evidence, or 无>",
    "### 出处",
    entries.slice(0, 5).map(entry => `[${entry.id}]`).join(" "),
  );

  return lines.join("\n");
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** One packed entry, delimited and stamped with the id the model must cite. */
function renderEntryBlock(entry: KnowledgeEntry, body?: string): string {
  const lines = [
    `<<< ENTRY [${entry.id}] >>>`,
    `title: ${entry.title}`,
    `path: ${entry.path}`,
    `tags: ${entry.tags.join(", ") || "-"}`,
    `summary: ${entry.summary}`,
  ];
  if (body !== undefined) {
    lines.push("--- content ---", body);
  }
  lines.push(`<<< END [${entry.id}] >>>`);
  return lines.join("\n");
}

function matchHeading(line: string): { key: SectionKey; rest: string } | undefined {
  const match = HEADING_RE.exec(line);
  if (!match) return undefined;
  const name = match[1].replace(/\s+/g, "").toLowerCase();
  const key = SECTION_ALIASES[name];
  if (!key) return undefined;
  return { key, rest: (match[2] ?? "").trim() };
}

function joinLines(lines: string[] | undefined): string {
  if (!lines) return "";
  return lines.map(line => line.trim()).filter(Boolean).join("\n").trim();
}

/**
 * Turns a section body into items. Bullets and numbered lists start new items;
 * a plain line after one continues it; a blank line closes it.
 */
function toItems(lines: string[] | undefined): string[] {
  if (!lines) return [];
  const items: string[] = [];
  let open = false;
  for (const line of lines) {
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      items.push(bullet[1].trim());
      open = true;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      open = false;
      continue;
    }
    if (open && items.length > 0) items[items.length - 1] = `${items[items.length - 1]} ${trimmed}`;
    else {
      items.push(trimmed);
      open = true;
    }
  }
  return items.filter(Boolean);
}

/**
 * Pulls citation tokens out of the 出处 section (or, when there is none, out of the
 * whole reply). Bracketed ids win; a bare id list is accepted only for tokens that
 * actually resolve, so prose is not mistaken for a citation.
 */
function citationTokens(text: string, entries: KnowledgeEntry[], fromSection: boolean): string[] {
  const tokens: string[] = [];
  const pattern = fromSection ? CITATION_RE : BARE_CITATION_RE;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    for (const token of match[1].split(/[\s,，、;；]+/)) {
      const cleaned = token.trim().replace(/^[`'"]+|[`'".,;]+$/g, "");
      if (cleaned && (fromSection || ID_SHAPE_RE.test(cleaned))) tokens.push(cleaned);
    }
  }
  if (tokens.length > 0 || !fromSection) return tokens;

  const known = new Set(entries.map(entry => entry.id.toLowerCase()));
  return text
    .split(/[\s,，、;；]+/)
    .map(token => token.trim())
    .filter(token => known.has(token.toLowerCase()));
}

function resolveCitations(
  tokens: string[],
  entries: KnowledgeEntry[],
): { citations: KnowledgeEntry[]; inventedCitations: string[] } {
  const byId = new Map(entries.map(entry => [entry.id.toLowerCase(), entry]));
  const citations: KnowledgeEntry[] = [];
  const inventedCitations: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byId.get(key);
    if (entry) citations.push(entry);
    else inventedCitations.push(token);
  }
  return { citations, inventedCitations };
}

function indent(text: string): string {
  return text.split("\n").map(line => `  ${line}`).join("\n");
}

function scoreEntry(entry: KnowledgeEntry, terms: string[]): number {
  if (terms.length === 0) return 1;
  const title = entry.title.toLowerCase();
  const tags = entry.tags.join(" ").toLowerCase();
  const pathText = entry.path.toLowerCase();
  const summary = `${entry.summary}\n${entry.preview ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 8;
    if (tags.includes(term)) score += 6;
    if (pathText.includes(term)) score += 3;
    if (summary.includes(term)) score += 1;
  }
  return score;
}

function digestReasons(query: string, entry: KnowledgeEntry): string[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/i).filter(Boolean);
  if (terms.length === 0) return [];
  const fields: Array<[string, string]> = [
    ["title", entry.title],
    ["tags", entry.tags.join(" ")],
    ["path", entry.path],
    ["summary", `${entry.summary}\n${entry.preview ?? ""}`],
  ];
  const reasons: string[] = [];
  for (const [name, value] of fields) {
    const lower = value.toLowerCase();
    const matched = terms.filter(term => lower.includes(term)).slice(0, 3);
    if (matched.length > 0) reasons.push(`${name} matches ${matched.join("/")}`);
  }
  return reasons;
}

function oneLine(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), 260);
}
