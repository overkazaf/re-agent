import { invalidCredentialHint, missingCredentialHint } from "../auth";
import type { AgentMessage, AgentTool, ChatProvider, ProviderConfig, ProviderInput, ProviderResponse, ToolCall } from "../types";
import { textFromBlocks } from "../utils";
import { anthropicUsage } from "./usage";

interface AnthropicCredential {
  value: string;
  scheme: "api-key" | "bearer";
}

export class AnthropicProvider implements ChatProvider {
  constructor(
    readonly name: string,
    readonly config: ProviderConfig,
  ) {}

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    const credential = resolveAnthropicCredential(this.config);
    if (!credential) {
      throw new Error(missingCredentialHint(this.name, this.config));
    }

    const response = await fetch(`${trimSlash(this.config.baseUrl ?? "https://api.anthropic.com")}/v1/messages`, {
      method: "POST",
      signal: input.signal,
      headers: {
        ...authHeaders(credential),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 8192,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        tools: input.tools.map(toAnthropicTool),
      }),
    });

    const raw = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${invalidCredentialHint(this.name, this.config)} Anthropic response: ${JSON.stringify(raw)}`);
      }
      throw new Error(`Anthropic error ${response.status}: ${JSON.stringify(raw)}`);
    }
    return parseAnthropic(raw);
  }
}

function resolveAnthropicCredential(config: ProviderConfig): AnthropicCredential | undefined {
  if (config.apiKey?.trim()) {
    return { value: config.apiKey.trim(), scheme: config.authScheme ?? inferSchemeFromValue(config.apiKey) };
  }
  for (const key of config.apiKeyEnv ?? []) {
    const value = process.env[key];
    if (value?.trim()) {
      return { value: value.trim(), scheme: config.authScheme ?? inferSchemeFromEnv(key) };
    }
  }
  return undefined;
}

function authHeaders(credential: AnthropicCredential): Record<string, string> {
  if (credential.scheme === "bearer") {
    return { Authorization: `Bearer ${credential.value}` };
  }
  return { "x-api-key": credential.value };
}

function inferSchemeFromEnv(envName: string): "api-key" | "bearer" {
  return envName.includes("OAUTH") || envName.includes("AUTH_TOKEN") ? "bearer" : "api-key";
}

function inferSchemeFromValue(value: string): "api-key" | "bearer" {
  return value.trim().startsWith("sk-ant-") ? "api-key" : "bearer";
}

function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: textFromBlocks(message.content) }] });
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      const text = textFromBlocks(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
    } else if (message.role === "toolResult") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: textFromBlocks(message.content), is_error: message.isError === true }],
      });
    }
  }
  return out;
}

function toAnthropicTool(tool: AgentTool): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function parseAnthropic(raw: unknown): ProviderResponse {
  const root = raw as { content?: Array<Record<string, unknown>> };
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const part of root.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      text += text ? `\n${part.text}` : part.text;
    } else if (part.type === "tool_use") {
      toolCalls.push({
        id: String(part.id ?? `call_${toolCalls.length}`),
        name: String(part.name ?? ""),
        arguments: isRecord(part.input) ? part.input : {},
      });
    }
  }
  return { text, toolCalls, usage: anthropicUsage(raw), raw };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
