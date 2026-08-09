import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlSession, listSessions, loadSession, resolveSession } from "./session";
import { textBlock } from "../utils";
import type { AgentMessage } from "../types";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-session-"));
  dirs.push(dir);
  return dir;
}

const user = (text: string): AgentMessage => ({ role: "user", content: [textBlock(text)] });

describe("session round trip", () => {
  test("writes and reads back a transcript with its plan", async () => {
    const dir = await scratch();
    const session = new JsonlSession(dir, "0xaf");
    await session.init({ workspace: "/ctf/chall" });
    await session.appendMessage(user("triage ./chall"));
    await session.appendMessage({ role: "assistant", content: [textBlock("on it")] });
    await session.appendEvent({ type: "plan", source: "codex", steps: [{ text: "unpack", status: "in_progress" }] });

    const loaded = await loadSession(session.file);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.meta.workspace).toBe("/ctf/chall");
    expect(loaded.plan?.steps[0].text).toBe("unpack");
  });

  test("survives a truncated final line", async () => {
    const dir = await scratch();
    const session = new JsonlSession(dir, "0xaf");
    await session.init({});
    await session.appendMessage(user("first"));
    await fs.appendFile(session.file, '{"type":"message","timestamp":"x","data":{"role":"us', "utf8");

    const loaded = await loadSession(session.file);
    expect(loaded.messages).toHaveLength(1);
  });

  test("drops tool calls whose results never landed", async () => {
    const dir = await scratch();
    const session = new JsonlSession(dir, "0xaf");
    await session.init({});
    await session.appendMessage(user("run it"));
    await session.appendMessage({
      role: "assistant",
      content: [],
      toolCalls: [
        { id: "done", name: "run_command", arguments: {} },
        { id: "lost", name: "run_command", arguments: {} },
      ],
    });
    await session.appendMessage({ role: "toolResult", toolCallId: "done", toolName: "run_command", content: [textBlock("ok")] });

    const loaded = await loadSession(session.file);
    const assistant = loaded.messages.find(message => message.role === "assistant");
    expect(assistant?.role === "assistant" && assistant.toolCalls?.map(call => call.id)).toEqual(["done"]);
  });

  test("lists newest first and resolves ids, prefixes, and paths", async () => {
    const dir = await scratch();
    const older = new JsonlSession(dir, "0xaf");
    await older.init({});
    await older.appendMessage(user("older question"));
    await Bun.sleep(1100); // mtime resolution
    const newer = new JsonlSession(dir, "0xaf");
    await newer.init({});
    await newer.appendMessage(user("newer question"));

    const sessions = await listSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].file).toBe(newer.file);
    expect(sessions[0].firstPrompt).toBe("newer question");
    expect(sessions[0].messages).toBe(1);

    expect((await resolveSession(dir))?.file).toBe(newer.file);
    expect((await resolveSession(dir, sessions[1].id))?.file).toBe(older.file);
    expect((await resolveSession(dir, older.file))?.file).toBe(older.file);
    expect((await resolveSession(dir, "nope"))).toBeUndefined();
  });

  test("ignores operator-shell and compaction markers when labelling a session", async () => {
    const dir = await scratch();
    const session = new JsonlSession(dir, "0xaf");
    await session.init({});
    await session.appendMessage(user("[operator shell] I ran this myself"));
    await session.appendMessage(user("the real question"));

    const [summary] = await listSessions(dir);
    expect(summary.firstPrompt).toBe("the real question");
  });
});
