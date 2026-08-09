import { describe, expect, test } from "bun:test";
import { formatCliFailure } from "./cli-tmux";

// Trimmed from a real failing run: `claude -p --output-format stream-json` where
// the upstream model refused. Exit 1, empty stderr, and the only line that
// explains anything is the terminal `result` event.
const REFUSAL_STDOUT = [
  '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"063e3cf2"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785090000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false}}',
  '{"is_error":true,"duration_api_ms":3305,"num_turns":1,"stop_reason":"refusal","session_id":"063e3cf2","total_cost_usd":0.7232}',
].join("\n");

describe("formatCliFailure", () => {
  test("explains a refusal instead of dumping the event stream", () => {
    const message = formatCliFailure("claude", "claude", 1, REFUSAL_STDOUT, "", "/tmp/run", "claude-json");
    expect(message).toContain("failed with exit 1");
    expect(message).toContain("stop_reason=refusal");
    expect(message).toContain("/agent codex");
    expect(message).toContain("overage rejected (out_of_credits)");
    // The misleading auth hint is suppressed once the real cause is known.
    expect(message).not.toContain("auth login");
    // And the raw JSONL wall never reaches the operator.
    expect(message).not.toContain("content_block_delta");
    expect(message.split("\n").length).toBeLessThan(12);
  });

  test("still dumps stdout when the CLI is not streaming JSONL", () => {
    const message = formatCliFailure("codex", "codex", 2, "boom: something broke", "", "/tmp/run");
    expect(message).toContain("boom: something broke");
    expect(message).toContain("codex login");
  });

  test("falls back to the auth hint when the stream carries no result event", () => {
    const partial = '{"type":"system","subtype":"init"}';
    const message = formatCliFailure("claude", "claude", 1, partial, "", "/tmp/run", "claude-json");
    expect(message).toContain("auth login");
    expect(message).not.toContain("stop_reason");
  });

  test("reports max-turns and surfaces the CLI's own message", () => {
    const stdout = '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"ran out of turns"}';
    const message = formatCliFailure("claude", "claude", 1, stdout, "", "/tmp/run", "claude-json");
    expect(message).toContain("max-turn limit");
    expect(message).toContain("ran out of turns");
  });

  test("survives malformed lines in the stream", () => {
    const stdout = ["not json", "{oops", '{"type":"result","is_error":true,"stop_reason":"refusal"}'].join("\n");
    expect(() => formatCliFailure("claude", "claude", 1, stdout, "", "/tmp/run", "claude-json")).not.toThrow();
    expect(formatCliFailure("claude", "claude", 1, stdout, "", "/tmp/run", "claude-json")).toContain("refused");
  });

  test("keeps stderr, which is where a crash actually lands", () => {
    const message = formatCliFailure("claude", "claude", 1, REFUSAL_STDOUT, "segfault", "/tmp/run", "claude-json");
    expect(message).toContain("stderr:\nsegfault");
  });
});
