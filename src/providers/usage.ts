// Token-usage extraction for the HTTP providers. Each vendor names the fields
// differently; this normalizes them onto TokenUsage.

import type { TokenUsage } from "../types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compact(usage: TokenUsage): TokenUsage | undefined {
  return Object.values(usage).some(value => value !== undefined) ? usage : undefined;
}

export function anthropicUsage(raw: unknown): TokenUsage | undefined {
  const usage = record(record(raw)?.usage);
  if (!usage) return undefined;
  return compact({
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  });
}

export function responsesUsage(raw: unknown): TokenUsage | undefined {
  const usage = record(record(raw)?.usage);
  if (!usage) return undefined;
  const details = record(usage.output_tokens_details);
  const cached = record(usage.input_tokens_details);
  return compact({
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    thinking: num(details?.reasoning_tokens),
    cacheRead: num(cached?.cached_tokens),
  });
}

export function chatUsage(raw: unknown): TokenUsage | undefined {
  const usage = record(record(raw)?.usage);
  if (!usage) return undefined;
  const details = record(usage.completion_tokens_details);
  const cached = record(usage.prompt_tokens_details);
  return compact({
    input: num(usage.prompt_tokens),
    output: num(usage.completion_tokens),
    thinking: num(details?.reasoning_tokens),
    cacheRead: num(cached?.cached_tokens),
  });
}
