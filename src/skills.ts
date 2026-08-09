import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clip } from "./utils";

export interface BuiltInSkill {
  name: string;
  description: string;
  path: string;
  body: string;
  tags: string[];
}

export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function builtInSkillsRoot(): string {
  return path.join(projectRoot(), "skills");
}

export async function loadBuiltInSkills(root = builtInSkillsRoot()): Promise<BuiltInSkill[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: BuiltInSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(root, entry.name, "SKILL.md");
    const body = await fs.readFile(skillPath, "utf8").catch(() => undefined);
    if (!body) continue;
    const metadata = parseFrontmatter(body);
    skills.push({
      name: metadata.name || entry.name,
      description: metadata.description || firstHeading(body) || "Built-in reverse engineering workflow.",
      tags: splitTags(metadata.tags || entry.name),
      path: skillPath,
      body,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function findBuiltInSkill(skills: BuiltInSkill[], name: string): BuiltInSkill | undefined {
  const needle = name.toLowerCase();
  return skills.find(skill => skill.name.toLowerCase() === needle || skill.tags.some(tag => tag.toLowerCase() === needle));
}

export function formatSkillList(skills: BuiltInSkill[]): string {
  if (skills.length === 0) return "No built-in skills found.";
  return skills.map(skill => `${skill.name.padEnd(18)} ${skill.description}`).join("\n");
}

export function skillSystemPrompt(skills: BuiltInSkill[]): string {
  if (skills.length === 0) return "";
  const catalog = skills.map(skill => `- ${skill.name}: ${skill.description}`).join("\n");
  return [
    "",
    "## Built-in 0xAF-Re Skills",
    "",
    "The host has project-local reverse engineering skills. Use them when a task matches their scope.",
    "Ask for `read_skill` when you need full instructions; use `list_skills` to inspect the catalog.",
    "Operators can run `/skills` to list them or `/skill <name> <task>` to force one workflow for a turn.",
    "",
    catalog,
  ].join("\n");
}

export function skillTurnPrompt(skill: BuiltInSkill, task: string): string {
  return [
    `Use built-in skill: ${skill.name}`,
    "",
    clip(skill.body, 20_000),
    "",
    "Task:",
    task.trim(),
  ].join("\n");
}

function parseFrontmatter(body: string): Record<string, string> {
  if (!body.startsWith("---\n")) return {};
  const end = body.indexOf("\n---", 4);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of body.slice(4, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim();
}

function splitTags(value: string): string[] {
  return value.split(/[,\s]+/).map(tag => tag.trim()).filter(Boolean);
}
