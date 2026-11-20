// Full in-memory AppAPI implementation for the GUI Demo Sandbox.
// Mirrors gui/manager.go + gui/events.go + gui/approval.go + gui/command.go
// over the exact frozen DTO shapes so every real GUI panel, dialog, animation,
// approval gate, RE 9-phase HUD, and xterm shell behaves identically to Wails.
import type { AppAPI } from '../lib/api'
import type {
  ApprovalDecision,
  ApprovalDTO,
  CommandResultDTO,
  EvidenceRecord,
  FindingDTO,
  FlowDTO,
  FlowStage,
  GoalSummaryDTO,
  HudDTO,
  Hypothesis,
  HypothesisExperiment,
  HypothesisMutationDTO,
  LifecycleState,
  LoopEvent,
  NoticeDTO,
  PlanSnapshot,
  PlanStep,
  ReDTO,
  RESampleType,
  ReviewRequestDTO,
  ReviewResultDTO,
  RunExperimentDTO,
  SandboxDTO,
  SessionInfo,
  SessionSummaryDTO,
  SettingsDTO,
  SettingsPatch,
  ShellInfo,
  StartOptions,
  TickDTO,
  TokenUsage,
  ToolRunSnapshot,
  VerificationRequestDTO,
} from '../lib/types'
import { emitDemoGuiEvent } from '../lib/events'
import { THEME_NAMES, type ThemeName } from '../theme/ThemeContext'
import {
  generateWriteupMarkdown,
  synthesizeProcessSummary,
} from '../components/re/cognitiveSynthesis'
import { DemoShellManager } from './mockShell'
import { applyLiveTheme, emitDemoSignal } from './signals'

// ---------- static mirrors from Go (workflow/picker.go & workflow/phase.go) ----------

const PHASES = [
  'triage',
  'static',
  'dynamic',
  'evidence',
  'interface',
  'hypothesis',
  'verify',
  'audit',
  'writeup',
] as const

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const SAMPLE_TYPES: RESampleType[] = [
  {
    key: 'apk',
    label: 'APK',
    desc: 'Android application package',
    prompts: [
      { short: 'Triage APK structure', full: 'Identify package name, permissions, components, native libs, and signing info for this APK.' },
      { short: 'Find hardcoded secrets', full: "Search for hardcoded API keys, tokens, URLs, and credentials in the APK's dex and resource files." },
      { short: 'Trace native JNI calls', full: 'Map JNI bridge methods between Java/Kotlin and native .so libraries in this APK.' },
      { short: 'Recover obfuscated logic', full: "Deobfuscate and recover the core business logic from this APK's smali/dex." },
    ],
  },
  {
    key: 'so',
    label: 'SO / ELF shared lib',
    desc: 'Linux/Android shared object',
    prompts: [
      { short: 'Symbol & import survey', full: 'List exported/imported symbols, detect stripping level, and identify key routines.' },
      { short: 'Find crypto primitives', full: 'Locate cryptographic constants, S-boxes, and cipher implementations in this binary.' },
      { short: 'Reconstruct C structs', full: 'Recover C/C++ struct layouts from field access patterns in the decompiled code.' },
    ],
  },
  {
    key: 'dylib',
    label: 'dylib / Mach-O',
    desc: 'macOS/iOS dynamic library',
    prompts: [
      { short: 'Objective-C class dump', full: 'Dump Objective-C class hierarchy, selectors, and protocol conformances.' },
      { short: 'Swift metadata recovery', full: 'Recover Swift type metadata, protocol witness tables, and generic signatures.' },
      { short: 'Entitlements & codesign', full: 'Extract and analyze code signing info, entitlements, and provisioning profile.' },
    ],
  },
  {
    key: 'elf',
    label: 'ELF binary',
    desc: 'Linux executable / core dump',
    prompts: [
      { short: 'Binary hardening check', full: 'Check RELRO, stack canary, NX, PIE, FORTIFY, and RPATH/RUNPATH settings.' },
      { short: 'Vulnerability surface', full: 'Identify dangerous function calls (gets, strcpy, system) and potential overflow points.' },
      { short: 'Control flow recovery', full: 'Recover the main control flow graph and identify key decision points.' },
    ],
  },
  {
    key: 'pe',
    label: 'PE / DLL',
    desc: 'Windows executable or library',
    prompts: [
      { short: 'Import table analysis', full: 'Analyze IAT/EAT, identify suspicious API imports (VirtualAlloc, CreateRemoteThread, etc).' },
      { short: 'Packer/protector detect', full: 'Detect packing, encryption, or obfuscation layers (UPX, VMProtect, Themida, etc).' },
      { short: 'Resource extraction', full: 'Extract embedded resources, version info, manifests, and suspicious payloads.' },
    ],
  },
  {
    key: 'firmware',
    label: 'Firmware blob',
    desc: 'Embedded / IoT firmware image',
    prompts: [
      { short: 'Firmware survey', full: '对 carrier.bin 做文件分诊与内嵌特征提取，建立初步假设' },
      { short: 'Extract filesystem', full: 'Carve and extract embedded signatures and payloads from carrier.bin.' },
      { short: 'Find hardcoded creds', full: 'Search for default passwords, private keys, certificates, and debug backdoors.' },
    ],
  },
  {
    key: 'pcap',
    label: 'PCAP / traffic',
    desc: 'Network capture file',
    prompts: [
      { short: 'Protocol identification', full: 'Identify protocols, session flows, and extract notable payloads from this capture.' },
      { short: 'C2 traffic analysis', full: 'Look for C2 beaconing patterns, DNS tunneling, or suspicious periodic connections.' },
    ],
  },
]

const COMMAND_COMPLETIONS: string[] = [
  '/help ',
  '/scan ',
  '/inspect ',
  '/anti ',
  '/diff ',
  '/decode ',
  '/entropy ',
  '/mitigations ',
  '/workflow ',
  '/phase ',
  '/goal ',
  '/cap ',
  '/audit',
  '/writeup',
  '/theme ',
  '/tools',
  '/skills',
  '/providers',
  '/status',
  '/sessions',
  '/compact',
  '/think ',
  '/tasks ',
  '/new',
]

// ---------- helpers ----------

function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
}

function modelForProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p.includes('codex-sol') || p.includes('codex sol') || p === 'codex') return 'codex sol'
  if (p.includes('gemini-4-carbon') || p.includes('carbon')) return 'gemini 4 carbon'
  if (p.includes('gemini-4-neon') || p.includes('neon')) return 'gemini 4 neon'
  if (p.includes('glm-5.3-flash') || p.includes('flash')) return 'glm-5.3-flash'
  if (p.includes('glm-5.3') || p === 'glm') return 'glm-5.3'
  if (p === 'ds' || p.includes('deepseek')) return 'ds (deepseek)'
  if (p.includes('claude')) return 'claude-opus-4-6'
  return 'demo-sandbox-1'
}

function shortSha16(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

function makeLoopEvent(partial: Partial<LoopEvent> & { type: LoopEvent['type'] }): LoopEvent {
  return {
    turn: 0,
    provider: 'codex-sol',
    phase: '',
    model: 'codex sol',
    endpoint: 'demo://sandbox',
    messages: 0,
    tokens: 0,
    tools: 34,
    ms: 0,
    ok: true,
    toolCalls: 0,
    textChars: 0,
    error: '',
    tokensBefore: 0,
    tokensAfter: 0,
    droppedMessages: 0,
    elidedToolResults: 0,
    progress: null,
    snapshot: null,
    text: '',
    usage: null,
    reason: '',
    name: '',
    args: null,
    preview: '',
    ...partial,
  }
}

function makePlanSteps(specs: Array<{ text: string; status: PlanStep['status'] }>): PlanStep[] {
  const now = Date.now()
  return specs.map((s, idx) => ({
    id: `step-${idx + 1}`,
    text: s.text,
    status: s.status,
    startedAt: s.status !== 'pending' ? now - (specs.length - idx) * 400 : 0,
    completedAt: s.status === 'completed' ? now - (specs.length - idx - 1) * 200 : 0,
  }))
}

function decodePayload(codec: string, data: string): { ok: boolean; out: string } {
  const c = codec.toLowerCase()
  try {
    if (c === 'base64' || c === 'b64') {
      return { ok: true, out: atob(data.trim()) }
    }
    if (c === 'hex') {
      const clean = data.replace(/[^0-9a-fA-F]/g, '')
      let str = ''
      for (let i = 0; i + 1 < clean.length; i += 2) {
        str += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
      }
      return { ok: true, out: str }
    }
    if (c === 'url') {
      return { ok: true, out: decodeURIComponent(data) }
    }
    if (c === 'rot13') {
      return {
        ok: true,
        out: data.replace(/[a-zA-Z]/g, (ch) => {
          const base = ch <= 'Z' ? 65 : 97
          return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base)
        }),
      }
    }
    if (c === 'xor') {
      return { ok: true, out: '0xaf{warmup_deck}' }
    }
    return { ok: false, out: `unsupported codec: ${codec} (try base64 | hex | url | rot13 | xor)` }
  } catch {
    return { ok: false, out: `failed to decode ${codec} payload` }
  }
}

// ---------- saved historical sessions for ResumeDialog ----------

interface SavedDemoSession {
  summary: SessionSummaryDTO
  workflow: string
  re: ReDTO | null
  history: LoopEvent[]
  plan: PlanSnapshot | null
  usage: TokenUsage
  hypotheses: Hypothesis[]
  evidence: EvidenceRecord[]
}

function makeSavedSessions(): SavedDemoSession[] {
  const now = Date.now()
  return [
    {
      summary: {
        id: 'hist-welcome-01',
        hash: 'a9f3c1e2',
        updatedAt: '2026-11-19T18:42:10Z',
        messages: 6,
        workspace: '/demo/welcome',
        firstPrompt: '分析 chall.js 并验证恢复的 token',
      },
      workflow: 'reverse',
      re: { sampleType: 'elf', phase: 'writeup', phaseIndex: 8, phaseCount: 9, hypotheses: 1, evidence: 4 },
      usage: { input: 6420, output: 1480, thinking: 910, cacheRead: 3200, cacheWrite: 0, costUsd: 0.0312 },
      plan: {
        source: 'agent',
        note: 'Verified token 0xaf{warmup_deck}',
        updatedAt: now - 3600_000,
        steps: makePlanSteps([
          { text: 'Read chall.js & locate XOR table', status: 'completed' },
          { text: 'Decode 17-byte payload with key 0x2a', status: 'completed' },
          { text: 'Verify via verify_artifact & write solve note', status: 'completed' },
        ]),
      },
      hypotheses: [
        {
          id: 'H-001',
          claim: 'chall.js 使用单字节 XOR（key=0x2a）编码目标令牌，解码结果 0xaf{warmup_deck} 可通过校验',
          confidence: 0.98,
          supporting: ['ev_001', 'ev_002', 'ev_003'],
          status: 'active',
          note: 'Confirmed by verify_artifact (2/2 cases passed)',
          createdAt: now - 3600_000,
          updatedAt: now - 3500_000,
        },
      ],
      evidence: [
        {
          id: 'ev_001',
          source: 'read_file',
          kind: 'tool_observation',
          view: 'static',
          summary: 'chall.js: XOR key=0x2a, encoded[17]',
          excerpt: 'const key = 0x2a;\nconst encoded = [26, 82, 75, 76, 81, 93, 75, 88, 71, 95, 90, 117, 78, 79, 73, 65, 87];',
          artifact: 'chall.js',
          sha256: '9e4a7c2b1f08d6e35c14a8b7d201f93e41c7b8a2f6e5d4c3b2a10987654321ab',
          bytes: 436,
          createdAt: now - 3600_000,
        },
        {
          id: 'ev_002',
          source: 'ctf_decode',
          kind: 'tool_observation',
          view: 'static',
          summary: 'XOR 0x2a decoded -> 0xaf{warmup_deck}',
          excerpt: 'codec=xor key=0x2a output="0xaf{warmup_deck}"',
          bytes: 17,
          createdAt: now - 3580_000,
        },
        {
          id: 'ev_003',
          source: 'verify_artifact',
          kind: 'verification_result',
          view: 'dynamic',
          summary: "node chall.js '0xaf{warmup_deck}' -> accepted; negative -> rejected",
          excerpt: 'case 1 (positive): exit=0 stdout="accepted"\ncase 2 (negative): exit=1 stdout="rejected"',
          verification: { build: false, passed: 2, total: 2, id: 'ev_003' },
          supports: ['H-001'],
          bytes: 94,
          createdAt: now - 3540_000,
        },
        {
          id: 'ev_004',
          source: 'audit:glm-5.3',
          kind: 'audit_finding',
          view: 'static',
          summary: 'GLM-5.3 adversarial audit PASS · 0 unsupported claims',
          excerpt: 'AUDIT H-001 SUPPORT ev_003 — static decode (ev_002) and dynamic replay (ev_003) verified.',
          supports: ['H-001'],
          bytes: 91,
          createdAt: now - 3500_000,
        },
      ],
      history: [
        makeLoopEvent({ type: 'user', text: '分析 chall.js 并验证恢复的 token' }),
        makeLoopEvent({
          type: 'reply',
          text: '## 历史复盘：welcome/chall.js\n\n- **算法**：单字节 XOR（key = `0x2a`）\n- **还原 Token**：`0xaf{warmup_deck}`\n- **验证结果**：`node chall.js "0xaf{warmup_deck}"` → `accepted`\n- **账本证据**：`ev_001`..`ev_004` 均已归档，可继续追问或复现。',
          textChars: 142,
        }),
      ],
    },
    {
      summary: {
        id: 'hist-apk-jni-02',
        hash: '7c2e9b04',
        updatedAt: '2026-11-19T16:15:33Z',
        messages: 10,
        workspace: '/demo/android-sign',
        firstPrompt: 'Trace JNI_OnLoad and locate HMAC-SHA256 signing key in libnative-sign.so',
      },
      workflow: 'reverse',
      re: { sampleType: 'apk', phase: 'verify', phaseIndex: 6, phaseCount: 9, hypotheses: 2, evidence: 5 },
      usage: { input: 18400, output: 3250, thinking: 2420, cacheRead: 9600, cacheWrite: 0, costUsd: 0.0845 },
      plan: {
        source: 'agent',
        note: 'JNI bridge mapped; ready for /audit',
        updatedAt: now - 7200_000,
        steps: makePlanSteps([
          { text: 'Parse AndroidManifest & enumerate native libs', status: 'completed' },
          { text: 'Map RegisterNatives table in JNI_OnLoad', status: 'completed' },
          { text: 'Reconstruct HMAC-SHA256 salt derivation', status: 'completed' },
          { text: 'Run /audit before final writeup', status: 'in_progress' },
        ]),
      },
      hypotheses: [
        {
          id: 'H-001',
          claim: 'com.example.auth.Signer.signPayload 在 JNI_OnLoad 动态注册至 sub_8f4c',
          confidence: 0.92,
          supporting: ['ev_001', 'ev_002'],
          status: 'active',
          createdAt: now - 7200_000,
          updatedAt: now - 7100_000,
        },
        {
          id: 'H-002',
          claim: 'HMAC-SHA256 盐值由包名 SHA1 前 16 字节与硬编码表异或派生',
          confidence: 0.88,
          supporting: ['ev_004', 'ev_005'],
          dependsOn: ['H-001'],
          status: 'active',
          createdAt: now - 7050_000,
          updatedAt: now - 7000_000,
        },
      ],
      evidence: [
        { id: 'ev_001', source: 'apk_inspect', kind: 'tool_observation', view: 'static', summary: 'pkg=com.example.auth · libnative-sign.so (arm64-v8a)', excerpt: 'AndroidManifest: minSdk=24 targetSdk=34\nNative libs: lib/arm64-v8a/libnative-sign.so (288KB)', bytes: 184, createdAt: now - 7200_000 },
        { id: 'ev_002', source: 'binary_inspect', kind: 'tool_observation', view: 'static', summary: 'JNI_OnLoad@0x8e10 -> RegisterNatives -> sub_8f4c', excerpt: 'ELF64 AArch64 stripped · .init_array(2) · exports=[JNI_OnLoad]', bytes: 210, createdAt: now - 7180_000 },
        { id: 'ev_003', source: 'anti_analysis', kind: 'tool_observation', view: 'static', summary: 'anti-Frida: /proc/self/maps + frida-agent', excerpt: '[MED] string match: "frida-agent", "/proc/self/maps" in .rodata+0x1240', bytes: 142, createdAt: now - 7150_000 },
        { id: 'ev_004', source: 'unicorn_emulate', kind: 'runtime_trace', view: 'dynamic', summary: 'sub_8f4c("hello") -> hmac=4a8b…91e2', excerpt: 'ARM64 emu ok · key_buf=16B · out_hex=4a8b09c17e22d4a591e2', bytes: 156, createdAt: now - 7080_000 },
        { id: 'ev_005', source: 'verify_artifact', kind: 'verification_result', view: 'dynamic', summary: 'Python HMAC replica matches 3/3 device vectors', excerpt: '3/3 test vectors matched bit-for-bit against captured traffic', verification: { build: false, passed: 3, total: 3, id: 'ev_005' }, supports: ['H-002'], bytes: 118, createdAt: now - 7000_000 },
      ],
      history: [
        makeLoopEvent({ type: 'user', text: 'Trace JNI_OnLoad and locate HMAC-SHA256 signing key in libnative-sign.so' }),
        makeLoopEvent({
          type: 'reply',
          text: '## 历史复盘：libnative-sign.so (ARM64)\n\n已定位 `JNI_OnLoad` → `RegisterNatives` 绑定 `signPayload(String) → sub_8f4c`，并通过 `anti_analysis` 发现 `/proc/self/maps` 反 Frida 检查。\n\n当前位于 **VER (7/9)** 阶段，可继续执行 `/audit` 完成对抗审计。',
          textChars: 164,
        }),
      ],
    },
    {
      summary: {
        id: 'hist-fw-carve-03',
        hash: '4d81aa19',
        updatedAt: '2026-11-18T21:05:00Z',
        messages: 8,
        workspace: '/demo/reverse-lab',
        firstPrompt: 'Triage carrier.bin and carve embedded PDF/ZIP signatures',
      },
      workflow: 'reverse',
      re: { sampleType: 'firmware', phase: 'audit', phaseIndex: 7, phaseCount: 9, hypotheses: 2, evidence: 6 },
      usage: { input: 11200, output: 2190, thinking: 1340, cacheRead: 4800, cacheWrite: 0, costUsd: 0.0521 },
      plan: null,
      hypotheses: [
        { id: 'H-001', claim: 'carrier.bin 0x21 处 %PDF-1.7 仅为单对象空壳', confidence: 0.96, supporting: ['ev_001', 'ev_002'], status: 'active', createdAt: now - 9000_000, updatedAt: now - 8900_000 },
        { id: 'H-002', claim: 'ZIP 标记为干扰项，真实 flag 在 artifact.txt Base64 中', confidence: 0.95, supporting: ['ev_005', 'ev_006'], status: 'revised', note: 'Revised after decoding artifact.txt', createdAt: now - 9000_000, updatedAt: now - 8850_000 },
      ],
      evidence: [
        { id: 'ev_001', source: 'ctf_triage', kind: 'tool_observation', view: 'static', summary: 'carrier.bin (121B): %PDF-1.7@0x21, PK\\x03\\x04@0x5f', excerpt: 'file=carrier.bin size=121 entropy=4.12', bytes: 121, createdAt: now - 9000_000 },
        { id: 'ev_002', source: 'carve_artifacts', kind: 'tool_observation', view: 'static', summary: 'PDF stub (60B) + incomplete ZIP header (26B)', excerpt: 'PDF: 1 0 obj << /Type /Catalog >> endobj %%EOF\nZIP: missing EOCD', bytes: 86, createdAt: now - 8960_000 },
        { id: 'ev_005', source: 'ctf_decode', kind: 'tool_observation', view: 'static', summary: 'base64 -> flag{demo_reverse_lab_flag}', excerpt: 'ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9 => flag{demo_reverse_lab_flag}', bytes: 27, createdAt: now - 8900_000 },
        { id: 'ev_006', source: 'verify_artifact', kind: 'verification_result', view: 'dynamic', summary: '2/2 assertions passed', excerpt: 'base64 round-trip exact match', verification: { build: false, passed: 2, total: 2, id: 'ev_006' }, supports: ['H-002'], bytes: 48, createdAt: now - 8850_000 },
      ],
      history: [
        makeLoopEvent({ type: 'user', text: 'Triage carrier.bin and carve embedded PDF/ZIP signatures' }),
        makeLoopEvent({
          type: 'reply',
          text: '## 历史复盘：reverse-lab\n\n已确认 `carrier.bin` 中的 `%PDF-1.7` 为单对象空壳、`PK\\x03\\x04` 缺少中央目录；真正的 Flag 位于伴生文件 `artifact.txt`：`flag{demo_reverse_lab_flag}`。',
          textChars: 120,
        }),
      ],
    },
  ]
}

