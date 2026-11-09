// WS4 dev page (dev-interact.html): the whole interaction layer with no Go
// backend. Installs an in-file fake window.go shim so create/resume/prompt/
// command/approve all succeed, seeds 3 fake sessions through
// __injectMockSession, then streams mock.ts payloads through
// __injectMockEvent — the exact dispatch path production events take.
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '../styles/tokens.css'
import '../styles/crt.css'
import '../styles/base.css'
import {
  __injectMockEvent,
  __injectMockSession,
  actions,
  hasBackend,
  useSessionStore,
} from '../store/sessions'
import { ApprovalDialog, PromptInput, SessionSidebar, TranscriptStream } from '../components/session'
import { QueuePanel, REHudPanel } from '../components/re'
import { approval, guiEvent, loopEvents, tick, tickIdle } from './mock'
import type { LoopEvent, RESampleType, SessionInfo } from '../lib/types'

// ---------- fake backend (browser-dev only) ----------

const DEMO_COMMANDS = ['/help', '/theme', '/workflow', '/phase', '/model', '/planner', '/executor', '/think', '/tasks', '/queue', '/compact', '/sessions', '/new']

function installFakeBackend() {
  const w = window as unknown as { go?: unknown }
  if (w.go) return
  let seq = 100
  w.go = {
    main: {
      App: {
        StartSession: async (opts: { workspace: string; role: string; workflow: string }) => {
          const info: SessionInfo = {
            id: `demo-${++seq}`,
            workspace: opts.workspace,
            role: opts.role,
            workflow: opts.workflow,
            planner: 'claude-opus-5-5',
            executor: 'claude-sonnet-5-5',
            lifecycle: 'idle',
          }
          return info
        },
        ResumeSession: async (id: string): Promise<SessionInfo> => ({
          id,
          workspace: '/Users/re/samples/resumed.bin',
          role: 'auto',
          workflow: 'reverse',
          planner: 'claude-opus-5-5',
          executor: 'claude-sonnet-5-5',
          lifecycle: 'idle',
        }),
        ListSessions: async () => [
          { id: 'demo-042', hash: 'a1b2c3', updatedAt: '2026-11-02T21:04:11', messages: 34, workspace: '/Users/re/samples/bank.apk', firstPrompt: 'triage this APK and locate the license check' },
          { id: 'demo-041', hash: 'd4e5f6', updatedAt: '2026-11-01T09:41:52', messages: 12, workspace: '/Users/re/ctf/rev-500', firstPrompt: 'solve rev-500, looks like a vm interpreter' },
        ],
        CloseSession: async () => {},
        SendPrompt: async () => {},
        SendCommand: async () => ({ ok: true, notices: [{ level: 'info' as const, text: '(demo shim) command accepted' }] }),
        RESampleTypes: async (): Promise<RESampleType[]> => [
          {
            key: 'apk', label: 'APK', desc: 'Android application package',
            prompts: [
              { short: 'Triage APK structure', full: 'Identify package name, permissions, components, native libs, and signing info for this APK.' },
              { short: 'Find hardcoded secrets', full: "Search for hardcoded API keys, tokens, URLs, and credentials in the APK's dex and resource files." },
              { short: 'Trace native JNI calls', full: 'Map JNI bridge methods between Java/Kotlin and native .so libraries in this APK.' },
              { short: 'Recover obfuscated logic', full: "Deobfuscate and recover the core business logic from this APK's smali/dex." },
            ],
          },
          {
            key: 'so', label: 'SO / ELF shared lib', desc: 'Linux/Android shared object',
            prompts: [
              { short: 'Symbol & import survey', full: 'List exported/imported symbols, detect stripping level, and identify key routines.' },
              { short: 'Find crypto primitives', full: 'Locate cryptographic constants, S-boxes, and cipher implementations in this binary.' },
            ],
          },
          {
            key: 'elf', label: 'ELF executable', desc: 'Linux binary, static or dynamic',
            prompts: [
              { short: 'Triage & mitigations', full: 'Identify architecture, linkage, and exploit mitigations (RELRO, canaries, NX, PIE).' },
              { short: 'Entry & main recovery', full: "Locate the entry point, recover main, and outline the program's control flow." },
            ],
          },
        ],
        Approve: async () => {},
        GetState: async () => tickIdle,
        Completions: async (line: string) => {
          const frag = line.trim().split(/\s+/)[0] || '/'
          const hits = DEMO_COMMANDS.filter((c) => c.startsWith(frag))
          return (hits.length > 0 ? hits : DEMO_COMMANDS).map((c) => `${c} `)
        },
        GetThemes: async () => ['deck', 'amber', 'matrix', 'mono'],
      },
    },
  }
}

