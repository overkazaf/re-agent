import { resolveApiKey } from "../config";
import { invalidCredentialHint, missingCredentialHint } from "../auth";
import type { AgentMessage, AgentTool, ChatProvider, ProviderConfig, ProviderInput, ProviderResponse, ToolCall } from "../types";
import { safeJsonParseObject, textFromBlocks } from "../utils";
import { responsesUsage } from "./usage";

export class OpenAIResponsesProvider implements ChatProvider {
  constructor(
    readonly name: string,
    readonly config: ProviderConfig,
  ) {}

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    const apiKey = resolveApiKey(this.config);
    if (!apiKey) {
      throw new Error(missingCredentialHint(this.name, this.config));
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      instructions: input.system,
      input: toResponsesInput(input.messages),
      tools: input.tools.map(toResponsesTool),
      max_output_tokens: this.config.maxTokens ?? 8192,
    };
    if (this.config.reasoningEffort) {
      body.reasoning = { effort: this.config.reasoningEffort };
    }

    const response = await fetch(`${trimSlash(this.config.baseUrl ?? "https://api.openai.com/v1")}/responses`, {
      method: "POST",
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(body),
    });

    const raw = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${invalidCredentialHint(this.name, this.config)} Provider response: ${JSON.stringify(raw)}`);
      }
      throw new Error(`OpenAI Responses error ${response.status}: ${JSON.stringify(raw)}`);
    }
    return parseResponses(raw);
  }
}

export function toResponsesInput(messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: [{ type: "input_text", text: textFromBlocks(message.content) }] });
    } else if (message.role === "assistant") {
      const text = textFromBlocks(message.content);
      if (text) out.push({ role: "assistant", content: [{ type: "output_text", text }] });
      // The tool calls have to go back too. Without them the `function_call_output`
      // below references a `call_id` that is not in the input, and the API
      // rejects the whole turn — which broke every multi-turn tool use here.
      for (const call of message.toolCalls ?? []) {
        out.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        });
      }
    } else if (message.role === "toolResult") {
      out.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: textFromBlocks(message.content),
      });
    }
  }
  return out;
}

function toResponsesTool(tool: AgentTool): unknown {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function parseResponses(raw: unknown): ProviderResponse {
  const root = raw as { output?: unknown[]; output_text?: string };
  let text = typeof root.output_text === "string" ? root.output_text : "";
  const toolCalls: ToolCall[] = [];
  for (const item of root.output ?? []) {
    const record = item as Record<string, unknown>;
    if (record.type === "function_call") {
      toolCalls.push({
        id: String(record.call_id ?? record.id ?? `call_${toolCalls.length}`),
        name: String(record.name ?? ""),
        arguments: safeJsonParseObject(String(record.arguments ?? "{}")),
      });
    } else if (record.type === "message" && Array.isArray(record.content)) {
      for (const part of record.content as Record<string, unknown>[]) {
        if (part.type === "output_text" && typeof part.text === "string") {
          text += text ? `\n${part.text}` : part.text;
        }
      }
    }
  }
  return { text, toolCalls, usage: responsesUsage(raw), raw };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