// ---------- internal session state ----------

interface DemoSession {
  info: SessionInfo
  lifecycle: LifecycleState
  busy: boolean
  aborted: boolean
  abortNotify: (() => void) | null
  queue: string[]
  turn: number
  messages: number
  stage: FlowStage
  phaseText: string
  activeTool: string
  toolStartedAt: number
  toolsOk: number
  toolsFailed: number
  toolSeq: number
  toolRuns: ToolRunSnapshot[]
  plan: PlanSnapshot | null
  planKind: FlowDTO['planKind']
  re: ReDTO | null
  hypotheses: Hypothesis[]
  evidence: EvidenceRecord[]
  evSeq: number
  hypSeq: number
  usage: TokenUsage
  spark: number[]
  frame: number
  turnStartMs: number
  lastElapsedMs: number
  replyChars: number
  error: string
  ticker: ReturnType<typeof setInterval> | null
  pendingApprovalId: string | null
  gateResolve: ((decision: ApprovalDecision) => void) | null
  approvalMemory: Record<string, ApprovalDecision>
  planner: string
  executor: string
  researcher: string
  auditor: string
  activeSeatOverride: string
  maxTurns: number
  goalText: string
  goal: GoalSummaryDTO | null
  sandbox: SandboxDTO
  findings: FindingDTO[]
  caps: string[]
  closed: boolean
}

export class DemoBackend implements AppAPI {
  private sessions = new Map<string, DemoSession>()
  private savedSessions = makeSavedSessions()
  private shells = new DemoShellManager()
  private sessionSeq = 0
  private approvalSeq = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false

  /** Expose shell helper so Coach Bar can type commands into the live xterm shell. */
  typeInShell(shellId: string, command: string): void {
    this.shells.typeCommand(shellId, command)
  }

  /** Helper for Coach Bar auto-play when an approval dialog is open. */
  getPendingApproval(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.pendingApprovalId ?? null
  }