// ---------- seed sessions + events through the real dispatch path ----------

const BASE_TS = Date.now() - 16_000

function mkEv(over: Partial<LoopEvent>): LoopEvent {
  return {
    type: 'turn', turn: 0, provider: '', phase: '', model: '', endpoint: '', messages: 0,
    tokens: 0, tools: 0, ms: 0, ok: false, toolCalls: 0, textChars: 0, error: '',
    tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0,
    progress: null, snapshot: null, text: '', usage: null, reason: '', name: '', args: null, preview: '',
    ...over,
  }
}

function seed() {
  __injectMockSession({ id: 's1', workspace: '/Users/re/samples/bank.apk', role: 'auto', workflow: 'reverse', planner: 'claude-opus-5-5', executor: 'claude-sonnet-5-5', lifecycle: 'running' }, true)
  __injectMockSession({ id: 's2', workspace: '/Users/re/ctf/firmware.bin', role: 'planner', workflow: 'ctf', planner: 'kimi-k3', executor: 'claude-sonnet-5-5', lifecycle: 'idle' })
  __injectMockSession({ id: 's3', workspace: '/Users/re/samples/chrome.pak', role: 'researcher', workflow: 'research', planner: 'glm-5', executor: 'glm-5', lifecycle: 'awaiting_approval' })

  __injectMockEvent(guiEvent('tick', tick('tool'), 's1'))
  __injectMockEvent({ sessionId: 's1', kind: 'loop', ts: BASE_TS, data: [loopEvents[0], loopEvents[1]] })
  loopEvents.slice(2).forEach((ev, i) => {
    __injectMockEvent({ sessionId: 's1', kind: 'loop', ts: BASE_TS + (i + 1) * 2100, data: [ev] })
  })

  __injectMockEvent(guiEvent('tick', tickIdle, 's2'))

  __injectMockEvent(guiEvent('tick', tick('think'), 's3'))
  __injectMockEvent({
    sessionId: 's3',
    kind: 'approval',
    ts: Date.now(),
    data: { ...approval, requestID: 'apr-0077', toolName: 'write_file', risk: 'write', summary: 'write notes inside workspace', argsPreview: '/Users/re/samples/chrome.pak/notes.md\n+ evidence: entropy 6.41 @ .text' },
  })

  // default-expanded approval card on the active session
  __injectMockEvent(guiEvent('approval', approval, 's1'))
}

// ---------- synthetic stream for auto-scroll / think tail demo ----------

const THINK_POOL = [
  'cross-referencing JNI_OnLoad callers — license gate likely in nativeInit()',
  'dispatcher at entry0+0x8f4c: flattened switch on state var v3',
  'comparing .rodata blobs — two candidate keys, need dynamic confirm',
  'frida hook plan: Interceptor.attach JNI_OnLoad, dump args at init',
  'checking obfuscation pass order — string decrypt runs before control flow flattening',
]

