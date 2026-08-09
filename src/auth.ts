import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, ProviderConfig } from "./types";
import { fileExists } from "./utils";

interface StoredSecrets {
  providers?: Record<string, { apiKey?: string }>;
}

export interface AuthStatus {
  provider: string;
  label: string;
  configured: boolean;
  source: string;
  envVars: string[];
}

const AUTH_DIR = path.join(os.homedir(), ".0xaf-re-agent");
const SECRETS_FILE = path.join(AUTH_DIR, "secrets.json");

export async function initializeAuthSources(config: AgentConfig, workspace: string): Promise<void> {
  await loadEnvFiles(workspace);
  await applyStoredSecrets(config);
}

export async function loginProvider(config: AgentConfig, providerName: string, apiKey: string): Promise<void> {
  const provider = config.providers[providerName];
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Empty credential was not saved.");

  const secrets = await readSecrets();
  secrets.providers ??= {};
  secrets.providers[providerName] = { apiKey: trimmed };
  await fs.mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(SECRETS_FILE, 0o600).catch(() => {});
  provider.apiKey = trimmed;
}

export async function logoutProvider(config: AgentConfig, providerName: string): Promise<boolean> {
  const secrets = await readSecrets();
  if (!secrets.providers?.[providerName]) return false;
  delete secrets.providers[providerName];
  await fs.mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(SECRETS_FILE, 0o600).catch(() => {});
  if (config.providers[providerName]?.apiKey) {
    delete config.providers[providerName].apiKey;
  }
  return true;
}

export async function credentialStatuses(config: AgentConfig): Promise<AuthStatus[]> {
  const secrets = await readSecrets();
  return await Promise.all(Object.entries(config.providers).map(async ([name, provider]) => {
    if (provider.type === "cli-tmux" || provider.type === "mock") {
      const source = provider.type === "mock" ? "mock" : await cliCredentialSource(provider);
      return {
        provider: name,
        label: provider.label ?? provider.type,
        configured: provider.type === "mock" || source.endsWith(":logged-in") || source.endsWith(":available"),
        source,
        envVars: [],
      };
    }
    const source = credentialSource(name, provider, secrets);
    return {
      provider: name,
      label: provider.label ?? provider.type,
      configured: source !== "missing",
      source,
      envVars: provider.apiKeyEnv ?? [],
    };
  }));
}

export function missingCredentialHint(providerName: string, provider: ProviderConfig): string {
  const envs = provider.apiKeyEnv?.join(", ") || "(none configured)";
  const lines = [
    `Missing API key for provider '${providerName}'.`,
    `Set one of: ${envs}`,
    `or run: bun src/cli.ts auth login ${providerName}`,
    `Credential store: ${SECRETS_FILE}`,
  ];
  if (provider.type === "anthropic" || providerName.toLowerCase().includes("claude")) {
    lines.push(
      "For standalone Claude Code, run: claude auth login; verify with: claude auth status.",
      "Note: Claude Code app login is not automatically the same as an Anthropic API key unless it exports ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN.",
    );
  }
  return lines.join(" ");
}

export function invalidCredentialHint(providerName: string, provider: ProviderConfig): string {
  const envs = provider.apiKeyEnv?.join(", ") || "(none configured)";
  const lines = [
    `Invalid API key/token for provider '${providerName}'.`,
    `Current credential came from config/env/store; expected one of: ${envs}`,
    `Run: bun src/cli.ts auth status`,
    `If source=stored, run: bun src/cli.ts auth logout ${providerName} && bun src/cli.ts auth login ${providerName}`,
    `Credential store: ${SECRETS_FILE}`,
  ];
  if (provider.type === "anthropic" || providerName.toLowerCase().includes("claude")) {
    lines.push(
      "If you are using an Anthropic OAuth/WIF token, set authScheme to \"bearer\" in agent.config.json.",
      "For Claude Code subscription login, run: claude auth login; verify with: claude auth status.",
      "For this Anthropic API adapter, use ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN or auth login claude.",
    );
  }
  return lines.join(" ");
}

