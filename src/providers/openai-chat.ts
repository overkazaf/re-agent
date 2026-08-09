import { resolveApiKey } from "../config";
import { invalidCredentialHint, missingCredentialHint } from "../auth";
import type { AgentMessage, AgentTool, ChatProvider, ProviderConfig, ProviderInput, ProviderResponse, ToolCall } from "../types";
import { safeJsonParseObject, textFromBlocks } from "../utils";
import { chatUsage } from "./usage";

export class OpenAIChatProvider implements ChatProvider {
  constructor(
    readonly name: string,
    readonly config: ProviderConfig,
  ) {}

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    const apiKey = resolveApiKey(this.config);
    if (!apiKey) {
      throw new Error(missingCredentialHint(this.name, this.config));
    }

    const response = await fetch(`${trimSlash(this.config.baseUrl ?? "https://api.openai.com/v1")}/chat/completions`, {
      method: "POST",
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: toChatMessages(input.system, input.messages),
        tools: input.tools.map(toChatTool),
        tool_choice: "auto",
        max_tokens: this.config.maxTokens ?? 8192,
      }),
    });

    const raw = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${invalidCredentialHint(this.name, this.config)} Provider response: ${JSON.stringify(raw)}`);
      }
      throw new Error(`OpenAI-compatible chat error ${response.status}: ${JSON.stringify(raw)}`);
    }
    return parseChat(raw);
  }
}

export function toChatMessages(system: string, messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: textFromBlocks(message.content) });
    } else if (message.role === "assistant") {
      const toolCalls = (message.toolCalls ?? []).map(call => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      const text = textFromBlocks(message.content);
      // Strict backends (DeepSeek, GLM) reject `tool_calls: []` and a null
      // content with no tool calls, so both keys are only sent when meaningful.
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: text || (toolCalls.length > 0 ? null : ""),
      };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    } else if (message.role === "toolResult") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: textFromBlocks(message.content) });
    }
  }
  return out;
}

function toChatTool(tool: AgentTool): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseChat(raw: unknown): ProviderResponse {
  const root = raw as { choices?: Array<{ message?: Record<string, unknown> }> };
  const message = root.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const rawCall of message.tool_calls as Record<string, unknown>[]) {
      const fn = rawCall.function as Record<string, unknown> | undefined;
      toolCalls.push({
        id: String(rawCall.id ?? `call_${toolCalls.length}`),
        name: String(fn?.name ?? ""),
        arguments: safeJsonParseObject(String(fn?.arguments ?? "{}")),
      });
    }
  }
  return { text, toolCalls, usage: chatUsage(raw), raw };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