function synth(i: number): LoopEvent {
  const cycle = i % 6
  switch (cycle) {
    case 0:
      return mkEv({ type: 'wire', phase: 'send', model: 'claude-sonnet-5-5', endpoint: 'api.anthropic.com', messages: 23 + i, tokens: 8200 + i * 37 })
    case 1:
      return mkEv({ type: 'progress', progress: { kind: 'thinking', text: THINK_POOL[i % THINK_POOL.length], tool: '', status: '', usage: null, plan: null, planNote: '' } })
    case 2:
      return mkEv({ type: 'tool_start', name: ['r2', 'frida_template', 'hexdump', 'strings'][i % 4], preview: ['afl entry0', 'hook license_check', '-s 0x8f4c -n 256', '-n 8 libnative.so'][i % 4] })
    case 3:
      return mkEv({ type: 'tool_end', name: ['r2', 'frida_template', 'hexdump', 'strings'][i % 4], ok: i % 4 !== 1, ms: 240 + i * 17, preview: i % 4 === 1 ? 'no device attached' : 'bx lr — gate bypassed at 0x9c20', error: i % 4 === 1 ? 'device offline' : '' })
    case 4:
      return mkEv({ type: 'wire', phase: 'recv', model: 'claude-sonnet-5-5', endpoint: 'api.anthropic.com', ms: 880 + i * 13, tokens: 420 + i * 11 })
    default:
      return mkEv({ type: 'progress', progress: { kind: 'status', text: `turn step ${i} — ${THINK_POOL[(i + 2) % THINK_POOL.length].slice(0, 40)}…`, tool: '', status: '', usage: null, plan: null, planNote: '' } })
  }
}

// ---------- demo page ----------

function Toasts() {
  const { toast } = useSessionStore()
  if (!toast) return null
  const tone = toast.tone === 'err' ? 'var(--err)' : toast.tone === 'ok' ? 'var(--ok)' : 'var(--muted)'
  return (
    <div
      onClick={() => actions.dismissToast()}
      title="click to dismiss"
      style={{
        position: 'fixed',
        right: 14,
        bottom: 14,
        border: `1px solid ${tone}`,
        background: 'var(--bg-panel)',
        color: tone,
        fontSize: 12,
        padding: '8px 12px',
        maxWidth: 380,
        cursor: 'pointer',
        zIndex: 60,
      }}
    >
      {toast.tone === 'err' ? '✗' : toast.tone === 'ok' ? '✓' : '·'} {toast.text}
    </div>
  )
}

