import { describe, expect, test } from "bun:test";
import { toChatMessages } from "./openai-chat";
import type { AgentMessage } from "../types";

const textBlock = (text: string) => ({ type: "text" as const, text });

describe("toChatMessages", () => {
  // DeepSeek/GLM reject `"tool_calls": []` with
  // "Invalid 'messages[n].tool_calls': empty array", which used to break every
  // follow-up turn as soon as one plain assistant reply was in the history.
  test("omits tool_calls entirely for a plain assistant reply", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [textBlock("who are you")] },
      { role: "assistant", content: [textBlock("I am 0xAF-Re.")] },
      { role: "user", content: [textBlock("again")] },
    ];
    const out = toChatMessages("sys", messages) as Array<Record<string, unknown>>;
    expect(out[2]).toEqual({ role: "assistant", content: "I am 0xAF-Re." });
    expect("tool_calls" in out[2]).toBe(false);
  });

  test("never sends a null content without tool calls", () => {
    const out = toChatMessages("sys", [{ role: "assistant", content: [] }]) as Array<Record<string, unknown>>;
    expect(out[1]).toEqual({ role: "assistant", content: "" });
  });

  test("keeps tool calls, using null content when the reply was tool-only", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "run_command", arguments: { command: "ls" } }],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "run_command", content: [textBlock("chall.bin")] },
    ];
    const out = toChatMessages("sys", messages) as Array<Record<string, unknown>>;
    expect(out[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } }],
    });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "chall.bin" });
  });
});
