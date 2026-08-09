import type {
  AgentConfig,
  AgentMessage,
  AgentRole,
  AgentRunOptions,
  AgentRunResult,
  AgentTool,
  ChatProvider,
  ContentBlock,
  ProviderConfig,
  ProviderResponse,
  ToolCall,
  PlanSnapshot,
  PlanStep,
  PlanUpdateMeta,
  ProviderProgress,
  TokenUsage,
  ToolContext,
} from "../types";
import { formatError, isAbortError, textBlock } from "../utils";
import { compactHistory, historyTokens, summarizationPrompt } from "./compaction";
import { requestApproval, tierForRisk } from "../security/approval";
import { PlanTracker } from "./plan";
import { JsonlSession } from "./session";

/** Fits comfortably inside the smallest context we routinely route to (deepseek-chat, 64k). */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 48_000;

/** Everything the UI needs to narrate a run as it happens. */
export type LoopEvent =
  | { type: "turn"; turn: number; provider: string }
  /** The request leaving for a provider: what is on the wire, and where to. */
  | {
      type: "wire";
      phase: "send";
      provider: string;
      model: string;
      endpoint: string;
      messages: number;
      tokens: number;
      tools: number;
    }
  /** The same request coming back. `ok: false` carries the failure reason. */
  | {
      type: "wire";
      phase: "recv";
      provider: string;
      ms: number;
      ok: boolean;
      usage?: TokenUsage;
      toolCalls: number;
      textChars: number;
      error?: string;
    }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; droppedMessages: number; elidedToolResults: number }
  | { type: "progress"; progress: ProviderProgress }
  | { type: "plan"; snapshot: PlanSnapshot }
  | { type: "reply"; text: string; usage?: TokenUsage; reasoning?: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; name: string; ok: boolean; ms: number; preview: string };

export interface AgentLoopOptions {
  config: AgentConfig;
  providers: Map<string, ChatProvider>;
  tools: AgentTool[];
  toolContext: ToolContext;
  systemPrompt: string;
  session: JsonlSession;
}

export class AgentLoop {
  private readonly messages: AgentMessage[] = [];
  // The task list survives across runs: the CLI providers resume one native
  // session, so the next turn usually keeps editing the same list.
  private readonly planTracker = new PlanTracker();
  private emitter: (event: LoopEvent) => void = () => {};
  /** Whoever answered last, so `/compact` defaults to the model that holds the context. */
  private lastProviderName?: string;

  constructor(private readonly options: AgentLoopOptions) {
    // The host-side update_plan tool publishes through the same path as the
    // CLI stream events, so both sources dedupe and persist identically.
    options.toolContext.onPlan = (steps, meta) => {
      void this.publishPlan(steps, meta);
    };
  }

  get history(): readonly AgentMessage[] {
    return this.messages;
  }

  get plan(): PlanSnapshot | undefined {
    return this.planTracker.current;
  }

  /**
   * Appends out-of-band context (operator shell output) to the transcript as a
   * user message. Nothing is sent to a provider now: it rides along with the
   * next prompt, which is also how the CLI providers pick it up in their resume
   * delta.
   */
  async addContext(text: string): Promise<void> {
    const message: AgentMessage = { role: "user", content: [textBlock(text)], timestamp: Date.now() };
    this.messages.push(message);
    await this.options.session.appendMessage(message);
  }

  /**
   * Loads a previous session's transcript into this loop. The messages are
   * replayed into the *new* session file too, so the resumed log is
   * self-contained and can itself be resumed.
   */
  async restore(messages: readonly AgentMessage[], plan?: { steps: PlanStep[]; source: string; note?: string }): Promise<void> {
    this.messages.length = 0;
    this.messages.push(...messages);
    for (const message of this.messages) await this.options.session.appendMessage(message);
    if (plan) await this.publishPlan(plan.steps, { source: plan.source, note: plan.note });
  }

  /** Estimated size of the live transcript, for `/context`. */
  get contextTokens(): number {
    return historyTokens(this.messages);
  }

