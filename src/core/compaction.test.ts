import { describe, expect, test } from "bun:test";
import { compactHistory, estimateTokens, historyTokens } from "./compaction";
import { textBlock, textFromBlocks } from "../utils";
import type { AgentMessage } from "../types";

const user = (text: string): AgentMessage => ({ role: "user", content: [textBlock(text)] });
const assistant = (text: string): AgentMessage => ({ role: "assistant", content: [textBlock(text)] });
const assistantCalling = (id: string): AgentMessage => ({
  role: "assistant",
  content: [],
  toolCalls: [{ id, name: "run_command", arguments: { command: "objdump -d ./chall" } }],
});
const toolResult = (id: string, text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "run_command",
  content: [textBlock(text)],
});

describe("estimateTokens", () => {
  test("counts CJK heavier than latin", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("逆向分析")).toBeGreaterThan(estimateTokens("abcd"));
  });
});

describe("compactHistory", () => {
  test("passes a small history through untouched", () => {
    const history = [user("hi"), assistant("hello")];
    const result = compactHistory(history, { budgetTokens: 1000 });
    expect(result.messages).toEqual(history);
    expect(result.droppedMessages).toBe(0);
    expect(result.elidedToolResults).toBe(0);
  });

  test("elides old tool result bodies before dropping anything", () => {
    const history = [
      user("disassemble it"),
      assistantCalling("a"),
      toolResult("a", `HEADLINE\n${"x".repeat(6000)}`),
      user("and now?"),
      assistant("done"),
    ];
    const result = compactHistory(history, { budgetTokens: 200, keepRecentMessages: 2 });

    expect(result.elidedToolResults).toBe(1);
    expect(result.droppedMessages).toBe(0);
    const elided = result.messages.find(message => message.role === "toolResult")!;
    const text = textFromBlocks(elided.content);
    expect(text).toContain("elided to save context");
    expect(text).toContain("HEADLINE"); // the first line survives as a pointer
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  test("drops whole exchanges and leaves a marker when elision is not enough", () => {
    const history: AgentMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push(user(`step ${i} ${"detail ".repeat(60)}`));
      history.push(assistant(`answer ${i} ${"prose ".repeat(60)}`));
    }
    const result = compactHistory(history, { budgetTokens: 400, keepRecentMessages: 4 });

    expect(result.droppedMessages).toBeGreaterThan(0);
    // The last exchange plus the marker is the floor — it cannot go below that,
    // but everything else is gone.
    expect(result.messages).toHaveLength(3);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore / 5);
    const marker = textFromBlocks(result.messages[0].content);
    expect(marker).toContain("[context compacted]");
    expect(marker).toContain("Earlier requests:");
    // The newest exchange is always still there verbatim.
    expect(textFromBlocks(result.messages.at(-1)!.content)).toContain("answer 11");
  });

  test("never separates a tool call from its results", () => {
    const history: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(user(`ask ${i} ${"pad ".repeat(50)}`));
      history.push(assistantCalling(`c${i}`));
      history.push(toolResult(`c${i}`, `output ${i} ${"pad ".repeat(50)}`));
    }
    const result = compactHistory(history, { budgetTokens: 300, keepRecentMessages: 3 });

    const ids = new Set<string>();
    for (const message of result.messages) {
      if (message.role === "assistant" && message.toolCalls) for (const call of message.toolCalls) ids.add(call.id);
      if (message.role === "toolResult") {
        // A result without its call would make strict chat APIs reject the turn.
        expect(ids.has(message.toolCallId)).toBe(true);
      }
    }
  });

  test("historyTokens tracks the compaction result", () => {
    const history = [user("a".repeat(4000)), assistant("b".repeat(4000)), user("recent"), assistant("recent reply")];
    const result = compactHistory(history, { budgetTokens: 60, keepRecentMessages: 2 });
    expect(historyTokens(result.messages)).toBe(result.tokensAfter);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });
});