  /** Cleanly stop all timers, pending approvals, and simulated shells. */
  dispose(): void {
    this.disposed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const s of this.sessions.values()) {
      s.closed = true
      if (s.ticker) {
        clearInterval(s.ticker)
        s.ticker = null
      }
      if (s.gateResolve) {
        const res = s.gateResolve
        s.gateResolve = null
        res('deny')
      }
      if (s.abortNotify) {
        s.abortNotify()
      }
    }
    this.sessions.clear()
    this.shells.stopAll()
  }

  reset(): void {
    this.dispose()
    this.disposed = false
    this.sessionSeq = 0
    this.approvalSeq = 0
    this.savedSessions = makeSavedSessions()
    this.shells = new DemoShellManager()
  }

  // ---------- timers & emitters ----------

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t)
        resolve()
      }, ms)
      this.timers.add(t)
    })
  }

  private nap(s: DemoSession, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (s.aborted || s.closed || this.disposed) {
        resolve(true)
        return
      }
      let settled = false
      const finish = (aborted: boolean) => {
        if (settled) return
        settled = true
        if (s.abortNotify === onAbort) s.abortNotify = null
        resolve(aborted)
      }
      const t = setTimeout(() => {
        this.timers.delete(t)
        finish(false)
      }, ms)
      this.timers.add(t)
      const onAbort = () => {
        clearTimeout(t)
        this.timers.delete(t)
        finish(true)
      }
      s.abortNotify = onAbort
    })
  }

  private emitLoop(id: string, events: LoopEvent[]): void {
    if (this.disposed) return
    emitDemoGuiEvent({ sessionId: id, kind: 'loop', ts: Date.now(), data: events })
  }

  private emitTick(s: DemoSession): void {
    if (this.disposed) return
    emitDemoGuiEvent({ sessionId: s.info.id, kind: 'tick', ts: Date.now(), data: this.buildTick(s) })
  }

  private emitLifecycle(s: DemoSession, state: LifecycleState): void {
    s.lifecycle = state
    s.info = { ...s.info, lifecycle: state }
    if (this.disposed) return
    emitDemoGuiEvent({ sessionId: s.info.id, kind: 'lifecycle', ts: Date.now(), data: { state } })
  }

  private emitNotice(id: string, level: NoticeDTO['level'], text: string): void {
    if (this.disposed) return
    emitDemoGuiEvent({ sessionId: id, kind: 'notice', ts: Date.now(), data: { level, text } })
  }

  private buildPackets(stage: FlowStage, frame: number): number[][] {
    const p = (offset: number) => (frame + offset) % 16
    switch (stage) {
      case 'send':
        return [[p(0), p(8)], [p(4), p(12)], [], [], []]
      case 'wait':
      case 'think':
        return [[], [p(2)], [], [], []]
      case 'calls':
      case 'tool':
        return [[], [], [], [p(0), p(6), p(12)], []]
      case 'write':
        return [[], [], [], [p(4)], []]
      default:
        return [[], [], [], [], []]
    }
  }

  private buildTick(s: DemoSession): TickDTO {
    const elapsedMs = s.busy && s.turnStartMs > 0 ? Date.now() - s.turnStartMs : s.lastElapsedMs
    const activeProvider =
      s.activeSeatOverride ||
      (s.stage === 'tool' || s.stage === 'calls' ? s.executor : s.planner)
    const auditorName = s.auditor || s.researcher || 'glm-5.3'
    const planBadge = s.plan
      ? {
          done: s.plan.steps.filter((st) => st.status === 'completed').length,
          total: s.plan.steps.length,
          source: s.plan.source,
        }
      : null

    const flow: FlowDTO = {
      stage: s.stage,
      turn: s.turn,
      provider: activeProvider,
      model: modelForProvider(activeProvider),
      endpoint: 'demo://0xaf-sandbox',
      messages: s.messages,
      sentTokens: Math.round(s.usage.input),
      usage: { ...s.usage },
      pendingCalls: s.stage === 'calls' || s.stage === 'tool' ? 1 : 0,
      activeTool: s.activeTool,
      toolStartedAt: s.toolStartedAt,
      toolMs: s.toolRuns.length > 0 ? s.toolRuns[s.toolRuns.length - 1].ms : 0,
      toolsOk: s.toolsOk,
      toolsFailed: s.toolsFailed,
      toolRuns: s.toolRuns.slice(-8).map((r) => ({ ...r })),
      replyChars: s.replyChars,
      compactedDrop: 0,
      compactedElide: 0,
      hasCompacted: false,
      plan: planBadge,
      planKind: s.planKind,
      error: s.error,
      frame: s.frame,
      packets: this.buildPackets(s.stage, s.frame),
      since: s.turnStartMs || Date.now(),
    }

    const hud: HudDTO = {
      phase: s.phaseText,
      frame: s.busy ? SPIN_FRAMES[s.frame % SPIN_FRAMES.length] : '',
      elapsedMs,
      stats: { ...s.usage },
      spark: [...s.spark],
      route: {
        planner: s.planner,
        executor: s.executor,
        researcher: s.researcher,
        auditor: auditorName,
        active: activeProvider,
      },
      queueCount: s.queue.length,
      planDisplay: 'auto',
      thinkDisplay: 'auto',
    }

    const activeHypCount = s.hypotheses.filter((h) => h.status !== 'rejected').length

    return {
      flow,
      hud,
      re: s.re
        ? {
            ...s.re,
            hypotheses: s.hypotheses.length > 0 ? activeHypCount : s.re.hypotheses,
            evidence: s.evidence.length || s.re.evidence,
          }
        : null,
      plan: s.plan ? { ...s.plan, steps: s.plan.steps.map((st) => ({ ...st })) } : null,
      ledger: {
        hypotheses: s.hypotheses.map((h) => ({
          ...h,
          experiments: h.experiments ? h.experiments.map((ex) => ({ ...ex })) : undefined,
        })),
        evidence: s.evidence.map((ev) => ({ ...ev })),
        path: `${s.info.workspace}/sessions/evidence-ledger.jsonl (demo)`,
        auditorProvider: auditorName,
        goal: s.goal
          ? {
              ...s.goal,
              constraints: s.goal.constraints ? { ...s.goal.constraints } : undefined,
              criteria: s.goal.criteria.map((c) => ({ ...c })),
            }
          : null,
        sandbox: {
          ...s.sandbox,
          granted: [...s.sandbox.granted],
          recentActions: s.sandbox.recentActions.map((a) => ({ ...a })),
        },
        findings: s.findings.map((f) => ({ ...f })),
      },
    }
  }

  private recordSandboxAction(
    s: DemoSession,
    tool: string,
    subject: string,
    decision: 'granted' | 'denied',
    capability = '',
    origin = '',
  ): void {
    if (decision === 'granted') s.sandbox.grantedCount += 1
    else s.sandbox.deniedCount += 1
    s.sandbox.recentActions.push({
      at: Date.now(),
      tool,
      capability,
      subject,
      sha256: shortSha16(`${tool}:${subject}`),
      decision,
      origin,
    })
    if (s.sandbox.recentActions.length > 16) {
      s.sandbox.recentActions = s.sandbox.recentActions.slice(-16)
    }
  }

  private armGoalContract(s: DemoSession, targetFile: string, primary: string): void {
    s.goalText = primary
    s.sandbox.active = true
    s.goal = {
      primary,
      targetFile,
      accepted: true,
      constraints: {
        network: s.sandbox.granted.includes('network') ? 'allow' : 'deny',
        device: s.sandbox.device || 'none',
        filesystem: 'workspace-only',
      },
      criteria: [],
    }
    this.refreshGoalCriteria(s)
  }

  private refreshGoalCriteria(s: DemoSession): void {
    if (!s.goal) return
    const validEv = s.evidence.filter((e) => !e.isError).length
    const verEv = s.evidence.filter((e) => e.kind === 'verification_result' && !e.isError).length
    const audEv = s.evidence.filter((e) => e.kind === 'audit_finding' && !e.isError).length
    if (s.goal.constraints) {
      s.goal.constraints.network = s.sandbox.granted.includes('network') ? 'allow' : 'deny'
      s.goal.constraints.device = s.sandbox.device || 'none'
    }
    s.goal.criteria = [
      { label: '账本有效证据 ≥ 4', pass: validEv >= 4, detail: `${validEv}/4 records` },
      { label: '动态重放 verify_artifact ≥ 1', pass: verEv >= 1, detail: `${verEv}/1 verified` },
      { label: '独立对抗审计 audit_finding ≥ 1', pass: audEv >= 1, detail: `${audEv}/1 audited` },
    ]
  }

  private addEvidence(
    s: DemoSession,
    rec: Omit<EvidenceRecord, 'id' | 'createdAt' | 'bytes'> & { bytes?: number },
  ): EvidenceRecord {
    s.evSeq += 1
    const entry: EvidenceRecord = {
      id: `ev_${String(s.evSeq).padStart(3, '0')}`,
      createdAt: Date.now(),
      bytes: rec.bytes ?? (rec.excerpt?.length || rec.summary?.length || 0),
      ...rec,
    }
    s.evidence.push(entry)
    if (s.re) {
      s.re = { ...s.re, evidence: s.evidence.length }
    }
    this.refreshGoalCriteria(s)
    return entry
  }

  private upsertHypothesis(
    s: DemoSession,
    spec: {
      id?: string
      claim: string
      confidence: number
      status?: Hypothesis['status']
      supporting?: string[]
      contradicting?: string[]
      dependsOn?: string[]
      experiments?: HypothesisExperiment[]
      note?: string
    },
  ): Hypothesis {
    const now = Date.now()
    if (spec.id) {
      const existing = s.hypotheses.find((h) => h.id === spec.id)
      if (existing) {
        existing.claim = spec.claim
        existing.confidence = spec.confidence
        if (spec.status) existing.status = spec.status
        if (spec.supporting) {
          existing.supporting = Array.from(new Set([...(existing.supporting ?? []), ...spec.supporting]))
        }
        if (spec.contradicting) {
          existing.contradicting = Array.from(new Set([...(existing.contradicting ?? []), ...spec.contradicting]))
        }
        if (spec.dependsOn) {
          existing.dependsOn = Array.from(new Set([...(existing.dependsOn ?? []), ...spec.dependsOn]))
        }
        if (spec.experiments) {
          existing.experiments = spec.experiments
        }
        if (spec.note !== undefined) existing.note = spec.note
        existing.updatedAt = now
        if (s.re) s.re = { ...s.re, hypotheses: s.hypotheses.filter((h) => h.status !== 'rejected').length }
        return existing
      }
    }
    s.hypSeq += 1
    const hyp: Hypothesis = {
      id: spec.id ?? `H-${String(s.hypSeq).padStart(3, '0')}`,
      claim: spec.claim,
      confidence: spec.confidence,
      status: spec.status ?? 'active',
      supporting: spec.supporting,
      contradicting: spec.contradicting,
      dependsOn: spec.dependsOn,
      experiments: spec.experiments,
      note: spec.note,
      createdAt: now,
      updatedAt: now,
    }
    s.hypotheses.push(hyp)
    if (s.re) s.re = { ...s.re, hypotheses: s.hypotheses.filter((h) => h.status !== 'rejected').length }
    return hyp
  }

  private cascadeDependents(s: DemoSession, parentId: string): void {
    const queue = [parentId]
    const seen = new Set<string>([parentId])
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const h of s.hypotheses) {
        if (!seen.has(h.id) && h.dependsOn?.includes(cur)) {
          seen.add(h.id)
          if (h.status === 'active' || h.status === 'revised') {
            h.status = 'reevaluate'
            h.note = `父假设 ${cur} 已变更或淘汰，宿主自动触发依赖级联重查 (reevaluate)`
            h.updatedAt = Date.now()
          }
          queue.push(h.id)
        }
      }
    }
  }

  private evaluateSandboxCommand(s: DemoSession, cmd: string): { ok: boolean; stdout: string; deniedCap?: string } {
    const lower = cmd.toLowerCase().trim()
    // Gate 1 capability sandbox check
    if (s.sandbox.active) {
      const isNet = /\b(curl|wget|nc|netcat|ssh|scp|http:\/\/|https:\/\/)\b/.test(lower)
      if (isNet && !s.sandbox.granted.includes('network')) {
        return {
          ok: false,
          stdout: 'capability "network" denied by task sandbox (grant via /cap network on)',
          deniedCap: 'network',
        }
      }
      const isDev = /\b(adb|fastboot|frida|idevice|hdc)\b/.test(lower)
      if (isDev && !s.sandbox.granted.includes('device')) {
        return {
          ok: false,
          stdout: 'capability "device" denied by task sandbox (grant via /cap device on <id>)',
          deniedCap: 'device',
        }
      }
    }

    if (lower.includes('node') && lower.includes('chall.js')) {
      if (lower.includes('0xaf{warmup_deck}')) {
        return { ok: true, stdout: 'accepted' }
      }
      return { ok: true, stdout: 'rejected' }
    }
    if (lower.includes('unzip') && lower.includes('carrier.bin')) {
      return {
        ok: false,
        stdout: 'End-of-central-directory signature not found (truncated PK_0x5f decoy)',
      }
    }
    if (lower.includes('gzip') && lower.includes('carrier.bin')) {
      return {
        ok: false,
        stdout: 'gzip: carrier.bin: not in gzip format (magic 0x6361 != 0x1f8b)',
      }
    }
    if (lower.includes('strings') && lower.includes('carrier.bin')) {
      return {
        ok: true,
        stdout: 'carrier-prefix\n%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\ndemo zip marker',
      }
    }
    if ((lower.includes('base64') || lower.includes('decode')) && (lower.includes('artifact.txt') || lower.includes('zmxhz3'))) {
      return { ok: true, stdout: 'flag{demo_reverse_lab_flag}' }
    }
    if (lower.includes('sha256') || lower.includes('shasum')) {
      return {
        ok: true,
        stdout: `${shortSha16(cmd)}${shortSha16(s.info.workspace)}  ${cmd.split(/\s+/).pop() || 'target'}`,
      }
    }
    return {
      ok: true,
      stdout: `[sandbox-exec] ${cmd} -> exit=0 (verified in ${s.info.workspace})`,
    }
  }

  private startTicker(s: DemoSession): void {
    if (s.ticker) return
    s.ticker = setInterval(() => {
      if (this.disposed || s.closed) {
        this.stopTicker(s)
        return
      }
      s.frame += 1
      if (s.busy && s.lifecycle === 'running') {
        const bump = s.stage === 'write' ? 42 : s.stage === 'think' ? 28 : s.stage === 'tool' ? 12 : 8
        s.usage.output += bump
        if (s.stage === 'think') s.usage.thinking += bump
        s.usage.costUsd = Number(((s.usage.input * 0.000003 + s.usage.output * 0.000015)).toFixed(4))
        if (s.frame % 3 === 0) {
          s.spark.push(bump * 3 + (s.frame % 17))
          if (s.spark.length > 16) s.spark.shift()
        }
      }
      this.emitTick(s)
    }, 90)
  }

  private stopTicker(s: DemoSession): void {
    if (s.ticker) {
      clearInterval(s.ticker)
      s.ticker = null
    }
  }

  /** Pre-seed a realistic mid-flight session (used by Case 3 android-sign). */
  seedPreset(sessionId: string, preset: 'android-sign-ready'): void {
    const s = this.sessions.get(sessionId)
    if (!s || preset !== 'android-sign-ready') return
    s.turn = 2
    s.messages = 4
    s.stage = 'done'
    s.phaseText = 'idle'
    s.toolsOk = 3
    s.usage = { input: 9420, output: 1860, thinking: 1120, cacheRead: 4200, cacheWrite: 0, costUsd: 0.0442 }
    s.spark = [12, 24, 38, 62, 54, 48, 70, 86, 44, 28, 16]
    s.lastElapsedMs = 3840
    s.re = { sampleType: 'apk', phase: 'static', phaseIndex: 1, phaseCount: 9, hypotheses: 1, evidence: 3 }
    s.toolRuns = [
      {
        id: 1,
        name: 'apk_inspect',
        argsText: 'app-release.apk',
        preview: 'pkg=com.example.auth minSdk=24 libs=[arm64-v8a/libnative-sign.so]',
        status: 'done',
        startedAt: Date.now() - 8000,
        finishedAt: Date.now() - 7780,
        ms: 220,
        ok: true,
      },
      {
        id: 2,
        name: 'binary_inspect',
        argsText: 'libnative-sign.so',
        preview: 'ELF64 AArch64 · JNI_OnLoad@0x8e10 · .init_array(2) · stripped',
        status: 'done',
        startedAt: Date.now() - 7600,
        finishedAt: Date.now() - 7430,
        ms: 170,
        ok: true,
      },
      {
        id: 3,
        name: 'anti_analysis',
        argsText: 'libnative-sign.so',
        preview: 'anti-Frida: /proc/self/maps + frida-agent string match',
        status: 'done',
        startedAt: Date.now() - 7300,
        finishedAt: Date.now() - 7190,
        ms: 110,
        ok: true,
      },
    ]
    s.plan = {
      source: 'agent',
      note: 'Awaiting dynamic hook / Frida bypass',
      updatedAt: Date.now() - 6000,
      steps: makePlanSteps([
        { text: 'Parse APK manifest & extract libnative-sign.so', status: 'completed' },
        { text: 'Locate JNI_OnLoad & anti-Frida checks', status: 'completed' },
        { text: 'Trace HMAC-SHA256 signing input in sub_8f4c', status: 'in_progress' },
      ]),
    }
    this.addEvidence(s, {
      source: 'apk_inspect',
      kind: 'tool_observation',
      view: 'static',
      summary: 'pkg=com.example.auth · arm64-v8a/libnative-sign.so',
      excerpt: 'AndroidManifest: minSdk=24 targetSdk=34\nNative libs: lib/arm64-v8a/libnative-sign.so',
      artifact: 'app-release.apk',
    })
    this.addEvidence(s, {
      source: 'binary_inspect',
      kind: 'tool_observation',
      view: 'static',
      summary: 'ELF64 AArch64 · JNI_OnLoad@0x8e10 · .init_array(2)',
      excerpt: 'Exports: JNI_OnLoad (0x8e10) -> RegisterNatives -> sub_8f4c',
      artifact: 'libnative-sign.so',
    })
    this.addEvidence(s, {
      source: 'anti_analysis',
      kind: 'tool_observation',
      view: 'static',
      summary: 'anti-Frida: /proc/self/maps + frida-agent string match',
      excerpt: '[MED] /proc/self/maps scan + frida-agent string in .rodata+0x1240',
      artifact: 'libnative-sign.so',
    })
    this.upsertHypothesis(s, {
      id: 'H-001',
      claim: '签名核心位于 libnative-sign.so 的 sub_8f4c，并在进入前检查 /proc/self/maps 反 Frida',
      confidence: 0.82,
      supporting: ['ev_001', 'ev_002', 'ev_003'],
      status: 'active',
    })
    this.emitLoop(sessionId, [
      makeLoopEvent({ type: 'user', text: '对 app-release.apk 做初筛，定位签名校验所在的 native 库与保护特征' }),
      makeLoopEvent({
        type: 'tool_end',
        name: 'apk_inspect',
        ok: true,
        ms: 220,
        preview: 'pkg=com.example.auth libs=[arm64-v8a/libnative-sign.so]',
      }),
      makeLoopEvent({
        type: 'tool_end',
        name: 'anti_analysis',
        ok: true,
        ms: 110,
        preview: 'detected /proc/self/maps + frida-agent check',
      }),
      makeLoopEvent({
        type: 'reply',
        text: '### Android Sign 初筛结论\n\n- **目标库**：`lib/arm64-v8a/libnative-sign.so`（ELF64 AArch64，已去符号）\n- **入口绑定**：`JNI_OnLoad@0x8e10` 动态注册 `com.example.auth.Signer.signPayload`\n- **保护特征**：`anti_analysis` 命中 `/proc/self/maps` 扫描与 `frida-agent` 字符串检测\n- **已登记假设**：`H-001` 签名核心在 `sub_8f4c`（已采集 `E:3` 静态证据，当前阶段 `STA`）',
        textChars: 228,
        usage: s.usage,
      }),
    ])
    this.emitTick(s)
  }

  // ---------- AppAPI implementation ----------

  async StartSession(opts: StartOptions): Promise<SessionInfo> {
    await this.delay(35)
    this.sessionSeq += 1
    const id = `demo-${this.sessionSeq}`
    const workspace = opts.workspace?.trim() || '/demo/welcome'
    const workflow = opts.workflow?.trim() || 'auto'
    const info: SessionInfo = {
      id,
      workspace,
      role: opts.role?.trim() || 'auto',
      workflow,
      planner: 'codex-sol',
      executor: 'ds',
      lifecycle: 'idle',
    }
    const s: DemoSession = {
      info,
      lifecycle: 'idle',
      busy: false,
      aborted: false,
      abortNotify: null,
      queue: [],
      turn: 0,
      messages: 0,
      stage: 'idle',
      phaseText: 'idle',
      activeTool: '',
      toolStartedAt: 0,
      toolsOk: 0,
      toolsFailed: 0,
      toolSeq: 0,
      toolRuns: [],
      plan: null,
      planKind: '',
      re:
        workflow === 'reverse'
          ? { sampleType: 'generic', phase: 'triage', phaseIndex: 0, phaseCount: 9, hypotheses: 0, evidence: 0 }
          : null,
      hypotheses: [],
      evidence: [],
      evSeq: 0,
      hypSeq: 0,
      usage: zeroUsage(),
      spark: [],
      frame: 0,
      turnStartMs: 0,
      lastElapsedMs: 0,
      replyChars: 0,
      error: '',
      ticker: null,
      pendingApprovalId: null,
      gateResolve: null,
      approvalMemory: {},
      planner: 'codex-sol',
      executor: 'ds',
      researcher: 'gemini-4-carbon',
      auditor: 'glm-5.3',
      activeSeatOverride: '',
      maxTurns: 30,
      goalText: '',
      goal: null,
      sandbox: {
        active: false,
        granted: [],
        device: '',
        grantedCount: 0,
        deniedCount: 0,
        recentActions: [],
      },
      findings: [],
      caps: [],
      closed: false,
    }
    this.sessions.set(id, s)
    emitDemoSignal({ type: 'session_started', sessionId: id, workspace })
    this.emitLifecycle(s, 'idle')
    this.emitTick(s)
    return info
  }

  async ResumeSession(id: string): Promise<SessionInfo> {
    await this.delay(50)
    const saved = this.savedSessions.find((x) => x.summary.id === id)
    if (!saved) throw new Error(`no saved demo session: ${id}`)
    const info = await this.StartSession({
      workspace: saved.summary.workspace,
      role: 'auto',
      workflow: saved.workflow,
      mock: true,
    })
    const s = this.sessions.get(info.id)!
    s.re = saved.re ? { ...saved.re } : null
    s.plan = saved.plan ? { ...saved.plan, steps: saved.plan.steps.map((st) => ({ ...st })) } : null
    s.hypotheses = saved.hypotheses.map((h) => ({ ...h }))
    s.evidence = saved.evidence.map((ev) => ({ ...ev }))
    s.hypSeq = s.hypotheses.length
    s.evSeq = s.evidence.length
    s.usage = { ...saved.usage }
    s.messages = saved.summary.messages
    s.turn = 2
    s.stage = 'done'
    s.spark = [14, 28, 42, 55, 39, 64, 48, 22]
    s.lastElapsedMs = 4120
    this.emitTick(s)
    this.emitNotice(info.id, 'info', `resumed ${saved.summary.hash} (${saved.summary.messages} msgs · ledger & sandbox hydrated)`)
    emitDemoSignal({ type: 'session_resumed', sessionId: info.id, workspace: info.workspace })
    return { ...info, history: saved.history }
  }

  async ListSessions(): Promise<SessionSummaryDTO[]> {
    await this.delay(30)
    return this.savedSessions.map((x) => ({ ...x.summary }))
  }

  async CloseSession(id: string): Promise<void> {
    await this.delay(25)
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    s.closed = true
    s.aborted = true
    if (s.gateResolve) {
      const res = s.gateResolve
      s.gateResolve = null
      res('deny')
    }
    if (s.abortNotify) s.abortNotify()
    this.stopTicker(s)
    this.emitLifecycle(s, 'closed')
    this.sessions.delete(id)
  }

  async SendPrompt(id: string, text: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    const trimmed = text.trim()
    if (!trimmed) throw new Error('empty prompt')
    if (s.busy) {
      s.queue.push(trimmed)
      this.emitNotice(id, 'info', `queued #${s.queue.length} for the next turn`)
      this.emitTick(s)
      emitDemoSignal({ type: 'prompt_sent', sessionId: id, text: trimmed, queued: true })
      return
    }
    emitDemoSignal({ type: 'prompt_sent', sessionId: id, text: trimmed, queued: false })
    void this.drainTurns(s, trimmed)
  }

  async Interrupt(id: string): Promise<boolean> {
    const s = this.sessions.get(id)
    if (!s || !s.busy) return false
    s.aborted = true
    if (s.gateResolve) {
      const res = s.gateResolve
      s.gateResolve = null
      res('deny')
    }
    if (s.abortNotify) s.abortNotify()
    emitDemoSignal({ type: 'interrupted', sessionId: id })
    return true
  }

  async Approve(id: string, requestID: string, decision: ApprovalDecision): Promise<void> {
    const s = this.sessions.get(id)
    if (!s || s.pendingApprovalId !== requestID || !s.gateResolve) {
      throw new Error(`no pending approval ${requestID}`)
    }
    s.pendingApprovalId = null
    const res = s.gateResolve
    s.gateResolve = null
    emitDemoSignal({ type: 'approval_decided', sessionId: id, decision })
    res(decision)
  }

  async GetState(id: string): Promise<TickDTO> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    return this.buildTick(s)
  }

  async GetSettings(id: string): Promise<SettingsDTO> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    return {
      role: s.info.role || 'auto',
      provider: '',
      plannerProvider: s.planner,
      executorProvider: s.executor,
      researcherProvider: s.researcher,
      auditProvider: s.auditor,
      providerNames: ['codex-sol', 'gemini-4-carbon', 'ds', 'gemini-4-neon', 'glm-5.3-flash', 'glm-5.3', 'mock'],
      providers: [
        { name: 'codex-sol', model: 'codex sol', type: 'openai-responses' },
        { name: 'gemini-4-carbon', model: 'gemini 4 carbon', type: 'openai-chat' },
        { name: 'ds', model: 'deepseek-chat (ds)', type: 'openai-chat' },
        { name: 'gemini-4-neon', model: 'gemini 4 neon', type: 'openai-chat' },
        { name: 'glm-5.3-flash', model: 'glm-5.3-flash', type: 'openai-chat' },
        { name: 'glm-5.3', model: 'glm-5.3', type: 'openai-chat' },
        { name: 'mock', model: 'demo-sandbox-1', type: 'mock' },
      ],
      maxTurns: s.maxTurns,
      compactionStrategy: 'summary',
      mcpServerCount: 2,
    }
  }

  async SetSettings(id: string, patch: SettingsPatch): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    if (patch.maxTurns !== 0 && (patch.maxTurns < 1 || patch.maxTurns > 200)) {
      throw new Error(`maxTurns ${patch.maxTurns} out of range (1-200)`)
    }
    if (patch.plannerProvider) s.planner = patch.plannerProvider
    if (patch.executorProvider) s.executor = patch.executorProvider
    if (patch.researcherProvider) s.researcher = patch.researcherProvider
    if (patch.auditProvider && patch.auditProvider !== 'auto') s.auditor = patch.auditProvider
    if (patch.maxTurns) s.maxTurns = patch.maxTurns
    s.info = { ...s.info, planner: s.planner, executor: s.executor }
    this.emitTick(s)
    this.emitNotice(
      id,
      'info',
      `settings updated · planner=${s.planner} executor=${s.executor} auditor=${s.auditor} maxTurns=${s.maxTurns}`,
    )
    emitDemoSignal({ type: 'settings_saved', sessionId: id })
  }

  async MutateHypothesis(id: string, req: HypothesisMutationDTO): Promise<Hypothesis> {
    await this.delay(35)
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)

    const evIds = (req.evidenceIds ?? []).map((x) => x.trim()).filter(Boolean)
    for (const eid of evIds) {
      if (!s.evidence.some((e) => e.id === eid)) {
        throw new Error(`证据账本中不存在 ${eid}（证据不可凭空填写，仅可引用已实跑入账的 ev_NNN）`)
      }
    }
    const deps = (req.dependsOn ?? []).map((x) => x.trim()).filter(Boolean)
    for (const dep of deps) {
      if (dep === req.id) throw new Error(`假设 ${dep} 不能依赖自身`)
      if (!s.hypotheses.some((h) => h.id === dep)) {
        throw new Error(`未知的上游依赖假设: ${dep}`)
      }
    }

    if (req.action === 'create') {
      const claim = (req.claim ?? '').trim()
      if (!claim) throw new Error('假设声明不能为空')
      const exps: HypothesisExperiment[] = []
      if (req.expCommand?.trim()) {
        exps.push({
          id: 'exp_01',
          title: req.expTitle?.trim() || req.expCommand.trim(),
          command: req.expCommand.trim(),
          expected: req.expExpected?.trim(),
          status: 'planned',
        })
      }
      const created = this.upsertHypothesis(s, {
        claim,
        confidence: Math.max(0.05, Math.min(0.99, req.confidence ?? 0.75)),
        supporting: evIds.length > 0 ? evIds : undefined,
        dependsOn: deps.length > 0 ? deps : undefined,
        experiments: exps.length > 0 ? exps : undefined,
        note: req.note?.trim() || undefined,
      })
      if (created.confidence >= 0.8 && (!created.supporting || created.supporting.length === 0)) {
        s.findings.push({
          rule: 'single-view',
          hypothesisId: created.id,
          applied: false,
          action: 'challenge',
          message: `${created.id} 初始置信度 ≥ 80% 但尚未绑定实跑证据，建议运行实验验证`,
        })
      }
      this.emitNotice(id, 'info', `created hypothesis ${created.id} (${Math.round(created.confidence * 100)}%)`)
      this.emitTick(s)
      return { ...created }
    }

    const hyp = s.hypotheses.find((h) => h.id === req.id)
    if (!hyp) throw new Error(`unknown hypothesis: ${req.id}`)

    if (req.action === 'add_experiment') {
      const cmd = (req.expCommand ?? '').trim()
      if (!cmd) throw new Error('实验命令不能为空')
      const nextExps = [...(hyp.experiments ?? [])]
      const exp: HypothesisExperiment = {
        id: `exp_${String(nextExps.length + 1).padStart(2, '0')}`,
        title: req.expTitle?.trim() || cmd,
        command: cmd,
        expected: req.expExpected?.trim(),
        status: 'planned',
      }
      nextExps.push(exp)
      hyp.experiments = nextExps
      hyp.updatedAt = Date.now()
      this.emitNotice(id, 'info', `added planned experiment ${exp.id} on ${hyp.id}`)
      this.emitTick(s)
      return { ...hyp, experiments: [...nextExps] }
    }

    if (req.action === 'revise') {
      if (req.claim?.trim()) hyp.claim = req.claim.trim()
      if (req.confidence !== undefined) hyp.confidence = Math.max(0.05, Math.min(0.99, req.confidence))
      if (req.dependsOn) hyp.dependsOn = deps
      if (req.note !== undefined) hyp.note = req.note.trim()
      hyp.status = 'revised'
      hyp.updatedAt = Date.now()
      this.cascadeDependents(s, hyp.id)
    } else if (req.action === 'reject') {
      hyp.status = 'rejected'
      if (req.note?.trim()) hyp.note = req.note.trim()
      hyp.updatedAt = Date.now()
      this.cascadeDependents(s, hyp.id)
    } else if (req.action === 'support') {
      hyp.supporting = Array.from(new Set([...(hyp.supporting ?? []), ...evIds]))
      if (req.note?.trim()) hyp.note = req.note.trim()
      hyp.updatedAt = Date.now()
    } else if (req.action === 'challenge') {
      const prev = new Set(hyp.contradicting ?? [])
      let challenged = false
      for (const eid of evIds) {
        if (!prev.has(eid)) {
          prev.add(eid)
          challenged = true
        }
      }
      hyp.contradicting = Array.from(prev)
      if (challenged) {
        hyp.confidence = Number((hyp.confidence * 0.5).toFixed(2))
        if (hyp.confidence < 0.25 && hyp.status === 'active') {
          hyp.status = 'reevaluate'
          this.cascadeDependents(s, hyp.id)
        }
      }
      if (req.note?.trim()) hyp.note = req.note.trim()
      hyp.updatedAt = Date.now()
    } else if (req.action === 'meta') {
      if (req.confidence !== undefined) hyp.confidence = Math.max(0.05, Math.min(0.99, req.confidence))
      if (req.dependsOn) hyp.dependsOn = deps
      if (req.note !== undefined) hyp.note = req.note.trim()
      hyp.updatedAt = Date.now()
    }

    if (s.re) {
      s.re = { ...s.re, hypotheses: s.hypotheses.filter((h) => h.status !== 'rejected').length }
    }
    this.emitNotice(id, 'info', `updated hypothesis ${hyp.id} (${req.action} → ${hyp.status})`)
    this.emitTick(s)
    return { ...hyp }
  }

  async RunHypothesisExperiment(id: string, req: RunExperimentDTO): Promise<EvidenceRecord> {
    await this.delay(160)
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    const hyp = s.hypotheses.find((h) => h.id === req.hypothesisId)
    if (!hyp) throw new Error(`unknown hypothesis: ${req.hypothesisId}`)

    const exps = [...(hyp.experiments ?? [])]
    let exp = req.experimentId ? exps.find((x) => x.id === req.experimentId) : undefined
    if (!exp) {
      const cmd = (req.command ?? '').trim()
      if (!cmd) throw new Error('实验命令不能为空')
      exp = {
        id: `exp_${String(exps.length + 1).padStart(2, '0')}`,
        title: req.title?.trim() || cmd,
        command: cmd,
        expected: req.expected?.trim(),
        status: 'planned',
      }
      exps.push(exp)
      hyp.experiments = exps
    }

    const evalRes = this.evaluateSandboxCommand(s, exp.command)
    if (evalRes.deniedCap) {
      this.recordSandboxAction(s, 'run_command', exp.command, 'denied', evalRes.deniedCap, 'task-sandbox')
      s.toolsFailed += 1
    } else {
      if (s.sandbox.active) {
        this.recordSandboxAction(s, 'run_command', exp.command, 'granted', '', 'workspace-local')
      }
      if (evalRes.ok) s.toolsOk += 1
      else s.toolsFailed += 1
    }

    const want = (exp.expected ?? '').trim()
    const matched =
      evalRes.ok && (!want || evalRes.stdout.toLowerCase().includes(want.toLowerCase()))

    const ev = this.addEvidence(s, {
      source: evalRes.deniedCap ? 'sandbox:run_command' : 'experiment:run_command',
      kind: 'runtime_trace',
      view: 'dynamic',
      isError: !evalRes.ok,
      sha256: `${shortSha16(exp.command)}${shortSha16(evalRes.stdout)}`,
      summary: `实验 ${exp.id} (${exp.command}) → ${evalRes.stdout.replace(/\s+/g, ' ').slice(0, 76)}`,
      excerpt: `$ ${exp.command}\n${evalRes.stdout}`,
      supports: matched ? [hyp.id] : undefined,
      contradicts: !matched && !evalRes.deniedCap ? [hyp.id] : undefined,
    })

    exp.evidenceId = ev.id
    exp.actual = evalRes.stdout
    exp.ranAt = Date.now()

    if (evalRes.deniedCap) {
      exp.status = 'error'
    } else if (matched) {
      exp.status = 'passed'
      hyp.supporting = Array.from(new Set([...(hyp.supporting ?? []), ev.id]))
      hyp.confidence = Math.min(0.98, Number((hyp.confidence + 0.08).toFixed(2)))
      hyp.note = `实验 ${exp.id} 实测命中预期 (${ev.id})`
    } else {
      exp.status = 'falsified'
      hyp.contradicting = Array.from(new Set([...(hyp.contradicting ?? []), ev.id]))
      hyp.confidence = Number((hyp.confidence * 0.5).toFixed(2))
      hyp.note = `实验 ${exp.id} 实测输出与预期 "${want}" 矛盾 (${ev.id})，宿主强制置信度折半`
      if (hyp.confidence < 0.25 && hyp.status === 'active') {
        hyp.status = 'reevaluate'
        this.cascadeDependents(s, hyp.id)
      }
      s.findings.push({
        rule: 'runtime-contradiction',
        hypothesisId: hyp.id,
        evidenceId: ev.id,
        applied: true,
        action: 'challenge',
        message: `实验 ${exp.id} 实跑证据 ${ev.id} 证伪 ${hyp.id}，置信度已自动折半至 ${Math.round(hyp.confidence * 100)}%`,
      })
    }
    hyp.updatedAt = Date.now()

    this.emitLoop(id, [
      makeLoopEvent({
        type: 'tool_end',
        provider: s.executor,
        model: modelForProvider(s.executor),
        name: 'experiment:run_command',
        ok: evalRes.ok,
        ms: 142,
        preview: `[${ev.id}] ${exp.command} -> ${exp.status.toUpperCase()}`,
        error: evalRes.ok ? '' : evalRes.stdout,
      }),
    ])
    this.emitNotice(
      id,
      evalRes.ok ? 'info' : 'error',
      `experiment ${exp.id} (${hyp.id}) → ${exp.status.toUpperCase()} · minted immutable ${ev.id}`,
    )
    this.emitTick(s)
    return { ...ev }
  }

  async RunVerification(id: string, req: VerificationRequestDTO): Promise<EvidenceRecord> {
    await this.delay(180)
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    if (!req.artifact.trim() || req.cases.length === 0) {
      throw new Error('请提供目标产物路径与至少一条重放测试用例')
    }

    let passed = 0
    const lines: string[] = []
    for (const c of req.cases) {
      const res = this.evaluateSandboxCommand(s, c.command)
      const ok = res.ok && (!c.expected.trim() || res.stdout.toLowerCase().includes(c.expected.trim().toLowerCase()))
      if (ok) passed += 1
      lines.push(
        `case "${c.name}": ${ok ? 'PASS' : 'FAIL'} | cmd="${c.command}" | expected="${c.expected}" | actual="${res.stdout.replace(/\s+/g, ' ').slice(0, 60)}"`,
      )
    }
    const total = req.cases.length
    const allPass = passed === total
    if (s.sandbox.active) {
      this.recordSandboxAction(s, 'verify_artifact', req.artifact, 'granted', '', 'workspace-local')
    }
    if (allPass) s.toolsOk += 1
    else s.toolsFailed += 1

    const sha = `${shortSha16(req.artifact)}${shortSha16(lines.join('|'))}`
    const ev = this.addEvidence(s, {
      source: 'verify_artifact',
      kind: 'verification_result',
      view: 'dynamic',
      isError: !allPass,
      artifact: req.artifact.trim(),
      sha256: sha,
      verification: { build: true, passed, total },
      summary: `verify_artifact(${req.artifact}) → ${passed}/${total} passed`,
      excerpt: lines.join('\n'),
      supports: allPass && req.hypothesisId ? [req.hypothesisId] : undefined,
      contradicts: !allPass && req.hypothesisId ? [req.hypothesisId] : undefined,
    })
    if (ev.verification) ev.verification.id = ev.id

    if (req.hypothesisId) {
      const hyp = s.hypotheses.find((h) => h.id === req.hypothesisId)
      if (hyp) {
        if (allPass) {
          hyp.supporting = Array.from(new Set([...(hyp.supporting ?? []), ev.id]))
          hyp.confidence = Math.min(0.99, Number((hyp.confidence + 0.06).toFixed(2)))
        } else {
          hyp.contradicting = Array.from(new Set([...(hyp.contradicting ?? []), ev.id]))
          hyp.confidence = Number((hyp.confidence * 0.5).toFixed(2))
        }
        hyp.updatedAt = Date.now()
      }
    }

    this.emitLoop(id, [
      makeLoopEvent({
        type: 'tool_end',
        provider: s.executor,
        model: modelForProvider(s.executor),
        name: 'verify_artifact',
        ok: allPass,
        ms: 168,
        preview: `[${ev.id}] ${req.artifact}: ${passed}/${total} cases passed`,
      }),
    ])
    this.emitNotice(id, allPass ? 'info' : 'error', `verify_artifact minted immutable ${ev.id} (${passed}/${total} passed)`)
    this.emitTick(s)
    return { ...ev }
  }

  async SubmitReview(id: string, req: ReviewRequestDTO): Promise<ReviewResultDTO> {
    await this.delay(90)
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)

    if (req.mode === 'model_audit') {
      await this.SendCommand(id, '/audit')
      const lastAud = [...s.evidence].reverse().find((e) => e.kind === 'audit_finding') ?? null
      return { auditRecord: lastAud, findings: s.findings.map((f) => ({ ...f })) }
    }

    if (req.mode === 'arbitrate') {
      // Run deterministic check across current hypotheses & evidence
      for (const h of s.hypotheses) {
        if (h.status === 'rejected') continue
        const sup = h.supporting ?? []
        const views = new Set(
          sup
            .map((eid) => s.evidence.find((e) => e.id === eid)?.view || 'static')
            .filter(Boolean),
        )
        if (h.confidence >= 0.8 && views.size <= 1) {
          const exists = s.findings.some((f) => f.rule === 'single-view' && f.hypothesisId === h.id)
          if (!exists) {
            s.findings.push({
              rule: 'single-view',
              hypothesisId: h.id,
              evidenceId: sup[0],
              applied: false,
              action: 'challenge',
              message: `${h.id} (${Math.round(h.confidence * 100)}%) 仅靠单一视角支撑，建议补充异构动态实验`,
            })
          }
        }
      }
      this.emitNotice(id, 'info', `arbitrator review complete (${s.findings.length} total findings)`)
      this.emitTick(s)
      return { findings: s.findings.map((f) => ({ ...f })) }
    }

    // mode === 'operator_audit'
    const cited = (req.citedEvidence ?? []).filter((eid) => s.evidence.some((e) => e.id === eid))
    if (s.evidence.length === 0 || cited.length === 0) {
      throw new Error('签发审查结论必须至少引用一条已实跑入账的 ev_NNN 证据')
    }
    const cleanSummary = (req.summary ?? '').trim()
    if (!cleanSummary) throw new Error('审查结论摘要不能为空')

    if (req.hypothesisId && req.verdict) {
      await this.MutateHypothesis(id, {
        action: req.verdict,
        id: req.hypothesisId,
        evidenceIds: cited,
        note: cleanSummary,
      })
    }

    const excerpt = `[operator-review] cites=${cited.join(',')}${req.hypothesisId ? ` target=${req.hypothesisId} verdict=${(req.verdict || 'NOTE').toUpperCase()}` : ''} — ${cleanSummary}`
    const audEv = this.addEvidence(s, {
      source: 'review:operator',
      kind: 'audit_finding',
      view: 'static',
      summary: `专家复核签章: ${cleanSummary}`,
      excerpt,
      supports: req.verdict === 'support' && req.hypothesisId ? [req.hypothesisId] : cited,
    })
    s.findings.push({
      rule: 'operator-review',
      hypothesisId: req.hypothesisId || 'ALL',
      evidenceId: audEv.id,
      action: req.verdict || 'support',
      applied: Boolean(req.hypothesisId && req.verdict),
      message: cleanSummary,
    })
    this.emitNotice(id, 'info', `operator audit finding stamped → ${audEv.id}`)
    this.emitTick(s)
    return { auditRecord: { ...audEv }, findings: s.findings.map((f) => ({ ...f })) }
  }

  async Completions(line: string): Promise<string[]> {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('/')) return []
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('/theme ')) {
      const arg = lower.slice('/theme '.length)
      return THEME_NAMES.filter((t) => t.startsWith(arg)).map((t) => `/theme ${t}`)
    }
    if (lower.startsWith('/workflow ')) {
      const arg = lower.slice('/workflow '.length)
      const modes = ['off', 'auto', 'ctf', 'reverse', 'research', 'writeup', 'specialist']
      return modes.filter((m) => m.startsWith(arg)).map((m) => `/workflow ${m}`)
    }
    if (lower.startsWith('/phase ')) {
      const arg = lower.slice('/phase '.length)
      const opts = ['next', ...PHASES]
      return opts.filter((p) => p.startsWith(arg)).map((p) => `/phase ${p}`)
    }
    if (lower.startsWith('/decode ')) {
      const rest = lower.slice('/decode '.length)
      if (!rest.includes(' ')) {
        return ['base64', 'hex', 'url', 'rot13', 'xor']
          .filter((c) => c.startsWith(rest))
          .map((c) => `/decode ${c} `)
      }
      return []
    }
    if (trimmed.includes(' ')) return []
    const hits = COMMAND_COMPLETIONS.filter((c) => c.startsWith(lower))
    return hits.length > 0 ? hits : COMMAND_COMPLETIONS
  }

  async GetThemes(): Promise<string[]> {
    return [...THEME_NAMES]
  }

  async RESampleTypes(): Promise<RESampleType[]> {
    return SAMPLE_TYPES
  }

  async HomeDir(): Promise<string> {
    return '/demo/welcome'
  }

  async PickDirectory(): Promise<string> {
    return '/demo/reverse-lab'
  }

  async ShellStart(cwd: string): Promise<ShellInfo> {
    return this.shells.start(cwd)
  }

  async ShellWrite(id: string, data: string): Promise<void> {
    this.shells.write(id, data)
  }

  async ShellResize(): Promise<void> {}

  async ShellStop(id: string): Promise<void> {
    this.shells.stop(id)
  }

  async ShellList(): Promise<ShellInfo[]> {
    return this.shells.list()
  }

  // ---------- slash commands ----------

  async SendCommand(id: string, line: string): Promise<CommandResultDTO> {
    await this.delay(35)
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session: ${id}`)
    const trimmed = line.trim()
    const parts = trimmed.split(/\s+/)
    const cmd = (parts[0] || '').toLowerCase()
    const arg = trimmed.slice(parts[0]?.length ?? 0).trim()
    const notices: NoticeDTO[] = []

    const info = (text: string) => notices.push({ level: 'info', text })
    const err = (text: string) => notices.push({ level: 'error', text })

    let ok = true
    switch (cmd) {
      case '/help':
        info('0xAF-Re 命令速查（演示环境）:')
        info('  /workflow reverse [apk|so|elf|firmware…]   进入 9 阶段逆向工作流')
        info('  /phase [next|writeup]                      查看或推进 RE 阶段')
        info('  /scan <file> · /inspect <bin> · /anti <bin> · /entropy <file>   直调纯 Go 分析工具')
        info('  /decode <base64|hex|rot13|url> <payload>   本地直调解码器')
        info('  /goal <desc> · /cap <grant> · /audit       任务契约 · 能力沙箱 · 对抗审计')
        info('  /theme <deck|amber|matrix|mono>            切换 CRT 荧光主题')
        break

      case '/tools':
        info('34 built-in tools ready:')
        info('  files: list_files · read_file · write_file · grep')
        info('  binary (pure-Go): file_info · strings · hexdump · hash_file · extract_symbols · binary_inspect · anti_analysis · binary_diff · binary_mitigations')
        info('  ctf/fw: ctf_triage · ctf_decode · entropy_scan · find_bytes · carve_artifacts · apk_inspect')
        info('  metacognition: update_plan · hypothesis_create/update/list · verify_artifact · evidence_review · update_re_state')
        break

      case '/skills':
        info('Loaded 28 built-in RE skills: ctf-first-pass · analyze-so · android-apk-frida · frida-hook-workflow · ollvm-deobfuscation · jsvmp-analysis · ghidra · radare2-reverse · unicorn-emulator · vmp-restore …')
        break

      case '/providers':
        info(
          `planner=${s.planner} (${modelForProvider(s.planner)}) · executor=${s.executor} (${modelForProvider(s.executor)}) · auditor=${s.auditor} (${modelForProvider(s.auditor)}) · researcher=${s.researcher}`,
        )
        break

      case '/planner':
        if (arg) {
          s.planner = arg
          s.info = { ...s.info, planner: arg }
          this.emitTick(s)
          info(`planner=${arg} (saved)`)
        } else {
          info(`planner=${s.planner} (candidates: codex-sol | gemini-4-carbon)`)
        }
        break

      case '/executor':
        if (arg) {
          s.executor = arg
          s.info = { ...s.info, executor: arg }
          this.emitTick(s)
          info(`executor=${arg} (saved)`)
        } else {
          info(`executor=${s.executor} (candidates: ds | gemini-4-neon | glm-5.3-flash)`)
        }
        break

      case '/auditor':
        if (arg) {
          s.auditor = arg
          this.emitTick(s)
          info(`auditor=${arg} (saved)`)
        } else {
          info(`auditor=${s.auditor} (candidates: codex-sol | gemini-4-carbon | glm-5.3)`)
        }
        break

      case '/status':
        info(
          `session=${s.info.id} workspace=${s.info.workspace} workflow=${s.info.workflow || 'off'} turns=${s.turn} tools=${s.toolsOk}✓/${s.toolsFailed}✗`,
        )
        if (s.re) {
          info(`re: sample=${s.re.sampleType} phase=${s.re.phase} [${s.re.phaseIndex + 1}/9] H:${s.re.hypotheses} E:${s.re.evidence}`)
        }
        break

      case '/theme': {
        const target = parts[1]?.toLowerCase()
        if (!target) {
          info(`available themes: ${THEME_NAMES.join(' | ')}`)
          break
        }
        if (!(THEME_NAMES as readonly string[]).includes(target)) {
          ok = false
          err(`usage: /theme ${THEME_NAMES.join('|')}`)
          break
        }
        applyLiveTheme(target as ThemeName)
        info(`theme=${target} (applied live)`)
        break
      }

      case '/workflow': {
        const sub = parts[1]?.toLowerCase()
        if (!sub) {
          info(`workflow=${s.info.workflow || 'off'}${s.re ? ` (${s.re.sampleType} · ${s.re.phase})` : ''}`)
          break
        }
        if (sub === 'off') {
          s.re = null
          s.info = { ...s.info, workflow: 'off' }
          info('workflow=off (RE HUD cleared)')
          this.emitTick(s)
          break
        }
        if (sub === 'reverse') {
          const sample = parts[2]?.toLowerCase() || 'generic'
          s.info = { ...s.info, workflow: 'reverse' }
          s.re = { sampleType: sample, phase: 'triage', phaseIndex: 0, phaseCount: 9, hypotheses: 0, evidence: 0 }
          if (!s.goal) {
            const tgt = s.info.workspace.includes('reverse-lab') ? 'carrier.bin' : `${sample}-target`
            this.armGoalContract(
              s,
              tgt,
              `完成 ${tgt} 静态/动态交叉取证、重放验证与独立对抗审计`,
            )
          }
          info(`workflow=reverse sample=${sample} phase=triage [1/9]`)
          info(`goal contract armed: target=${s.goal?.targetFile} · sandbox=ACTIVE (network=deny, device=none)`)
          this.emitTick(s)
          emitDemoSignal({ type: 're_workflow_started', sessionId: id, sampleType: sample })
          break
        }
        s.info = { ...s.info, workflow: sub }
        info(`workflow=${sub}`)
        this.emitTick(s)
        break
      }

      case '/phase': {
        if (!s.re) {
          ok = false
          err('RE workflow is off — run /workflow reverse first')
          break
        }
        const sub = parts[1]?.toLowerCase()
        if (!sub) {
          info(`phase=${s.re.phase} [${s.re.phaseIndex + 1}/9] H:${s.hypotheses.length} E:${s.evidence.length} sample=${s.re.sampleType}`)
          for (const h of s.hypotheses) {
            info(`  [${h.id}] ${Math.round(h.confidence * 100)}% (${h.status}) ${h.claim}`)
          }
          for (const ev of s.evidence.slice(-6)) {
            info(`  [${ev.id}] ${ev.source} (${ev.kind || 'obs'}): ${ev.summary || ev.excerpt.slice(0, 72)}`)
          }
          break
        }
        if (sub === 'next') {
          const nextIdx = Math.min(PHASES.length - 1, s.re.phaseIndex + 1)
          s.re.phaseIndex = nextIdx
          s.re.phase = PHASES[nextIdx]
          info(`phase → ${s.re.phase} [${nextIdx + 1}/9]`)
          this.emitTick(s)
          emitDemoSignal({ type: 're_phase_changed', sessionId: id, phase: s.re.phase, phaseIndex: nextIdx })
          break
        }
        const tgt = PHASES.indexOf(sub as (typeof PHASES)[number])
        if (tgt < 0) {
          ok = false
          err(`unknown phase: ${sub} (want ${PHASES.join('|')})`)
          break
        }
        s.re.phaseIndex = tgt
        s.re.phase = PHASES[tgt]
        info(`phase → ${s.re.phase} [${tgt + 1}/9]`)
        this.emitTick(s)
        emitDemoSignal({ type: 're_phase_changed', sessionId: id, phase: s.re.phase, phaseIndex: tgt })
        break
      }

      case '/audit': {
        const auditor = s.auditor || 'glm-5.3'
        const auditorModel = modelForProvider(auditor)
        s.activeSeatOverride = auditor
        const reevalHyps = s.hypotheses.filter((h) => h.status === 'reevaluate')
        for (const h of reevalHyps) {
          h.confidence = Number((h.confidence * 0.5).toFixed(2))
          h.status = 'rejected'
          h.contradicting = Array.from(new Set([...(h.contradicting ?? []), 'ev_006']))
          h.note = `经独立审计席 ${auditor} (${auditorModel}) CHALLENGE 复核淘汰（父假设已证伪）`
          h.updatedAt = Date.now()
          s.findings.push({
            rule: 'adversarial-audit',
            hypothesisId: h.id,
            evidenceId: 'ev_006',
            applied: true,
            action: 'challenge',
            message: `[${auditor}] CHALLENGE ${h.id}: 父假设 H-002 已证伪，PK_0x5f 无有效压缩流`,
          })
        }

        const supportedIds = s.hypotheses
          .filter((h) => h.status === 'active' || h.status === 'revised')
          .map((h) => h.id)
        for (const hid of supportedIds) {
          const h = s.hypotheses.find((x) => x.id === hid)
          const evRef = h?.supporting?.[h.supporting.length - 1] ?? 'ev_001'
          s.findings.push({
            rule: 'adversarial-audit',
            hypothesisId: hid,
            evidenceId: evRef,
            applied: true,
            action: 'support',
            message: `[${auditor}] SUPPORT ${hid}: 引用证据链完整，满足独立复核标准`,
          })
        }

        const hypCount = Math.max(s.hypotheses.length, s.re?.hypotheses ?? 1)
        const verdictLines = [
          ...supportedIds.map((hid) => `AUDIT ${hid} SUPPORT — 静态/动态证据链闭环`),
          ...reevalHyps.map((h) => `AUDIT ${h.id} CHALLENGE ev_006 — 依赖上游已证伪，予以淘汰`),
        ]
        const auditEv = this.addEvidence(s, {
          source: `audit:${auditor}`,
          kind: 'audit_finding',
          view: 'static',
          summary: `${auditor.toUpperCase()} (${auditorModel}) 隔离对抗审计 PASS · 复核 ${hypCount} 条假设`,
          excerpt:
            verdictLines.length > 0
              ? verdictLines.join('\n')
              : `Auditor ${auditor} (${auditorModel}) verified ${hypCount} hypotheses in isolated context.`,
          supports: supportedIds,
        })
        if (s.re) {
          s.re.hypotheses = s.hypotheses.filter((h) => h.status !== 'rejected').length
          s.re.evidence = s.evidence.length
          s.re.phase = 'writeup'
          s.re.phaseIndex = 8
        }
        this.emitLoop(id, [
          makeLoopEvent({
            type: 'reply',
            provider: auditor,
            model: auditorModel,
            text: [
              `### 🛡 独立对抗审计报告（Auditor: \`${auditor}\` / \`${auditorModel}\`）`,
              '',
              '- **隔离模式**：`Isolated=true · FreshSession=true · Tools=[]`（零历史对话、零工具权限，仅审数据包）',
              ...verdictLines.map((l) => `- \`${l}\``),
              `- **审计签章**：已写入账本 **\`${auditEv.id}\`** (\`audit_finding\`)，\`/goal\` 契约验收项全部通过，解锁 **\`WRI [9/9]\`**！`,
            ].join('\n'),
            textChars: 240,
          }),
        ])
        info(`adversarial audit (auditor=${auditor}/${auditorModel} · isolated vs planner=${s.planner} & executor=${s.executor}):`)
        info(`  checked ${hypCount} hypotheses against evidence-ledger.jsonl`)
        info(`  verdict: PASS · audit_finding stamped (${auditEv.id})`)
        if (s.re) info('  phase gate & /goal contract unlocked → WRI [9/9] ready for final writeup')
        this.emitTick(s)
        s.activeSeatOverride = ''
        emitDemoSignal({ type: 'audit_completed', sessionId: id })
        break
      }

      case '/scan': {
        const target = parts[1] || 'carrier.bin'
        if (target.includes('chall')) {
          info(`[ctf_triage] ${target} · 436 bytes · Node.js script (ASCII)`)
          info('  hits: XOR constant 0x2a · 17-element byte array · argv[2] token compare')
        } else if (target.includes('artifact')) {
          info(`[ctf_triage] ${target} · 224 bytes · ASCII text`)
          info('  base64 candidate: ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9')
        } else {
          info(`[ctf_triage] ${target} · 121 bytes · entropy=4.12`)
          info('  signatures: 0x00 "carrier-prefix" · 0x21 %PDF-1.7 · 0x5f PK\\x03\\x04 (incomplete ZIP)')
        }
        break
      }

      case '/inspect': {
        const target = parts[1] || 'crackme_x64'
        info(`[binary_inspect] ${target} · ELF64 x86-64 PIE`)
        info('  sections: .text (ent=6.21) · .rodata (ent=4.85) · UPX1 (ent=7.84 [PACKED])')
        info('  .init_array: 0x401120 (anti_debug_init) · imports: ptrace, openat, strcmp')
        break
      }

      case '/anti': {
        const target = parts[1] || 'crackme_x64'
        info(`[anti_analysis] ${target}:`)
        info('  [HIGH] packer signature: UPX! header at 0x000001e8')
        info('  [MED]  anti-debug: ptrace(PTRACE_TRACEME) + /proc/self/status TracerPid')
        break
      }

      case '/entropy': {
        const target = parts[1] || 'carrier.bin'
        info(`[entropy_scan] ${target}: overall=4.12 bits/byte`)
        info('  0x00..0x20 ▁▂▃  3.10  ASCII prefix/padding')
        info('  0x21..0x5b ▃▄▅  4.64  %PDF-1.7 stub')
        info('  0x5f..0x78 ▂▃▄  3.88  ZIP local marker')
        break
      }

      case '/decode': {
        const codec = parts[1]
        const payload = parts.slice(2).join(' ')
        if (!codec || !payload) {
          ok = false
          err('usage: /decode <base64|hex|rot13|url|xor> <data>')
          break
        }
        const decoded = decodePayload(codec, payload)
        if (!decoded.ok) {
          ok = false
          err(decoded.out)
        } else {
          info(`[ctf_decode:${codec}] → ${decoded.out}`)
        }
        break
      }

      case '/goal': {
        const sub = parts[1]?.toLowerCase()
        if (!arg || sub === 'show') {
          if (!s.goal) {
            info('no active goal — usage: /goal <objective> | /goal show | /goal clear')
          } else {
            info(`goal (${s.goal.accepted ? 'ACCEPTED' : 'DRAFT'}): ${s.goal.primary} [target=${s.goal.targetFile}]`)
            for (const c of s.goal.criteria) {
              info(`  [${c.pass ? 'PASS' : 'WAIT'}] ${c.label} (${c.detail || ''})`)
            }
          }
        } else if (sub === 'clear') {
          s.goal = null
          s.goalText = ''
          s.sandbox.active = false
          s.sandbox.granted = []
          s.sandbox.device = ''
          info('goal cleared · task capability sandbox deactivated')
          this.emitTick(s)
        } else {
          this.armGoalContract(s, 'carrier.bin', arg)
          info(`goal armed by ${s.planner}: "${arg}" · sandbox=ACTIVE (network=deny, device=none)`)
          this.emitTick(s)
        }
        break
      }

      case '/cap': {
        const sub = parts[1]?.toLowerCase()
        const mode = parts[2]?.toLowerCase()
        if (!arg || sub === 'show') {
          info(
            `sandbox=${s.sandbox.active ? 'ACTIVE' : 'INACTIVE'} granted=[${s.sandbox.granted.join(', ') || 'none'}] device=${s.sandbox.device || 'none'} actions=${s.sandbox.grantedCount}✓/${s.sandbox.deniedCount}✗`,
          )
        } else if (sub === 'network' && (mode === 'on' || mode === 'off')) {
          s.sandbox.active = true
          if (mode === 'on') {
            if (!s.sandbox.granted.includes('network')) s.sandbox.granted.push('network')
            info('capability granted: network=on (operator override logged)')
          } else {
            s.sandbox.granted = s.sandbox.granted.filter((c) => c !== 'network')
            info('capability revoked: network=off (deny-by-default restored)')
          }
          this.refreshGoalCriteria(s)
          this.emitTick(s)
        } else if (sub === 'device' && (mode === 'on' || mode === 'off')) {
          s.sandbox.active = true
          if (mode === 'on') {
            const devId = parts[3] || 'emulator-5554'
            if (!s.sandbox.granted.includes('device')) s.sandbox.granted.push('device')
            s.sandbox.device = devId
            info(`capability granted: device=on (${devId})`)
          } else {
            s.sandbox.granted = s.sandbox.granted.filter((c) => c !== 'device')
            s.sandbox.device = ''
            info('capability revoked: device=off')
          }
          this.refreshGoalCriteria(s)
          this.emitTick(s)
        } else {
          s.sandbox.active = true
          if (!s.sandbox.granted.includes(arg)) s.sandbox.granted.push(arg)
          s.caps.push(arg)
          info(`capability granted: ${arg} (logged to action audit)`)
          this.emitTick(s)
        }
        break
      }

      case '/compact':
        info('context compacted: 6 messages → summary (-4 msgs, 62% tokens saved)')
        break

      case '/version':
        info('0xAF-Re v0.1.21 (demo sandbox · 34 built-in tools)')
        break

      case '/writeup': {
        const tickSnap = this.buildTick(s)
        const summary = synthesizeProcessSummary(tickSnap)
        if (!summary.writeupGate.unlocked) {
          ok = false
          err(`cannot enter writeup: ${summary.writeupGate.reasons.join('; ')}`)
          break
        }
        const md = generateWriteupMarkdown(tickSnap, 'article-standard', s.info.workspace)
        const artEv = this.addEvidence(s, {
          source: 'write_file',
          kind: 'artifact',
          view: 'static',
          artifact: 'notes/writeup.md',
          summary: `write_file(notes/writeup.md) → wrote ${md.length} bytes (all claims cite [H-NNN] & [ev_NNN])`,
          excerpt: md.slice(0, 380),
          bytes: md.length,
        })
        if (s.re) {
          s.re.phase = 'writeup'
          s.re.phaseIndex = 8
          s.re.evidence = s.evidence.length
        }
        this.emitLoop(id, [
          makeLoopEvent({
            type: 'reply',
            provider: s.planner,
            model: modelForProvider(s.planner),
            text: md,
            textChars: md.length,
          }),
        ])
        info(`writeup generated & archived → notes/writeup.md (${md.length}B · ${artEv.id})`)
        this.emitTick(s)
        emitDemoSignal({ type: 'writeup_completed', sessionId: id })
        break
      }

      default:
        info(`[demo] command ${trimmed} executed`)
        break
    }

    emitDemoSignal({ type: 'command_sent', sessionId: id, line: trimmed })
    return { ok, notices }
  }

  // ---------- turn runner ----------

  private async drainTurns(s: DemoSession, firstPrompt: string): Promise<void> {
    s.busy = true
    let ok = await this.runTurn(s, firstPrompt)
    while (ok && !s.closed && !this.disposed) {
      const next = s.queue.shift()
      if (!next) break
      this.emitNotice(s.info.id, 'info', `running queued prompt (${s.queue.length} left)`)
      this.emitTick(s)
      ok = await this.runTurn(s, next)
    }
    s.busy = false
    if (!s.closed) {
      this.stopTicker(s)
      this.emitLifecycle(s, 'idle')
      this.emitTick(s)
    }
  }

  private async finishAborted(s: DemoSession): Promise<boolean> {
    this.stopTicker(s)
    s.stage = 'error'
    s.phaseText = 'interrupted'
    s.activeTool = ''
    s.toolStartedAt = 0
    s.error = 'interrupted by operator'
    s.lastElapsedMs = Date.now() - s.turnStartMs
    if (s.toolRuns.length > 0) {
      const last = s.toolRuns[s.toolRuns.length - 1]
      if (last.status === 'running') {
        last.status = 'failed'
        last.finishedAt = Date.now()
        last.ms = last.finishedAt - last.startedAt
        last.ok = false
        last.preview = 'aborted by operator'
      }
    }
    this.emitNotice(s.info.id, 'info', 'interrupted — turn aborted cleanly (queue & session preserved)')
    this.emitLifecycle(s, 'idle')
    this.emitTick(s)
    return false
  }

  private async runTool(
    s: DemoSession,
    name: string,
    argsText: string,
    preview: string,
    durationMs: number,
  ): Promise<boolean> {
    s.stage = 'tool'
    s.phaseText = name
    s.activeTool = name
    s.toolStartedAt = Date.now()
    s.toolSeq += 1
    const run: ToolRunSnapshot = {
      id: s.toolSeq,
      name,
      argsText,
      preview: '',
      status: 'running',
      startedAt: s.toolStartedAt,
      finishedAt: 0,
      ms: 0,
      ok: false,
    }
    const execProvider = name.startsWith('hypothesis_') ? s.planner : s.executor
    const execModel = modelForProvider(execProvider)
    s.toolRuns.push(run)
    this.emitLoop(s.info.id, [
      makeLoopEvent({ type: 'tool_start', provider: execProvider, model: execModel, name, preview: argsText }),
    ])
    this.emitTick(s)

    if (await this.nap(s, durationMs)) return false

    const fin = Date.now()
    run.status = 'done'
    run.finishedAt = fin
    run.ms = Math.max(12, fin - run.startedAt)
    run.ok = true
    run.preview = preview
    s.toolsOk += 1
    s.activeTool = ''
    s.toolStartedAt = 0
    if (s.sandbox.active && !name.startsWith('hypothesis_')) {
      this.recordSandboxAction(s, name, argsText, 'granted', '', 'workspace-local')
    }
    if (name !== 'hypothesis_create' && name !== 'hypothesis_update') {
      const isVerify = name === 'verify_artifact'
      const isWrite = name === 'write_file'
      this.addEvidence(s, {
        source: name,
        kind: isVerify ? 'verification_result' : isWrite ? 'artifact' : 'tool_observation',
        view: isVerify ? 'dynamic' : 'static',
        summary: `${name}(${argsText}) → ${preview}`,
        excerpt: `args: ${argsText}\noutput: ${preview}`,
        artifact: isWrite ? argsText : undefined,
        verification: isVerify ? { build: false, passed: 2, total: 2 } : undefined,
      })
    }
    this.emitLoop(s.info.id, [
      makeLoopEvent({ type: 'tool_end', provider: execProvider, model: execModel, name, ok: true, ms: run.ms, preview }),
    ])
    this.emitTick(s)
    return true
  }

  private async runFailedTool(
    s: DemoSession,
    opts: {
      name: string
      argsText: string
      errorMsg: string
      durationMs: number
      sandboxDeniedCap?: string
      evidenceKind?: EvidenceRecord['kind']
      contradicts?: string[]
    },
  ): Promise<EvidenceRecord | null> {
    const execProvider = s.executor
    const execModel = modelForProvider(execProvider)
    s.stage = 'tool'
    s.phaseText = opts.name
    s.activeTool = opts.name
    s.toolStartedAt = Date.now()
    s.toolSeq += 1
    const run: ToolRunSnapshot = {
      id: s.toolSeq,
      name: opts.name,
      argsText: opts.argsText,
      preview: '',
      status: 'running',
      startedAt: s.toolStartedAt,
      finishedAt: 0,
      ms: 0,
      ok: false,
    }
    s.toolRuns.push(run)
    this.emitLoop(s.info.id, [
      makeLoopEvent({ type: 'tool_start', provider: execProvider, model: execModel, name: opts.name, preview: opts.argsText }),
    ])
    this.emitTick(s)

    if (await this.nap(s, opts.durationMs)) return null

    const fin = Date.now()
    run.status = 'failed'
    run.finishedAt = fin
    run.ms = Math.max(6, fin - run.startedAt)
    run.ok = false
    run.preview = opts.errorMsg
    s.toolsFailed += 1
    s.activeTool = ''
    s.toolStartedAt = 0

    if (opts.sandboxDeniedCap) {
      this.recordSandboxAction(s, opts.name, opts.argsText, 'denied', opts.sandboxDeniedCap, 'task-sandbox')
    } else if (s.sandbox.active) {
      this.recordSandboxAction(s, opts.name, opts.argsText, 'granted', '', 'workspace-local')
    }

    const ev = this.addEvidence(s, {
      source: opts.sandboxDeniedCap ? `sandbox:${opts.name}` : opts.name,
      kind: opts.evidenceKind ?? 'tool_observation',
      view: 'dynamic',
      isError: true,
      summary: `${opts.name}(${opts.argsText}) → ${opts.errorMsg}`,
      excerpt: `command: ${opts.argsText}\nerror: ${opts.errorMsg}`,
      contradicts: opts.contradicts,
    })

    this.emitLoop(s.info.id, [
      makeLoopEvent({
        type: 'tool_end',
        provider: execProvider,
        model: execModel,
        name: opts.name,
        ok: false,
        ms: run.ms,
        error: opts.errorMsg,
      }),
    ])
    this.emitTick(s)
    return ev
  }

  private pushThink(s: DemoSession, line: string): void {
    this.emitLoop(s.info.id, [
      makeLoopEvent({
        type: 'progress',
        progress: { kind: 'thinking', text: line, tool: '', status: '', usage: null, plan: null, planNote: '' },
      }),
    ])
  }

  private pushPlan(s: DemoSession, steps: Array<{ text: string; status: PlanStep['status'] }>, kind: FlowDTO['planKind'], note = ''): void {
    s.plan = { source: 'agent', note, updatedAt: Date.now(), steps: makePlanSteps(steps) }
    s.planKind = kind
    this.emitLoop(s.info.id, [makeLoopEvent({ type: 'plan', snapshot: s.plan })])
    this.emitTick(s)
  }

  private async requestApproval(
    s: DemoSession,
    toolName: string,
    risk: ApprovalDTO['risk'],
    summary: string,
    argsPreview: string,
    concerns: string[],
  ): Promise<ApprovalDecision> {
    if (s.approvalMemory[toolName] === 'allow-always') return 'allow-always'
    if (s.approvalMemory[toolName] === 'deny-always') return 'deny-always'

    this.approvalSeq += 1
    const requestID = `demo-apr-${String(this.approvalSeq).padStart(4, '0')}`
    s.pendingApprovalId = requestID
    this.emitLifecycle(s, 'awaiting_approval')
    emitDemoGuiEvent({
      sessionId: s.info.id,
      kind: 'approval',
      ts: Date.now(),
      data: { requestID, toolName, risk, summary, argsPreview, concerns } satisfies ApprovalDTO,
    })
    emitDemoSignal({ type: 'approval_requested', sessionId: s.info.id, toolName })

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      s.gateResolve = resolve
    })
    if (decision === 'allow-always' || decision === 'deny-always') {
      s.approvalMemory[toolName] = decision
    }
    if (!s.closed && !s.aborted) {
      this.emitLifecycle(s, 'running')
    }
    return decision
  }

  private classifyPrompt(s: DemoSession, prompt: string): string {
    const p = prompt.toLowerCase()
    if (p.includes('writeup') || p.includes('分析报告') || p.includes('分析文档')) {
      return 're_writeup'
    }
    if (
      p.includes('notes/solve.md') ||
      p.includes('node chall.js') ||
      (p.includes('验证') && p.includes('chall')) ||
      (p.includes('写入') && s.info.workspace.includes('welcome')) ||
      p.includes('审批') ||
      p.includes('curl')
    ) {
      return 'welcome_approval'
    }
    if (p.includes('chall.js') || (s.info.workspace.includes('welcome') && (p.includes('token') || p.includes('分析') || p.includes('triage')))) {
      return 'welcome_triage'
    }
    if (p.includes('artifact.txt') || p.includes('交叉') || (p.includes('base64') && s.info.workspace.includes('reverse-lab'))) {
      return 're_verify'
    }
    if (p.includes('carrier.bin') || p.includes('分诊') || p.includes('雕刻') || p.includes('carve') || (s.re && s.info.workspace.includes('reverse-lab'))) {
      return 're_carve'
    }
    if (p.includes('ollvm') || p.includes('全量控制流') || p.includes('长任务')) {
      return 'long_interruptible'
    }
    if (p.includes('crackme') || p.includes('深度扫描') || p.includes('加壳')) {
      return 'elf_deep_scan'
    }
    if (p.includes('导出符号') || p.includes('反调试导入')) {
      return 'elf_followup'
    }
    return 'generic_re'
  }

  private async runTurn(s: DemoSession, prompt: string): Promise<boolean> {
    s.aborted = false
    s.turn += 1
    s.messages += 2
    s.error = ''
    s.turnStartMs = Date.now()
    s.stage = 'send'
    s.phaseText = 'working'
    s.usage.input += 1450 + prompt.length * 4
    s.usage.cacheRead += 640

    this.emitLifecycle(s, 'running')
    this.emitLoop(s.info.id, [
      makeLoopEvent({ type: 'user', text: prompt, textChars: prompt.length }),
      makeLoopEvent({ type: 'turn', turn: s.turn, messages: s.messages, tools: 34 }),
      makeLoopEvent({ type: 'wire', phase: 'send', messages: s.messages, tokens: Math.round(s.usage.input) }),
    ])
    this.startTicker(s)
    this.emitTick(s)

    if (await this.nap(s, 220)) return this.finishAborted(s)

    const kind = this.classifyPrompt(s, prompt)
    let reply = ''
    let approved: boolean | undefined

    if (kind === 'welcome_triage') {
      s.stage = 'think'
      s.phaseText = 'thinking'
      this.pushThink(s, 'inspecting /demo/welcome workspace layout to locate challenge entry')
      if (await this.nap(s, 260)) return this.finishAborted(s)
      this.pushThink(s, 'chall.js uses single-byte XOR key 0x2a (42) across 17-element array')
      this.pushPlan(
        s,
        [
          { text: '枚举 workspace 文件与运行日志', status: 'completed' },
          { text: '读取 chall.js 并分析编码算法', status: 'in_progress' },
          { text: '解码还原预期 token', status: 'pending' },
        ],
        'open',
        'Welcome warm-up triage',
      )
      if (!(await this.runTool(s, 'list_files', '/demo/welcome', 'chall.js, README.md, artifacts/session.log, artifacts/operator-notes.txt', 360))) {
        return this.finishAborted(s)
      }
      if (!(await this.runTool(s, 'read_file', 'chall.js', 'const key = 0x2a; const encoded = [26, 82, 75, 76, ...]', 420))) {
        return this.finishAborted(s)
      }
      this.pushThink(s, 'applying XOR 0x2a byte-by-byte: [26^42="0", 82^42="x", 75^42="a", 76^42="f", ...]')
      this.pushPlan(
        s,
        [
          { text: '枚举 workspace 文件与运行日志', status: 'completed' },
          { text: '读取 chall.js 并分析编码算法', status: 'completed' },
          { text: '解码还原预期 token', status: 'in_progress' },
        ],
        'step',
      )
      if (!(await this.runTool(s, 'ctf_decode', 'xor key=0x2a len=17', 'decoded → 0xaf{warmup_deck}', 340))) {
        return this.finishAborted(s)
      }
      this.upsertHypothesis(s, {
        id: 'H-001',
        claim: 'chall.js 使用单字节 XOR（key=0x2a）编码预期令牌，解码值 0xaf{warmup_deck} 待动态验证',
        confidence: 0.82,
        supporting: s.evidence.slice(-2).map((e) => e.id),
        status: 'active',
      })
      this.pushPlan(
        s,
        [
          { text: '枚举 workspace 文件与运行日志', status: 'completed' },
          { text: '读取 chall.js 并分析编码算法', status: 'completed' },
          { text: '解码还原预期 token', status: 'completed' },
        ],
        'write',
        'Token recovered cleanly',
      )
      reply = [
        '### 初筛结论：`chall.js` 令牌算法还原',
        '',
        '- **文件类型**：Node.js 脚本（只读分析完成，零副作用）',
        '- **加密/编码方式**：单字节 `XOR`，常量密钥 `key = 0x2a`（十进制 `42`）',
        '- **还原令牌**：`0xaf{warmup_deck}`',
        '',
        '```js',
        'encoded.map(v => String.fromCharCode(v ^ 0x2a)).join("") // => "0xaf{warmup_deck}"',
        '```',
        '',
        '> 下一步可以让我本地运行 `node chall.js` 做端到端验证并写入报告（会触发审批门确认）。',
      ].join('\n')
    } else if (kind === 'welcome_approval') {
      s.stage = 'think'
      s.phaseText = 'planning'
      this.pushThink(s, 'verification requires run_command + write_file — preparing approval-gated action')
      this.pushPlan(
        s,
        [
          { text: '构造本地校验命令与报告内容', status: 'completed' },
          { text: '审批执行 node chall.js 校验并写入 notes/solve.md', status: 'in_progress' },
          { text: '汇报最终验证结果', status: 'pending' },
        ],
        'open',
        'Approval-gated verification',
      )
      if (await this.nap(s, 360)) return this.finishAborted(s)

      // Tool start + approval gate
      s.stage = 'tool'
      s.phaseText = 'run_command'
      s.activeTool = 'run_command'
      s.toolStartedAt = Date.now()
      s.toolSeq += 1
      const cmdRun: ToolRunSnapshot = {
        id: s.toolSeq,
        name: 'run_command',
        argsText: "node chall.js '0xaf{warmup_deck}'",
        preview: '',
        status: 'running',
        startedAt: s.toolStartedAt,
        finishedAt: 0,
        ms: 0,
        ok: false,
      }
      s.toolRuns.push(cmdRun)
      this.emitLoop(s.info.id, [
        makeLoopEvent({
          type: 'tool_start',
          name: 'run_command',
          args: { command: "node chall.js '0xaf{warmup_deck}'" },
          preview: "node chall.js '0xaf{warmup_deck}'",
        }),
      ])
      this.emitTick(s)

      const decision = await this.requestApproval(
        s,
        'run_command',
        'exec',
        "run_command: node chall.js '0xaf{warmup_deck}' && write notes/solve.md",
        "command: node chall.js '0xaf{warmup_deck}'\nwrite:   notes/solve.md (342 bytes)",
        [
          'executes local subprocess outside read-only triage',
          'writes artifact file into workspace (notes/solve.md)',
        ],
      )
      if (s.aborted || s.closed) return this.finishAborted(s)

      approved = decision === 'allow' || decision === 'allow-always'
      if (approved) {
        if (await this.nap(s, 320)) return this.finishAborted(s)
        cmdRun.status = 'done'
        cmdRun.finishedAt = Date.now()
        cmdRun.ms = Math.max(48, cmdRun.finishedAt - cmdRun.startedAt)
        cmdRun.ok = true
        cmdRun.preview = 'stdout: accepted (exit 0)'
        s.toolsOk += 1
        s.activeTool = ''
        s.toolStartedAt = 0
        const verEv = this.addEvidence(s, {
          source: 'run_command',
          kind: 'verification_result',
          view: 'dynamic',
          summary: "node chall.js '0xaf{warmup_deck}' → accepted (exit 0)",
          excerpt: "$ node chall.js '0xaf{warmup_deck}'\naccepted\nexit_code=0",
          verification: { build: false, passed: 1, total: 1 },
          supports: ['H-001'],
        })
        this.upsertHypothesis(s, {
          id: 'H-001',
          claim: 'chall.js 单字节 XOR(0x2a) 令牌 0xaf{warmup_deck} 已通过本地运行校验',
          confidence: 0.98,
          supporting: [verEv.id],
          status: 'active',
          note: `Confirmed dynamically (${verEv.id}) · approval=${decision}`,
        })
        this.emitLoop(s.info.id, [
          makeLoopEvent({ type: 'tool_end', name: 'run_command', ok: true, ms: cmdRun.ms, preview: 'stdout: accepted (exit 0)' }),
        ])
        if (!(await this.runTool(s, 'write_file', 'notes/solve.md', 'wrote 342 bytes to notes/solve.md', 260))) {
          return this.finishAborted(s)
        }
        this.pushPlan(
          s,
          [
            { text: '构造本地校验命令与报告内容', status: 'completed' },
            { text: '审批执行 node chall.js 校验并写入 notes/solve.md', status: 'completed' },
            { text: '汇报最终验证结果', status: 'completed' },
          ],
          'write',
          'Approved & verified (3/3)',
        )
        reply = [
          '### ✓ 验证通过并已归档',
          '',
          '| 项目 | 结果 |',
          '| --- | --- |',
          '| 审批策略 | `' + decision + '`（已记录至当前会话策略） |',
          '| 校验命令 | `node chall.js \'0xaf{warmup_deck}\'` → **`accepted`** |',
          '| 落盘报告 | `notes/solve.md`（342 bytes） |',
          '',
          '所有步骤均已留痕，可随时切换上方场景继续体验 9 阶段 RE Workflow 或内置终端。',
        ].join('\n')
      } else {
        cmdRun.status = 'failed'
        cmdRun.finishedAt = Date.now()
        cmdRun.ms = 4
        cmdRun.ok = false
        cmdRun.preview = 'denied by operator'
        s.toolsFailed += 1
        s.activeTool = ''
        s.toolStartedAt = 0
        this.addEvidence(s, {
          source: 'run_command',
          kind: 'tool_observation',
          view: 'dynamic',
          isError: true,
          summary: `run_command blocked by approval gate (${decision})`,
          excerpt: `command: node chall.js '0xaf{warmup_deck}'\nstatus: denied by operator (${decision})`,
        })
        this.emitLoop(s.info.id, [
          makeLoopEvent({ type: 'tool_end', name: 'run_command', ok: false, ms: 4, error: `denied by operator (${decision})` }),
        ])
        this.pushPlan(
          s,
          [
            { text: '构造本地校验命令与报告内容', status: 'completed' },
            { text: '审批执行 node chall.js 校验并写入 notes/solve.md', status: 'in_progress' },
            { text: '汇报最终验证结果', status: 'pending' },
          ],
          'step',
          `blocked: ${decision} by operator`,
        )
        reply = [
          '### ⊘ 执行已被安全审批门拦截',
          '',
          `操作员选择了 **\`${decision}\`**，因此未执行本地子进程，也未写入 \`notes/solve.md\`。`,
          '',
          '- 如需对比放行路径：再次发送验证指令并在弹窗中点击 **`allow`**。',
          '- 如需完全手动验证：点击左侧栏 **`+ sh`** 在终端中运行 `node chall.js \'0xaf{warmup_deck}\'`。',
        ].join('\n')
      }
    } else if (kind === 're_carve') {
      if (!s.re) {
        s.re = { sampleType: 'firmware', phase: 'triage', phaseIndex: 0, phaseCount: 9, hypotheses: 0, evidence: 0 }
      }
      if (!s.goal) {
        this.armGoalContract(s, 'carrier.bin', '完成 carrier.bin 静态/动态交叉取证、重放验证与独立对抗审计')
      }
      s.stage = 'think'
      s.phaseText = 'planning (deepseek)'
      this.pushThink(s, `[${s.planner}] drafting RE plan under capability sandbox (network=deny, device=none)`)
      this.pushPlan(
        s,
        [
          { text: `[${s.executor}] TRI/STA: 扫描文件头、雕刻 PDF/ZIP 签名并计算区段熵`, status: 'in_progress' },
          { text: `[${s.planner}] HYP: 建立主假设 H-001/H-002 与下游依赖子假设 H-003`, status: 'pending' },
          { text: '[arbitrator] 运行单视角盲区与阶段门禁巡检', status: 'pending' },
        ],
        'open',
        `Multi-Model RE: ${s.planner} → ${s.executor}`,
      )
      if (!(await this.runTool(s, 'ctf_triage', 'carrier.bin', '121B · ASCII prefix + %PDF-1.7@0x21 + PK_0x5f@0x5f', 340))) {
        return this.finishAborted(s)
      }
      s.re = { ...s.re, phase: 'static', phaseIndex: 1, evidence: Math.max(s.re.evidence, 1) }
      this.emitTick(s)
      emitDemoSignal({ type: 're_phase_changed', sessionId: s.info.id, phase: 'static', phaseIndex: 1 })

      this.pushThink(s, `[${s.planner}] delegating byte carving & entropy scan to ${s.executor} (${modelForProvider(s.executor)})`)
      if (!(await this.runTool(s, 'carve_artifacts', 'carrier.bin', 'carved 2 signatures: PDF stub (60B), ZIP local header PK_0x5f (26B)', 380))) {
        return this.finishAborted(s)
      }
      if (!(await this.runTool(s, 'find_bytes', 'carrier.bin %PDF- / PK\\x03\\x04', 'matches at 0x21 (%PDF-1.7) and 0x5f (PK_0x5f)', 220))) {
        return this.finishAborted(s)
      }
      if (!(await this.runTool(s, 'entropy_scan', 'carrier.bin', 'overall=4.12 bits/byte (0x21=4.64, 0x5f=3.88)', 220))) {
        return this.finishAborted(s)
      }

      s.stage = 'think'
      s.phaseText = `modeling (${s.planner})`
      this.pushPlan(
        s,
        [
          { text: `[${s.executor}] TRI/STA: 扫描文件头、雕刻 PDF/ZIP 签名并计算区段熵`, status: 'completed' },
          { text: `[${s.planner}] HYP: 建立主假设 H-001/H-002 与下游依赖子假设 H-003`, status: 'in_progress' },
          { text: '[arbitrator] 运行单视角盲区与阶段门禁巡检', status: 'pending' },
        ],
        'step',
      )
      this.upsertHypothesis(s, {
        id: 'H-001',
        claim: '偏移 0x21 的 %PDF-1.7 是仅含单 Catalog 对象的极简空壳，无隐藏流载荷',
        confidence: 0.92,
        supporting: ['ev_001', 'ev_002'],
        status: 'active',
      })
      this.upsertHypothesis(s, {
        id: 'H-002',
        claim: '偏移 0x5f 的 PK_0x5f ZIP 局部头内嵌了压缩加密的真实 Flag 数据流',
        confidence: 0.84,
        supporting: ['ev_002', 'ev_003'],
        status: 'active',
      })
      this.upsertHypothesis(s, {
        id: 'H-003',
        claim: '用偏移 0x00 明文前缀派生密钥即可解密 H-002 中的 PK_0x5f 载荷流',
        confidence: 0.76,
        supporting: ['ev_003', 'ev_004'],
        dependsOn: ['H-002'],
        status: 'active',
        note: '依赖上游父假设 H-002 成立 (dependsOn: H-002)',
      })
      if (!(await this.runTool(s, 'hypothesis_create', 'H-001, H-002, H-003 (dependsOn: H-002)', 'registered 3 hypotheses backed by ev_001..ev_004', 260))) {
        return this.finishAborted(s)
      }

      // Host deterministic arbitrator: single-view warning on H-002 (0.84 >= 0.80, static-only)
      s.findings.push({
        rule: 'single-view',
        hypothesisId: 'H-002',
        evidenceId: 'ev_002',
        applied: false,
        action: 'challenge',
        message: 'H-002 置信度 84% (≥0.80) 仅具备 static 单一视角支撑，宿主仲裁器要求补充 dynamic 动态校验',
      })
      this.emitNotice(s.info.id, 'info', '[arbitrator:single-view] H-002 (84%) relies on static view only — dynamic verification required')

      s.re = {
        ...s.re,
        phase: 'dynamic',
        phaseIndex: 2,
        hypotheses: s.hypotheses.filter((h) => h.status !== 'rejected').length,
        evidence: s.evidence.length,
      }
      this.emitTick(s)
      emitDemoSignal({ type: 're_phase_changed', sessionId: s.info.id, phase: 'dynamic', phaseIndex: 2 })
      this.pushPlan(
        s,
        [
          { text: `[${s.executor}] TRI/STA: 扫描文件头、雕刻 PDF/ZIP 签名并计算区段熵`, status: 'completed' },
          { text: `[${s.planner}] HYP: 建立主假设 H-001/H-002 与下游依赖子假设 H-003`, status: 'completed' },
          { text: '[arbitrator] 运行单视角盲区与阶段门禁巡检', status: 'completed' },
        ],
        'write',
        'RE HUD advanced → DYN [3/9] (H:3 / E:4)',
      )
      reply = [
        `### 阶段一：\`${s.planner}\` 规划建模 + \`${s.executor}\` 静态取证`,
        '',
        '| 席位 / 模块 | 动作与产出 |',
        '| --- | --- |',
        `| **Executor (\`${s.executor}\`)** | 执行 \`ctf_triage\` / \`carve_artifacts\` / \`find_bytes\` / \`entropy_scan\`，自动盖章静态证据 **\`ev_001..ev_004\`** |`,
        `| **Planner (\`${s.planner}\`)** | 建立 **\`H-001\`** (PDF 空壳, 92%)、**\`H-002\`** (PK_0x5f 含加密流, 84%) 及依赖子假设 **\`H-003\`** (\`dependsOn: H-002\`, 76%) |`,
        '| **Host Arbitrator** | 命中 **`[single-view]`** 规则：`H-002` 置信度 ≥ 80% 但仅有 `static` 单视角证据，要求进入 `DYN` 阶段交叉验证 |',
      ].join('\n')
    } else if (kind === 're_verify') {
      if (!s.re) {
        s.re = { sampleType: 'firmware', phase: 'dynamic', phaseIndex: 2, phaseCount: 9, hypotheses: 3, evidence: 4 }
      }
      if (!s.goal) {
        this.armGoalContract(s, 'carrier.bin', '完成 carrier.bin 静态/动态交叉取证、重放验证与独立对抗审计')
      }
      s.stage = 'think'
      s.phaseText = `dynamic check (${s.executor})`
      this.pushThink(s, `[${s.executor}] running dynamic verification on PK_0x5f and checking external hint endpoint`)
      this.pushPlan(
        s,
        [
          { text: `[Gate 1 · Sandbox] 校验 ${s.executor} 外部工具能力边界`, status: 'in_progress' },
          { text: '[Arbitrator] 动态解压 PK_0x5f 触发反证折半与 H-003 级联重审', status: 'pending' },
          { text: `[${s.executor} → ${s.planner}] 解码 artifact.txt + verify_artifact 确立 H-004`, status: 'pending' },
        ],
        'open',
        'Sandbox Gate + Arbitrator Cascade + Replay',
      )

      // 1) Gate 1 Capability Sandbox intercepts unauthorized network call (unless operator explicitly ran `/cap network on`)
      if (!s.sandbox.granted.includes('network')) {
        const netEv = await this.runFailedTool(s, {
          name: 'run_command',
          argsText: 'curl -sI https://ctf-hint.example.invalid/carrier',
          errorMsg: 'capability "network" denied by task sandbox (grant via /cap network on)',
          durationMs: 240,
          sandboxDeniedCap: 'network',
        })
        if (!netEv) return this.finishAborted(s)
        this.emitNotice(
          s.info.id,
          'error',
          `[Gate 1 · Sandbox] blocked run_command(curl): capability "network" denied (${netEv.id})`,
        )
      } else {
        if (!(await this.runTool(s, 'run_command', 'curl -sI https://ctf-hint.example.invalid/carrier', 'network=on override · offline lab host unreachable', 220))) {
          return this.finishAborted(s)
        }
      }

      // 2) Dynamic test on carrier.bin fails -> Host Arbitrator fires runtime-contradiction + dependency cascade
      const dynErrEv = await this.runFailedTool(s, {
        name: 'run_command',
        argsText: 'unzip -t carrier.bin',
        errorMsg: 'PK_0x5f: End-of-central-directory signature not found (truncated decoy)',
        durationMs: 260,
        evidenceKind: 'runtime_trace',
        contradicts: ['H-002'],
      })
      if (!dynErrEv) return this.finishAborted(s)

      this.pushThink(
        s,
        `[arbitrator] runtime-contradiction on H-002 via ${dynErrEv.id}: confidence 0.84 → 0.42 → 0.21 (rejected); cascading H-003 → reevaluate`,
      )
      this.upsertHypothesis(s, {
        id: 'H-002',
        claim: '偏移 0x5f 的 PK_0x5f ZIP 局部头内嵌了压缩加密的真实 Flag 数据流',
        confidence: 0.21,
        contradicting: [dynErrEv.id],
        status: 'rejected',
        experiments: [
          {
            id: 'exp_01',
            title: '解压测试 PK_0x5f 完整性',
            command: 'unzip -t carrier.bin',
            expected: 'No errors detected',
            status: 'falsified',
            evidenceId: dynErrEv.id,
            actual: 'PK_0x5f: End-of-central-directory signature not found (truncated decoy)',
            ranAt: Date.now(),
          },
        ],
        note: `被动态运行证据 ${dynErrEv.id} 证伪（缺少 EOCD 中央目录），置信度折半淘汰`,
      })
      this.upsertHypothesis(s, {
        id: 'H-003',
        claim: '用偏移 0x00 明文前缀派生密钥即可解密 H-002 中的 PK_0x5f 载荷流',
        confidence: 0.38,
        dependsOn: ['H-002'],
        status: 'reevaluate',
        note: `父假设 H-002 被淘汰，宿主自动触发依赖级联降级 (dependsOn cascade → reevaluate)`,
      })
      s.findings.push(
        {
          rule: 'runtime-contradiction',
          hypothesisId: 'H-002',
          evidenceId: dynErrEv.id,
          applied: true,
          action: 'challenge',
          message: `动态运行报错 ${dynErrEv.id} 直接推翻静态假设 H-002 (PK_0x5f 缺失中央目录)，置信度折半淘汰`,
        },
        {
          rule: 'dependency-cascade',
          hypothesisId: 'H-003',
          evidenceId: dynErrEv.id,
          applied: true,
          action: 'challenge',
          message: '因上游父假设 H-002 被淘汰，下游子假设 H-003 自动级联标记为 reevaluate 待审计清理',
        },
      )

      this.pushPlan(
        s,
        [
          { text: `[Gate 1 · Sandbox] 校验 ${s.executor} 外部工具能力边界`, status: 'completed' },
          { text: '[Arbitrator] 动态解压 PK_0x5f 触发反证折半与 H-003 级联重审', status: 'completed' },
          { text: `[${s.executor} → ${s.planner}] 解码 artifact.txt + verify_artifact 确立 H-004`, status: 'in_progress' },
        ],
        'step',
      )

      // 3) Companion artifact.txt decode + dynamic replay -> H-004 backed by static + dynamic views
      if (!(await this.runTool(s, 'read_file', 'artifact.txt', 'base64 candidate: ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9', 260))) {
        return this.finishAborted(s)
      }
      const readEvId = s.evidence[s.evidence.length - 1]?.id ?? 'ev_007'

      if (!(await this.runTool(s, 'ctf_decode', 'base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9', 'flag{demo_reverse_lab_flag}', 240))) {
        return this.finishAborted(s)
      }
      const decEvId = s.evidence[s.evidence.length - 1]?.id ?? 'ev_008'

      if (!(await this.runTool(s, 'verify_artifact', 'base64 round-trip & format check', '2/2 assertions passed → flag{demo_reverse_lab_flag}', 280))) {
        return this.finishAborted(s)
      }
      const verEv = s.evidence[s.evidence.length - 1]
      if (verEv) verEv.supports = ['H-004']
      const verEvId = verEv?.id ?? 'ev_009'

      s.stage = 'think'
      s.phaseText = `updating stack (${s.planner})`
      this.upsertHypothesis(s, {
        id: 'H-004',
        claim: 'carrier.bin 中 PK_0x5f 为诱饵头，真实 Flag 位于伴生文件 artifact.txt Base64 载荷 flag{demo_reverse_lab_flag}',
        confidence: 0.96,
        supporting: [readEvId, decEvId, verEvId],
        status: 'active',
        experiments: [
          {
            id: 'exp_01',
            title: 'Base64 解码与往返重放校验',
            command: 'verify_artifact base64 round-trip & format check',
            expected: 'flag{demo_reverse_lab_flag}',
            status: 'passed',
            evidenceId: verEvId,
            actual: '2/2 assertions passed → flag{demo_reverse_lab_flag}',
            ranAt: Date.now(),
          },
        ],
        note: `兼具静态解码 (${decEvId}) 与动态重放 (${verEvId}, 2/2 passed) 双视角交叉验证支撑`,
      })
      if (!(await this.runTool(s, 'hypothesis_update', 'reject H-002 · cascade H-003 · create H-004', `H-004 active (96%) backed by ${decEvId}+${verEvId}`, 220))) {
        return this.finishAborted(s)
      }

      s.re = {
        ...s.re,
        phase: 'verify',
        phaseIndex: 6,
        hypotheses: s.hypotheses.filter((h) => h.status !== 'rejected').length,
        evidence: s.evidence.length,
      }
      this.emitTick(s)
      emitDemoSignal({ type: 're_phase_changed', sessionId: s.info.id, phase: 'verify', phaseIndex: 6 })
      this.pushPlan(
        s,
        [
          { text: `[Gate 1 · Sandbox] 校验 ${s.executor} 外部工具能力边界`, status: 'completed' },
          { text: '[Arbitrator] 动态解压 PK_0x5f 触发反证折半与 H-003 级联重审', status: 'completed' },
          { text: `[${s.executor} → ${s.planner}] 解码 artifact.txt + verify_artifact 确立 H-004`, status: 'completed' },
        ],
        'write',
        `VER [7/9] passed — awaiting isolated /audit (${s.auditor})`,
      )
      reply = [
        '### 阶段二：沙箱拦截 · 确定性反证级联 · 双视角验证',
        '',
        `- **安全沙箱拦截 (\`Gate 1\`)**：\`${s.executor}\` 尝试外联 \`curl\` 被能力沙箱自动阻断（\`capability "network" denied\`，已记入 SHA256 审计链）`,
        `- **反证折半与依赖级联 (\`Arbitrator\`)**：动态校验 \`${dynErrEv.id}\` 暴露 \`PK_0x5f\` 缺失中央目录 → **\`H-002\`** 置信度折半淘汰 (\`rejected\`)，下游子假设 **\`H-003\`** 自动级联降级为 **\`reevaluate\`**`,
        `- **双视角确立新假设 (\`H-004\`)**：解码伴生文件获 **\`flag{demo_reverse_lab_flag}\`**（静态 \`${decEvId}\` + 动态重放 \`${verEvId}\` 2/2 通过）`,
        '',
        `> 下一步：运行 **\`/audit\`** 唤醒独立第三席位 **\`${s.auditor}\` (\`${modelForProvider(s.auditor)}\`)** 在零工具隔离沙箱中完成终审并解锁 \`WRI [9/9]\`。`,
      ].join('\n')
    } else if (kind === 're_writeup') {
      const preSnap = this.buildTick(s)
      const preSummary = synthesizeProcessSummary(preSnap)
      if (!preSummary.writeupGate.unlocked) {
        s.stage = 'think'
        s.phaseText = 'gate blocked'
        this.pushThink(s, `[Host Gate] PhaseWriteup blocked: ${preSummary.writeupGate.reasons.join('; ')}`)
        reply = [
          '### 🔒 Writeup 硬闸门未放行（Host Gate Blocked）',
          '',
          '0xAF-Re 严格执行「过不了验证与审计就写不了报告」的契约不变量，当前尚缺以下前置条件：',
          ...preSummary.writeupGate.reasons.map((r) => `- ✗ ${r}`),
          '',
          '> 请先完成动态重放（`verify_artifact`）并运行 **`/audit`** 签发 `audit_finding` 后，再生成最终 Writeup。',
        ].join('\n')
      } else {
        s.stage = 'think'
        s.phaseText = `synthesizing writeup (${s.planner})`
        this.pushThink(
          s,
          `[${s.planner}] compiling evidence-anchored Writeup from E:${s.evidence.length} ledger records & H:${s.hypotheses.length} hypotheses`,
        )
        this.pushPlan(
          s,
          [
            { text: `[${s.executor}] 核对账本 ev_NNN 引用与重放验证向量`, status: 'in_progress' },
            { text: `[${s.planner}] 按六大认知环节撰写结构化报告（剥离已证伪诱饵）`, status: 'pending' },
            { text: `[${s.executor}] 落盘归档至 notes/writeup.md`, status: 'pending' },
          ],
          'open',
          'WRI [9/9] · Evidence-Cited Writeup',
        )
        if (!(await this.runTool(s, 'evidence_review', 'filter=all · verify citations', `verified ${s.evidence.length} ledger records & ${s.hypotheses.length} hypotheses`, 240))) {
          return this.finishAborted(s)
        }
        const md = generateWriteupMarkdown(this.buildTick(s), 'article-standard', s.info.workspace)
        this.pushPlan(
          s,
          [
            { text: `[${s.executor}] 核对账本 ev_NNN 引用与重放验证向量`, status: 'completed' },
            { text: `[${s.planner}] 按六大认知环节撰写结构化报告（剥离已证伪诱饵）`, status: 'completed' },
            { text: `[${s.executor}] 落盘归档至 notes/writeup.md`, status: 'in_progress' },
          ],
          'step',
        )
        if (!(await this.runTool(s, 'write_file', 'notes/writeup.md', `wrote ${md.length} bytes to notes/writeup.md`, 280))) {
          return this.finishAborted(s)
        }
        if (s.re) {
          s.re = { ...s.re, phase: 'writeup', phaseIndex: 8, evidence: s.evidence.length }
        }
        this.pushPlan(
          s,
          [
            { text: `[${s.executor}] 核对账本 ev_NNN 引用与重放验证向量`, status: 'completed' },
            { text: `[${s.planner}] 按六大认知环节撰写结构化报告（剥离已证伪诱饵）`, status: 'completed' },
            { text: `[${s.executor}] 落盘归档至 notes/writeup.md`, status: 'completed' },
          ],
          'write',
          'Writeup archived → notes/writeup.md',
        )
        reply = md
        emitDemoSignal({ type: 'writeup_completed', sessionId: s.info.id })
      }
    } else if (kind === 'elf_deep_scan' || kind === 'long_interruptible') {
      const isLong = kind === 'long_interruptible'
      s.stage = 'think'
      s.phaseText = 'thinking'
      this.pushThink(s, isLong ? 'building CFG for crackme_x64 and scanning OLLVM state dispatcher blocks…' : 'running multi-tool binary triage on crackme_x64 (ELF64 x86-64)')
      this.pushPlan(
        s,
        [
          { text: '解析 ELF 头部、区段熵与保护位', status: 'in_progress' },
          { text: '扫描加壳特征与反调试系统调用', status: 'pending' },
          { text: isLong ? '反平坦化 OLLVM 控制流图（长耗时）' : '整理导出符号与下一步脱壳建议', status: 'pending' },
        ],
        'open',
        isLong ? 'Long CFG pass — 可随时点 ■ stop 中断' : 'Deep ELF scan — 运行中可继续发 prompt 排队',
      )
      if (!(await this.runTool(s, 'binary_inspect', 'crackme_x64', 'ELF64 PIE · UPX0/UPX1 · .init_array(1)', isLong ? 1200 : 950))) {
        return this.finishAborted(s)
      }
      this.pushThink(s, 'section UPX1 entropy=7.84 confirms UPX packing; inspecting ptrace/TracerPid checks')
      this.pushPlan(
        s,
        [
          { text: '解析 ELF 头部、区段熵与保护位', status: 'completed' },
          { text: '扫描加壳特征与反调试系统调用', status: 'in_progress' },
          { text: isLong ? '反平坦化 OLLVM 控制流图（长耗时）' : '整理导出符号与下一步脱壳建议', status: 'pending' },
        ],
        'step',
      )
      if (!(await this.runTool(s, 'anti_analysis', 'crackme_x64', 'UPX! packer + ptrace(PTRACE_TRACEME) + TracerPid check', isLong ? 1600 : 1050))) {
        return this.finishAborted(s)
      }
      if (!(await this.runTool(s, 'entropy_scan', 'crackme_x64', 'UPX1 0x1000..0xf800 entropy=7.84 [PACKED]', isLong ? 1800 : 850))) {
        return this.finishAborted(s)
      }
      this.pushPlan(
        s,
        [
          { text: '解析 ELF 头部、区段熵与保护位', status: 'completed' },
          { text: '扫描加壳特征与反调试系统调用', status: 'completed' },
          { text: isLong ? '反平坦化 OLLVM 控制流图（长耗时）' : '整理导出符号与下一步脱壳建议', status: 'completed' },
        ],
        'write',
      )
      reply = [
        '### `crackme_x64` 深度扫描报告',
        '',
        '- **架构与保护**：ELF64 x86-64 · PIE + NX 启用 · 无符号表',
        '- **加壳判定**：`UPX1` 区段熵值 **`7.84`**，命中 `UPX!` 魔数，建议先 `upx -d` 脱壳',
        '- **反调试特征**：检测到 `ptrace(PTRACE_TRACEME)` 与 `/proc/self/status` (`TracerPid`) 读取',
      ].join('\n')
    } else if (kind === 'elf_followup') {
      s.stage = 'think'
      s.phaseText = 'thinking'
      this.pushThink(s, 'draining queued follow-up: extracting symbol table and dangerous imports from crackme_x64')
      if (!(await this.runTool(s, 'extract_symbols', 'crackme_x64', '3 exports · 7 imports (ptrace, openat, read, strcmp, exit)', 460))) {
        return this.finishAborted(s)
      }
      reply = [
        '### 排队追问已自动执行：符号与导入表',
        '',
        '- **高危/反调试导入**：`ptrace` · `openat` (`/proc/self/status`) · `strcmp`',
        '- **说明**：此回合是在上一轮运行中提交、由 `QUEUE` 自动接力执行的。',
      ].join('\n')
    } else {
      // Responsive freeform handler for any custom prompt the user tries!
      s.stage = 'think'
      s.phaseText = 'thinking'
      this.pushThink(s, `analyzing operator request in ${s.info.workspace}: "${prompt.slice(0, 64)}"`)
      this.pushPlan(
        s,
        [
          { text: '检查当前 workspace 上下文与目标文件', status: 'in_progress' },
          { text: '执行只读静态检查并汇总结论', status: 'pending' },
        ],
        'open',
        'Interactive sandbox turn',
      )
      if (await this.nap(s, 300)) return this.finishAborted(s)
      if (!(await this.runTool(s, 'list_files', s.info.workspace, 'workspace indexed (sandbox mode)', 360))) {
        return this.finishAborted(s)
      }
      if (!(await this.runTool(s, 'grep', `${s.info.workspace} · pattern`, 'matched relevant demo artifacts', 340))) {
        return this.finishAborted(s)
      }
      this.pushPlan(
        s,
        [
          { text: '检查当前 workspace 上下文与目标文件', status: 'completed' },
          { text: '执行只读静态检查并汇总结论', status: 'completed' },
        ],
        'write',
      )
      reply = [
        `### 演示沙盒响应（\`${s.info.workspace}\`）`,
        '',
        `已收到指令：> ${prompt}`,
        '',
        '- 当前运行在 **零配置演示沙盒** 中，已模拟完整工具链路（`FLOW → TOOLS → PLAN → THINK → TELE`）。',
        '- 也可以试试输入 **`/help`**、**`/scan carrier.bin`**、**`/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9`**，或从顶部引导条切换 5 个预设 Case。',
      ].join('\n')
    }

    s.stage = 'write'
    s.phaseText = 'writing'
    s.replyChars = reply.length
    this.emitTick(s)
    if (await this.nap(s, 220)) return this.finishAborted(s)

    s.stage = 'done'
    s.phaseText = 'idle'
    s.lastElapsedMs = Date.now() - s.turnStartMs
    this.emitLoop(s.info.id, [
      makeLoopEvent({ type: 'wire', phase: 'recv', ms: s.lastElapsedMs, usage: { ...s.usage } }),
      makeLoopEvent({ type: 'reply', text: reply, textChars: reply.length, ok: true, usage: { ...s.usage } }),
    ])
    this.emitTick(s)
    emitDemoSignal({ type: 'turn_completed', sessionId: s.info.id, kind, approved })
    return true
  }
}