  /**
   * Folds the whole session into one summary message, using a model rather than
   * the mechanical passes. Destructive by design: the detail lives on in the
   * JSONL, while the working history restarts from the briefing.
   */
  async compact(options: { providerName?: string; signal?: AbortSignal } = {}): Promise<{
    provider: string;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
  }> {
    const providerName = options.providerName ?? this.lastProviderName ?? this.options.config.executorProvider;
    const provider = this.options.providers.get(providerName);
    if (!provider) throw new Error(`Provider not configured: ${providerName}`);
    if (this.messages.length === 0) throw new Error("Nothing to compact yet.");

    const tokensBefore = historyTokens(this.messages);
    const request: AgentMessage = { role: "user", content: [textBlock(summarizationPrompt())], timestamp: Date.now() };
    const view = compactHistory([...this.messages, request], {
      budgetTokens: provider.config.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
    });
    const response = await provider.complete({
      system: this.options.systemPrompt,
      messages: view.messages,
      tools: [],
      workspace: this.options.toolContext.workspace,
      sessionDir: this.options.toolContext.sessionDir,
      signal: options.signal,
    });
    const summary = response.text.trim();
    if (!summary) throw new Error(`${providerName} returned an empty summary; history left untouched.`);

    const replacement: AgentMessage = {
      role: "user",
      content: [textBlock(`[session summary — earlier turns compacted]\n${summary}`)],
      timestamp: Date.now(),
    };
    this.messages.length = 0;
    this.messages.push(replacement);
    await this.options.session.appendMessage(replacement);
    const tokensAfter = historyTokens(this.messages);
    await this.options.session
      .appendEvent({ type: "compaction", mode: "summary", provider: providerName, tokensBefore, tokensAfter })
      .catch(() => {});
    return { provider: providerName, tokensBefore, tokensAfter, summary };
  }

