import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, ToolContext } from "../types";
import { asNumber, asString, clip, textBlock } from "../utils";
import { validatePathRead } from "../security/policy";
import { runProcess } from "./process";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export function createAndroidTools(): AgentTool[] {
  return [
    apkManifestTool,
    apkSignatureTool,
    jadxDecompileTool,
    jadxSearchTool,
    dexInfoTool,
    apkExtractTool,
  ];
}

// ---------------------------------------------------------------------------
// apk_manifest — parse AndroidManifest.xml via aapt2/aapt
// ---------------------------------------------------------------------------

const apkManifestTool: AgentTool = {
  name: "apk_manifest",
  description:
    "Parse AndroidManifest.xml from an APK: package, SDK versions, permissions, components (activities/services/receivers/providers with exported + intent-filters), debuggable/allowBackup/cleartextTraffic flags, networkSecurityConfig, and meta-data.",
  risk: "read",
  parameters: objectSchema({ path: { type: "string", description: "Workspace-relative APK path." } }, ["path"]),
  async execute(args, context) {
    const target = resolveApk(args, context);
    const raw = await runAapt(target, context);
    const parsed = parseManifestTree(raw);
    const out = formatManifest(path.relative(context.workspace, target), parsed);
    const spilled = await spillIfLarge(out, { context, label: "apk-manifest" });
    return { content: [textBlock(spilled.text)], details: { pkg: parsed.packageName, artifact: spilled.artifact } };
  },
};

async function runAapt(target: string, context: ToolContext): Promise<string> {
  const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };
  const aapt2 = await runProcess(["aapt2", "dump", "xmltree", target, "--file", "AndroidManifest.xml"], opts).catch(() => null);
  if (aapt2 && aapt2.code === 0 && aapt2.stdout.trim()) return aapt2.stdout;
  const aapt = await runProcess(["aapt", "dump", "xmltree", target, "AndroidManifest.xml"], opts).catch(() => null);
  if (aapt && aapt.code === 0 && aapt.stdout.trim()) return aapt.stdout;
  const badging = await runProcess(["aapt2", "dump", "badging", target], opts).catch(() => null);
  if (badging && badging.code === 0 && badging.stdout.trim()) return badging.stdout;
  const badging1 = await runProcess(["aapt", "dump", "badging", target], opts).catch(() => null);
  if (badging1 && badging1.code === 0 && badging1.stdout.trim()) return badging1.stdout;
  throw new Error("Neither aapt2 nor aapt found. Install Android SDK build-tools: brew install --cask android-commandlinetools");
}

interface ManifestInfo {
  packageName: string;
  versionCode: string;
  versionName: string;
  minSdk: string;
  targetSdk: string;
  compileSdk: string;
  debuggable: string;
  allowBackup: string;
  usesCleartextTraffic: string;
  networkSecurityConfig: string;
  permissions: string[];
  activities: ComponentInfo[];
  services: ComponentInfo[];
  receivers: ComponentInfo[];
  providers: ComponentInfo[];
  metaData: Array<{ name: string; value: string }>;
}

interface ComponentInfo {
  name: string;
  exported: string;
  intentFilters: string[];
}

export function parseManifestTree(raw: string): ManifestInfo {
  const info: ManifestInfo = {
    packageName: "", versionCode: "", versionName: "",
    minSdk: "", targetSdk: "", compileSdk: "",
    debuggable: "false", allowBackup: "unknown", usesCleartextTraffic: "unknown",
    networkSecurityConfig: "",
    permissions: [], activities: [], services: [], receivers: [], providers: [], metaData: [],
  };

  const isBadging = /^package:/.test(raw);
  if (isBadging) {
    parseBadgingOutput(raw, info);
  } else {
    parseXmlTree(raw, info);
  }
  return info;
}