export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const piped = await Bun.stdin.text();
    return piped.trim();
  }

  process.stdout.write(label);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function loadEnvFiles(workspace: string): Promise<void> {
  const candidates = [
    path.join(workspace, ".env"),
    path.join(process.cwd(), ".env"),
    path.join(AUTH_DIR, ".env"),
    path.join(os.homedir(), ".omp", "agent", ".env"),
    path.join(os.homedir(), ".env"),
  ];
  for (const file of candidates) {
    if (!(await fileExists(file))) continue;
    const vars = parseEnv(await fs.readFile(file, "utf8"));
    for (const [key, value] of Object.entries(vars)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

async function applyStoredSecrets(config: AgentConfig): Promise<void> {
  const secrets = await readSecrets();
  for (const [name, entry] of Object.entries(secrets.providers ?? {})) {
    if (!entry.apiKey?.trim()) continue;
    const provider = config.providers[name];
    if (!provider) continue;
    if (provider.apiKey?.trim()) continue;
    const hasEnv = (provider.apiKeyEnv ?? []).some(key => process.env[key]?.trim());
    if (!hasEnv) provider.apiKey = entry.apiKey.trim();
  }
}

async function readSecrets(): Promise<StoredSecrets> {
  if (!(await fileExists(SECRETS_FILE))) return {};
  try {
    const parsed = JSON.parse(await fs.readFile(SECRETS_FILE, "utf8")) as StoredSecrets;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function credentialSource(providerName: string, provider: ProviderConfig, secrets: StoredSecrets): string {
  if (provider.apiKey?.trim()) return "config/runtime";
  for (const key of provider.apiKeyEnv ?? []) {
    if (process.env[key]?.trim()) return `env:${key}`;
  }
  if (secrets.providers?.[providerName]?.apiKey?.trim()) return "stored";
  return "missing";
}

async function cliCredentialSource(provider: ProviderConfig): Promise<string> {
  const command = provider.cliCommand;
  if (!command) return "cli:missing-command";
  const args = cliAuthStatusArgs(command);
  if (!args) return `cli:${command}`;
  const result = await runCliStatus(command, args, provider.cliUnsetEnv ?? []);
  if (result.ok) return command === "grok" ? `cli:${command}:available` : `cli:${command}:logged-in`;
  if (result.missingCommand) return `cli:${command}:missing`;
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (text.includes("not logged in") || text.includes("not authenticated") || text.includes("login")) {
    return `cli:${command}:not-logged-in`;
  }
  return `cli:${command}:status-${result.status}`;
}

function cliAuthStatusArgs(command: string): string[] | undefined {
  if (command === "claude") return ["auth", "status", "--text"];
  if (command === "codex") return ["login", "status"];
  if (command === "grok") return ["version"];
  return undefined;
}

async function runCliStatus(
  command: string,
  args: string[],
  unsetEnv: string[],
): Promise<{ ok: boolean; status: number; stdout: string; stderr: string; missingCommand?: boolean }> {
  try {
    const child = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: filteredEnv(unsetEnv),
    });
    const timedOut = await Promise.race([
      child.exited.then(status => ({ timedOut: false, status })),
      Bun.sleep(10_000).then(() => ({ timedOut: true, status: 124 })),
    ]);
    if (timedOut.timedOut) child.kill();
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch(() => ""),
      new Response(child.stderr).text().catch(() => ""),
    ]);
    return { ok: timedOut.status === 0, status: timedOut.status, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 127,
      stdout: "",
      stderr: message,
      missingCommand: message.toLowerCase().includes("no such file") || message.toLowerCase().includes("not found"),
    };
  }
}

function filteredEnv(unsetEnv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of unsetEnv) delete env[key];
  return env;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value.includes("\0")) out[key] = value;
  }
  return out;
}