function Demo() {
  const { sessions, activeId } = useSessionStore()
  const active = activeId ? sessions.get(activeId) ?? null : null
  const [streaming, setStreaming] = useState(false)
  const seq = useRef(0)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  useEffect(() => {
    if (!streaming) return
    const iv = setInterval(() => {
      const id = activeIdRef.current
      if (!id) return
      __injectMockEvent({ sessionId: id, kind: 'loop', ts: Date.now(), data: [synth(seq.current++)] })
    }, 600)
    return () => clearInterval(iv)
  }, [streaming])

  const runtime = active
  const queueCount = runtime?.latestTick?.hud.queueCount ?? 0

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          border: '1px solid var(--rule)',
          background: 'var(--bg-panel)',
          padding: '6px 10px',
          fontSize: 12,
        }}
      >
        <span style={{ color: 'var(--accent)', letterSpacing: '0.12em' }}>▓▒░ WS4 · INTERACTION LAYER DEMO</span>
        <span style={{ color: hasBackend() ? 'var(--ok)' : 'var(--warn)' }}>
          {hasBackend() ? '● wails runtime' : '◐ browser dev — fake backend shim'}
        </span>
        <span style={{ flex: 1 }} />
        <DemoBtn onClick={() => runtime && __injectMockEvent(guiEvent('tick', tick('tool'), runtime.info.id))}>+ tick</DemoBtn>
        <DemoBtn onClick={() => runtime && __injectMockEvent(guiEvent('approval', { ...approval, requestID: `apr-${Date.now() % 10000}` }, runtime.info.id))}>
          + approval
        </DemoBtn>
        <DemoBtn onClick={() => setStreaming((v) => !v)} tone={streaming ? 'err' : 'ok'}>
          {streaming ? '■ stop stream' : '▶ stream'}
        </DemoBtn>
        <span style={{ color: 'var(--faint)' }}>store sessions: {sessions.size}</span>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '250px 1fr 300px', gap: 10 }}>
        <SessionSidebar width={248} />

        {/* transcript + prompt */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid var(--rule)',
              background: 'var(--bg-panel)',
            }}
          >
            <header
              style={{
                color: 'var(--muted)',
                fontSize: 11,
                letterSpacing: '0.12em',
                padding: '4px 10px',
                borderBottom: '1px solid var(--rule)',
                display: 'flex',
                gap: 10,
              }}
            >
              <span>╭─ TRANSCRIPT ─╮</span>
              {runtime && (
                <span style={{ color: 'var(--faint)' }}>
                  {runtime.info.id} · {runtime.lifecycle} · {runtime.loopBuffer.length} events
                  {runtime.pendingApproval ? ' · ⏸ awaiting approval' : ''}
                </span>
              )}
            </header>
            {runtime ? (
              <TranscriptStream runtime={runtime} />
            ) : (
              <div style={{ color: 'var(--faint)', fontSize: 12, padding: 12 }}>no active session</div>
            )}
          </div>
          <PromptInput sessionId={runtime?.info.id ?? null} running={runtime?.lifecycle === 'running'} queueCount={queueCount} />
        </section>

        {/* right rail */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'auto' }}>
          <REHudPanel re={runtime?.latestTick?.re ?? null} />
          <QueuePanel count={queueCount} />

          {runtime?.pendingApproval ? (
            <ApprovalDialog approval={runtime.pendingApproval} sessionId={runtime.info.id} inline />
          ) : (
            <div style={{ border: '1px dashed var(--rule)', color: 'var(--faint)', fontSize: 11, padding: 10 }}>
              ○ no pending approval — [+ approval] 注入一张
            </div>
          )}

          <div style={{ border: '1px solid var(--rule)', background: 'var(--bg-panel)', padding: '6px 10px' }}>
            <div style={{ color: 'var(--muted)', fontSize: 10, letterSpacing: '0.12em', marginBottom: 4 }}>THINK TAIL (store.thinkLines)</div>
            <div style={{ color: 'var(--faint)', fontSize: 11, lineHeight: 1.5 }}>
              {(runtime?.thinkLines.length ?? 0) === 0
                ? '— empty（thinking progress → store）'
                : runtime?.thinkLines.slice(-6).map((l, i) => <div key={`${i}-${l.slice(0, 12)}`}>· {l}</div>)}
            </div>
          </div>

          <div style={{ border: '1px solid var(--rule)', background: 'var(--bg-panel)', padding: '6px 10px' }}>
            <div style={{ color: 'var(--muted)', fontSize: 10, letterSpacing: '0.12em', marginBottom: 4 }}>NOTICES (sendCommand sink)</div>
            <div style={{ color: 'var(--faint)', fontSize: 11, lineHeight: 1.5 }}>
              {(runtime?.notices.length ?? 0) === 0
                ? '— empty（试 /queue 或 /help）'
                : runtime?.notices.slice(-6).map((n, i) => (
                    <div key={i} style={{ color: n.level === 'error' ? 'var(--err)' : 'var(--faint)' }}>
                      {n.level === 'error' ? '✗' : '·'} {n.text}
                    </div>
                  ))}
            </div>
          </div>
        </section>
      </div>

      <Toasts />
    </div>
  )
}

function DemoBtn({ onClick, tone = 'accent', children }: { onClick: () => void; tone?: 'accent' | 'ok' | 'err'; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none',
        border: `1px solid var(--${tone})`,
        color: `var(--${tone})`,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 11,
        padding: '2px 8px',
      }}
    >
      {children}
    </button>
  )
}

installFakeBackend()
seed()
createRoot(document.getElementById('root')!).render(<Demo />)
