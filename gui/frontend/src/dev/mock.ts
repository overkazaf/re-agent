// Mock payloads matching the frozen contract, so every workstream can develop
// and demo its components without the Go backend. Read-only for agents.
// Realistic values follow the TUI's shape (internal/ui/flow.go, dashboard.go).

import type {
  ApprovalDTO,
  FlowDTO,
  GuiEvent,
  HudDTO,
  LoopEvent,
  PlanSnapshot,
  TickDTO,
  TokenUsage,
  ToolRunSnapshot,
} from '../lib/types'

const usage: TokenUsage = {
  input: 48211, output: 3921, thinking: 1840, cacheRead: 121055, cacheWrite: 9012, costUsd: 0.4137,
}

export function flow(stage: FlowDTO['stage'], over: Partial<FlowDTO> = {}): FlowDTO {
  return {
    stage, turn: 4, provider: 'claude-max', model: 'claude-sonnet-5-5', endpoint: 'api.anthropic.com',
    messages: 23, sentTokens: 8412, usage, pendingCalls: 0, activeTool: '', toolMs: 0,
    toolsOk: 6, toolsFailed: 1, toolRuns: [], replyChars: 0, compactedDrop: 0, compactedElide: 0,
    hasCompacted: true, plan: { done: 3, total: 7, source: 'update_plan' }, planKind: '',
    error: '', frame: 12, packets: [[3, 8, 14], [2, 9], [5, 11, 16], [1, 7]], since: Date.now() - 94_000,
    ...over,
  }
}

export const toolRuns: ToolRunSnapshot[] = [
  { id: 1, name: 'strings', argsText: '-n 8 binary.so', preview: 'libnative.so · OpenSSL 1.1.1 · JNI_OnLoad', status: 'done', startedAt: Date.now() - 32_000, finishedAt: Date.now() - 31_000, ms: 820, ok: true },
  { id: 2, name: 'entropy', argsText: 'binary.so', preview: 'mean 6.41 — sections .text/.data packed?', status: 'done', startedAt: Date.now() - 30_000, finishedAt: Date.now() - 29_000, ms: 410, ok: true },
  { id: 3, name: 'r2', argsText: '-q aaa -c afl binary.so', preview: '142 funcs · 9 imports · entry0 + 0x8f4c', status: 'done', startedAt: Date.now() - 28_000, finishedAt: Date.now() - 25_000, ms: 3120, ok: true },
  { id: 4, name: 'run_command', argsText: 'python3 scripts/unpack_stub.py', preview: '[+] stub unpacked → /tmp/unpacked.bin (2.1 MB)', status: 'done', startedAt: Date.now() - 24_000, finishedAt: Date.now() - 20_000, ms: 4400, ok: true },
  { id: 5, name: 'frida_template', argsText: 'hook JNI_OnLoad', preview: 'template staged — attach pending device', status: 'failed', startedAt: Date.now() - 19_000, finishedAt: Date.now() - 18_000, ms: 990, ok: false },
  { id: 6, name: 'hexdump', argsText: '-s 0x8f4c -n 128 /tmp/unpacked.bin', preview: '7f 45 4c 46 02 01 01 00 ... aarch64 dylib', status: 'running', startedAt: Date.now() - 3_000, finishedAt: 0, ms: 0, ok: false },
]

export function hud(over: Partial<HudDTO> = {}): HudDTO {
  return {
    phase: 'reverse · phase 2/7 static',
    frame: '⠹', elapsedMs: 94_200, stats: usage,
    spark: [0.2, 0.5, 0.35, 0.8, 0.6, 0.9, 0.4, 0.7, 1.0, 0.65, 0.3, 0.55, 0.85, 0.45, 0.7],
    route: { planner: 'claude-opus-5-5', executor: 'claude-sonnet-5-5', active: 'executor' },
    queueCount: 2, planDisplay: 'auto', thinkDisplay: 'auto',
    ...over,
  }
}

export const planSnapshot: PlanSnapshot = {
  source: 'update_plan',
  note: 'triage suggests OLLVM flattening — pivot to deobfuscation after static pass',
  updatedAt: Date.now() - 8_000,
  steps: [
    { text: 'Triage binary: file type, packer, protections', status: 'completed', id: '1', startedAt: Date.now() - 90_000, completedAt: Date.now() - 80_000 },
    { text: 'Static pass: strings, entropy, symbol map', status: 'completed', id: '2', startedAt: Date.now() - 80_000, completedAt: Date.now() - 60_000 },
    { text: 'Unpack stub, recover DEX/SO layout', status: 'completed', id: '3', startedAt: Date.now() - 60_000, completedAt: Date.now() - 30_000 },
    { text: 'Locate license check routine in .text', status: 'in_progress', id: '4', startedAt: Date.now() - 30_000, completedAt: 0 },
    { text: 'Map control-flow flattening dispatcher', status: 'pending', id: '5', startedAt: 0, completedAt: 0 },
    { text: 'Dynamic confirm with Frida hooks', status: 'pending', id: '6', startedAt: 0, completedAt: 0 },
    { text: 'Writeup: findings + IoC signatures', status: 'pending', id: '7', startedAt: 0, completedAt: 0 },
  ],
}

