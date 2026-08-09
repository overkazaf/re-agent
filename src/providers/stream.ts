// Normalizes the JSONL event streams emitted by `claude -p --output-format
// stream-json` and `codex exec --json` into one event shape, so the UI can show
// real reasoning text, tool activity, and token usage while a CLI turn runs.

import type { PlanStep, PlanStepStatus, TokenUsage } from "../types";

export type StreamEventKind = "status" | "thinking" | "text" | "tool" | "usage" | "final" | "plan";

export interface StreamEvent {
  kind: StreamEventKind;
  /** Delta text for `thinking` / `text`. */
  text?: string;
  /** Tool name for `tool`. */
  tool?: string;
  /** Short phase label for `status`. */
  status?: string;
  usage?: TokenUsage;
  /** Complete assistant reply, carried by `final`. */
  finalText?: string;
  /** Full replacement task list, carried by `plan`. */
  plan?: PlanStep[];
  /** Optional one-line rationale accompanying a `plan`. */
  planNote?: string;
}

export type StreamFormat = "claude-json" | "codex-json";

export function streamFormatFor(command: string | undefined, args: string[]): StreamFormat | undefined {
  if (command === "claude" && args.includes("stream-json")) return "claude-json";
  if (command === "codex" && args.includes("--json")) return "codex-json";
  return undefined;
}

/**
 * Incremental JSONL parser. Feed it raw chunks as they are appended to the CLI
 * stdout log; it buffers partial lines and yields normalized events.
 */
export class StreamParser {
  private buffer = "";
  private usage: TokenUsage = {};
  private finalText?: string;
  /**
   * Claude's task list arrives as incremental `TaskCreate` / `TaskUpdate` calls
   * rather than a whole-list replacement, so a running table is needed. Its
   * lifetime must match the *CLI session*, not this parser: with
   * `cliResumeSession` the native session outlives the turn, and a turn that
   * only sends `TaskUpdate` would otherwise find an empty table and publish
   * nothing. The provider therefore owns the table and passes it in.
   */
  private readonly tasks: ClaudeTaskTable;

  constructor(
    private readonly format: StreamFormat,
    tasks: ClaudeTaskTable = new ClaudeTaskTable(),
  ) {
    this.tasks = tasks;
  }

  get totals(): TokenUsage {
    return { ...this.usage };
  }

  get lastText(): string | undefined {
    return this.finalText;
  }

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line.startsWith("{")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // tolerate interleaved non-JSON output
      }
      events.push(...this.translate(parsed as Record<string, unknown>));
    }
    return events;
  }

  private translate(event: Record<string, unknown>): StreamEvent[] {
    const events =
      this.format === "claude-json" ? translateClaude(event, this.tasks) : translateCodex(event);
    for (const item of events) {
      if (item.usage) this.usage = mergeUsage(this.usage, item.usage);
      if (item.kind === "final" && item.finalText) this.finalText = item.finalText;
    }
    return events;
  }
}

