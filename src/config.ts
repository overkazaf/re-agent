import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, ProviderConfig, ReasoningEffort } from "./types";
import { fileExists } from "./utils";

const DEFAULT_CONFIG: AgentConfig = {
  name: "0xAF-Re",
  plannerProvider: "codex",
  executorProvider: "claude",
  defaultRole: "auto",
  maxTurns: 8,
  providers: {
    codex: {
      type: "cli-tmux",
      label: "Codex CLI tmux",
      model: "codex-cli",
      cliCommand: "codex",
      cliArgs: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-last-message",
        "{output}",
        "-",
      ],
      cliTimeoutMs: 10 * 60_000,
      cliUnsetEnv: ["OPENAI_API_KEY", "OPENAI_CODEX_OAUTH_TOKEN"],
    },
    claude: {
      type: "cli-tmux",
      label: "Claude Code tmux",
      model: "claude-code-cli",
      cliCommand: "claude",
      cliArgs: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "default"],
      cliTimeoutMs: 10 * 60_000,
      cliUnsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
      cliResumeSession: true,
    },
    "codex-api": {
      type: "openai-responses",
      label: "Codex API",
      model: "gpt-5.3-codex",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: ["OPENAI_API_KEY", "OPENAI_CODEX_OAUTH_TOKEN"],
      reasoningEffort: "high",
    },
    "claude-api": {
      type: "anthropic",
      label: "Claude API Opus 4.8",
      model: "claude-opus-4-8",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
      maxTokens: 8192,
    },
    grok: {
      type: "openai-responses",
      label: "Grok Build 4.5",
      model: "grok-4.5",
      baseUrl: "https://api.x.ai/v1",
      apiKeyEnv: ["XAI_API_KEY"],
      reasoningEffort: "high",
      maxTokens: 8192,
    },
    "grok-cli": {
      type: "cli-tmux",
      label: "Grok Build CLI tmux",
      model: "grok-build-cli",
      cliCommand: "grok",
      cliArgs: [
        "--prompt-file",
        "{prompt}",
        "--output-format",
        "plain",
        "--disable-web-search",
        "--no-memory",
        "--permission-mode",
        "dontAsk",
      ],
      cliTimeoutMs: 10 * 60_000,
      cliPromptMaxChars: 80_000,
      cliResumeSession: true,
    },
    deepseek: {
      type: "openai-chat",
      label: "DeepSeek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: ["DEEPSEEK_API_KEY"],
      maxTokens: 8192,
    },
    glm: {
      type: "openai-chat",
      label: "GLM / Z.AI",
      model: "glm-4.6",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKeyEnv: ["ZAI_API_KEY", "GLM_API_KEY"],
      maxTokens: 8192,
    },
    mock: {
      type: "mock",
      label: "Mock Provider",
      model: "mock-reasoner",
    },
  },
};

export async function loadConfig(configPath?: string): Promise<{ config: AgentConfig; path?: string }> {
  const candidates = [
    configPath,
    path.resolve(process.cwd(), "agent.config.json"),
    path.join(os.homedir(), ".0xaf-re-agent", "config.json"),
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!(await fileExists(resolved))) continue;
    const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as Partial<AgentConfig>;
    return { config: mergeConfig(DEFAULT_CONFIG, parsed), path: resolved };
  }

  return { config: DEFAULT_CONFIG };
}

function mergeConfig(base: AgentConfig, next: Partial<AgentConfig>): AgentConfig {
  const providers: Record<string, ProviderConfig> = { ...base.providers };
  for (const [name, provider] of Object.entries(next.providers ?? {})) {
    providers[name] = { ...(providers[name] ?? {}), ...provider } as ProviderConfig;
  }
  return {
    ...base,
    ...next,
    providers,
    mcpServers: { ...(base.mcpServers ?? {}), ...(next.mcpServers ?? {}) },
    maxTurns: next.maxTurns ?? base.maxTurns,
  };
}

const PREFS_FILE = path.join(os.homedir(), ".0xaf-re-agent", "ui.json");

export interface UiPrefs {
  theme?: string;
  /** Visualization mode for a turn: full | flow | trace | off. */
  flow?: string;
}

/** UI preferences persist separately from agent config so `/theme` can survive restarts. */
export async function loadUiPrefs(): Promise<UiPrefs> {
  if (!(await fileExists(PREFS_FILE))) return {};
  try {
    const parsed = JSON.parse(await fs.readFile(PREFS_FILE, "utf8")) as UiPrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Merges into whatever is already stored, so saving one preference keeps the rest. */
export async function saveUiPrefs(prefs: UiPrefs): Promise<void> {
  try {
    const merged = { ...(await loadUiPrefs()), ...prefs };
    await fs.mkdir(path.dirname(PREFS_FILE), { recursive: true, mode: 0o700 });
    await fs.writeFile(PREFS_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  } catch {
    // preference persistence is best-effort; never break the session over it
  }
}

/**
 * Applies a reasoning-effort level to a provider. HTTP providers carry it in
 * the request body; CLI providers take it through their own argv, which differs
 * per tool, so rewrite the stored args in place.
 */
export function setReasoningEffort(provider: ProviderConfig, effort: ReasoningEffort): void {
  provider.reasoningEffort = effort;
  if (provider.type !== "cli-tmux") return;
  const args = [...(provider.cliArgs ?? [])];

  if (provider.cliCommand === "claude") {
    const index = args.indexOf("--effort");
    if (index >= 0) args[index + 1] = effort;
    else args.unshift("--effort", effort);
    provider.cliArgs = args;
    return;
  }

  if (provider.cliCommand === "codex") {
    const setting = `model_reasoning_effort=${effort}`;
    const index = args.findIndex(arg => arg.startsWith("model_reasoning_effort="));
    if (index >= 0) args[index] = setting;
    else {
      // `-c key=value` must precede the `exec` subcommand's trailing operands.
      const anchor = args.indexOf("exec");
      const at = anchor >= 0 ? anchor + 1 : 0;
      args.splice(at, 0, "-c", setting);
    }
    provider.cliArgs = args;
  }
}

export function resolveApiKey(provider: ProviderConfig): string | undefined {
  if (provider.apiKey?.trim()) return provider.apiKey.trim();
  for (const key of provider.apiKeyEnv ?? []) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}
