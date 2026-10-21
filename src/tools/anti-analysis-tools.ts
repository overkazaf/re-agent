import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, ToolContext } from "../types";
import { asNumber, asString, clip, resolveInside, textBlock } from "../utils";
import { validatePathRead } from "../security/policy";
import { spillIfLarge } from "./output";
import { runProcess } from "./process";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export function createAntiAnalysisTools(): AgentTool[] {
  return [
    detectAntiAnalysisTool,
    detectPackerTool,
  ];
}

// ===========================================================================
// Rust backend bridge
// ===========================================================================

function oxafParseBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "bin", "oxaf-parse");
}

async function rustAntiParse(
  subcommand: string,
  target: string,
  context: ToolContext,
): Promise<Record<string, unknown> | null> {
  const bin = oxafParseBin();
  try { await fs.access(bin); } catch { return null; }
  try {
    const result = await runProcess(
      [bin, subcommand, target],
      { cwd: context.workspace, timeoutMs: context.policy.commandTimeoutMs, signal: context.signal },
    );
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return null;
  } catch { return null; }
}

function formatRustAntiOutput(json: Record<string, unknown>, rel: string): string {
  const lines: string[] = [
    "ANTI-ANALYSIS SCAN (rust/goblin)",
    `path: ${rel}`,
    `size: ${json.size} bytes`,
    "",
    `findings (${json.total_findings}):`,
    "",
  ];

  const categories = json.categories as Array<Record<string, unknown>> | undefined;
  if (categories?.length) {
    for (const cat of categories) {
      const catName = String(cat.category ?? "").toUpperCase().replace(/_/g, "-");
      const findings = cat.findings as Array<Record<string, unknown>> | undefined;
      if (!findings?.length) continue;
      lines.push(`  ${catName} [${findings[0].confidence}]`);
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i];
        const prefix = i < findings.length - 1 ? "├──" : "└──";
        lines.push(`  ${prefix} ${f.description}`);
        if (f.offset) lines.push(`      offset: ${f.offset}, ${f.detail}`);
      }
      lines.push("");
    }
  }

  const summary = json.summary as Record<string, Record<string, unknown>> | undefined;
  if (summary) {
    lines.push("summary:");
    for (const [cat, info] of Object.entries(summary)) {
      lines.push(`  ${cat}: ${info.count} indicators${(info.count as number) > 0 ? ` (${info.confidence} confidence)` : ""}`);
    }
  }

  const hints = json.bypass_hints as string[] | undefined;
  if (hints?.length) {
    lines.push("", "bypass hints:");
    for (const h of hints) lines.push(`  - ${h}`);
  }

  return lines.join("\n");
}

