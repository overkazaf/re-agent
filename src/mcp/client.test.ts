import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpClient } from "./client";
import { connectMcpServers, mcpToolName } from "./tools";
import type { ToolContext } from "../types";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** A stdio MCP server just real enough to exercise the transport. */
const FAKE_SERVER = `
const send = payload => { process.stdout.write(JSON.stringify(payload) + "\\n"); };
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      // Chatty servers log to stdout; the client must not choke on it.
      process.stdout.write("starting up, not json\\n");
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "echo", description: "echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "boom", description: "fails", inputSchema: { type: "object", properties: {} } },
        { name: "hidden", description: "filtered out", inputSchema: { type: "object", properties: {} } },
      ] } });
    } else if (message.method === "tools/call") {
      if (message.params.name === "boom") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "tool exploded" } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo:" + message.params.arguments.text }] } });
      }
    }
  }
});
`;

async function fakeServer(): Promise<{ command: string; args: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-mcp-"));
  dirs.push(dir);
  const file = path.join(dir, "server.mjs");
  await fs.writeFile(file, FAKE_SERVER, "utf8");
  return { command: process.execPath, args: [file] };
}

function context(sessionDir: string): ToolContext {
  return {
    workspace: sessionDir,
    sessionDir,
    policy: {
      allowWrites: false,
      allowNetwork: false,
      allowSensitive: false,
      commandTimeoutMs: 5000,
      maxReadBytes: 4096,
      maxToolOutputChars: 4000,
      approvalMode: "safe",
      approvals: {},
    },
  };
}

describe("mcpToolName", () => {
  test("sanitizes and stays inside the 64-char provider limit", () => {
    expect(mcpToolName("ida", "get_metadata")).toBe("mcp__ida__get_metadata");
    expect(mcpToolName("github.com/mrexodia/ida-pro-mcp", "x")).toMatch(/^mcp__[A-Za-z0-9_-]+__x$/);
    const long = mcpToolName("a".repeat(80), "get_function_by_address");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("get_function_by_address")).toBe(true);
  });
});

describe("McpClient", () => {
  test("handshakes, lists tools, and round-trips a call", async () => {
    const server = await fakeServer();
    const client = await McpClient.connect("fake", server);
    expect(client.available.map(tool => tool.name)).toEqual(["echo", "boom", "hidden"]);
    expect(client.status).toBe("ready");

    const result = await client.callTool("echo", { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    client.close();
    expect(client.alive).toBe(false);
  });

  test("surfaces a server-side error as a rejection", async () => {
    const server = await fakeServer();
    const client = await McpClient.connect("fake", server);
    await expect(client.callTool("boom", {})).rejects.toThrow(/tool exploded/);
    client.close();
  });

  test("honors the tool allow-list from config", async () => {
    const server = await fakeServer();
    const client = await McpClient.connect("fake", { ...server, tools: ["echo"] });
    expect(client.available.map(tool => tool.name)).toEqual(["echo"]);
    client.close();
  });

  test("a call after close fails instead of hanging", async () => {
    const server = await fakeServer();
    const client = await McpClient.connect("fake", server);
    client.close();
    await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/not connected/);
  });
});

describe("connectMcpServers", () => {
  test("wraps remote tools as AgentTools", async () => {
    const server = await fakeServer();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "0xaf-mcp-ctx-"));
    dirs.push(dir);
    const [connection] = await connectMcpServers({ fake: server });

    expect(connection.error).toBeUndefined();
    expect(connection.tools.map(tool => tool.name)).toContain("mcp__fake__echo");
    const echo = connection.tools.find(tool => tool.name === "mcp__fake__echo")!;
    expect(echo.risk).toBe("write");
    expect(echo.description).toContain("[fake]");

    const result = await echo.execute({ text: "yo" }, context(dir));
    expect(result.content[0]).toEqual({ type: "text", text: "echo:yo" });
    connection.client?.close();
  });

  test("a server that will not start is reported, not thrown", async () => {
    const [connection] = await connectMcpServers({ broken: { command: "definitely-not-a-real-binary-xyz" } });
    expect(connection.tools).toHaveLength(0);
    expect(connection.error).toBeTruthy();
  });

  test("disabled servers are skipped", async () => {
    const server = await fakeServer();
    expect(await connectMcpServers({ fake: { ...server, disabled: true } })).toHaveLength(0);
  });
});
