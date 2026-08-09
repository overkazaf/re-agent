import type { ChatProvider, ProviderConfig, ProviderInput, ProviderResponse, ToolCall } from "../types";

/**
 * Offline stand-in. By default it echoes the prompt and calls nothing, which is
 * what `--smoke` wants. A `mockScript` in the provider config turns it into a
 * scripted actor instead — one entry per turn — so tool-driven behaviour (the
 * plan subsystem in particular) can be exercised end to end without a network
 * or an API key. The last entry repeats once the script runs out.
 */
export class MockProvider implements ChatProvider {
  private turn = 0;

  constructor(
    readonly name: string,
    readonly config: ProviderConfig,
  ) {}

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    const script = this.config.mockScript;
    if (script && script.length > 0) {
      const step = script[Math.min(this.turn++, script.length - 1)];
      const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((call, index) => ({
        id: call.id ?? `mock_${this.turn}_${index}`,
        name: call.name,
        arguments: call.arguments ?? {},
      }));
      input.onProgress?.({ kind: "status", status: "mock" });
      return { text: step.text ?? "", toolCalls, usage: step.usage };
    }

    const last = [...input.messages].reverse().find(message => message.role === "user");
    const prompt = last && last.role === "user" ? last.content.map(block => block.type === "text" ? block.text : "[image]").join("\n") : "";
    return {
      text:
        `0xAF-Re mock response via ${this.name}.\n\n` +
        `Received: ${prompt || "(empty prompt)"}\n\n` +
        `Available tools: ${input.tools.map(tool => tool.name).join(", ")}`,
      toolCalls: [],
    };
  }
}
