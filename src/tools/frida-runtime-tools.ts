import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, ToolContext, ToolResult } from "../types";
import { asNumber, asString, clip, resolveInside, textBlock } from "../utils";
import { requestApproval } from "../security/approval";
import { commandConcerns } from "../security/policy";
import { runProcess } from "./process";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const FRIDA_TARGETS = ["usb", "remote", "local"] as const;
type FridaTarget = (typeof FRIDA_TARGETS)[number];

function targetFlag(target: FridaTarget): string[] {
  if (target === "usb") return ["-U"];
  if (target === "remote") return ["-R"];
  return [];
}

function parseFridaTarget(value: unknown): FridaTarget {
  const s = asString(value, "usb");
  return FRIDA_TARGETS.includes(s as FridaTarget) ? (s as FridaTarget) : "usb";
}

function fridaNotFound(err: unknown): ToolResult {
  if (err instanceof Error && ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|not found/i.test(err.message))) {
    return {
      content: [textBlock("frida-tools not found. Install with: pip install frida-tools")],
      isError: true,
    };
  }
  throw err;
}

export function createFridaRuntimeTools(): AgentTool[] {
  return [
    fridaPsTool,
    fridaSpawnTool,
    fridaAttachTool,
    fridaRunSnippetTool,
    fridaListDevicesTool,
  ];
}

const fridaPsTool: AgentTool = {
  name: "frida_ps",
  description: "List processes on a connected device using frida-ps. Useful for finding target process names or PIDs before attaching.",
  risk: "read",
  parameters: objectSchema({
    target: { type: "string", enum: FRIDA_TARGETS, default: "usb", description: "Device target: usb, remote, or local." },
    filter: { type: "string", description: "Optional string to filter process names (case-insensitive grep)." },
  }),
  async execute(args, context) {
    const target = parseFridaTarget(args.target);
    const cmd = ["frida-ps", ...targetFlag(target)];
    try {
      const result = await runProcess(cmd, {
        cwd: context.workspace,
        timeoutMs: context.policy.commandTimeoutMs,
        signal: context.signal,
      });
      let output = result.stdout || result.stderr || "(no output)";
      const filter = asString(args.filter).trim();
      if (filter && result.stdout) {
        const regex = new RegExp(filter, "i");
        const lines = result.stdout.split(/\r?\n/);
        const header = lines[0] ?? "";
        const separator = lines[1] && /^[-\s]+$/.test(lines[1]) ? lines[1] : "";
        const matches = lines.slice(separator ? 2 : 1).filter(line => regex.test(line));
        output = [header, separator, ...matches].filter(Boolean).join("\n") || `(no processes matching '${filter}')`;
      }
      const spilled = await spillIfLarge(output, { context, label: "frida-ps" });
      return { content: [textBlock(spilled.text)], isError: result.code !== 0, details: { exit: result.code, target, artifact: spilled.artifact } };
    } catch (err) {
      return fridaNotFound(err);
    }
  },
};

