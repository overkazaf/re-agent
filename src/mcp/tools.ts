// Wraps MCP server tools as native AgentTools so the loop, the approval gate
// and the output budget treat them exactly like the built-in ones.

import { McpClient } from "./client";
import type { McpServerConfig } from "./client";
import { spillIfLarge } from "../tools/output";
import { textFromBlocks } from "../utils";
import type { AgentTool } from "../types";

/** OpenAI-compatible tool names: `[A-Za-z0-9_-]{1,64}`. */
const MAX_TOOL_NAME = 64;

export interface McpConnection {
  name: string;
  client?: McpClient;
  tools: AgentTool[];
  error?: string;
}

export function mcpToolName(server: string, tool: string): string {
  const slug = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const full = `mcp__${slug(server)}__${slug(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  // Trim the server half first: the tool name is what the model reasons about.
  const room = MAX_TOOL_NAME - `mcp____${slug(tool)}`.length;
  return `mcp__${slug(server).slice(0, Math.max(1, room))}__${slug(tool)}`.slice(0, MAX_TOOL_NAME);
}

/**
 * Connects every configured server. A server that fails to start is reported,
 * never fatal — an IDA plugin that is not running should not stop a session.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): Promise<McpConnection[]> {
  const entries = Object.entries(servers ?? {}).filter(([, config]) => !config.disabled);
  return await Promise.all(entries.map(([name, config]) => connectOne(name, config)));
}

async function connectOne(name: string, config: McpServerConfig): Promise<McpConnection> {
  try {
    const client = await McpClient.connect(name, config);
    return { name, client, tools: client.available.map(tool => wrap(name, client, tool)) };
  } catch (error) {
    return { name, tools: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function wrap(server: string, client: McpClient, tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }): AgentTool {
  return {
    name: mcpToolName(server, tool.name),
    description: `[${server}] ${tool.description ?? tool.name}`,
    // MCP servers do not declare a tier; treat them as state-changing, which is
    // what the approval modes assume for anything that is not a plain read.
    risk: "write",
    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    async execute(args, context) {
      const result = await client.callTool(tool.name, args, { signal: context.signal });
      const spilled = await spillIfLarge(textFromBlocks(result.content), {
        context,
        label: `${server}-${tool.name}`,
      });
      const images = result.content.filter(block => block.type === "image");
      return {
        content: [{ type: "text", text: spilled.text }, ...images],
        isError: result.isError,
        details: { server, tool: tool.name, artifact: spilled.artifact },
      };
    },
  };
}