export function tick(stage: FlowDTO['stage'], over: Partial<FlowDTO> = {}): TickDTO {
  return {
    flow: flow(stage, { toolRuns, ...over }),
    hud: hud(),
    re: {
      sampleType: 'APK', phase: 'static', phaseIndex: 2, phaseCount: 7,
      hypotheses: 2, evidence: 5,
    },
    plan: planSnapshot,
  }
}

export const tickIdle: TickDTO = {
  flow: flow('idle', { turn: 0, toolRuns: [], plan: null, packets: [[] as never[]] as number[][], usage: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } }),
  hud: hud({ phase: 'idle', frame: '', elapsedMs: 0, route: { planner: 'claude-opus-5-5', executor: 'claude-sonnet-5-5', active: '—' }, queueCount: 0, spark: [] }),
  re: null,
  plan: null,
}

// ---------- loop events (transcript stream) ----------

export const loopEvents: LoopEvent[] = [
  { type: 'turn', turn: 4, provider: 'claude-sonnet-5-5', phase: '', model: '', endpoint: '', messages: 23, tokens: 0, tools: 24, ms: 0, ok: false, toolCalls: 0, textChars: 0, error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0, progress: null, snapshot: null, text: '', usage: null, reason: '', name: '', args: null, preview: '' },
  { type: 'wire', turn: 0, provider: '', phase: 'send', model: 'claude-sonnet-5-5', endpoint: 'api.anthropic.com', messages: 23, tokens: 8412, tools: 24, ms: 0, ok: false, toolCalls: 0, textChars: 0, error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0, progress: null, snapshot: null, text: '', usage: null, reason: '', name: '', args: null, preview: '' },
  { type: 'progress', turn: 0, provider: '', phase: '', model: '', endpoint: '', messages: 0, tokens: 0, tools: 0, ms: 0, ok: false, toolCalls: 0, textChars: 0, error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0, progress: { kind: 'thinking', text: 'strings hit JNI_OnLoad + OpenSSL — native lib, likely license check in .text…', tool: '', status: '', usage: null, plan: null, planNote: '' }, snapshot: null, text: '', usage: null, reason: '', name: '', args: null, preview: '' },
  { type: 'tool_start', turn: 0, provider: '', phase: '', model: '', endpoint: '', messages: 0, tokens: 0, tools: 0, ms: 0, ok: false, toolCalls: 0, textChars: 0, error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0, progress: null, snapshot: null, text: '', usage: null, reason: '', name: 'entropy', args: { path: 'binary.so' }, preview: 'binary.so' },
  { type: 'tool_end', turn: 0, provider: '', phase: '', model: '', endpoint: '', messages: 0, tokens: 0, tools: 0, ms: 410, ok: true, toolCalls: 0, textChars: 0, error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0, progress: null, snapshot: null, text: '', usage: null, reason: '', name: 'entropy', args: null, preview: 'mean 6.41 — sections .text/.data packed?' },
  { type: 'plan', turn: 0, provider: '', phase: '', model: '', endpoint: '', messages: 0, tokens: 0, tools: 0, ms: 0, ok: false, toolCalls: 0, textChars: 0, error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0, progress: null, snapshot: planSnapshot, text: '', usage: null, reason: '', name: '', args: null, preview: '' },
  { type: 'reply', turn: 0, provider: '', phase: '', model: '', endpoint: '', messages: 0, tokens: 0, tools: 0, ms: 0, ok: false, toolCalls: 0, textChars: 812, error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0, progress: null, snapshot: null, text: '## Static pass\n\n`binary.so` is an **aarch64 ELF**, OpenSSL statically linked. Entropy scan flags `.text` at **6.41 mean** — consistent with OLLVM flattening rather than packing.\n\nNext: locate the dispatcher loop around `entry0 + 0x8f4c`.', usage: { input: 8412, output: 812, thinking: 1840, cacheRead: 121055, cacheWrite: 9012, costUsd: 0.0412 }, reason: '', name: '', args: null, preview: '' },
]

// ---------- approval / notices / lifecycle ----------

export const approval: ApprovalDTO = {
  requestID: 'apr-0042',
  toolName: 'run_command',
  risk: 'exec',
  summary: 'execute shell command in workspace',
  argsPreview: 'adb shell am start -n com.target.app/.MainActivity',
}

export function guiEvent(kind: GuiEvent['kind'], data: GuiEvent['data'], sessionId = 's1'): GuiEvent {
  return { sessionId, kind, ts: Date.now(), data }
}