function mergeUsage(base: TokenUsage, next: TokenUsage): TokenUsage {
  const out: TokenUsage = { ...base };
  for (const key of ["input", "output", "thinking", "cacheRead", "cacheWrite", "costUsd"] as const) {
    const value = next[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function planStatus(value: unknown): PlanStepStatus {
  return value === "in_progress" || value === "completed" ? value : "pending";
}

// Plans are a decorative layer: every unrecognized entry is dropped and an
// empty list means "no plan event", so a shape change can never fail a run.
function toPlan(raw: unknown, toStep: (entry: Record<string, unknown>) => PlanStep | undefined): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const step = record ? toStep(record) : undefined;
    if (step) steps.push(step);
  }
  return steps;
}

/**
 * The only place a task id is ever stated. `TaskCreate`'s arguments carry no
 * id — the CLI mints it server-side and reports it back in this result text.
 */
const TASK_CREATED = /Task #(\d+) created successfully:[ \t]*([^\n]+)/;

interface TaskEntry {
  id: string;
  text: string;
  status: PlanStepStatus;
  /**
   * True once a `Task #N created successfully` result confirmed the id. Until
   * then the id is a guess and the entry may still be claimed by a result.
   */
  bound: boolean;
}

/**
 * Ordered task table rebuilt from Claude's incremental `TaskCreate` /
 * `TaskUpdate` calls. Every mutator returns whether the visible list actually
 * changed, so a no-op confirmation does not churn the UI. Nothing here throws:
 * unrecognized input simply reports "no change".
 */
export class ClaudeTaskTable {
  private readonly entries: TaskEntry[] = [];

  /** Drops everything. Called when the CLI starts a fresh native session. */
  reset(): void {
    this.entries.length = 0;
  }

  /** The full current list, in creation order. */
  get steps(): PlanStep[] {
    return this.entries.map(entry => ({ id: entry.id, text: entry.text, status: entry.status }));
  }

  /**
   * Authoritative id binding from a tool_result. Claims a matching provisional
   * entry when there is one, so the `TaskCreate` fallback never double-inserts.
   */
  bind(id: string, subject: string): boolean {
    const provisional = this.entries.find(entry => !entry.bound && entry.text === subject);
    if (provisional) {
      const changed = provisional.id !== id;
      provisional.id = id;
      provisional.bound = true;
      return changed;
    }
    // Already known under this id (a repeated result, or a create we missed).
    if (this.entries.some(entry => entry.id === id)) return false;
    this.entries.push({ id, text: subject, status: "pending", bound: true });
    return true;
  }

  /**
   * Fallback for a `TaskCreate` whose result never arrives: surface the step
   * immediately under a guessed id, which `bind` corrects if the result lands.
   */
  create(subject: string): boolean {
    if (this.entries.some(entry => !entry.bound && entry.text === subject)) return false;
    this.entries.push({ id: this.nextId(), text: subject, status: "pending", bound: false });
    return true;
  }

  /**
   * Applies a `TaskUpdate`. An unknown id is ignored rather than inserted:
   * synthesising a step from an id alone would put a meaningless row ("task 7")
   * in front of the operator. The case that used to make this lossy — a table
   * younger than the CLI session — is fixed by giving the table the session's
   * lifetime instead (see the constructor).
   */
  update(id: string, status: unknown, subject: unknown): boolean {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return false;
    let changed = false;
    if (typeof status === "string") {
      const next = planStatus(status);
      if (next !== entry.status) {
        entry.status = next;
        changed = true;
      }
    }
    if (typeof subject === "string" && subject.length > 0 && subject !== entry.text) {
      entry.text = subject;
      changed = true;
    }
    return changed;
  }

  /** Claude numbers tasks sequentially, so the best guess is "one past the max". */
  private nextId(): string {
    let max = 0;
    for (const entry of this.entries) {
      const value = Number(entry.id);
      if (Number.isInteger(value) && value > max) max = value;
    }
    return String(max + 1);
  }
}

/** Task ids arrive as `"1"` in practice, but accept the numeric form too. */
function taskId(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  return Number.isInteger(value) ? String(value) : undefined;
}

/**
 * Applies the structured `tool_use_result` that rides at the top level of a
 * `user` event, alongside `message`. It states the id/subject binding and the
 * status transition as data rather than as English, so it is preferred over the
 * result text. `handled` reports whether the shape was recognized at all —
 * only when it was not do we fall back to parsing the prose.
 */
function applyStructuredResult(
  event: Record<string, unknown>,
  tasks: ClaudeTaskTable,
): { handled: boolean; changed: boolean } {
  const result = asRecord(event.tool_use_result);
  if (!result) return { handled: false, changed: false };

  // TaskCreate: {"task":{"id":"1","subject":"Identify file type"}}
  const task = asRecord(result.task);
  const created = taskId(task?.id);
  const subject = task?.subject;
  if (created !== undefined && typeof subject === "string" && subject.length > 0) {
    return { handled: true, changed: tasks.bind(created, subject) };
  }

  // TaskUpdate: {"taskId":"1","statusChange":{"from":"pending","to":"completed"}}.
  // Honouring this makes the table self-correcting when the TaskUpdate tool_use
  // itself was missed — the one loss that would otherwise strand a step.
  const updated = taskId(result.taskId);
  if (updated !== undefined) {
    const to = asRecord(result.statusChange)?.to;
    return { handled: true, changed: tasks.update(updated, to, result.subject) };
  }

  return { handled: false, changed: false };
}

/**
 * A non-null `parent_tool_use_id` marks a call made by a spawned sub-agent.
 * Sub-agents keep their own task lists, which are not the operator's plan, so
 * their task events must not reach the table.
 */
function isSubAgentEvent(event: Record<string, unknown>): boolean {
  return typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id.length > 0;
}

/** A tool_result's `content` is a plain string in some events and text blocks in others. */
function resultTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      texts.push(raw);
      continue;
    }
    // Non-text blocks (Claude's `tool_reference`, images, …) carry no subject.
    const text = asRecord(raw)?.text;
    if (typeof text === "string") texts.push(text);
  }
  return texts;
}

function claudeUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined;
  const details = asRecord(raw.output_tokens_details);
  const usage: TokenUsage = {
    input: num(raw.input_tokens),
    output: num(raw.output_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    cacheWrite: num(raw.cache_creation_input_tokens),
    thinking: num(details?.thinking_tokens),
  };
  return Object.values(usage).some(value => value !== undefined) ? usage : undefined;
}

function translateClaude(event: Record<string, unknown>, tasks: ClaudeTaskTable): StreamEvent[] {
  const type = event.type;

  if (type === "system" && event.subtype === "status") {
    const status = typeof event.status === "string" ? event.status : undefined;
    return status ? [{ kind: "status", status }] : [];
  }

  if (type === "stream_event") {
    const inner = asRecord(event.event);
    if (!inner) return [];
    const innerType = inner.type;

    if (innerType === "content_block_delta") {
      const delta = asRecord(inner.delta);
      if (!delta) return [];
      if (delta.type === "thinking_delta") {
        // Claude Code redacts the reasoning text and reports only a running
        // token estimate, so emit the phase regardless of whether text is
        // present and carry the estimate as live usage.
        const estimated = num(delta.estimated_tokens);
        return [
          {
            kind: "thinking",
            text: typeof delta.thinking === "string" ? delta.thinking : "",
            usage: estimated !== undefined ? { thinking: estimated } : undefined,
          },
        ];
      }
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return [{ kind: "text", text: delta.text }];
      }
      return [];
    }

    if (innerType === "content_block_start") {
      const block = asRecord(inner.content_block);
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return [{ kind: "tool", tool: block.name }];
      }
      if (block?.type === "thinking") return [{ kind: "thinking", text: "" }];
      return [];
    }

    if (innerType === "message_start") {
      const usage = claudeUsage(asRecord(asRecord(inner.message)?.usage));
      return usage ? [{ kind: "usage", usage }] : [];
    }

    if (innerType === "message_delta") {
      const usage = claudeUsage(asRecord(inner.usage));
      return usage ? [{ kind: "usage", usage }] : [];
    }
    return [];
  }

  // The streamed `content_block_start` above sees a tool name but never its
  // arguments; the assembled call arrives in this non-streamed event, which is
  // the only place a task-list call is complete.
  if (type === "assistant") {
    if (isSubAgentEvent(event)) return [];
    const content = asRecord(event.message)?.content;
    if (!Array.isArray(content)) return [];
    const events: StreamEvent[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type !== "tool_use") continue;
      const input = asRecord(block.input);

      // Claude Code 2.1.x has no TodoWrite, but other versions and configs do,
      // and there it is still a whole-list replacement.
      if (block.name === "TodoWrite") {
        const plan = toPlan(input?.todos, entry =>
          typeof entry.content === "string" ? { text: entry.content, status: planStatus(entry.status) } : undefined,
        );
        if (plan.length > 0) events.push({ kind: "plan", plan });
        continue;
      }

      // TaskCreate states no id; the `Task #N created` tool_result below binds
      // one. Insert on the call anyway so a missing result cannot hide a step.
      if (block.name === "TaskCreate") {
        const subject = input?.subject;
        if (typeof subject === "string" && subject.length > 0 && tasks.create(subject)) {
          events.push({ kind: "plan", plan: tasks.steps });
        }
        continue;
      }

      if (block.name === "TaskUpdate") {
        const id = input?.taskId;
        const key = typeof id === "string" ? id : typeof id === "number" ? String(id) : undefined;
        if (key !== undefined && tasks.update(key, input?.status, input?.subject)) {
          events.push({ kind: "plan", plan: tasks.steps });
        }
      }
    }
    return events;
  }

  // Tool results ride back in as `user` events. They are the only place a task
  // id is ever stated, which makes them the authoritative binding.
  if (type === "user") {
    if (isSubAgentEvent(event)) return [];
    const events: StreamEvent[] = [];

    // Structured first: `tool_use_result` states the binding as data. The
    // result text is only parsed when that shape is absent or unrecognized.
    const structured = applyStructuredResult(event, tasks);
    if (structured.changed) events.push({ kind: "plan", plan: tasks.steps });
    if (structured.handled) return events;

    const content = asRecord(event.message)?.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (block?.type !== "tool_result") continue;
      for (const text of resultTexts(block.content)) {
        const match = TASK_CREATED.exec(text);
        if (match && tasks.bind(match[1] as string, (match[2] as string).trim())) {
          events.push({ kind: "plan", plan: tasks.steps });
        }
      }
    }
    return events;
  }

  if (type === "result") {
    const usage = claudeUsage(asRecord(event.usage)) ?? {};
    const cost = num(event.total_cost_usd);
    if (cost !== undefined) usage.costUsd = cost;
    const finalText = typeof event.result === "string" ? event.result : undefined;
    return [{ kind: "final", finalText, usage }];
  }

  return [];
}