function parseBadgingOutput(raw: string, info: ManifestInfo): void {
  // Newer aapt2 inserts versionCodeRel between versionCode and versionName, so
  // match the name first and pick the versions up independently.
  const pkgMatch = raw.match(/package:\s+name='([^']+)'/);
  if (pkgMatch) {
    info.packageName = pkgMatch[1];
    info.versionCode = raw.match(/versionCode='([^']*)'/)?.[1] ?? "";
    info.versionName = raw.match(/versionName='([^']*)'/)?.[1] ?? "";
  }
  const sdkMin = raw.match(/sdkVersion:'(\d+)'/);
  if (sdkMin) info.minSdk = sdkMin[1];
  const sdkTarget = raw.match(/targetSdkVersion:'(\d+)'/);
  if (sdkTarget) info.targetSdk = sdkTarget[1];
  for (const m of raw.matchAll(/uses-permission:\s+name='([^']+)'/g)) info.permissions.push(m[1]);
  for (const m of raw.matchAll(/activity(?:-alias)?[^']*name='([^']+)'/g)) info.activities.push({ name: m[1], exported: "unknown", intentFilters: [] });
  for (const m of raw.matchAll(/service[^']*name='([^']+)'/g)) info.services.push({ name: m[1], exported: "unknown", intentFilters: [] });
  for (const m of raw.matchAll(/receiver[^']*name='([^']+)'/g)) info.receivers.push({ name: m[1], exported: "unknown", intentFilters: [] });
  for (const m of raw.matchAll(/provider[^']*name='([^']+)'/g)) info.providers.push({ name: m[1], exported: "unknown", intentFilters: [] });
}

function parseXmlTree(raw: string, info: ManifestInfo): void {
  const lines = raw.split(/\r?\n/);

  const extractAttr = (line: string, attr: string): string => {
    const re = new RegExp(`${attr}(?:\\([^)]*\\))?="([^"]*)"`, "i");
    const m = line.match(re);
    if (m) return m[1];
    const hexRe = new RegExp(`${attr}(?:\\([^)]*\\))?=\\(.*?\\)0x([0-9a-fA-F]+)`, "i");
    const hm = line.match(hexRe);
    if (hm) return String(parseInt(hm[1], 16));
    return "";
  };

  const extractRawAttr = (line: string, attr: string): string => {
    const re = new RegExp(`${attr}(?:\\([^)]*\\))?=(?:"([^"]*)"|\\(.*?\\)0x([0-9a-fA-F]+))`, "i");
    const m = line.match(re);
    return m ? (m[1] ?? String(parseInt(m[2], 16))) : "";
  };

  type ComponentKind = "activity" | "service" | "receiver" | "provider";
  let currentComponent: ComponentInfo | null = null;
  let currentComponentKind: ComponentKind | null = null;
  let inIntentFilter = false;
  let intentFilterParts: string[] = [];

  // xmltree output has no end tags, so an intent-filter only closes when the
  // next E: element shows up — often the next component's own line, or a
  // sibling intent-filter. Close any pending filter before switching targets,
  // or the component's last one is silently dropped.
  const closeIntentFilter = (): void => {
    if (!inIntentFilter) return;
    if (currentComponent && intentFilterParts.length) currentComponent.intentFilters.push(intentFilterParts.join(", "));
    inIntentFilter = false;
    intentFilterParts = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/\bE:\s*manifest\b/i.test(trimmed) || /^N:\s*android/i.test(trimmed)) {
      const pkg = extractAttr(trimmed, "package");
      if (pkg) info.packageName = pkg;
    }

    if (/\bA:\s*package/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "package");
      if (v) info.packageName = v;
    }

    if (/android:versionCode/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:versionCode");
      if (v) info.versionCode = v;
    }
    if (/android:versionName/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:versionName");
      if (v) info.versionName = v;
    }
    if (/android:minSdkVersion/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:minSdkVersion");
      if (v) info.minSdk = v;
    }
    if (/android:targetSdkVersion/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:targetSdkVersion");
      if (v) info.targetSdk = v;
    }
    if (/compileSdkVersion/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "compileSdkVersion");
      if (v) info.compileSdk = v;
    }
    if (/android:debuggable/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:debuggable");
      info.debuggable = v === "true" || v === "-1" || v === "1" || v === "ffffffff" ? "true" : "false";
    }
    if (/android:allowBackup/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:allowBackup");
      info.allowBackup = v === "true" || v === "-1" || v === "1" || v === "ffffffff" ? "true" : "false";
    }
    if (/android:usesCleartextTraffic/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:usesCleartextTraffic");
      info.usesCleartextTraffic = v === "true" || v === "-1" || v === "1" || v === "ffffffff" ? "true" : "false";
    }
    if (/android:networkSecurityConfig/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:networkSecurityConfig");
      if (v) info.networkSecurityConfig = v;
    }

    if (/\bE:\s*uses-permission\b/i.test(trimmed)) {
      const name = extractAttr(trimmed, "android:name");
      if (name) info.permissions.push(name);
    }
    if (/\bA:\s*android:name.*uses-permission/i.test(trimmed) || (/\bA:\s*android:name/i.test(trimmed) && lines[Math.max(0, lines.indexOf(line) - 1)]?.includes("uses-permission"))) {
      const v = extractRawAttr(trimmed, "android:name");
      if (v && v.includes(".permission.") && !info.permissions.includes(v)) info.permissions.push(v);
    }

    const componentMatch = trimmed.match(/\bE:\s*(activity|service|receiver|provider)\b/i);
    if (componentMatch) {
      closeIntentFilter();
      flushComponent(info, currentComponent, currentComponentKind);
      currentComponentKind = componentMatch[1].toLowerCase() as ComponentKind;
      const name = extractAttr(trimmed, "android:name");
      const exported = extractRawAttr(trimmed, "android:exported");
      currentComponent = { name: name || "", exported: exported || "unset", intentFilters: [] };
    }

    if (currentComponent && /\bA:\s*android:name/i.test(trimmed) && !currentComponent.name) {
      const v = extractRawAttr(trimmed, "android:name");
      if (v && !v.includes(".permission.")) currentComponent.name = v;
    }
    if (currentComponent && /\bA:\s*android:exported/i.test(trimmed)) {
      const v = extractRawAttr(trimmed, "android:exported");
      if (v) currentComponent.exported = v === "true" || v === "-1" || v === "1" || v === "ffffffff" ? "true" : "false";
    }

    if (/\bE:\s*intent-filter\b/i.test(trimmed)) {
      closeIntentFilter();
      inIntentFilter = true;
      intentFilterParts = [];
    }
    if (inIntentFilter) {
      const actionMatch = trimmed.match(/android:name.*?=.*?"([^"]+)"/);
      if (actionMatch && /action|category|data/i.test(trimmed)) {
        intentFilterParts.push(actionMatch[1]);
      }
    }
    if (inIntentFilter) {
      // `\bE:\s*(?!action|…)` would false-match the child lines here: \s* can
      // backtrack to zero spaces, putting the lookahead right before
      // " action" where it passes and ends the filter too early. Compare the
      // element name itself — any child other than these closes the filter.
      const element = trimmed.match(/\bE:\s*(\S+)/i)?.[1];
      if (element && !/^(?:action|category|data|intent-filter)$/i.test(element)) {
        closeIntentFilter();
      }
    }

    if (/\bE:\s*meta-data\b/i.test(trimmed)) {
      const name = extractAttr(trimmed, "android:name");
      const value = extractAttr(trimmed, "android:value") || extractAttr(trimmed, "android:resource");
      if (name) info.metaData.push({ name, value });
    }
  }
  closeIntentFilter();
  flushComponent(info, currentComponent, currentComponentKind);
}

function flushComponent(info: ManifestInfo, component: ComponentInfo | null, kind: string | null): void {
  if (!component || !kind) return;
  const list = kind === "activity" ? info.activities : kind === "service" ? info.services : kind === "receiver" ? info.receivers : info.providers;
  list.push(component);
}

function formatManifest(rel: string, m: ManifestInfo): string {
  const lines: string[] = [
    "APK MANIFEST",
    `path: ${rel}`,
    "",
    `package: ${m.packageName || "unknown"}`,
    `versionCode: ${m.versionCode || "unknown"}`,
    `versionName: ${m.versionName || "unknown"}`,
    `minSdk: ${m.minSdk || "unknown"}`,
    `targetSdk: ${m.targetSdk || "unknown"}`,
    ...(m.compileSdk ? [`compileSdk: ${m.compileSdk}`] : []),
    "",
    "security flags:",
    `  debuggable: ${m.debuggable}`,
    `  allowBackup: ${m.allowBackup}`,
    `  usesCleartextTraffic: ${m.usesCleartextTraffic}`,
    ...(m.networkSecurityConfig ? [`  networkSecurityConfig: ${m.networkSecurityConfig}`] : []),
    "",
    `permissions (${m.permissions.length}):`,
    ...(m.permissions.length ? m.permissions.map(p => `- ${p}`) : ["- none"]),
  ];

  const formatComponents = (label: string, components: ComponentInfo[]) => {
    lines.push("", `${label} (${components.length}):`);
    if (!components.length) { lines.push("- none"); return; }
    for (const c of components) {
      const exp = c.exported !== "unset" ? ` exported=${c.exported}` : "";
      lines.push(`- ${c.name || "(unnamed)"}${exp}`);
      for (const f of c.intentFilters) lines.push(`    intent-filter: ${f}`);
    }
  };
  formatComponents("activities", m.activities);
  formatComponents("services", m.services);
  formatComponents("receivers", m.receivers);
  formatComponents("providers", m.providers);

  if (m.metaData.length) {
    lines.push("", `meta-data (${m.metaData.length}):`);
    for (const md of m.metaData) lines.push(`- ${md.name} = ${md.value || "(empty)"}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// apk_signature — verify APK signing scheme
// ---------------------------------------------------------------------------

const apkSignatureTool: AgentTool = {
  name: "apk_signature",
  description: "Verify APK signing scheme (v1/v2/v3/v4), certificate info (CN, O, validity, fingerprint), and verification result.",
  risk: "read",
  parameters: objectSchema({ path: { type: "string", description: "Workspace-relative APK path." } }, ["path"]),
  async execute(args, context) {
    const target = resolveApk(args, context);
    const rel = path.relative(context.workspace, target);
    const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };

    const apksigner = await runProcess(["apksigner", "verify", "--verbose", "--print-certs", target], opts).catch(() => null);
    if (apksigner && (apksigner.code === 0 || apksigner.stdout.trim())) {
      const out = formatApksignerOutput(rel, apksigner.stdout + "\n" + apksigner.stderr, apksigner.code === 0);
      return { content: [textBlock(out)], details: { tool: "apksigner", verified: apksigner.code === 0 } };
    }

    const jarsigner = await runProcess(["jarsigner", "-verify", "-verbose", "-certs", target], opts).catch(() => null);
    if (jarsigner && (jarsigner.code === 0 || jarsigner.stdout.trim())) {
      const out = formatJarsignerOutput(rel, jarsigner.stdout + "\n" + jarsigner.stderr, jarsigner.code === 0);
      return { content: [textBlock(out)], details: { tool: "jarsigner", verified: jarsigner.code === 0 } };
    }

    const keytool = await runProcess(
      ["sh", "-c", `unzip -p ${shellQuote(target)} META-INF/*.RSA META-INF/*.DSA META-INF/*.EC 2>/dev/null | keytool -printcert`],
      opts,
    ).catch(() => null);
    if (keytool && keytool.stdout.trim()) {
      const out = [
        "APK SIGNATURE",
        `path: ${rel}`,
        "tool: keytool (fallback — apksigner/jarsigner not found)",
        "",
        keytool.stdout.trim(),
      ].join("\n");
      return { content: [textBlock(out)], details: { tool: "keytool" } };
    }

    throw new Error("No signature verification tool found. Install Android SDK build-tools (apksigner) or JDK (jarsigner/keytool).");
  },
};

function formatApksignerOutput(rel: string, raw: string, verified: boolean): string {
  const schemes: string[] = [];
  if (/Verified using v1 scheme.*?:\s*true/i.test(raw)) schemes.push("v1 (JAR)");
  if (/Verified using v2 scheme.*?:\s*true/i.test(raw)) schemes.push("v2 (APK Signature Scheme v2)");
  if (/Verified using v3 scheme.*?:\s*true/i.test(raw)) schemes.push("v3 (APK Signature Scheme v3)");
  if (/Verified using v3\.1 scheme.*?:\s*true/i.test(raw)) schemes.push("v3.1");
  if (/Verified using v4 scheme.*?:\s*true/i.test(raw)) schemes.push("v4");

  const certs: string[] = [];
  for (const m of raw.matchAll(/Signer #\d+.*?(?=Signer #|\z)/gs)) certs.push(m[0].trim());
  if (!certs.length && raw.trim()) certs.push(raw.trim());

  const lines = [
    "APK SIGNATURE",
    `path: ${rel}`,
    `verified: ${verified ? "yes" : "NO — signature invalid or missing"}`,
    `schemes: ${schemes.join(", ") || "none detected"}`,
    "",
    ...certs.map(c => c),
  ];
  return lines.join("\n");
}

function formatJarsignerOutput(rel: string, raw: string, verified: boolean): string {
  const lines = [
    "APK SIGNATURE",
    `path: ${rel}`,
    `tool: jarsigner`,
    `verified: ${verified ? "yes" : "NO"}`,
    "",
    raw.trim(),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// jadx_decompile — decompile APK/DEX with JADX, optionally search
// ---------------------------------------------------------------------------

const jadxDecompileTool: AgentTool = {
  name: "jadx_decompile",
  description:
    "Decompile APK/DEX with JADX (skipping resources for speed) into a session-local directory. Optionally search the decompiled Java source with a grep pattern. Returns the output directory path so jadx_search can reuse it.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative APK or DEX file path." },
      search: { type: "string", description: "Optional grep pattern to search decompiled source." },
      classFilter: { type: "string", description: "Only decompile classes matching this pattern (passed as --class-name-filter to jadx)." },
      maxOutput: { type: "number", default: 65536 },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveApk(args, context);
    const rel = path.relative(context.workspace, target);
    const baseName = path.basename(target, path.extname(target));
    const outDir = path.join(context.sessionDir, `jadx-${baseName}-${Date.now()}`);
    const maxOutput = Math.min(asNumber(args.maxOutput, 65536), context.policy.maxReadBytes);
    const opts = { cwd: context.workspace, timeoutMs: 120_000, signal: context.signal };

    const jadxArgs = ["jadx", "-d", outDir, "--no-res", "--no-imports"];
    const classFilter = asString(args.classFilter).trim();
    if (classFilter) jadxArgs.push("--class-name-filter", classFilter);
    jadxArgs.push(target);

    const jadx = await runProcess(jadxArgs, opts).catch(() => null);
    if (!jadx || (jadx.code !== 0 && !await dirHasFiles(outDir))) {
      const stderr = jadx?.stderr?.trim() ?? "";
      if (/jadx.*not found|No such file/i.test(stderr) || !jadx) {
        throw new Error("jadx not found. Install: brew install jadx / apt install jadx / https://github.com/skylot/jadx");
      }
      throw new Error(`jadx failed (exit ${jadx.code}): ${stderr.slice(0, 500)}`);
    }

    const searchPattern = asString(args.search).trim();
    const lines: string[] = [
      "JADX DECOMPILE",
      `source: ${rel}`,
      `output: ${outDir}`,
      ...(classFilter ? [`class-filter: ${classFilter}`] : []),
      `jadx exit: ${jadx.code}`,
    ];

    if (jadx.stderr.trim()) {
      const warnings = jadx.stderr.split(/\r?\n/).filter(l => /WARN|ERROR/i.test(l)).slice(0, 5);
      if (warnings.length) {
        lines.push("", "warnings:", ...warnings.map(w => `- ${w.trim()}`));
      }
    }

    const sourceDir = path.join(outDir, "sources");
    const fileCount = await countFiles(sourceDir);
    lines.push("", `decompiled files: ${fileCount}`);

    if (searchPattern) {
      lines.push("", `search: ${searchPattern}`, "");
      const grepResult = await grepDir(sourceDir, searchPattern, 100, context);
      lines.push(grepResult || "(no matches)");
    } else {
      const tree = await listTree(sourceDir, outDir, 60);
      if (tree.length) {
        lines.push("", "source tree:", ...tree.map(t => `  ${t}`));
      }
    }

    lines.push("", "hint: use jadx_search to search this output without re-decompiling.");

    const spilled = await spillIfLarge(lines.join("\n"), { context, label: `jadx-${baseName}`, maxChars: maxOutput });
    return { content: [textBlock(spilled.text)], details: { outDir, fileCount, artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// jadx_search — search already-decompiled JADX output
// ---------------------------------------------------------------------------

const jadxSearchTool: AgentTool = {
  name: "jadx_search",
  description: "Search in already-decompiled JADX output directory without re-decompiling. Use after jadx_decompile.",
  risk: "read",
  parameters: objectSchema(
    {
      jadxDir: { type: "string", description: "Path to JADX output directory (from jadx_decompile output)." },
      pattern: { type: "string", description: "Grep pattern to search for." },
      maxMatches: { type: "number", default: 100 },
    },
    ["jadxDir", "pattern"],
  ),
  async execute(args, context) {
    const jadxDir = asString(args.jadxDir);
    const pattern = asString(args.pattern);
    const maxMatches = Math.min(Math.max(1, asNumber(args.maxMatches, 100)), 500);

    let searchDir = jadxDir;
    try { await fs.access(searchDir); } catch {
      searchDir = path.resolve(context.workspace, jadxDir);
      await fs.access(searchDir);
    }

    const sourcesDir = path.join(searchDir, "sources");
    const targetDir = await fs.access(sourcesDir).then(() => sourcesDir).catch(() => searchDir);

    const result = await grepDir(targetDir, pattern, maxMatches, context);
    const out = [
      "JADX SEARCH",
      `dir: ${jadxDir}`,
      `pattern: ${pattern}`,
      "",
      result || "(no matches)",
    ].join("\n");

    const spilled = await spillIfLarge(out, { context, label: `jadx-search-${pattern}` });
    return { content: [textBlock(spilled.text)], details: { artifact: spilled.artifact } };
  },
};

// ---------------------------------------------------------------------------
// dex_info — quick DEX header analysis
// ---------------------------------------------------------------------------

const dexInfoTool: AgentTool = {
  name: "dex_info",
  description: "Quick DEX file header analysis: magic, version, checksum, SHA-1, class/method/field/string counts, file size. Parses the DEX header directly when dexdump is unavailable.",
  risk: "read",
  parameters: objectSchema({ path: { type: "string", description: "Workspace-relative DEX file path." } }, ["path"]),
  async execute(args, context) {
    const target = resolveFile(args, context);
    const rel = path.relative(context.workspace, target);
    const stat = await fs.stat(target);

    const header = await parseDexHeader(target);
    if (!header) throw new Error("Not a valid DEX file (bad magic).");

    const lines = [
      "DEX INFO",
      `path: ${rel}`,
      `size: ${stat.size} bytes`,
      "",
      `magic: ${header.magic}`,
      `version: ${header.version}`,
      `checksum: ${header.checksum}`,
      `sha1: ${header.sha1}`,
      `file_size: ${header.fileSize}`,
      `header_size: ${header.headerSize}`,
      `endian_tag: ${header.endianTag}`,
      "",
      `string_ids: ${header.stringIdsSize}`,
      `type_ids: ${header.typeIdsSize}`,
      `proto_ids: ${header.protoIdsSize}`,
      `field_ids: ${header.fieldIdsSize}`,
      `method_ids: ${header.methodIdsSize}`,
      `class_defs: ${header.classDefsSize}`,
      `data_size: ${header.dataSize}`,
    ];

    const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };
    const dexdump = await runProcess(["dexdump", "-f", target], opts).catch(() => null);
    if (dexdump && dexdump.code === 0 && dexdump.stdout.trim()) {
      const summary = dexdump.stdout.split(/\r?\n/).slice(0, 30).join("\n");
      lines.push("", "dexdump summary:", summary);
    }

    return { content: [textBlock(lines.join("\n"))], details: header };
  },
};

interface DexHeader {
  magic: string;
  version: string;
  checksum: string;
  sha1: string;
  fileSize: number;
  headerSize: number;
  endianTag: string;
  stringIdsSize: number;
  typeIdsSize: number;
  protoIdsSize: number;
  fieldIdsSize: number;
  methodIdsSize: number;
  classDefsSize: number;
  dataSize: number;
}

async function parseDexHeader(file: string): Promise<DexHeader | null> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(112);
    const { bytesRead } = await handle.read(buf, 0, 112, 0);
    if (bytesRead < 112) return null;

    const magic = buf.subarray(0, 4).toString("ascii");
    if (magic !== "dex\n") return null;

    const version = buf.subarray(4, 7).toString("ascii");
    const checksum = buf.readUInt32LE(8).toString(16).padStart(8, "0");
    const sha1 = buf.subarray(12, 32).toString("hex");
    const fileSize = buf.readUInt32LE(32);
    const headerSize = buf.readUInt32LE(36);
    const endianTag = buf.readUInt32LE(40) === 0x12345678 ? "little-endian" : "big-endian";
    const stringIdsSize = buf.readUInt32LE(56);
    const typeIdsSize = buf.readUInt32LE(64);
    const protoIdsSize = buf.readUInt32LE(72);
    const fieldIdsSize = buf.readUInt32LE(80);
    const methodIdsSize = buf.readUInt32LE(88);
    const classDefsSize = buf.readUInt32LE(96);
    const dataSize = buf.readUInt32LE(104);

    return {
      magic: `dex\\n`, version, checksum, sha1, fileSize, headerSize, endianTag,
      stringIdsSize, typeIdsSize, protoIdsSize, fieldIdsSize, methodIdsSize, classDefsSize, dataSize,
    };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// apk_extract — extract specific files from APK (ZIP)
// ---------------------------------------------------------------------------

const apkExtractTool: AgentTool = {
  name: "apk_extract",
  description: "Extract specific files from an APK (ZIP) into a session-local directory for further analysis. Use glob patterns to select files.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative APK path." },
      patterns: {
        type: "array",
        items: { type: "string" },
        description: 'Glob patterns for files to extract, e.g. ["lib/arm64-v8a/*.so", "classes.dex", "assets/*"].',
      },
      outDir: { type: "string", description: "Output directory (defaults to session-local extracted/<apk-name>)." },
    },
    ["path", "patterns"],
  ),
  async execute(args, context) {
    const target = resolveApk(args, context);
    const rel = path.relative(context.workspace, target);
    const baseName = path.basename(target, path.extname(target));
    const patterns = coerceStringArray(args.patterns);
    if (!patterns.length) throw new Error("patterns must be a non-empty array of glob strings.");

    const outDirArg = asString(args.outDir).trim();
    const outDir = outDirArg
      ? path.resolve(context.workspace, outDirArg)
      : path.join(context.sessionDir, "extracted", baseName);
    await fs.mkdir(outDir, { recursive: true });

    const opts = { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };
    const unzipArgs = ["unzip", "-o", "-d", outDir, target, ...patterns];
    const result = await runProcess(unzipArgs, opts).catch(() => null);

    if (!result) throw new Error("unzip not found. Install: brew install unzip / apt install unzip");

    const extracted = await listTree(outDir, outDir, 200);
    const lines = [
      "APK EXTRACT",
      `source: ${rel}`,
      `patterns: ${patterns.join(", ")}`,
      `output: ${outDir}`,
      `unzip exit: ${result.code}`,
      "",
      `extracted files (${extracted.length}):`,
      ...(extracted.length ? extracted.map(f => `- ${f}`) : ["- none matched"]),
    ];

    if (result.stderr.trim() && result.code !== 0) {
      lines.push("", "errors:", result.stderr.trim().split(/\r?\n/).slice(0, 5).join("\n"));
    }

    return { content: [textBlock(lines.join("\n"))], details: { outDir, count: extracted.length, exit: result.code } };
  },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveApk(args: Record<string, unknown>, context: ToolContext): string {
  const target = path.resolve(context.workspace, asString(args.path));
  const normalizedRoot = path.resolve(context.workspace);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${asString(args.path)}`);
  }
  validatePathRead(target, context.policy);
  return target;
}

function resolveFile(args: Record<string, unknown>, context: ToolContext): string {
  return resolveApk(args, context);
}

/** Single-quote a path for a `sh -c` string; a raw filename with quotes or `$` would break out. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (typeof value === "string") return value.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

async function dirHasFiles(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const visit = async (d: string) => {
      const entries = await fs.readdir(d, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) count++;
        else if (entry.isDirectory()) await visit(path.join(d, entry.name));
        if (count > 10000) return;
      }
    };
    await visit(dir);
  } catch { /* dir may not exist */ }
  return count;
}

async function listTree(dir: string, base: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const visit = async (d: string) => {
    if (out.length >= max) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= max) return;
      const full = path.join(d, entry.name);
      out.push(path.relative(base, full));
      if (entry.isDirectory()) await visit(full);
    }
  };
  await visit(dir);
  return out;
}

async function grepDir(dir: string, pattern: string, maxMatches: number, context: ToolContext): Promise<string> {
  const opts = { cwd: dir, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal };
  const rg = await runProcess(
    ["rg", "--line-number", "--hidden", "--glob", "!.git", "--max-count", String(maxMatches), pattern, "."],
    opts,
  ).catch(() => null);
  if (rg && (rg.stdout.trim() || rg.code === 0)) return rg.stdout.trim() || "(no matches)";

  const grep = await runProcess(
    ["grep", "-rn", "--include=*.java", "--include=*.kt", "--include=*.xml", "-m", String(maxMatches), pattern, "."],
    opts,
  ).catch(() => null);
  if (grep && grep.stdout.trim()) return grep.stdout.trim();

  return await jsGrepDir(dir, pattern, maxMatches);
}

async function jsGrepDir(dir: string, pattern: string, maxMatches: number): Promise<string> {
  const regex = new RegExp(pattern, "i");
  const results: string[] = [];
  const visit = async (d: string) => {
    if (results.length >= maxMatches) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxMatches) return;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { await visit(full); continue; }
      if (!/\.(java|kt|xml|smali|json)$/i.test(entry.name)) continue;
      let text: string;
      try { text = await fs.readFile(full, "utf8"); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
        if (regex.test(lines[i])) results.push(`${path.relative(dir, full)}:${i + 1}:${lines[i]}`);
      }
    }
  };
  await visit(dir);
  return results.join("\n") || "(no matches)";
}
