import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage, PlanStep } from "../types";
import { textFromBlocks } from "../utils";

export interface SessionEntry {
  type: "session" | "message" | "event";
  timestamp: string;
  data: unknown;
}

/** One row of the `--resume` / `/sessions` picker. */
export interface SessionSummary {
  /** Stable handle: the file name without `.jsonl`, also accepted as a prefix. */
  id: string;
  file: string;
  startedAt: string;
  updatedAt: Date;
  workspace?: string;
  messages: number;
  /** First thing the operator asked, which is what makes a session recognizable. */
  firstPrompt?: string;
  lastPrompt?: string;
}

export interface LoadedSession {
  file: string;
  meta: Record<string, unknown>;
  messages: AgentMessage[];
  /** Last task list recorded, so a resumed session picks the plan back up. */
  plan?: { steps: PlanStep[]; source: string; note?: string };
}

export class JsonlSession {
  readonly file: string;

  constructor(sessionDir: string, name = "session") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(sessionDir, `${stamp}-${name}.jsonl`);
  }

  async init(meta: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await this.append({ type: "session", timestamp: new Date().toISOString(), data: meta });
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    await this.append({ type: "message", timestamp: new Date().toISOString(), data: message });
  }

  async appendEvent(data: unknown): Promise<void> {
    await this.append({ type: "event", timestamp: new Date().toISOString(), data });
  }

  private async append(entry: SessionEntry): Promise<void> {
    await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

/** Newest first. Unreadable or empty files are skipped rather than fatal. */
export async function listSessions(sessionDir: string, limit = 20): Promise<SessionSummary[]> {
  const names = await fs.readdir(sessionDir).catch(() => [] as string[]);
  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(sessionDir, name);
    const summary = await summarize(file).catch(() => undefined);
    if (summary) summaries.push(summary);
  }
  return summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
}

/** Resolves an id, id prefix, or path to a session file. */
export async function resolveSession(sessionDir: string, idOrPath?: string): Promise<SessionSummary | undefined> {
  const sessions = await listSessions(sessionDir, 500);
  if (!idOrPath) return sessions[0];
  const resolved = path.resolve(idOrPath);
  const byPath = sessions.find(session => path.resolve(session.file) === resolved);
  if (byPath) return byPath;
  const wanted = path.basename(idOrPath).replace(/\.jsonl$/, "");
  return sessions.find(session => session.id === wanted) ?? sessions.find(session => session.id.startsWith(wanted));
}

export async function loadSession(file: string): Promise<LoadedSession> {
  const entries = await readEntries(file);
  const meta = (entries.find(entry => entry.type === "session")?.data as Record<string, unknown>) ?? {};
  const messages: AgentMessage[] = [];
  let plan: LoadedSession["plan"];
  for (const entry of entries) {
    if (entry.type === "message") {
      messages.push(entry.data as AgentMessage);
      continue;
    }
    if (entry.type !== "event") continue;
    const data = entry.data as { type?: string; steps?: PlanStep[]; source?: string; note?: string };
    if (data?.type === "plan" && Array.isArray(data.steps)) {
      plan = { steps: data.steps, source: data.source ?? "resumed", note: data.note };
    }
  }
  return { file, meta, messages: repair(messages), plan };
}

/**
 * Drops assistant tool calls whose results never made it to disk (a crash or a
 * kill mid-tool). Providers reject that shape, so a session with one would be
 * unresumable.
 */
function repair(messages: AgentMessage[]): AgentMessage[] {
  const answered = new Set(
    messages.filter(message => message.role === "toolResult").map(message => (message as { toolCallId: string }).toolCallId),
  );
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      const kept = message.toolCalls.filter(call => answered.has(call.id));
      if (kept.length === 0) {
        // Nothing but unanswered calls: keep any text, drop the calls.
        if (textFromBlocks(message.content).trim()) out.push({ ...message, toolCalls: undefined });
        continue;
      }
      out.push({ ...message, toolCalls: kept });
      continue;
    }
    out.push(message);
  }
  return out;
}

async function summarize(file: string): Promise<SessionSummary | undefined> {
  const entries = await readEntries(file);
  if (entries.length === 0) return undefined;
  const meta = (entries.find(entry => entry.type === "session")?.data as Record<string, unknown>) ?? {};
  const prompts = entries
    .filter(entry => entry.type === "message" && (entry.data as AgentMessage).role === "user")
    .map(entry => textFromBlocks((entry.data as AgentMessage & { content: [] }).content).split("\n", 1)[0] ?? "")
    .filter(line => line.trim() && !line.startsWith("[operator shell]") && !line.startsWith("[context compacted]"));
  const stat = await fs.stat(file);
  return {
    id: path.basename(file).replace(/\.jsonl$/, ""),
    file,
    startedAt: entries[0]?.timestamp ?? stat.mtime.toISOString(),
    updatedAt: stat.mtime,
    workspace: typeof meta.workspace === "string" ? meta.workspace : undefined,
    messages: entries.filter(entry => entry.type === "message").length,
    firstPrompt: prompts[0],
    lastPrompt: prompts[prompts.length - 1],
  };
}

async function readEntries(file: string): Promise<SessionEntry[]> {
  const text = await fs.readFile(file, "utf8");
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // A truncated last line is expected when a session was killed mid-write.
    }
  }
  return entries;
}