function formatRustPackerOutput(json: Record<string, unknown>, rel: string): string {
  const lines: string[] = [
    "PACKER DETECTION (rust/goblin)",
    `path: ${rel}`,
    `size: ${json.size} bytes`,
    `entropy: ${json.overall_entropy} bits/byte`,
    `verdict: ${json.verdict}`,
    "",
  ];

  const packers = json.packers_detected as Array<Record<string, unknown>> | undefined;
  if (packers?.length) {
    lines.push("detected:");
    for (const p of packers) {
      lines.push(`  ${p.name}: matched "${p.matched}" at ${p.offset}`);
    }
  }

  const anomalies = json.anomalies as string[] | undefined;
  if (anomalies?.length) {
    lines.push("", "anomalies:");
    for (const a of anomalies) lines.push(`  - ${a}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Confidence = "high" | "medium" | "low";

type FindingCategory =
  | "ANTI-DEBUG"
  | "ANTI-VM"
  | "ANTI-FRIDA"
  | "ANTI-ROOT"
  | "OBFUSCATION"
  | "ANTI-TAMPER";

interface Finding {
  category: FindingCategory;
  confidence: Confidence;
  label: string;
  detail: string;
  offset?: number;
  /** Used for bypass hint generation. */
  tag: string;
}

// ---------------------------------------------------------------------------
// Pattern databases
// ---------------------------------------------------------------------------

interface StringPattern {
  category: FindingCategory;
  confidence: Confidence;
  pattern: RegExp;
  label: string;
  tag: string;
}

const STRING_PATTERNS: StringPattern[] = [
  // ---- Anti-Debug (Linux/Android) ----
  { category: "ANTI-DEBUG", confidence: "high", pattern: /ptrace/i, label: "ptrace import/reference — likely PTRACE_TRACEME self-trace", tag: "ptrace" },
  { category: "ANTI-DEBUG", confidence: "high", pattern: /\/proc\/self\/status/i, label: "/proc/self/status read — TracerPid check", tag: "proc-status" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /\/proc\/self\/maps/i, label: "/proc/self/maps inspection — memory map enumeration", tag: "proc-maps" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /getppid/i, label: "getppid() call — parent process check", tag: "getppid" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /PR_SET_DUMPABLE/i, label: "prctl(PR_SET_DUMPABLE, 0) — prevent core dump/attach", tag: "pr-set-dumpable" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /SIGTRAP/i, label: "SIGTRAP handler — breakpoint detection", tag: "sigtrap" },
  { category: "ANTI-DEBUG", confidence: "low", pattern: /clock_gettime/i, label: "clock_gettime — timing-based anti-debug", tag: "timing" },
  { category: "ANTI-DEBUG", confidence: "low", pattern: /gettimeofday/i, label: "gettimeofday — timing-based anti-debug", tag: "timing" },
  { category: "ANTI-DEBUG", confidence: "low", pattern: /SIGSEGV/i, label: "SIGSEGV handler — exception-based anti-debug", tag: "sigsegv" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /TracerPid/i, label: "TracerPid string — explicit debugger PID check", tag: "proc-status" },

  // ---- Anti-Debug (Windows) ----
  { category: "ANTI-DEBUG", confidence: "high", pattern: /IsDebuggerPresent/i, label: "IsDebuggerPresent API — direct debugger check", tag: "is-debugger-present" },
  { category: "ANTI-DEBUG", confidence: "high", pattern: /CheckRemoteDebuggerPresent/i, label: "CheckRemoteDebuggerPresent API", tag: "remote-debugger" },
  { category: "ANTI-DEBUG", confidence: "high", pattern: /NtQueryInformationProcess/i, label: "NtQueryInformationProcess — ProcessDebugPort/ObjectHandle", tag: "nt-query" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /OutputDebugString/i, label: "OutputDebugString trick — error-based debugger detection", tag: "output-debug-string" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /NtGlobalFlag/i, label: "NtGlobalFlag check — PEB heap debug flags", tag: "nt-global-flag" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /DebugBreak/i, label: "DebugBreak / int 3 trigger", tag: "debug-break" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /FindWindow[AW]?/i, label: "FindWindow — scanning for debugger windows", tag: "find-window" },
  { category: "ANTI-DEBUG", confidence: "low", pattern: /OllyD[Bb][Gg]/i, label: "OllyDbg window class reference", tag: "find-window" },
  { category: "ANTI-DEBUG", confidence: "low", pattern: /x64dbg/i, label: "x64dbg window class reference", tag: "find-window" },
  { category: "ANTI-DEBUG", confidence: "low", pattern: /\bIDA\b/, label: "IDA reference (possible anti-IDA check)", tag: "find-window" },
  { category: "ANTI-DEBUG", confidence: "medium", pattern: /TlsCallback/i, label: "TLS callback reference — early execution before entry point", tag: "tls-callback" },
  { category: "ANTI-DEBUG", confidence: "low", pattern: /BeingDebugged/i, label: "PEB->BeingDebugged reference", tag: "peb-debugged" },

  // ---- Anti-VM / Anti-Emulation ----
  { category: "ANTI-VM", confidence: "high", pattern: /VMwareVMware/i, label: "VMware CPUID vendor string", tag: "vm-cpuid" },
  { category: "ANTI-VM", confidence: "high", pattern: /KVMKVMKVM/i, label: "KVM CPUID vendor string", tag: "vm-cpuid" },
  { category: "ANTI-VM", confidence: "high", pattern: /XenVMMXenVMM/i, label: "Xen CPUID vendor string", tag: "vm-cpuid" },
  { category: "ANTI-VM", confidence: "high", pattern: /VBoxVBoxVBox/i, label: "VirtualBox CPUID vendor string", tag: "vm-cpuid" },
  { category: "ANTI-VM", confidence: "medium", pattern: /vmtoolsd/i, label: "VMware Tools process check", tag: "vm-tools" },
  { category: "ANTI-VM", confidence: "medium", pattern: /VBoxService/i, label: "VirtualBox Guest Additions service", tag: "vm-tools" },
  { category: "ANTI-VM", confidence: "medium", pattern: /VBoxGuest/i, label: "VirtualBox Guest driver", tag: "vm-tools" },
  { category: "ANTI-VM", confidence: "low", pattern: /\.vmdk/i, label: "VMware disk file extension", tag: "vm-files" },
  { category: "ANTI-VM", confidence: "low", pattern: /\.vmx\b/i, label: "VMware config file extension", tag: "vm-files" },
  { category: "ANTI-VM", confidence: "medium", pattern: /HARDWARE\\DESCRIPTION\\System\\BIOS/i, label: "BIOS registry key — VM vendor check", tag: "vm-registry" },
  { category: "ANTI-VM", confidence: "low", pattern: /00:0[Cc]:29/i, label: "VMware MAC prefix (00:0C:29)", tag: "vm-mac" },
  { category: "ANTI-VM", confidence: "low", pattern: /08:00:27/i, label: "VirtualBox MAC prefix (08:00:27)", tag: "vm-mac" },
  { category: "ANTI-VM", confidence: "medium", pattern: /SMBIOS/i, label: "SMBIOS/DMI table check — VM detection", tag: "vm-smbios" },
  { category: "ANTI-VM", confidence: "low", pattern: /\brdtsc\b/i, label: "RDTSC timing — VM/emulation timing side-channel", tag: "vm-rdtsc" },
  { category: "ANTI-VM", confidence: "low", pattern: /\bcpuid\b/i, label: "CPUID instruction reference — hypervisor detection", tag: "vm-cpuid" },

  // ---- Anti-Frida ----
  { category: "ANTI-FRIDA", confidence: "high", pattern: /frida-server/i, label: "frida-server string reference", tag: "frida-string" },
  { category: "ANTI-FRIDA", confidence: "high", pattern: /frida-agent/i, label: "frida-agent string reference", tag: "frida-string" },
  { category: "ANTI-FRIDA", confidence: "high", pattern: /frida-gadget/i, label: "frida-gadget string reference", tag: "frida-string" },
  { category: "ANTI-FRIDA", confidence: "medium", pattern: /\blinjector\b/i, label: "linjector reference — Frida injector library", tag: "frida-string" },
  { category: "ANTI-FRIDA", confidence: "medium", pattern: /frida_agent_/i, label: "frida_agent_ named pipe pattern", tag: "frida-pipe" },
  { category: "ANTI-FRIDA", confidence: "medium", pattern: /re\.frida\.server/i, label: "Frida server service name", tag: "frida-string" },
  { category: "ANTI-FRIDA", confidence: "low", pattern: /gmain\b/i, label: "gmain reference — Frida GLib main loop artifact", tag: "frida-gmain" },
  { category: "ANTI-FRIDA", confidence: "low", pattern: /gdbus/i, label: "GDBus reference — Frida D-Bus communication", tag: "frida-dbus" },

  // ---- Anti-Root / Jailbreak (Android / iOS) ----
  { category: "ANTI-ROOT", confidence: "high", pattern: /\/system\/app\/Superuser\.apk/i, label: "Superuser.apk path check", tag: "root-path" },
  { category: "ANTI-ROOT", confidence: "high", pattern: /\/system\/xbin\/su\b/i, label: "/system/xbin/su binary check", tag: "root-path" },
  { category: "ANTI-ROOT", confidence: "high", pattern: /\/sbin\/su\b/i, label: "/sbin/su binary check", tag: "root-path" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /com\.noshufou\.android\.su/i, label: "Superuser package check", tag: "root-pkg" },
  { category: "ANTI-ROOT", confidence: "high", pattern: /com\.topjohnwu\.magisk/i, label: "Magisk Manager package check", tag: "root-pkg" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /eu\.chainfire\.supersu/i, label: "SuperSU package check", tag: "root-pkg" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /com\.koushikdutta\.superuser/i, label: "Koushikdutta Superuser package check", tag: "root-pkg" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /libmagisk/i, label: "libmagisk library reference", tag: "root-magisk" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /\/data\/adb\/magisk/i, label: "Magisk data directory check", tag: "root-magisk" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /test-keys/i, label: "Build tags test-keys check (unsigned build)", tag: "root-buildtag" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /SafetyNet/i, label: "SafetyNet attestation reference", tag: "root-safetynet" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /PlayIntegrity/i, label: "Play Integrity API reference", tag: "root-safetynet" },
  { category: "ANTI-ROOT", confidence: "high", pattern: /\/Applications\/Cydia\.app/i, label: "Cydia.app path (iOS jailbreak)", tag: "jailbreak-cydia" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /cydia:\/\//i, label: "cydia:// URL scheme (iOS jailbreak)", tag: "jailbreak-cydia" },
  { category: "ANTI-ROOT", confidence: "high", pattern: /MobileSubstrate/i, label: "MobileSubstrate reference (iOS jailbreak)", tag: "jailbreak-substrate" },
  { category: "ANTI-ROOT", confidence: "medium", pattern: /\bLiberty\b/i, label: "Liberty Lite reference (jailbreak hide)", tag: "jailbreak-hide" },

  // ---- Obfuscation / Packing ----
  { category: "OBFUSCATION", confidence: "high", pattern: /UPX!/i, label: "UPX packer signature", tag: "packer-upx" },
  { category: "OBFUSCATION", confidence: "high", pattern: /\bMPRESS\b/i, label: "MPRESS packer signature", tag: "packer-mpress" },
  { category: "OBFUSCATION", confidence: "high", pattern: /\bASPack\b/i, label: "ASPack packer signature", tag: "packer-aspack" },
  { category: "OBFUSCATION", confidence: "high", pattern: /\bThemida\b/i, label: "Themida/WinLicense protector", tag: "packer-themida" },
  { category: "OBFUSCATION", confidence: "high", pattern: /VMProtect/i, label: "VMProtect virtualization protector", tag: "packer-vmprotect" },
  { category: "OBFUSCATION", confidence: "medium", pattern: /Armadillo/i, label: "Armadillo protector", tag: "packer-armadillo" },
  { category: "OBFUSCATION", confidence: "medium", pattern: /\bobfuscat/i, label: "Obfuscation-related string", tag: "obfuscation-string" },
  { category: "OBFUSCATION", confidence: "low", pattern: /\bpacked\b/i, label: "Packing-related string", tag: "packed-string" },

  // ---- Anti-Tamper ----
  { category: "ANTI-TAMPER", confidence: "medium", pattern: /\btampered\b/i, label: "Tamper detection string", tag: "tamper-string" },
  { category: "ANTI-TAMPER", confidence: "medium", pattern: /\bmodified\b.*\bdetect/i, label: "Modification detection string", tag: "tamper-string" },
  { category: "ANTI-TAMPER", confidence: "medium", pattern: /checksum failed/i, label: "Checksum failure message", tag: "tamper-checksum" },
  { category: "ANTI-TAMPER", confidence: "medium", pattern: /integrity.{0,20}check/i, label: "Integrity check reference", tag: "tamper-integrity" },
  { category: "ANTI-TAMPER", confidence: "low", pattern: /self.{0,10}hash/i, label: "Self-hashing pattern", tag: "tamper-selfhash" },
  { category: "ANTI-TAMPER", confidence: "low", pattern: /code.{0,10}sign/i, label: "Code signing verification reference", tag: "tamper-codesign" },
];

// Byte-level patterns (searched in raw binary)
interface BytePattern {
  category: FindingCategory;
  confidence: Confidence;
  bytes: Buffer;
  label: string;
  tag: string;
}

const BYTE_PATTERNS: BytePattern[] = [
  // Frida default port 27042 as little-endian uint16 (0x69A2)
  { category: "ANTI-FRIDA", confidence: "low", bytes: Buffer.from([0xa2, 0x69]), label: "port 27042 LE constant — Frida default port check", tag: "frida-port" },
  // Frida default port 27042 as big-endian uint16
  { category: "ANTI-FRIDA", confidence: "low", bytes: Buffer.from([0x69, 0xa2]), label: "port 27042 BE constant — Frida default port check", tag: "frida-port" },
  // INT 2D (anti-debug on Windows x86)
  { category: "ANTI-DEBUG", confidence: "medium", bytes: Buffer.from([0xcd, 0x2d]), label: "INT 2D instruction — Windows kernel debugger check", tag: "int-2d" },
  // INT 3 (breakpoint)  — only useful near suspicious context; included as low
  { category: "ANTI-DEBUG", confidence: "low", bytes: Buffer.from([0xcc]), label: "INT 3 (breakpoint) — possible anti-debug trap", tag: "int-3" },
  // CPUID instruction encoding (0F A2) — hypervisor bit check
  { category: "ANTI-VM", confidence: "low", bytes: Buffer.from([0x0f, 0xa2]), label: "CPUID instruction (0F A2) — VM detection", tag: "vm-cpuid-insn" },
  // RDTSC instruction encoding (0F 31) — timing side-channel
  { category: "ANTI-VM", confidence: "low", bytes: Buffer.from([0x0f, 0x31]), label: "RDTSC instruction (0F 31) — timing check", tag: "vm-rdtsc-insn" },
];

// Bypass hint database keyed by finding tag
const BYPASS_HINTS: Record<string, string> = {
  "ptrace": "hook ptrace to return 0, or NOP the PTRACE_TRACEME call",
  "proc-status": "hook open/read for /proc/self/status, return TracerPid: 0",
  "proc-maps": "hook open/read for /proc/self/maps, filter out injected library entries",
  "getppid": "hook getppid to return expected parent PID",
  "pr-set-dumpable": "hook prctl, intercept PR_SET_DUMPABLE and return 0",
  "sigtrap": "hook signal/sigaction for SIGTRAP, let the handler pass",
  "timing": "hook clock_gettime/gettimeofday to return consistent values",
  "sigsegv": "ensure SIGSEGV handler is not overwritten by debugger",
  "is-debugger-present": "hook IsDebuggerPresent to return 0 / FALSE",
  "remote-debugger": "hook CheckRemoteDebuggerPresent to set *pbDebuggerPresent=FALSE",
  "nt-query": "hook NtQueryInformationProcess, return 0 for debug port queries",
  "output-debug-string": "hook OutputDebugStringA/W, set last error to expected value",
  "nt-global-flag": "patch PEB->NtGlobalFlag to 0",
  "debug-break": "set hardware breakpoint instead of software BP, or NOP the DebugBreak call",
  "find-window": "hook FindWindowA/W, return NULL for debugger class names",
  "tls-callback": "patch TLS callback table entry or set breakpoint at TLS callback address",
  "peb-debugged": "patch PEB->BeingDebugged to 0 at runtime",
  "int-2d": "NOP the INT 2D instruction (patch CD 2D → 90 90)",
  "int-3": "be aware of INT 3 traps; use hardware breakpoints to step over",
  "vm-cpuid": "hook/patch CPUID to return host vendor string, clear hypervisor bit",
  "vm-cpuid-insn": "hook/intercept CPUID leaf 1, clear ECX bit 31 (hypervisor present)",
  "vm-tools": "uninstall or hide VM guest tools/services before analysis",
  "vm-files": "remove VM-related file artifacts from guest filesystem",
  "vm-registry": "patch registry keys to remove VM vendor strings",
  "vm-mac": "change VM network adapter MAC address to a physical vendor prefix",
  "vm-smbios": "patch SMBIOS/DMI tables to remove VM vendor info",
  "vm-rdtsc": "use a VM with RDTSC exit interception (e.g., KVM tsc_offset)",
  "vm-rdtsc-insn": "use a hypervisor that virtualizes RDTSC consistently",
  "frida-string": "use frida-gadget instead of frida-server, or hook the detection function",
  "frida-pipe": "rename the Frida named pipe, or hook the pipe enumeration",
  "frida-port": "run frida-server on a non-default port (frida-server -l 0.0.0.0:1337)",
  "frida-gmain": "use stalker-based hooking or rename gmain thread",
  "frida-dbus": "patch or hook D-Bus detection, or use Frida without GDBus",
  "root-path": "hook File.exists / access() for root binary paths, return false/ENOENT",
  "root-pkg": "hook PackageManager.getPackageInfo, throw NameNotFoundException for root apps",
  "root-magisk": "use Magisk DenyList / Shamiko to hide from the target app",
  "root-buildtag": "hook Build.TAGS to return 'release-keys'",
  "root-safetynet": "use Magisk + Universal SafetyNet Fix / Play Integrity Fix",
  "jailbreak-cydia": "hook NSFileManager fileExistsAtPath for Cydia paths, return NO",
  "jailbreak-substrate": "use a jailbreak hide tweak (e.g., A-Bypass, Choicy, Shadow)",
  "jailbreak-hide": "already using a hide tool — ensure it covers all check vectors",
  "packer-upx": "unpack with `upx -d <binary>`, then re-analyze",
  "packer-mpress": "unpack with a generic unpacker or dump from memory at OEP",
  "packer-aspack": "unpack with a generic PE unpacker or dump at OEP",
  "packer-themida": "use x64dbg + Scylla to dump at OEP after VM handlers execute",
  "packer-vmprotect": "trace VM handlers with Unicorn/Miasm, or use commercial devirtualizer",
  "packer-armadillo": "use Armadillo-specific unpackers or memory dump at OEP",
  "obfuscation-string": "look for string decryption routines; hook or emulate them",
  "packed-string": "suspect packing — check entropy and try known unpackers",
  "tamper-string": "NOP or patch the tamper detection branch to always pass",
  "tamper-checksum": "hook checksum computation to return expected value, or patch the compare",
  "tamper-integrity": "locate the integrity check function and patch the conditional jump",
  "tamper-selfhash": "hook the hashing function to return the original hash",
  "tamper-codesign": "hook signature verification API to return success",
};

// ---------------------------------------------------------------------------
// ELF parser helpers (minimal, pure JS)
// ---------------------------------------------------------------------------

interface ElfInfo {
  is64: boolean;
  endian: "le" | "be";
  entry: number;
  phoff: number;
  phentsize: number;
  phnum: number;
  shoff: number;
  shentsize: number;
  shnum: number;
}

function parseElfHeader(data: Buffer): ElfInfo | undefined {
  if (data.length < 64) return undefined;
  if (data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) return undefined;
  const is64 = data[4] === 2;
  const endian: "le" | "be" = data[5] === 1 ? "le" : "be";
  const r16 = endian === "le" ? (o: number) => data.readUInt16LE(o) : (o: number) => data.readUInt16BE(o);
  const r32 = endian === "le" ? (o: number) => data.readUInt32LE(o) : (o: number) => data.readUInt32BE(o);
  if (is64 && data.length < 64) return undefined;
  if (!is64 && data.length < 52) return undefined;
  if (is64) {
    // entry at 24 (8 bytes), phoff at 32, shoff at 40
    const entryLow = r32(24);
    const phoff = r32(32);    // low 32 bits is enough for section scanning
    const shoff = r32(40);
    return {
      is64, endian,
      entry: entryLow,
      phoff,
      phentsize: r16(54),
      phnum: r16(56),
      shoff,
      shentsize: r16(58),
      shnum: r16(60),
    };
  }
  return {
    is64, endian,
    entry: r32(24),
    phoff: r32(28),
    phentsize: r16(42),
    phnum: r16(44),
    shoff: r32(32),
    shentsize: r16(46),
    shnum: r16(48),
  };
}

interface ElfSegment {
  type: number;
  flags: number;
  offset: number;
  vaddr: number;
  filesz: number;
  memsz: number;
}

function parseElfSegments(data: Buffer, elf: ElfInfo): ElfSegment[] {
  const segments: ElfSegment[] = [];
  const r32 = elf.endian === "le" ? (o: number) => data.readUInt32LE(o) : (o: number) => data.readUInt32BE(o);
  for (let i = 0; i < elf.phnum; i++) {
    const off = elf.phoff + i * elf.phentsize;
    if (off + elf.phentsize > data.length) break;
    if (elf.is64) {
      segments.push({
        type: r32(off),
        flags: r32(off + 4),
        offset: r32(off + 8),
        vaddr: r32(off + 16),
        filesz: r32(off + 32),
        memsz: r32(off + 40),
      });
    } else {
      segments.push({
        type: r32(off),
        offset: r32(off + 4),
        vaddr: r32(off + 8),
        filesz: r32(off + 16),
        memsz: r32(off + 20),
        flags: r32(off + 24),
      });
    }
  }
  return segments;
}

interface ElfSection {
  nameIdx: number;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  name: string;
}

function parseElfSections(data: Buffer, elf: ElfInfo): ElfSection[] {
  const sections: ElfSection[] = [];
  const r32 = elf.endian === "le" ? (o: number) => data.readUInt32LE(o) : (o: number) => data.readUInt32BE(o);
  // Read string table section header to resolve names
  const strtabIdx = elf.is64
    ? (data.length > 62 ? (elf.endian === "le" ? data.readUInt16LE(62) : data.readUInt16BE(62)) : 0)
    : (data.length > 50 ? (elf.endian === "le" ? data.readUInt16LE(50) : data.readUInt16BE(50)) : 0);

  // First pass: collect raw sections
  for (let i = 0; i < elf.shnum; i++) {
    const off = elf.shoff + i * elf.shentsize;
    if (off + elf.shentsize > data.length) break;
    if (elf.is64) {
      sections.push({
        nameIdx: r32(off),
        type: r32(off + 4),
        flags: r32(off + 8),
        addr: r32(off + 16),
        offset: r32(off + 24),
        size: r32(off + 32),
        name: "",
      });
    } else {
      sections.push({
        nameIdx: r32(off),
        type: r32(off + 4),
        flags: r32(off + 8),
        addr: r32(off + 12),
        offset: r32(off + 16),
        size: r32(off + 20),
        name: "",
      });
    }
  }

  // Resolve names from strtab
  if (strtabIdx < sections.length) {
    const strtab = sections[strtabIdx];
    if (strtab && strtab.offset + strtab.size <= data.length) {
      for (const sec of sections) {
        const start = strtab.offset + sec.nameIdx;
        if (start >= data.length) continue;
        let end = start;
        while (end < data.length && end < strtab.offset + strtab.size && data[end] !== 0) end++;
        sec.name = data.subarray(start, end).toString("ascii");
      }
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// PE parser helpers (minimal, pure JS)
// ---------------------------------------------------------------------------

interface PeInfo {
  is64: boolean;
  numSections: number;
  sectionOffset: number;
  entry: number;
  imageBase: number;
  /** File offset of optional header for size-of-headers etc. */
  optionalHeaderOffset: number;
}

function parsePeHeader(data: Buffer): PeInfo | undefined {
  if (data.length < 64) return undefined;
  if (data[0] !== 0x4d || data[1] !== 0x5a) return undefined; // MZ
  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset + 24 > data.length) return undefined;
  if (data.readUInt32LE(peOffset) !== 0x00004550) return undefined; // PE\0\0
  const machine = data.readUInt16LE(peOffset + 4);
  const numSections = data.readUInt16LE(peOffset + 6);
  const optionalSize = data.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  if (optionalHeaderOffset + optionalSize > data.length) return undefined;
  const magic = data.readUInt16LE(optionalHeaderOffset);
  const is64 = magic === 0x20b;
  const entry = data.readUInt32LE(optionalHeaderOffset + 16);
  const imageBase = is64
    ? data.readUInt32LE(optionalHeaderOffset + 24) // low 32 bits
    : data.readUInt32LE(optionalHeaderOffset + 28);
  const sectionOffset = optionalHeaderOffset + optionalSize;
  return { is64, numSections, sectionOffset, entry, imageBase, optionalHeaderOffset };
}

interface PeSection {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  rawSize: number;
  rawOffset: number;
  characteristics: number;
}

function parsePeSections(data: Buffer, pe: PeInfo): PeSection[] {
  const sections: PeSection[] = [];
  for (let i = 0; i < pe.numSections; i++) {
    const off = pe.sectionOffset + i * 40;
    if (off + 40 > data.length) break;
    let nameEnd = 8;
    for (let j = 0; j < 8; j++) {
      if (data[off + j] === 0) { nameEnd = j; break; }
    }
    sections.push({
      name: data.subarray(off, off + nameEnd).toString("ascii"),
      virtualSize: data.readUInt32LE(off + 8),
      virtualAddress: data.readUInt32LE(off + 12),
      rawSize: data.readUInt32LE(off + 16),
      rawOffset: data.readUInt32LE(off + 20),
      characteristics: data.readUInt32LE(off + 36),
    });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

function shannonEntropy(data: Buffer, start = 0, length?: number): number {
  const end = Math.min(data.length, start + (length ?? data.length));
  const n = end - start;
  if (n <= 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (let i = start; i < end; i++) counts[data[i]]++;
  let entropy = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// Printable string extraction
// ---------------------------------------------------------------------------

function extractPrintableStrings(data: Buffer, minLen: number): Array<{ offset: number; value: string }> {
  const out: Array<{ offset: number; value: string }> = [];
  let current = "";
  let startOffset = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b >= 0x20 && b <= 0x7e) {
      if (current.length === 0) startOffset = i;
      current += String.fromCharCode(b);
    } else {
      if (current.length >= minLen) out.push({ offset: startOffset, value: current });
      current = "";
    }
  }
  if (current.length >= minLen) out.push({ offset: startOffset, value: current });
  return out;
}

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

function scanAntiAnalysis(data: Buffer): Finding[] {
  const findings: Finding[] = [];
  const seenTags = new Map<string, number>(); // tag -> count, to avoid excessive duplicates

  // Extract strings
  const strings = extractPrintableStrings(data, 4);

  // String pattern matching
  for (const { offset, value } of strings) {
    for (const pat of STRING_PATTERNS) {
      if (!pat.pattern.test(value)) continue;
      const key = pat.tag;
      const count = seenTags.get(key) ?? 0;
      if (count >= 3) continue; // max 3 hits per tag to avoid noise
      seenTags.set(key, count + 1);
      findings.push({
        category: pat.category,
        confidence: pat.confidence,
        label: pat.label,
        detail: `offset: 0x${offset.toString(16).padStart(8, "0")}, string: "${value.length > 80 ? value.slice(0, 77) + "..." : value}"`,
        offset,
        tag: pat.tag,
      });
    }
  }

  // Byte pattern matching (skip INT3 which is too noisy alone)
  for (const bp of BYTE_PATTERNS) {
    if (bp.tag === "int-3") continue; // too many false positives as standalone
    const key = bp.tag;
    const count = seenTags.get(key) ?? 0;
    if (count >= 3) continue;
    let searchStart = 0;
    let hitCount = 0;
    while (hitCount < 3 - count) {
      const idx = data.indexOf(bp.bytes, searchStart);
      if (idx < 0) break;
      seenTags.set(key, (seenTags.get(key) ?? 0) + 1);
      findings.push({
        category: bp.category,
        confidence: bp.confidence,
        label: bp.label,
        detail: `offset: 0x${idx.toString(16).padStart(8, "0")}, bytes: ${bp.bytes.toString("hex")}`,
        offset: idx,
        tag: bp.tag,
      });
      searchStart = idx + bp.bytes.length;
      hitCount++;
    }
  }

  // ---- Structural checks ----

  // ELF-specific
  const elf = parseElfHeader(data);
  if (elf) {
    const segments = parseElfSegments(data, elf);
    const sections = parseElfSections(data, elf);

    // RWX segments (self-modifying code)
    const PF_X = 1, PF_W = 2, PF_R = 4;
    for (const seg of segments) {
      if (seg.type === 1 /* PT_LOAD */ && (seg.flags & (PF_R | PF_W | PF_X)) === (PF_R | PF_W | PF_X)) {
        findings.push({
          category: "OBFUSCATION",
          confidence: "high",
          label: "RWX segment — self-modifying code possible",
          detail: `vaddr: 0x${seg.vaddr.toString(16).padStart(8, "0")}, flags: RWX, size: ${seg.memsz}`,
          offset: seg.vaddr,
          tag: "rwx-segment",
        });
      }
    }

    // .text section entropy
    const textSection = sections.find(s => s.name === ".text");
    if (textSection && textSection.size > 64 && textSection.offset + textSection.size <= data.length) {
      const ent = shannonEntropy(data, textSection.offset, textSection.size);
      if (ent > 7.5) {
        findings.push({
          category: "OBFUSCATION",
          confidence: "high",
          label: `.text section entropy: ${ent.toFixed(2)} bits/byte (packed/encrypted)`,
          detail: `section offset: 0x${textSection.offset.toString(16).padStart(8, "0")}, size: ${textSection.size}`,
          offset: textSection.offset,
          tag: "high-entropy-text",
        });
      } else if (ent > 6.8) {
        findings.push({
          category: "OBFUSCATION",
          confidence: "medium",
          label: `.text section entropy: ${ent.toFixed(2)} bits/byte (possibly obfuscated)`,
          detail: `section offset: 0x${textSection.offset.toString(16).padStart(8, "0")}, size: ${textSection.size}`,
          offset: textSection.offset,
          tag: "high-entropy-text",
        });
      }
    }

    // Entry point in non-.text section
    if (textSection) {
      const entryInText = elf.entry >= textSection.addr && elf.entry < textSection.addr + textSection.size;
      if (!entryInText && elf.entry !== 0) {
        const entrySection = sections.find(s => elf.entry >= s.addr && elf.entry < s.addr + s.size);
        findings.push({
          category: "OBFUSCATION",
          confidence: "medium",
          label: `entry point (0x${elf.entry.toString(16)}) outside .text — in ${entrySection?.name || "unknown section"}`,
          detail: `.text range: 0x${textSection.addr.toString(16)}-0x${(textSection.addr + textSection.size).toString(16)}`,
          offset: elf.entry,
          tag: "entry-outside-text",
        });
      }
    }

    // Suspicious section names
    for (const sec of sections) {
      const lower = sec.name.toLowerCase();
      if (lower === "upx0" || lower === "upx1" || lower === "upx2") {
        findings.push({ category: "OBFUSCATION", confidence: "high", label: `UPX section: ${sec.name}`, detail: `offset: 0x${sec.offset.toString(16)}`, offset: sec.offset, tag: "packer-upx" });
      }
    }
  }

  // PE-specific
  const pe = parsePeHeader(data);
  if (pe) {
    const sections = parsePeSections(data, pe);

    // RWX sections
    const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
    const IMAGE_SCN_MEM_READ = 0x40000000;
    const IMAGE_SCN_MEM_WRITE = 0x80000000;
    for (const sec of sections) {
      if ((sec.characteristics & (IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE | IMAGE_SCN_MEM_EXECUTE))
          === (IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE | IMAGE_SCN_MEM_EXECUTE)) {
        findings.push({
          category: "OBFUSCATION",
          confidence: "high",
          label: `RWX PE section: ${sec.name}`,
          detail: `VA: 0x${sec.virtualAddress.toString(16).padStart(8, "0")}, size: ${sec.virtualSize}, chars: 0x${sec.characteristics.toString(16)}`,
          offset: sec.rawOffset,
          tag: "rwx-segment",
        });
      }
    }

    // Entry point section check
    const entryRva = pe.entry;
    const textSec = sections.find(s => s.name === ".text");
    if (textSec) {
      const entryInText = entryRva >= textSec.virtualAddress && entryRva < textSec.virtualAddress + textSec.virtualSize;
      if (!entryInText && entryRva !== 0) {
        const entrySec = sections.find(s => entryRva >= s.virtualAddress && entryRva < s.virtualAddress + s.virtualSize);
        findings.push({
          category: "OBFUSCATION",
          confidence: "medium",
          label: `entry point RVA 0x${entryRva.toString(16)} outside .text — in ${entrySec?.name || "unknown"}`,
          detail: `.text VA range: 0x${textSec.virtualAddress.toString(16)}-0x${(textSec.virtualAddress + textSec.virtualSize).toString(16)}`,
          offset: entryRva,
          tag: "entry-outside-text",
        });
      }
    }

    // .text entropy
    if (textSec && textSec.rawSize > 64 && textSec.rawOffset + textSec.rawSize <= data.length) {
      const ent = shannonEntropy(data, textSec.rawOffset, textSec.rawSize);
      if (ent > 7.5) {
        findings.push({ category: "OBFUSCATION", confidence: "high", label: `.text section entropy: ${ent.toFixed(2)} bits/byte (packed/encrypted)`, detail: `raw offset: 0x${textSec.rawOffset.toString(16)}, size: ${textSec.rawSize}`, offset: textSec.rawOffset, tag: "high-entropy-text" });
      } else if (ent > 6.8) {
        findings.push({ category: "OBFUSCATION", confidence: "medium", label: `.text section entropy: ${ent.toFixed(2)} bits/byte (possibly obfuscated)`, detail: `raw offset: 0x${textSec.rawOffset.toString(16)}, size: ${textSec.rawSize}`, offset: textSec.rawOffset, tag: "high-entropy-text" });
      }
    }

    // Suspicious PE section names
    for (const sec of sections) {
      const lower = sec.name.toLowerCase();
      const checks: Array<[string, string]> = [
        [".vmp0", "packer-vmprotect"], [".vmp1", "packer-vmprotect"],
        [".themida", "packer-themida"], [".winlice", "packer-themida"],
        [".enigma", "packer-enigma"], ["pec2", "packer-pecompact"],
        [".mpress", "packer-mpress"], [".aspack", "packer-aspack"],
        [".adata", "packer-aspack"],
        ["upx0", "packer-upx"], ["upx1", "packer-upx"],
      ];
      for (const [needle, tag] of checks) {
        if (lower === needle || lower.startsWith(needle)) {
          findings.push({ category: "OBFUSCATION", confidence: "high", label: `Packer/protector section: ${sec.name}`, detail: `VA: 0x${sec.virtualAddress.toString(16)}, size: ${sec.virtualSize}`, offset: sec.rawOffset, tag });
        }
      }
    }

    // Import table anomaly: very few imports in a non-trivial PE
    const importCount = sections.filter(s => s.rawSize > 0).length;
    if (data.length > 50_000 && importCount <= 2) {
      findings.push({
        category: "OBFUSCATION",
        confidence: "medium",
        label: "Very few PE sections with data — possible packing or import reconstruction",
        detail: `sections with data: ${importCount}, file size: ${data.length}`,
        tag: "packed-import-anomaly",
      });
    }

    // Overlay detection (data after last section)
    if (sections.length > 0) {
      const lastSection = sections.reduce((a, b) => (a.rawOffset + a.rawSize > b.rawOffset + b.rawSize ? a : b));
      const lastSectionEnd = lastSection.rawOffset + lastSection.rawSize;
      if (lastSectionEnd < data.length && data.length - lastSectionEnd > 512) {
        const overlaySize = data.length - lastSectionEnd;
        const overlayEntropy = shannonEntropy(data, lastSectionEnd, Math.min(overlaySize, 8192));
        findings.push({
          category: "OBFUSCATION",
          confidence: "low",
          label: `PE overlay data: ${overlaySize} bytes after last section`,
          detail: `offset: 0x${lastSectionEnd.toString(16)}, entropy: ${overlayEntropy.toFixed(2)}`,
          offset: lastSectionEnd,
          tag: "pe-overlay",
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatFindings(findings: Finding[]): string {
  // Group by category
  const groups = new Map<FindingCategory, Finding[]>();
  for (const f of findings) {
    const list = groups.get(f.category) ?? [];
    list.push(f);
    groups.set(f.category, list);
  }

  const categoryOrder: FindingCategory[] = [
    "ANTI-DEBUG", "ANTI-VM", "ANTI-FRIDA", "ANTI-ROOT", "OBFUSCATION", "ANTI-TAMPER",
  ];

  const lines: string[] = [];
  for (const cat of categoryOrder) {
    const items = groups.get(cat);
    if (!items || items.length === 0) continue;
    // Determine highest confidence in category
    const maxConf = items.some(f => f.confidence === "high") ? "high" : items.some(f => f.confidence === "medium") ? "medium" : "low";
    lines.push(`  ${cat} [${maxConf}]`);
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      const isLast = i === items.length - 1;
      const prefix = isLast ? "  └──" : "  ├──";
      const contPrefix = isLast ? "     " : "  │  ";
      lines.push(`${prefix} ${f.label}`);
      lines.push(`${contPrefix} ${f.detail}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatSummary(findings: Finding[]): string {
  const categoryOrder: FindingCategory[] = [
    "ANTI-DEBUG", "ANTI-VM", "ANTI-FRIDA", "ANTI-ROOT", "OBFUSCATION", "ANTI-TAMPER",
  ];
  const lines: string[] = [];
  for (const cat of categoryOrder) {
    const items = findings.filter(f => f.category === cat);
    if (items.length === 0) {
      lines.push(`  ${cat.toLowerCase().replace(/-/g, "_")}: 0 indicators`);
    } else {
      const maxConf = items.some(f => f.confidence === "high") ? "high" : items.some(f => f.confidence === "medium") ? "medium" : "low";
      lines.push(`  ${cat.toLowerCase().replace(/-/g, "_")}: ${items.length} indicator${items.length > 1 ? "s" : ""} (${maxConf} confidence)`);
    }
  }
  return lines.join("\n");
}

function formatBypassHints(findings: Finding[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of findings) {
    if (seen.has(f.tag)) continue;
    const hint = BYPASS_HINTS[f.tag];
    if (!hint) continue;
    seen.add(f.tag);
    // Use a short label derived from the tag
    const shortLabel = f.tag.replace(/-/g, " ").replace(/_/g, " ");
    lines.push(`  - ${shortLabel}: ${hint}`);
  }
  return lines.length > 0 ? lines.join("\n") : "  - none (no known bypass for detected indicators)";
}

// ---------------------------------------------------------------------------
// Tool 1: detect_anti_analysis
// ---------------------------------------------------------------------------

const detectAntiAnalysisTool: AgentTool = {
  name: "detect_anti_analysis",
  description:
    "Comprehensive anti-analysis scanner: detects anti-debugging (ptrace, IsDebuggerPresent, timing), anti-VM (CPUID, VMware/VBox), anti-Frida, anti-root/jailbreak, obfuscation (packed sections, RWX, high entropy), and anti-tamper indicators. Pure JS — no external tools needed.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative binary or APK/DEX path." },
      maxBytes: { type: "number", default: 8388608, description: "Maximum bytes to scan (default 8MB)." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("detect_anti_analysis expects a file path.");
    const rel = path.relative(context.workspace, target);

    // Try Rust backend first
    const rustResult = await rustAntiParse("anti", target, context);
    if (rustResult) {
      const text = formatRustAntiOutput(rustResult, rel);
      const spilled = await spillIfLarge(text, { context, label: `anti-${path.basename(target)}` });
      return { content: [textBlock(spilled.text)], details: { engine: "rust/goblin", artifact: spilled.artifact } };
    }

    // JS fallback
    const maxBytes = Math.min(Math.max(1024, asNumber(args.maxBytes, 8 * 1024 * 1024)), 32 * 1024 * 1024);
    const data = await readPrefix(target, Math.min(stat.size, maxBytes));

    const findings = scanAntiAnalysis(data);

    // Sort: high confidence first, then by category order, then by offset
    const confOrder: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence] || a.category.localeCompare(b.category) || (a.offset ?? 0) - (b.offset ?? 0));

    const out = [
      "ANTI-ANALYSIS SCAN",
      `path: ${rel}`,
      `size: ${stat.size} bytes`,
      ...(stat.size > data.length ? [`scanned: ${data.length}/${stat.size} bytes`] : []),
      "",
      `findings (${findings.length}):`,
      "",
      findings.length > 0 ? formatFindings(findings) : "  none detected",
      "summary:",
      formatSummary(findings),
      "",
      "bypass hints:",
      formatBypassHints(findings),
    ];

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `anti-analysis-${path.basename(target)}` });
    return {
      content: [textBlock(spilled.text)],
      details: {
        total: findings.length,
        categories: Object.fromEntries(
          (["ANTI-DEBUG", "ANTI-VM", "ANTI-FRIDA", "ANTI-ROOT", "OBFUSCATION", "ANTI-TAMPER"] as FindingCategory[]).map(
            cat => [cat, findings.filter(f => f.category === cat).length],
          ),
        ),
        artifact: spilled.artifact,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 2: detect_packer — focused packer/protector identification
// ---------------------------------------------------------------------------

interface PackerResult {
  name: string;
  confidence: Confidence;
  evidence: string[];
}

function detectPackers(data: Buffer): PackerResult[] {
  const results: PackerResult[] = [];
  const strings = extractPrintableStrings(data, 3);
  const stringSet = new Set(strings.map(s => s.value.toLowerCase()));
  const stringValues = strings.map(s => s.value);

  const elf = parseElfHeader(data);
  const pe = parsePeHeader(data);

  const elfSections = elf ? parseElfSections(data, elf) : [];
  const peSections = pe ? parsePeSections(data, pe) : [];
  const allSectionNames = [...elfSections.map(s => s.name), ...peSections.map(s => s.name)].map(n => n.toLowerCase());

  // Helper: check if any section name matches
  const hasSection = (names: string[]) => names.some(n => allSectionNames.includes(n.toLowerCase()));
  const hasString = (pattern: RegExp) => stringValues.some(s => pattern.test(s));
  const findStringOffset = (pattern: RegExp) => strings.find(s => pattern.test(s.value));

  // UPX
  {
    const evidence: string[] = [];
    if (hasString(/UPX!/)) evidence.push("UPX! magic string found");
    if (hasSection(["upx0", "upx1", "upx2"])) evidence.push("UPX section names (UPX0/UPX1)");
    if (hasString(/This file is packed with the UPX/i)) evidence.push("UPX info string");
    if (evidence.length > 0) results.push({ name: "UPX", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // MPRESS
  {
    const evidence: string[] = [];
    if (hasSection([".mpress1", ".mpress2", ".mpress"])) evidence.push("MPRESS section name");
    if (hasString(/MPRESS/i)) evidence.push("MPRESS string reference");
    if (evidence.length > 0) results.push({ name: "MPRESS", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // ASPack
  {
    const evidence: string[] = [];
    if (hasSection([".aspack", ".adata"])) evidence.push("ASPack section name");
    if (hasString(/ASPack/i)) evidence.push("ASPack string");
    if (evidence.length > 0) results.push({ name: "ASPack", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // Themida / WinLicense
  {
    const evidence: string[] = [];
    if (hasSection([".themida", ".winlice"])) evidence.push("Themida/WinLicense section name");
    if (hasString(/Themida/i)) evidence.push("Themida string");
    if (hasString(/WinLicense/i)) evidence.push("WinLicense string");
    if (evidence.length > 0) results.push({ name: "Themida/WinLicense", confidence: "high", evidence });
  }

  // VMProtect
  {
    const evidence: string[] = [];
    if (hasSection([".vmp0", ".vmp1", ".vmp2"])) evidence.push("VMProtect section name");
    if (hasString(/VMProtect/i)) evidence.push("VMProtect string");
    if (hasString(/VMProtectSDK/i)) evidence.push("VMProtectSDK import");
    if (evidence.length > 0) results.push({ name: "VMProtect", confidence: "high", evidence });
  }

  // Enigma Protector
  {
    const evidence: string[] = [];
    if (hasSection([".enigma1", ".enigma2", ".enigma"])) evidence.push("Enigma section name");
    if (hasString(/Enigma Protector/i)) evidence.push("Enigma Protector string");
    if (evidence.length > 0) results.push({ name: "Enigma Protector", confidence: "high", evidence });
  }

  // PECompact
  {
    const evidence: string[] = [];
    if (hasSection(["pec2", "pec1"])) evidence.push("PECompact section name");
    if (hasString(/PECompact/i)) evidence.push("PECompact string");
    if (evidence.length > 0) results.push({ name: "PECompact", confidence: "high", evidence });
  }

  // Armadillo
  {
    const evidence: string[] = [];
    if (hasString(/Armadillo/i)) evidence.push("Armadillo string");
    if (hasString(/Silicon Realms/i)) evidence.push("Silicon Realms Toolworks string");
    if (evidence.length > 0) results.push({ name: "Armadillo", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // Obsidium
  {
    const evidence: string[] = [];
    if (hasSection([".obsidium"])) evidence.push("Obsidium section name");
    if (hasString(/Obsidium/i)) evidence.push("Obsidium string");
    if (evidence.length > 0) results.push({ name: "Obsidium", confidence: "high", evidence });
  }

  // Android-specific packers
  // 360 Jiagu
  {
    const evidence: string[] = [];
    if (hasString(/libjiagu/i)) evidence.push("libjiagu.so library");
    if (hasString(/qihoo/i)) evidence.push("Qihoo/360 string");
    if (evidence.length > 0) results.push({ name: "360 Jiagu", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // Tencent Legu
  {
    const evidence: string[] = [];
    if (hasString(/libshell/i)) evidence.push("libshell.so (Legu)");
    if (hasString(/libtup/i)) evidence.push("libtup.so (Legu)");
    if (hasString(/libexecmain/i)) evidence.push("libexecmain.so (Legu)");
    if (evidence.length > 0) results.push({ name: "Tencent Legu", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // Bangcle (SecNeo)
  {
    const evidence: string[] = [];
    if (hasString(/libsecexe/i)) evidence.push("libsecexe.so (Bangcle)");
    if (hasString(/libsecmain/i)) evidence.push("libsecmain.so (Bangcle)");
    if (hasString(/libDexHelper/i)) evidence.push("libDexHelper.so (Bangcle)");
    if (evidence.length > 0) results.push({ name: "Bangcle/SecNeo", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // Ijiami
  {
    const evidence: string[] = [];
    if (hasString(/ijiami/i)) evidence.push("Ijiami string");
    if (hasString(/libexec\.so/i)) evidence.push("libexec.so (Ijiami)");
    if (evidence.length > 0) results.push({ name: "Ijiami", confidence: "medium", evidence });
  }

  // NetEase Yidun
  {
    const evidence: string[] = [];
    if (hasString(/libnesec/i)) evidence.push("libnesec.so (Yidun)");
    if (hasString(/yidun/i)) evidence.push("Yidun string");
    if (evidence.length > 0) results.push({ name: "NetEase Yidun", confidence: evidence.length >= 2 ? "high" : "medium", evidence });
  }

  // DexGuard
  {
    const evidence: string[] = [];
    if (hasString(/dexguard/i)) evidence.push("DexGuard string");
    if (evidence.length > 0) results.push({ name: "DexGuard", confidence: "medium", evidence });
  }

  // ---- Generic anomaly checks ----

  // Entry point in non-standard section
  if (pe) {
    const textSec = peSections.find(s => s.name.toLowerCase() === ".text");
    if (textSec) {
      const entryInText = pe.entry >= textSec.virtualAddress && pe.entry < textSec.virtualAddress + textSec.virtualSize;
      if (!entryInText && pe.entry !== 0) {
        const entrySec = peSections.find(s => pe.entry >= s.virtualAddress && pe.entry < s.virtualAddress + s.virtualSize);
        results.push({
          name: "Unknown/Custom Packer (entry point anomaly)",
          confidence: "medium",
          evidence: [`entry RVA 0x${pe.entry.toString(16)} is in ${entrySec?.name || "unknown"}, not .text`],
        });
      }
    }

    // Very few imports for a non-trivial binary
    // Scan for import directory: check the 2nd data directory entry
    // For simplicity, just check string-based heuristic
    const importStrings = strings.filter(s => /^(Get|Set|Load|Create|Open|Read|Write|Close|Find|Query|Nt)\w+$/.test(s.value));
    if (data.length > 100_000 && importStrings.length < 5) {
      results.push({
        name: "Unknown/Custom Packer (import anomaly)",
        confidence: "low",
        evidence: [`only ${importStrings.length} API-like strings in ${data.length} byte binary`],
      });
    }
  }

  if (elf) {
    const textSec = elfSections.find(s => s.name === ".text");
    if (textSec) {
      const entryInText = elf.entry >= textSec.addr && elf.entry < textSec.addr + textSec.size;
      if (!entryInText && elf.entry !== 0) {
        const entrySec = elfSections.find(s => elf.entry >= s.addr && elf.entry < s.addr + s.size);
        results.push({
          name: "Unknown/Custom Packer (entry point anomaly)",
          confidence: "medium",
          evidence: [`entry 0x${elf.entry.toString(16)} is in ${entrySec?.name || "unknown"}, not .text`],
        });
      }
    }
  }

  // High overall entropy check
  if (data.length > 1024) {
    const overall = shannonEntropy(data, 0, Math.min(data.length, 1024 * 1024));
    if (overall > 7.5) {
      results.push({
        name: "Unknown Packer (high overall entropy)",
        confidence: "medium",
        evidence: [`overall entropy: ${overall.toFixed(3)} bits/byte (>7.5 threshold)`],
      });
    }
  }

  // Overlay data for PE
  if (pe && peSections.length > 0) {
    const lastSection = peSections.reduce((a, b) => (a.rawOffset + a.rawSize > b.rawOffset + b.rawSize ? a : b));
    const lastEnd = lastSection.rawOffset + lastSection.rawSize;
    if (lastEnd < data.length && data.length - lastEnd > 512) {
      const overlaySize = data.length - lastEnd;
      const overlayEnt = shannonEntropy(data, lastEnd, Math.min(overlaySize, 8192));
      results.push({
        name: "Overlay Data",
        confidence: "low",
        evidence: [
          `${overlaySize} bytes after last PE section at offset 0x${lastEnd.toString(16)}`,
          `overlay entropy: ${overlayEnt.toFixed(2)} bits/byte`,
        ],
      });
    }
  }

  return results;
}

const detectPackerTool: AgentTool = {
  name: "detect_packer",
  description:
    "Focused packer/protector identification for ELF, PE, and Mach-O binaries. Checks UPX, MPRESS, ASPack, Themida, VMProtect, Enigma, PECompact, Armadillo, Obsidium, 360 Jiagu, Tencent Legu, Bangcle, Ijiami, NetEase Yidun, DexGuard, and generic anomaly indicators (entry point, imports, entropy, overlay). Pure JS — no external tools needed.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative binary path." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("detect_packer expects a file path.");
    const rel = path.relative(context.workspace, target);

    // Try Rust backend first
    const rustResult = await rustAntiParse("packer", target, context);
    if (rustResult) {
      const text = formatRustPackerOutput(rustResult, rel);
      const spilled = await spillIfLarge(text, { context, label: `packer-${path.basename(target)}` });
      return { content: [textBlock(spilled.text)], details: { engine: "rust/goblin", artifact: spilled.artifact } };
    }

    // JS fallback
    const maxBytes = Math.min(stat.size, 16 * 1024 * 1024);
    const data = await readPrefix(target, maxBytes);

    const packers = detectPackers(data);

    const elf = parseElfHeader(data);
    const pe = parsePeHeader(data);
    const format = elf ? "ELF" : pe ? "PE" : data.subarray(0, 4).toString("hex") === "cffaedfe" || data.subarray(0, 4).toString("hex") === "feedfacf" ? "Mach-O" : "unknown";

    const elfSections = elf ? parseElfSections(data, elf) : [];
    const peSections = pe ? parsePeSections(data, pe) : [];
    const allSections = [...elfSections.map(s => ({ name: s.name, offset: s.offset, size: s.size })), ...peSections.map(s => ({ name: s.name, offset: s.rawOffset, size: s.rawSize }))];

    const overall = shannonEntropy(data, 0, Math.min(data.length, 1024 * 1024));

    const out = [
      "PACKER DETECTION",
      `path: ${rel}`,
      `format: ${format}`,
      `size: ${stat.size} bytes`,
      `overall entropy: ${overall.toFixed(3)} bits/byte`,
      ...(allSections.length ? [`sections: ${allSections.map(s => s.name || "(unnamed)").join(", ")}`] : []),
      "",
    ];

    if (packers.length === 0) {
      out.push("result: no known packer/protector detected");
    } else {
      out.push(`detected (${packers.length}):`);
      for (const p of packers) {
        out.push(`  ▸ ${p.name} [${p.confidence}]`);
        for (const e of p.evidence) out.push(`    - ${e}`);
      }
    }

    // Section details
    if (allSections.length > 0) {
      out.push("", "section details:");
      for (const sec of allSections) {
        if (sec.size === 0) continue;
        const ent = sec.offset + sec.size <= data.length ? shannonEntropy(data, sec.offset, sec.size) : 0;
        const flag = ent > 7.5 ? " ⚠ high entropy" : ent > 6.8 ? " ▲ elevated" : "";
        out.push(`  ${(sec.name || "(unnamed)").padEnd(16)} offset=0x${sec.offset.toString(16).padStart(8, "0")}  size=${String(sec.size).padStart(8)}  entropy=${ent.toFixed(2)}${flag}`);
      }
    }

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `packer-${path.basename(target)}` });
    return {
      content: [textBlock(spilled.text)],
      details: { format, packers: packers.map(p => p.name), count: packers.length, entropy: overall, artifact: spilled.artifact },
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readPrefix(file: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
