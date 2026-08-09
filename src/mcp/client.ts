// Minimal MCP client (stdio transport, JSON-RPC 2.0 over newline-delimited
// JSON). Enough to borrow another process's tools — IDA Pro through
// ida-pro-mcp being the one that matters here — without pulling in an SDK.

import type { ContentBlock } from "../types";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "0xaf-re-agent", version: "0.1.0" };

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-call ceiling; decompiling a large function is not instant. */
  timeoutMs?: number;
  disabled?: boolean;
  /** Only expose these tool names (after the server lists them). */
  tools?: string[];
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private tools: McpToolInfo[] = [];
  private closed = false;
  private exitReason?: string;

  private constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly proc: ReturnType<typeof Bun.spawn>,
  ) {}

  static async connect(name: string, config: McpServerConfig): Promise<McpClient> {
    const proc = Bun.spawn([config.command, ...(config.args ?? [])], {
      cwd: config.cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const client = new McpClient(name, config, proc);
    client.pump();
    client.watchExit();
    try {
      await client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      client.notify("notifications/initialized", {});
      const listed = (await client.request("tools/list", {})) as { tools?: McpToolInfo[] };
      client.tools = (listed.tools ?? []).filter(tool => !config.tools || config.tools.includes(tool.name));
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  get available(): McpToolInfo[] {
    return this.tools;
  }

  get alive(): boolean {
    return !this.closed && this.exitReason === undefined;
  }

  get status(): string {
    if (this.exitReason) return this.exitReason;
    return this.closed ? "closed" : "ready";
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ content: ContentBlock[]; isError?: boolean }> {
    const raw = (await this.request("tools/call", { name: tool, arguments: args }, options.signal)) as {
      content?: Array<Record<string, unknown>>;
      isError?: boolean;
    };
    return { content: toBlocks(raw.content ?? []), isError: raw.isError };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server '${this.name}' closed before request ${id} answered.`));
    }
    this.pending.clear();
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error(`MCP server '${this.name}' is not connected (${this.status}).`);
    const id = this.nextId++;
    const timeoutMs = this.config.timeoutMs ?? 60_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${this.name}' ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(new Error("Interrupted by operator."));
        },
        { once: true },
      );
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return await promise;
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(payload: unknown): void {
    const stdin = this.proc.stdin as { write(chunk: string): void; flush?(): void };
    stdin.write(`${JSON.stringify(payload)}\n`);
    stdin.flush?.();
  }

  /** Reads newline-delimited JSON-RPC frames until the process ends. */
  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (line) this.dispatch(line);
          newline = this.buffer.indexOf("\n");
        }
      }
    } catch {
      // stream torn down with the process
    }
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
    try {
      message = JSON.parse(line);
    } catch {
      return; // servers sometimes log plain text to stdout; ignore it
    }
    if (typeof message.id !== "number") return; // notification from the server
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`MCP '${this.name}': ${message.error.message ?? "unknown error"}`));
    else pending.resolve(message.result);
  }

  private async watchExit(): Promise<void> {
    const code = await this.proc.exited.catch(() => -1);
    const stderr = await new Response(this.proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
    this.exitReason = `exited (code ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}`;
    this.close();
  }
}

function toBlocks(content: Array<Record<string, unknown>>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
    } else if (item.type === "image" && typeof item.data === "string") {
      blocks.push({ type: "image", data: item.data, mimeType: String(item.mimeType ?? "image/png") });
    } else {
      // resource links and anything newer: keep the payload rather than drop it
      blocks.push({ type: "text", text: JSON.stringify(item) });
    }
  }
  return blocks;
}
