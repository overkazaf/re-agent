import { describe, expect, test } from "bun:test";
import { toResponsesInput } from "./openai-responses";
import { textBlock } from "../utils";
import type { AgentMessage } from "../types";

describe("toResponsesInput", () => {
  // The Responses API matches function_call_output to a function_call by
  // call_id. Sending the output without the call is a 400, which used to break
  // codex-api/grok on the turn after *any* tool use — update_plan included.
  test("round-trips a tool call so its output has something to attach to", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [textBlock("triage ./chall")] },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "update_plan", arguments: { plan: [{ step: "triage", status: "pending" }] } }],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "update_plan", content: [textBlock("plan updated")] },
    ];
    const input = toResponsesInput(messages) as Array<Record<string, unknown>>;

    const call = input.find(item => item.type === "function_call");
    const output = input.find(item => item.type === "function_call_output");
    expect(call).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "triage", status: "pending" }] }),
    });
    expect(output).toMatchObject({ call_id: "call_1" });
    // Order matters: the call has to precede its output.
    expect(input.indexOf(call!)).toBeLessThan(input.indexOf(output!));
  });

  test("keeps assistant text alongside its tool calls", () => {
    const input = toResponsesInput([
      {
        role: "assistant",
        content: [textBlock("running the plan tool")],
        toolCalls: [{ id: "c", name: "grep", arguments: {} }],
      },
    ]) as Array<Record<string, unknown>>;
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({ role: "assistant" });
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "c" });
  });

  test("every tool result has a matching call in the input", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [textBlock("go")] },
      {
        role: "assistant",
        content: [],
        toolCalls: [
          { id: "a", name: "list_files", arguments: {} },
          { id: "b", name: "read_file", arguments: { path: "x" } },
        ],
      },
      { role: "toolResult", toolCallId: "a", toolName: "list_files", content: [textBlock("x")] },
      { role: "toolResult", toolCallId: "b", toolName: "read_file", content: [textBlock("y")] },
    ];
    const input = toResponsesInput(messages) as Array<Record<string, unknown>>;
    const callIds = new Set(input.filter(item => item.type === "function_call").map(item => item.call_id));
    const outputIds = input.filter(item => item.type === "function_call_output").map(item => item.call_id);
    expect(outputIds).toHaveLength(2);
    for (const id of outputIds) expect(callIds.has(id)).toBe(true);
  });
});