  /** Appends a tool result, keeping the in-memory history and the JSONL in step. */
  private async pushToolResult(
    call: ToolCall,
    content: ContentBlock[],
    isError?: boolean,
    details?: unknown,
  ): Promise<void> {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError,
      details,
      timestamp: Date.now(),
    };
    this.messages.push(message);
    await this.options.session.appendMessage(message);
  }

  /**
   * Closes out an interrupted run. The marker keeps user/assistant alternation
   * intact for the strict chat APIs and tells the model, on the next turn, that
   * the previous answer was cut short rather than finished.
   */
  private async noteInterrupted(): Promise<void> {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "assistant" && !last.toolCalls?.length) return;
    const marker: AgentMessage = {
      role: "assistant",
      content: [textBlock("[interrupted by operator]")],
      timestamp: Date.now(),
    };
    this.messages.push(marker);
    await this.options.session.appendMessage(marker);
    await this.options.session.appendEvent({ type: "interrupted" }).catch(() => {});
  }

  /** Records a new task list, ignoring no-op updates. */
  private async publishPlan(steps: PlanStep[], meta: PlanUpdateMeta): Promise<void> {
    const snapshot = this.planTracker.update(steps, meta);
    if (!snapshot) return;
    this.emitter({ type: "plan", snapshot });
    await this.options.session
      .appendEvent({ type: "plan", source: snapshot.source, note: snapshot.note, steps: snapshot.steps })
      .catch(() => {
        // the plan is a decorative layer; never fail a run over persistence
      });
  }

  async run(prompt: string, runOptions: AgentRunOptions = {}): Promise<AgentRunResult> {
    const emit = runOptions.onEvent ?? (() => {});
    this.emitter = emit;
    const totals: TokenUsage = {};
    const role = runOptions.role ?? this.options.config.defaultRole;
    const providerName = runOptions.providerName ?? this.routeProvider(role, prompt);
    const provider = this.options.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider not configured: ${providerName}`);
    }
    this.lastProviderName = providerName;

    const userMessage: AgentMessage = { role: "user", content: [textBlock(prompt)], timestamp: Date.now() };
    this.messages.push(userMessage);
    await this.options.session.appendMessage(userMessage);

    const signal = runOptions.signal;
    const maxTurns = runOptions.maxTurns ?? this.options.config.maxTurns;
    const finish = (turnCount: number, interrupted = false): AgentRunResult => ({
      provider: providerName,
      role,
      messages: [...this.messages],
      turns: turnCount,
      usage: totals,
      ...(interrupted ? { interrupted: true } : {}),
    });
    let turns = 0;
    for (; turns < maxTurns; turns++) {
      if (signal?.aborted) {
        await this.noteInterrupted();
        return finish(turns, true);
      }
      emit({ type: "turn", turn: turns + 1, provider: providerName });
      // The transcript on disk stays complete; only the view sent upstream is
      // trimmed to the provider's budget.
      const view = compactHistory(this.messages, {
        budgetTokens: provider.config.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      });
      if (view.droppedMessages > 0 || view.elidedToolResults > 0) {
        emit({ type: "compaction", ...view });
        await this.options.session
          .appendEvent({
            type: "compaction",
            tokensBefore: view.tokensBefore,
            tokensAfter: view.tokensAfter,
            dropped: view.droppedMessages,
            elided: view.elidedToolResults,
          })
          .catch(() => {});
      }
      let response: ProviderResponse;
      const sentAt = Date.now();
      emit({
        type: "wire",
        phase: "send",
        provider: providerName,
        model: provider.config.model,
        endpoint: describeEndpoint(provider.config),
        messages: view.messages.length,
        tokens: view.tokensAfter,
        tools: this.options.tools.length,
      });
      try {
        response = await provider.complete({
          system: this.options.systemPrompt,
          messages: view.messages,
          tools: this.options.tools,
          workspace: this.options.toolContext.workspace,
          sessionDir: this.options.toolContext.sessionDir,
          signal,
          onProgress: progress => {
            if (progress.kind === "plan" && progress.plan) {
              void this.publishPlan(progress.plan, { source: providerName, note: progress.planNote });
            }
            emit({ type: "progress", progress });
          },
        });
      } catch (error) {
        const aborted = signal?.aborted || isAbortError(error);
        emit({
          type: "wire",
          phase: "recv",
          provider: providerName,
          ms: Date.now() - sentAt,
          ok: false,
          toolCalls: 0,
          textChars: 0,
          error: aborted ? "interrupted" : formatError(error),
        });
        // An interrupt is an outcome, not a failure: keep the transcript usable
        // so the next prompt (or a resumed session) still lines up.
        if (aborted) {
          await this.noteInterrupted();
          return finish(turns + 1, true);
        }
        throw error;
      }
      emit({
        type: "wire",
        phase: "recv",
        provider: providerName,
        ms: Date.now() - sentAt,
        ok: true,
        usage: response.usage,
        toolCalls: response.toolCalls.length,
        textChars: response.text.length,
      });
      accumulate(totals, response.usage);
      emit({ type: "reply", text: response.text, usage: response.usage, reasoning: response.reasoning });

      const assistantMessage: AgentMessage = {
        role: "assistant",
        provider: providerName,
        model: provider.config.model,
        content: response.text ? [textBlock(response.text)] : [],
        toolCalls: response.toolCalls,
        timestamp: Date.now(),
      };
      this.messages.push(assistantMessage);
      await this.options.session.appendMessage(assistantMessage);

      if (response.toolCalls.length === 0) {
        return finish(turns + 1);
      }

      // Every tool call must end up with a result, including on interrupt:
      // providers reject a history where an assistant tool call dangles.
      let interrupted = false;
      for (const call of response.toolCalls) {
        if (interrupted || signal?.aborted) {
          interrupted = true;
          await this.pushToolResult(call, [textBlock("Interrupted by operator before this tool ran.")], true);
          continue;
        }
        const tool = this.options.tools.find(candidate => candidate.name === call.name);
        if (!tool) {
          await this.pushToolResult(call, [textBlock(`Tool not found: ${call.name}`)], true);
          continue;
        }

        emit({ type: "tool_start", name: call.name, args: call.arguments });
        const startedAt = Date.now();
        const callContext: ToolContext = { ...this.options.toolContext, signal };
        try {
          // Tier gate. Command-level safety concerns are raised inside the tool,
          // which is the only place that knows the actual command text.
          await requestApproval(
            { tool: call.name, tier: tierForRisk(tool.risk), summary: summarizeCall(call), concerns: [] },
            callContext,
          );
          const result = await tool.execute(call.arguments, callContext);
          emit({
            type: "tool_end",
            name: call.name,
            ok: !result.isError,
            ms: Date.now() - startedAt,
            preview: previewOf(result.content),
          });
          await this.pushToolResult(call, result.content, result.isError, result.details);
        } catch (error) {
          const aborted = signal?.aborted || isAbortError(error);
          if (aborted) interrupted = true;
          const message = aborted ? "Interrupted by operator." : formatError(error);
          emit({ type: "tool_end", name: call.name, ok: false, ms: Date.now() - startedAt, preview: message });
          await this.pushToolResult(call, [textBlock(message)], true);
        }
        // A tool call that finished right as the operator hit ^C still counts:
        // the remaining calls in this batch are the ones to skip.
        if (signal?.aborted) interrupted = true;
      }
      if (interrupted) {
        await this.noteInterrupted();
        return finish(turns + 1, true);
      }
    }

    await this.options.session.appendEvent({ type: "max_turns_reached", maxTurns });
    return { provider: providerName, role, messages: [...this.messages], turns, usage: totals };
  }

  private routeProvider(role: AgentRole, prompt: string): string {
    if (role === "planner") return this.options.config.plannerProvider;
    if (role === "executor") return this.options.config.executorProvider;

    const lower = prompt.toLowerCase();
    if (isExecutionPrompt(lower)) {
      return this.options.config.executorProvider;
    }
    return this.options.config.plannerProvider;
  }
}

// Usage is summed across turns; cost is summed too, since each turn bills
// separately. Cache counters are additive for the same reason.
function accumulate(totals: TokenUsage, next?: TokenUsage): void {
  if (!next) return;
  for (const key of ["input", "output", "thinking", "cacheRead", "cacheWrite", "costUsd"] as const) {
    const value = next[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
}

/**
 * Where a turn is actually going, in the shortest honest form: a URL for the
 * HTTP providers, the child command for the tmux CLIs.
 */
export function describeEndpoint(config: ProviderConfig): string {
  const base = (config.baseUrl ?? "").replace(/\/+$/, "");
  switch (config.type) {
    case "openai-chat":
      return `${base || "https://api.openai.com/v1"}/chat/completions`;
    case "openai-responses":
      return `${base || "https://api.openai.com/v1"}/responses`;
    case "anthropic":
      return `${base || "https://api.anthropic.com"}/v1/messages`;
    case "cli-tmux":
      return `tmux:${config.cliCommand ?? "cli"}`;
    default:
      return `${config.type}://${config.model}`;
  }
}

/** One-line "what is about to run" for the approval prompt. */
function summarizeCall(call: ToolCall): string {
  const entries = Object.entries(call.arguments ?? {});
  if (entries.length === 0) return call.name;
  const rendered = entries
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return rendered.length > 200 ? `${rendered.slice(0, 197)}…` : rendered;
}

function previewOf(content: Array<{ type: string; text?: string }>): string {
  const text = content.map(block => (block.type === "text" ? block.text ?? "" : "")).join(" ").trim();
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

function isExecutionPrompt(lowerPrompt: string): boolean {
  return [
    "run ",
    "execute",
    "shell",
    "command",
    "read file",
    "list files",
    "ls ",
    "cat ",
    "grep",
    "strings",
    "hexdump",
    "objdump",
    "nm ",
    "file ",
    "check ./",
    "inspect ./",
    "summarize ./",
    "执行",
    "运行",
    "跑一下",
    "跑 ",
    "读取",
    "读一下",
    "列出",
    "查看文件",
    "看文件",
    "检查 ./",
    "分析 ./",
    "总结 ./",
  ].some(keyword => lowerPrompt.includes(keyword));
}
