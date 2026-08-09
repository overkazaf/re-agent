import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLoop } from "./agent-loop";
import { JsonlSession } from "./session";
import { InterruptedError, textBlock } from "../utils";
import type { AgentConfig, AgentTool, ChatProvider, ProviderInput, ProviderResponse, ToolContext } from "../types";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-loop-"));
  tmpDirs.push(dir);
  return dir;
}

const config: AgentConfig = {
  name: "test",
  plannerProvider: "p",
  executorProvider: "p",
  defaultRole: "auto",
  maxTurns: 4,
  providers: { p: { type: "mock", model: "m" } },
};

function provider(script: Array<(input: ProviderInput) => ProviderResponse | Promise<ProviderResponse>>): ChatProvider {
  let turn = 0;
  return {
    name: "p",
    config: config.providers.p,
    async complete(input) {
      const step = script[Math.min(turn++, script.length - 1)];
      return await step(input);
    },
  };
}

const reply = (text: string): ProviderResponse => ({ text, toolCalls: [] });
const callsTool = (name: string, id = "call_1"): ProviderResponse => ({
  text: "",
  toolCalls: [{ id, name, arguments: {} }],
});

async function makeLoop(
  chat: ChatProvider,
  tools: AgentTool[] = [],
): Promise<{ loop: AgentLoop; context: ToolContext }> {
  const dir = await scratch();
  const session = new JsonlSession(dir, "test");
  await session.init({});
  const context: ToolContext = {
    workspace: dir,
    sessionDir: dir,
    policy: { allowWrites: false, allowNetwork: false, allowSensitive: false, commandTimeoutMs: 1000, maxReadBytes: 1024, maxToolOutputChars: 24_000, approvalMode: "safe", approvals: {} },
  };
  return {
    context,
    loop: new AgentLoop({
      config,
      providers: new Map([["p", chat]]),
      tools,
      toolContext: context,
      systemPrompt: "sys",
      session,
    }),
  };
}

const blockingTool = (started: { resolve?: () => void }): AgentTool => ({
  name: "slow",
  description: "waits for the signal",
  risk: "execute",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    started.resolve?.();
    await new Promise<void>((_ok, fail) => {
      context.signal?.addEventListener("abort", () => fail(new InterruptedError()), { once: true });
    });
    return { content: [textBlock("never")] };
  },
});

describe("AgentLoop context budget", () => {
  test("sends a compacted view while keeping the full history", async () => {
    const seen: number[] = [];
    const chat = provider([
      input => {
        seen.push(input.messages.length);
        return reply("ok");
      },
    ]);
    // A budget this small forces a drop on the second turn.
    chat.config.contextBudgetTokens = 60;
    const { loop } = await makeLoop(chat);
    const events: string[] = [];

    await loop.run("first ".repeat(80));
    await loop.run("second ".repeat(80), { onEvent: event => events.push(event.type) });

    expect(seen[0]).toBe(1);
    // Turn 2 has 3 messages of history but is sent as marker + last exchange.
    expect(loop.history).toHaveLength(4);
    expect(seen[1]).toBeLessThan(3);
    expect(events).toContain("compaction");
  });
});

describe("AgentLoop interruption", () => {
  test("a normal run is unaffected", async () => {
    const { loop } = await makeLoop(provider([() => reply("done")]));
    const result = await loop.run("hi");
    expect(result.interrupted).toBeUndefined();
    expect(result.turns).toBe(1);
    expect(loop.history.at(-1)?.role).toBe("assistant");
  });

  test("an already-aborted signal stops before calling the provider", async () => {
    let calls = 0;
    const { loop } = await makeLoop(provider([() => { calls++; return reply("nope"); }]));
    const result = await loop.run("hi", { signal: AbortSignal.abort() });
    expect(calls).toBe(0);
    expect(result.interrupted).toBe(true);
    expect(result.turns).toBe(0);
  });

  test("a provider abort ends the run and leaves a marker in the history", async () => {
    const controller = new AbortController();
    const { loop } = await makeLoop(
      provider([
        () => {
          controller.abort();
          throw new InterruptedError();
        },
      ]),
    );
    const result = await loop.run("hi", { signal: controller.signal });
    expect(result.interrupted).toBe(true);
    const last = loop.history.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.role === "assistant" && last.content[0]?.type === "text" && last.content[0].text).toContain("interrupted");
  });

  test("the signal reaches tools, and every tool call still gets a result", async () => {
    const controller = new AbortController();
    const started: { resolve?: () => void } = {};
    const running = new Promise<void>(resolve => {
      started.resolve = resolve;
    });
    const { loop } = await makeLoop(
      provider([
        () => ({ text: "", toolCalls: [{ id: "a", name: "slow", arguments: {} }, { id: "b", name: "slow", arguments: {} }] }),
        () => reply("unreachable"),
      ]),
      [blockingTool(started)],
    );
    const run = loop.run("hi", { signal: controller.signal });
    await running;
    controller.abort();
    const result = await run;

    expect(result.interrupted).toBe(true);
    const assistant = loop.history.find(message => message.role === "assistant" && message.toolCalls?.length);
    const results = loop.history.filter(message => message.role === "toolResult");
    // Pairing invariant: strict chat APIs reject a dangling tool call.
    expect(assistant?.role === "assistant" && assistant.toolCalls?.length).toBe(2);
    expect(results.map(message => message.role === "toolResult" && message.toolCallId)).toEqual(["a", "b"]);
    expect(results.every(message => message.role === "toolResult" && message.isError)).toBe(true);
  });

  test("interrupting between turns stops the loop", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { loop } = await makeLoop(
      provider([
        () => {
          calls++;
          controller.abort();
          return callsTool("missing");
        },
        () => {
          calls++;
          return reply("should not run");
        },
      ]),
    );
    const result = await loop.run("hi", { signal: controller.signal });
    expect(calls).toBe(1);
    expect(result.interrupted).toBe(true);
    // The unknown tool still produced a paired result before the loop bailed.
    expect(loop.history.filter(message => message.role === "toolResult")).toHaveLength(1);
  });
});