// Codex has iterated on its JSONL shape across versions, so match several
// known layouts and ignore anything unrecognized rather than guessing.
function translateCodex(event: Record<string, unknown>): StreamEvent[] {
  const msg = asRecord(event.msg) ?? event;
  const type = typeof msg.type === "string" ? msg.type : typeof event.type === "string" ? event.type : "";

  if (type === "agent_reasoning_delta" || type === "reasoning_delta") {
    const text = typeof msg.delta === "string" ? msg.delta : typeof msg.text === "string" ? msg.text : undefined;
    return text ? [{ kind: "thinking", text }] : [];
  }
  if (type === "agent_reasoning" || type === "reasoning") {
    const text = typeof msg.text === "string" ? msg.text : undefined;
    return text ? [{ kind: "thinking", text }] : [];
  }
  if (type === "agent_message_delta") {
    const text = typeof msg.delta === "string" ? msg.delta : undefined;
    return text ? [{ kind: "text", text }] : [];
  }
  if (type === "agent_message") {
    const text = typeof msg.message === "string" ? msg.message : typeof msg.text === "string" ? msg.text : undefined;
    return text ? [{ kind: "final", finalText: text }] : [];
  }
  if (type === "exec_command_begin" || type === "exec_command") {
    const command = Array.isArray(msg.command) ? msg.command.join(" ") : typeof msg.command === "string" ? msg.command : undefined;
    return [{ kind: "tool", tool: command ? `shell: ${command}` : "shell" }];
  }
  // `turn.completed` carries the authoritative per-turn usage in current Codex
  // builds; `token_count` is the older streaming counter.
  if (type === "token_count" || type === "usage" || type === "turn.completed") {
    const info = asRecord(msg.info) ?? msg;
    const total =
      asRecord(event.usage) ?? asRecord(info.total_token_usage) ?? asRecord(info.usage) ?? info;
    const usage: TokenUsage = {
      input: num(total.input_tokens) ?? num(total.prompt_tokens),
      output: num(total.output_tokens) ?? num(total.completion_tokens),
      thinking: num(total.reasoning_output_tokens) ?? num(total.reasoning_tokens),
      cacheRead: num(total.cached_input_tokens),
    };
    return Object.values(usage).some(value => value !== undefined) ? [{ kind: "usage", usage }] : [];
  }

  // Legacy plan shape: UpdatePlanArgs { explanation, plan: [PlanItemArg] }.
  if (type === "plan_update" || type === "update_plan") {
    const plan = toPlan(msg.plan, entry =>
      typeof entry.step === "string" ? { text: entry.step, status: planStatus(entry.status) } : undefined,
    );
    if (plan.length === 0) return [];
    const note = typeof msg.explanation === "string" ? msg.explanation : undefined;
    return [{ kind: "plan", plan, planNote: note }];
  }

  if (type === "turn.started") return [{ kind: "status", status: "requesting" }];

  // Newer item-based envelope: {"type":"item.completed","item":{...}}
  if (type === "item.completed" || type === "item.started") {
    const item = asRecord(event.item) ?? asRecord(msg.item);
    if (!item) return [];
    if (item.type === "reasoning" && typeof item.text === "string") return [{ kind: "thinking", text: item.text }];
    if (item.type === "agent_message" && typeof item.text === "string") return [{ kind: "final", finalText: item.text }];
    if (item.type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : undefined;
      return [{ kind: "tool", tool: command ? `shell: ${command}` : "shell" }];
    }
    // Item-shaped plan. The tag lives under `type` in some builds and
    // `item_type` in others, and the list is `items` or `todo_items`.
    const itemType = typeof item.type === "string" ? item.type : typeof item.item_type === "string" ? item.item_type : "";
    if (itemType === "todo_list") {
      const plan = toPlan(Array.isArray(item.items) ? item.items : item.todo_items, entry => {
        const text = typeof entry.text === "string" ? entry.text : typeof entry.step === "string" ? entry.step : undefined;
        return text ? { text, status: entry.completed === true ? "completed" : planStatus(entry.status) } : undefined;
      });
      return plan.length > 0 ? [{ kind: "plan", plan }] : [];
    }
    return [];
  }

  return [];
}