const fridaSpawnTool: AgentTool = {
  name: "frida_spawn",
  description: "Spawn an app with Frida instrumentation. Launches the target package with a hook script, captures output for a bounded duration, then terminates. Use for dynamic analysis of Android/iOS apps.",
  risk: "execute",
  parameters: objectSchema({
    package: { type: "string", description: "Application package identifier to spawn (e.g. com.example.app)." },
    script: { type: "string", description: "Workspace-relative path to the Frida hook script (.js)." },
    target: { type: "string", enum: FRIDA_TARGETS, default: "usb" },
    timeoutMs: { type: "number", default: 10000, description: "How long to capture output before killing the process (max 60000)." },
  }, ["package", "script"]),
  async execute(args, context) {
    const pkg = asString(args.package);
    const scriptRel = asString(args.script);
    const scriptPath = resolveInside(context.workspace, scriptRel);
    const target = parseFridaTarget(args.target);
    const timeoutMs = Math.min(Math.max(1000, asNumber(args.timeoutMs, 10000)), 60000);

    await fs.access(scriptPath).catch(() => {
      throw new Error(`Hook script not found: ${scriptRel}`);
    });

    const command = `frida ${targetFlag(target).join(" ")} -f ${pkg} -l ${scriptRel} --no-pause`;
    await requestApproval(
      { tool: "frida_spawn", tier: "exec", summary: command, concerns: commandConcerns(`frida -f ${pkg}`, context.policy) },
      context,
    );

    const cmd = ["frida", ...targetFlag(target), "-f", pkg, "-l", scriptPath, "--no-pause"];
    try {
      const result = await runProcess(cmd, {
        cwd: context.workspace,
        timeoutMs,
        signal: context.signal,
      });
      const output = formatFridaOutput(command, result.stdout, result.stderr, result.code, timeoutMs);
      const spilled = await spillIfLarge(output, { context, label: `frida-spawn-${pkg}` });
      return { content: [textBlock(spilled.text)], isError: result.code !== 0, details: { exit: result.code, package: pkg, target, artifact: spilled.artifact } };
    } catch (err) {
      return fridaNotFound(err);
    }
  },
};

const fridaAttachTool: AgentTool = {
  name: "frida_attach",
  description: "Attach Frida to a running process by PID or name, load a hook script, capture output for a bounded duration. Use frida_ps first to find the target.",
  risk: "execute",
  parameters: objectSchema({
    process: { type: "string", description: "Process PID (number) or process name to attach to." },
    script: { type: "string", description: "Workspace-relative path to the Frida hook script (.js)." },
    target: { type: "string", enum: FRIDA_TARGETS, default: "usb" },
    timeoutMs: { type: "number", default: 10000, description: "How long to capture output before detaching (max 60000)." },
  }, ["process", "script"]),
  async execute(args, context) {
    const proc = asString(args.process);
    const scriptRel = asString(args.script);
    const scriptPath = resolveInside(context.workspace, scriptRel);
    const target = parseFridaTarget(args.target);
    const timeoutMs = Math.min(Math.max(1000, asNumber(args.timeoutMs, 10000)), 60000);

    await fs.access(scriptPath).catch(() => {
      throw new Error(`Hook script not found: ${scriptRel}`);
    });

    const isPid = /^\d+$/.test(proc);
    const procFlag = isPid ? ["-p", proc] : ["-n", proc];
    const command = `frida ${targetFlag(target).join(" ")} ${isPid ? "-p" : "-n"} ${proc} -l ${scriptRel}`;
    await requestApproval(
      { tool: "frida_attach", tier: "exec", summary: command, concerns: commandConcerns(`frida ${isPid ? "-p" : "-n"} ${proc}`, context.policy) },
      context,
    );

    const cmd = ["frida", ...targetFlag(target), ...procFlag, "-l", scriptPath];
    try {
      const result = await runProcess(cmd, {
        cwd: context.workspace,
        timeoutMs,
        signal: context.signal,
      });
      const output = formatFridaOutput(command, result.stdout, result.stderr, result.code, timeoutMs);
      const spilled = await spillIfLarge(output, { context, label: `frida-attach-${proc}` });
      return { content: [textBlock(spilled.text)], isError: result.code !== 0, details: { exit: result.code, process: proc, target, artifact: spilled.artifact } };
    } catch (err) {
      return fridaNotFound(err);
    }
  },
};

