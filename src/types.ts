export type ProviderKind = "openai-responses" | "anthropic" | "openai-chat" | "cli-tmux" | "mock";

export type AgentRole = "planner" | "executor" | "auto";

export type ProviderName = "codex" | "claude" | "deepseek" | "glm" | "mock" | string;

/**
 * Reasoning effort. Not every backend accepts every level: the OpenAI
 * Responses API tops out at "high", while the Claude and Codex CLIs also
 * accept "xhigh"/"max".
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface ProviderConfig {
  type: ProviderKind;
  label?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string[];
  authScheme?: "api-key" | "bearer";
  cliCommand?: string;
  cliArgs?: string[];
  cliTimeoutMs?: number;
  cliPromptMaxChars?: number;
  cliFallbackDirect?: boolean;
  cliUnsetEnv?: string[];
  cliResumeSession?: boolean;
  cliSessionIdArg?: string;
  cliResumeArg?: string;
  /** Set false to disable live JSONL event streaming for this CLI provider. */
  cliStream?: boolean;
  maxTokens?: number;
  /** Context ceiling for the transcript sent to this provider; older history is compacted away. */
  contextBudgetTokens?: number;
  /** `mock` only: one scripted response per turn, so tool flows can run offline. */
  mockScript?: Array<{
    text?: string;
    toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
    usage?: TokenUsage;
  }>;
  reasoningEffort?: ReasoningEffort;
  headers?: Record<string, string>;
}

export interface AgentConfig {
  name: string;
  plannerProvider: ProviderName;
  executorProvider: ProviderName;
  /** Answers `/know` lookups. Falls back to the executor when unset. */
  knowledgeProvider?: ProviderName;
  defaultRole: AgentRole;
  maxTurns: number;
  providers: Record<string, ProviderConfig>;
  /** External MCP servers whose tools join the local registry. */
  mcpServers?: Record<string, import("./mcp/client").McpServerConfig>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "system"; content: string; timestamp?: number }
  | { role: "user"; content: ContentBlock[]; timestamp?: number }
  | { role: "assistant"; content: ContentBlock[]; toolCalls?: ToolCall[]; provider?: string; model?: string; timestamp?: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: ContentBlock[]; isError?: boolean; details?: unknown; timestamp?: number };

export type PlanStepStatus = "pending" | "in_progress" | "completed";

/** One step of the task list a provider is working through. */
export interface PlanStep {
  text: string;
  status: PlanStepStatus;
  /** Provider-side identifier, when the source has one (Claude's `Task #N`). */
  id?: string;
  /** Filled in by PlanTracker as the step changes state, for the HUD timings. */
  startedAt?: number;
  completedAt?: number;
}

export interface PlanSnapshot {
  steps: PlanStep[];
  /** Where the plan came from: a provider name, or "update_plan" for the host tool. */
  source: string;
  /** Optional one-line rationale (Codex sends this as `explanation`). */
  note?: string;
  updatedAt: number;
}

export interface PlanUpdateMeta {
  source: string;
  note?: string;
}

/** How much trust a tool call needs: reads are cheap, exec can do anything. */
export type ApprovalTier = "read" | "write" | "exec";

/**
 * `yolo` never prompts. `safe` (default) runs any tool but stops for commands
 * that trip a safety pattern (rm -rf, network with the network off, anything
 * credential-shaped). `write` also stops for every exec-tier tool, and
 * `always-ask` stops for anything that is not a read.
 */
export type ApprovalMode = "yolo" | "safe" | "write" | "always-ask";

export type ApprovalDecision = "allow" | "allow-always" | "deny" | "deny-always";

export interface ApprovalRequest {
  tool: string;
  tier: ApprovalTier;
  /** One-line description of what is about to happen (usually the command). */
  summary: string;
  /** Safety patterns the request tripped; non-empty means always prompt. */
  concerns: string[];
}

export interface ToolContext {
  workspace: string;
  sessionDir: string;
  policy: ExecutionPolicy;
  /** Aborted when the operator interrupts the turn; long tools should honor it. */
  signal?: AbortSignal;
  /** Set by the CLI in interactive mode; absent means "no one is there to ask". */
  confirm?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Set by the CLI so the update_plan tool can publish into the live pane. */
  onPlan?: (steps: PlanStep[], meta: PlanUpdateMeta) => void;
}

export interface ExecutionPolicy {
  allowWrites: boolean;
  allowNetwork: boolean;
  allowSensitive: boolean;
  commandTimeoutMs: number;
  maxReadBytes: number;
  /** Per-tool-call context budget; anything larger is spilled to an artifact file. */
  maxToolOutputChars: number;
  approvalMode: ApprovalMode;
  /** Per-tool overrides, including the ones the operator sets with "always" during a session. */
  approvals: Record<string, "allow" | "deny">;
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  details?: unknown;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: "read" | "write" | "execute" | "network";
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  thinking?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  /** Full reasoning text captured from the provider, when it exposes one. */
  reasoning?: string;
  raw?: unknown;
}

export interface ChatProvider {
  name: string;
  config: ProviderConfig;
  complete(input: ProviderInput): Promise<ProviderResponse>;
}

/** Live progress emitted by a provider while a turn is still running. */
export interface ProviderProgress {
  kind: "status" | "thinking" | "text" | "tool" | "usage" | "plan";
  text?: string;
  tool?: string;
  status?: string;
  usage?: TokenUsage;
  /** Full replacement task list, carried by `plan`. */
  plan?: PlanStep[];
  planNote?: string;
}

export interface ProviderInput {
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  workspace?: string;
  sessionDir?: string;
  signal?: AbortSignal;
  onProgress?: (event: ProviderProgress) => void;
}

export interface AgentRunOptions {
  role?: AgentRole;
  providerName?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (event: import("./core/agent-loop").LoopEvent) => void;
}

export interface AgentRunResult {
  provider: string;
  role: AgentRole;
  messages: AgentMessage[];
  turns: number;
  usage?: TokenUsage;
  /** The operator interrupted this run; `messages` is still a valid history. */
  interrupted?: boolean;
}
