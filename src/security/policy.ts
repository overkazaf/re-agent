import type { ExecutionPolicy } from "../types";

const NETWORK_TOKENS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "nmap",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "socat",
  "openssl s_client",
  "dig",
  "whois",
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[^\n;]*r[^\n;]*f\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bdiskutil\s+erase/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\blaunchctl\b/i,
  /\bsudo\b/i,
  />\s*\/dev\/(?:sd|disk|rdisk)/i,
];

const SENSITIVE_PATTERNS = [
  /\.ssh\b/i,
  /\.aws\b/i,
  /\.gnupg\b/i,
  /keychain/i,
  /id_rsa/i,
  /id_ed25519/i,
  /password/i,
  /secret/i,
  /token/i,
];

/**
 * Everything about a command that deserves a second look, in operator-readable
 * form. Empty means the command is unremarkable. Callers decide what to do with
 * the list: ask the operator when there is one to ask, refuse otherwise.
 */
export function commandConcerns(command: string, policy: ExecutionPolicy): string[] {
  const compact = command.trim();
  if (!compact) throw new Error("Command is empty.");
  const concerns: string[] = [];
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(compact)) concerns.push(`destructive pattern ${pattern}`);
  }
  if (!policy.allowNetwork) {
    const lower = compact.toLowerCase();
    for (const token of NETWORK_TOKENS) {
      if (new RegExp(`(^|[\\s;&|])${escapeRegex(token)}($|[\\s;&|])`, "i").test(lower)) {
        concerns.push(`network command '${token}' (--allow-network to stop asking)`);
      }
    }
  }
  if (!policy.allowSensitive) {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(compact)) concerns.push(`sensitive/secret-like token ${pattern} (--allow-sensitive to stop asking)`);
    }
  }
  return concerns;
}

/** Hard refusal, for callers with no approval path (non-interactive runs). */
export function validateCommand(command: string, policy: ExecutionPolicy): void {
  const concerns = commandConcerns(command, policy);
  if (concerns.length > 0) throw new Error(`Blocked by policy: ${concerns.join("; ")}`);
}

export function validatePathRead(pathValue: string, policy: ExecutionPolicy): void {
  if (policy.allowSensitive) return;
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(pathValue)) {
      throw new Error(`Sensitive path blocked by policy: ${pathValue}`);
    }
  }
}

export function validateWriteAllowed(policy: ExecutionPolicy): void {
  if (!policy.allowWrites) {
    throw new Error("Writes are disabled. Start with --write to permit write_file.");
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
