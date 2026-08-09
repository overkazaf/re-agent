// Context budgeting for long sessions.
//
// The full transcript is always kept on disk and in memory; what this module
// produces is the *view* of it that gets sent to a provider. Two mechanical
// passes, cheapest first, mirroring omp's pruning-then-compaction order:
//
//   1. elide the bodies of old tool results (the bulk of an RE session)
//   2. drop whole oldest exchanges, replacing them with one compaction marker
//
// Both preserve the invariant strict chat APIs care about: an assistant message
// with tool calls is never separated from its tool results.

import type { AgentMessage, ContentBlock } from "../types";
import { textBlock, textFromBlocks } from "../utils";

export interface CompactionOptions {
  /** Token ceiling for the whole message list handed to the provider. */
  budgetTokens: number;
  /** Newest exchanges that are never touched. */
  keepRecentMessages?: number;
  /** Tool results longer than this are candidates for elision. */
  elideToolResultsOver?: number;
}

export interface CompactionResult {
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
  elidedToolResults: number;
  droppedMessages: number;
}

const DEFAULT_KEEP_RECENT = 8;
const DEFAULT_ELIDE_OVER = 400;

/**
 * Rough token estimate. Deliberately cheap and provider-agnostic: ~4 chars per
 * token for latin text, ~1.5 for CJK, which is close enough to drive a budget
 * without pulling in a tokenizer.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else if (code >= 0xf900 && code <= 0xfaff) cjk++;
    else if (code >= 0xff00 && code <= 0xffef) cjk++;
  }
  const latin = Math.max(0, text.length - cjk);
  return Math.ceil(latin / 4 + cjk / 1.5);
}

export function messageTokens(message: AgentMessage): number {
  const body = message.role === "system" ? message.content : textFromBlocks(message.content);
  const toolCalls = message.role === "assistant" && message.toolCalls?.length
    ? JSON.stringify(message.toolCalls)
    : "";
  // +4 for the role/envelope overhead every provider adds per message.
  return estimateTokens(body) + estimateTokens(toolCalls) + 4;
}

export function historyTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

/** Applies the budget to `messages`, returning the list to actually send. */
export function compactHistory(messages: readonly AgentMessage[], options: CompactionOptions): CompactionResult {
  const tokensBefore = historyTokens(messages);
  const keepRecent = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT;
  const elideOver = options.elideToolResultsOver ?? DEFAULT_ELIDE_OVER;
  if (tokensBefore <= options.budgetTokens) {
    return { messages: [...messages], tokensBefore, tokensAfter: tokensBefore, elidedToolResults: 0, droppedMessages: 0 };
  }

  // Pass 1 — elide old tool result bodies. The call and its arguments stay, so
  // the model still knows what was run and can re-run or read the artifact.
  const working = [...messages];
  const protectedFrom = Math.max(0, working.length - keepRecent);
  let elidedToolResults = 0;
  for (let i = 0; i < protectedFrom; i++) {
    const message = working[i];
    if (message.role !== "toolResult") continue;
    const text = textFromBlocks(message.content);
    if (text.length <= elideOver) continue;
    working[i] = {
      ...message,
      content: [textBlock(elidedNote(message.toolName, text))] as ContentBlock[],
    };
    elidedToolResults++;
  }

  // Pass 2 — drop whole exchanges from the front until the budget fits. The
  // keep-recent window is a preference, not a floor: when even it overflows,
  // eat into it rather than silently blowing the budget. The last exchange
  // always survives — without it there is no turn left to answer.
  const hardFloor = Math.max(0, lastExchangeStart(working));
  let droppedMessages = 0;
  let cursor = 0;
  // The marker itself costs tokens (it lists earlier prompts), so it is measured
  // rather than guessed — otherwise the budget is quietly overshot.
  const overBudget = () =>
    historyTokens(working.slice(cursor)) + (cursor > 0 ? messageTokens(compactionMarker(messages.slice(0, cursor))) : 0) >
    options.budgetTokens;
  while (cursor < protectedFrom && overBudget()) {
    cursor = nextBoundary(working, cursor);
    droppedMessages = cursor;
  }
  while (cursor < hardFloor && overBudget()) {
    cursor = nextBoundary(working, cursor);
    droppedMessages = cursor;
  }

  const kept = working.slice(cursor);
  const out = droppedMessages > 0 ? [compactionMarker(messages.slice(0, droppedMessages)), ...kept] : kept;
  return { messages: out, tokensBefore, tokensAfter: historyTokens(out), elidedToolResults, droppedMessages };
}

/**
 * Advances past one whole exchange: a message plus, when it is an assistant
 * turn with tool calls, all of its tool results.
 */
function nextBoundary(messages: readonly AgentMessage[], from: number): number {
  let index = from + 1;
  while (index < messages.length && messages[index].role === "toolResult") index++;
  return index;
}

/** Index where the final user→assistant→tools exchange begins. */
function lastExchangeStart(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return 0;
}

function elidedNote(toolName: string, text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const head = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  return `[older ${toolName} result elided to save context: ${text.length} chars. First line: ${head}]`;
}

/** One user message standing in for everything that was dropped. */
export function compactionMarker(dropped: readonly AgentMessage[]): AgentMessage {
  const prompts = dropped
    .filter(message => message.role === "user")
    .map(message => textFromBlocks(message.content).split("\n", 1)[0] ?? "")
    .filter(Boolean)
    .slice(-6)
    .map(line => `- ${line.length > 100 ? `${line.slice(0, 97)}…` : line}`);
  const tools = new Set(
    dropped.filter(message => message.role === "toolResult").map(message => (message as { toolName: string }).toolName),
  );
  const lines = [
    `[context compacted] ${dropped.length} earlier messages were dropped to stay inside the context budget.`,
    prompts.length > 0 ? `Earlier requests:\n${prompts.join("\n")}` : "",
    tools.size > 0 ? `Tools already used: ${[...tools].join(", ")}` : "",
    "Full transcript is on disk in the session JSONL; re-run a tool if you need detail again.",
  ].filter(Boolean);
  return { role: "user", content: [textBlock(lines.join("\n"))], timestamp: Date.now() };
}

/** Prompt used by `/compact` to fold a session into a briefing. */
export function summarizationPrompt(): string {
  return [
    "Summarize this reverse engineering session for your own future self.",
    "Write dense notes, not prose. Cover:",
    "1. The target(s) and what has been established about them (formats, protections, key symbols/offsets).",
    "2. Commands and tools already run, with their conclusions — so they are not repeated.",
    "3. Current hypotheses, dead ends already ruled out, and the exact next steps.",
    "4. Any recovered values: flags, keys, tokens, file paths, artifact paths.",
    "Return only the notes.",
  ].join("\n");
}