const fridaRunSnippetTool: AgentTool = {
  name: "frida_run_snippet",
  description: "Execute an inline Frida script snippet against a spawned app or running process. Writes the code to a temp file, runs Frida, captures output. Ideal for quick one-off hooks without creating a persistent script file.",
  risk: "execute",
  parameters: objectSchema({
    code: { type: "string", description: "Inline Frida JavaScript code to execute." },
    package: { type: "string", description: "Spawn mode: application package to launch (e.g. com.example.app)." },
    process: { type: "string", description: "Attach mode: PID or process name. Provide either package (spawn) or process (attach), not both." },
    target: { type: "string", enum: FRIDA_TARGETS, default: "usb" },
    timeoutMs: { type: "number", default: 10000, description: "Capture duration before terminating (max 60000)." },
  }, ["code"]),
  async execute(args, context) {
    const code = asString(args.code);
    const pkg = asString(args.package).trim();
    const proc = asString(args.process).trim();
    const target = parseFridaTarget(args.target);
    const timeoutMs = Math.min(Math.max(1000, asNumber(args.timeoutMs, 10000)), 60000);

    if (!pkg && !proc) {
      return { content: [textBlock("frida_run_snippet requires either 'package' (spawn) or 'process' (attach).")], isError: true };
    }
    if (pkg && proc) {
      return { content: [textBlock("Provide either 'package' (spawn) or 'process' (attach), not both.")], isError: true };
    }

    const snippetFile = path.join(context.sessionDir, `_frida_snippet_${Date.now()}.js`);
    await fs.mkdir(path.dirname(snippetFile), { recursive: true });
    await fs.writeFile(snippetFile, code, "utf8");

    let cmd: string[];
    let summary: string;
    if (pkg) {
      cmd = ["frida", ...targetFlag(target), "-f", pkg, "-l", snippetFile, "--no-pause"];
      summary = `frida ${targetFlag(target).join(" ")} -f ${pkg} -l <snippet> --no-pause`;
    } else {
      const isPid = /^\d+$/.test(proc);
      const procFlag = isPid ? ["-p", proc] : ["-n", proc];
      cmd = ["frida", ...targetFlag(target), ...procFlag, "-l", snippetFile];
      summary = `frida ${targetFlag(target).join(" ")} ${isPid ? "-p" : "-n"} ${proc} -l <snippet>`;
    }

    await requestApproval(
      { tool: "frida_run_snippet", tier: "exec", summary, concerns: commandConcerns(summary, context.policy) },
      context,
    );

    try {
      const result = await runProcess(cmd, {
        cwd: context.workspace,
        timeoutMs,
        signal: context.signal,
      });
      const header = `FRIDA SNIPPET\n$ ${summary}\nscript: ${snippetFile}\nexit=${result.code}\ncapture: ${timeoutMs}ms\n`;
      const body = [
        result.stdout ? `\noutput:\n${result.stdout}` : "",
        result.stderr ? `\nstderr:\n${result.stderr}` : "",
      ].filter(Boolean).join("\n");
      const output = `${header}${body || "\n(no output captured)"}`;
      const spilled = await spillIfLarge(output, { context, label: `frida-snippet-${pkg || proc}` });
      return { content: [textBlock(spilled.text)], isError: result.code !== 0, details: { exit: result.code, snippetFile, target, artifact: spilled.artifact } };
    } catch (err) {
      return fridaNotFound(err);
    }
  },
};

const fridaListDevicesTool: AgentTool = {
  name: "frida_list_devices",
  description: "List Frida-visible devices (USB, remote, local). Use to verify device connectivity before spawning or attaching.",
  risk: "read",
  parameters: objectSchema({}),
  async execute(_args, context) {
    try {
      const result = await runProcess(["frida-ls-devices"], {
        cwd: context.workspace,
        timeoutMs: context.policy.commandTimeoutMs,
        signal: context.signal,
      });
      const output = result.stdout || result.stderr || "(no devices found)";
      return { content: [textBlock(output.trim())], isError: result.code !== 0, details: { exit: result.code } };
    } catch (err) {
      return fridaNotFound(err);
    }
  },
};

function formatFridaOutput(command: string, stdout: string, stderr: string, code: number, timeoutMs: number): string {
  const header = `FRIDA\n$ ${command}\nexit=${code}\ncapture: ${timeoutMs}ms`;
  const parts = [
    header,
    stdout ? `\noutput:\n${stdout}` : "",
    stderr ? `\nstderr:\n${stderr}` : "",
  ].filter(Boolean);
  return parts.join("\n") || `${header}\n(no output captured)`;
}
