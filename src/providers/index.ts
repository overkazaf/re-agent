import type { ChatProvider, ProviderConfig } from "../types";
import { AnthropicProvider } from "./anthropic";
import { CliTmuxProvider } from "./cli-tmux";
import { MockProvider } from "./mock";
import { OpenAIChatProvider } from "./openai-chat";
import { OpenAIResponsesProvider } from "./openai-responses";

export function createProvider(name: string, config: ProviderConfig): ChatProvider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(name, config);
    case "openai-responses":
      return new OpenAIResponsesProvider(name, config);
    case "openai-chat":
      return new OpenAIChatProvider(name, config);
    case "cli-tmux":
      return new CliTmuxProvider(name, config);
    case "mock":
      return new MockProvider(name, config);
    default:
      throw new Error(`Unsupported provider type: ${(config as ProviderConfig).type}`);
  }
}
