import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDemoAppAPI, type AppAPI } from '../lib/api'
import { setDemoEventsOnly } from '../lib/events'
import { DemoBackend } from '../demo/backend'
import type { CommandResultDTO, LoopEvent, SessionInfo } from '../lib/types'
import { shouldExecuteCommandOnEnter } from '../components/session/PromptInput'
import {
  LOOP_LIMIT,
  NOTICE_LIMIT,
  __injectMockEvent,
  __injectMockSession,
  actions,
  getSessionStoreSnapshot,
  resetSessionStoreForDemo,
} from './sessions'

function makeSessionInfo(id = 's-1'): SessionInfo {
  return {
    id,
    workspace: '/demo/test-ws',
    role: 'auto',
    workflow: 'auto',
    planner: 'codex-sol',
    executor: 'ds',
    lifecycle: 'idle',
  }
}

function makeLoopEv(text: string): LoopEvent {
  return {
    type: 'progress',
    turn: 0,
    provider: 'mock',
    phase: '',
    model: '',
    endpoint: '',
    messages: 0,
    tokens: 0,
    tools: 0,
    ms: 0,
    ok: true,
    toolCalls: 0,
    textChars: text.length,
    error: '',
    tokensBefore: 0,
    tokensAfter: 0,
    droppedMessages: 0,
    elidedToolResults: 0,
    progress: { kind: 'status', text, tool: '', status: '', usage: null, plan: null, planNote: '' },
    snapshot: null,
    text,
    usage: null,
    reason: '',
    name: '',
    args: null,
    preview: '',
  }
}

function stubSendCommand(impl: (id: string, line: string) => Promise<CommandResultDTO>): void {
  const partial: Partial<AppAPI> = {
    SendCommand: impl,
  }
  setDemoAppAPI(partial as AppAPI)
}

describe('actions.sendCommand visible feedback & capping', () => {
  beforeEach(() => {
    resetSessionStoreForDemo()
    setDemoAppAPI(null)
    __injectMockSession(makeSessionInfo('s-1'), true)
  })

  afterEach(() => {
    resetSessionStoreForDemo()
    setDemoAppAPI(null)
    vi.restoreAllMocks()
  })

  it('appends notices, transcript loopBuffer command+output entries, and ok toast on success', async () => {
    stubSendCommand(async () => ({
      ok: true,
      notices: [
        { level: 'info', text: 'session=s-1 workspace=/demo/test-ws workflow=auto turns=0' },
        { level: 'info', text: 're: sample=elf phase=triage [1/9]' },
      ],
    }))

    const res = await actions.sendCommand('s-1', '/status')
    expect(res.ok).toBe(true)

    const snap = getSessionStoreSnapshot()
    const rt = snap.sessions.get('s-1')!
    expect(rt.notices).toHaveLength(2)
    expect(rt.notices[0].text).toContain('session=s-1')

    expect(rt.loopBuffer).toHaveLength(2)
    expect(rt.loopTs).toHaveLength(2)
    expect(rt.firstLoopTs).not.toBeNull()

    expect(rt.loopBuffer[0].type).toBe('user')
    expect(rt.loopBuffer[0].phase).toBe('command')
    expect(rt.loopBuffer[0].text).toBe('/status')

    expect(rt.loopBuffer[1].type).toBe('reply')
    expect(rt.loopBuffer[1].phase).toBe('command')
    expect(rt.loopBuffer[1].name).toBe('/status')
    expect(rt.loopBuffer[1].ok).toBe(true)
    expect(rt.loopBuffer[1].text).toContain('session=s-1')
    expect(rt.loopBuffer[1].text).toContain('re: sample=elf')

    expect(snap.toast).not.toBeNull()
    expect(snap.toast!.tone).toBe('ok')
    expect(snap.toast!.text).toContain('/status')
    expect(snap.toast!.text).toContain('session=s-1')
  })

  it('records error in notices, loopBuffer, and err toast and returns { ok: false, error } when res.ok is false', async () => {
    stubSendCommand(async () => ({
      ok: false,
      notices: [{ level: 'error', text: '未知命令: /xyz — 输入 /help 查看可用命令' }],
    }))

    const res = await actions.sendCommand('s-1', '/xyz')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('未知命令: /xyz')
    }

    const snap = getSessionStoreSnapshot()
    const rt = snap.sessions.get('s-1')!
    expect(rt.notices).toHaveLength(1)
    expect(rt.notices[0].level).toBe('error')

    expect(rt.loopBuffer).toHaveLength(2)
    expect(rt.loopBuffer[0].type).toBe('user')
    expect(rt.loopBuffer[0].text).toBe('/xyz')
    expect(rt.loopBuffer[1].type).toBe('reply')
    expect(rt.loopBuffer[1].phase).toBe('command')
    expect(rt.loopBuffer[1].ok).toBe(false)
    expect(rt.loopBuffer[1].error).toContain('未知命令: /xyz')

    expect(snap.toast).not.toBeNull()
    expect(snap.toast!.tone).toBe('err')
    expect(snap.toast!.text).toContain('未知命令: /xyz')
  })

  it('still appends visible fallback output and toast when backend returns empty notices', async () => {
    stubSendCommand(async () => ({ ok: true, notices: [] }))

    const res = await actions.sendCommand('s-1', '/compact')
    expect(res.ok).toBe(true)

    const snap = getSessionStoreSnapshot()
    const rt = snap.sessions.get('s-1')!
    expect(rt.loopBuffer).toHaveLength(2)
    expect(rt.loopBuffer[1].text).toContain('/compact')
    expect(snap.toast?.tone).toBe('ok')
    expect(snap.toast?.text).toContain('/compact')
  })

  it('records error in notices, loopBuffer, and err toast when api.sendCommand rejects', async () => {
    stubSendCommand(async () => {
      throw new Error('bridge offline')
    })

    const res = await actions.sendCommand('s-1', '/help')
    expect(res.ok).toBe(false)

    const snap = getSessionStoreSnapshot()
    const rt = snap.sessions.get('s-1')!
    expect(rt.notices).toHaveLength(1)
    expect(rt.notices[0].level).toBe('error')
    expect(rt.loopBuffer).toHaveLength(2)
    expect(rt.loopBuffer[1].ok).toBe(false)
    expect(rt.loopBuffer[1].error).toContain('bridge offline')
    expect(snap.toast?.tone).toBe('err')
    expect(snap.toast?.text).toContain('bridge offline')
  })

  it('clears prior loopBuffer on /clear while keeping the clear confirmation visible', async () => {
    __injectMockEvent({
      sessionId: 's-1',
      kind: 'loop',
      ts: 1000,
      data: [makeLoopEv('old line 1'), makeLoopEv('old line 2')],
    })
    expect(getSessionStoreSnapshot().sessions.get('s-1')!.loopBuffer).toHaveLength(2)

    stubSendCommand(async () => ({
      ok: true,
      notices: [{ level: 'info', text: 'transcript cleared' }],
    }))

    const res = await actions.sendCommand('s-1', '/clear')
    expect(res.ok).toBe(true)

    const rt = getSessionStoreSnapshot().sessions.get('s-1')!
    expect(rt.loopBuffer).toHaveLength(2)
    expect(rt.loopBuffer[0].text).toBe('/clear')
    expect(rt.loopBuffer[1].text).toContain('transcript cleared')
    expect(rt.loopTs).toHaveLength(2)
  })

  it('preserves LOOP_LIMIT and NOTICE_LIMIT ring-buffer capping', async () => {
    // Seed near LOOP_LIMIT and NOTICE_LIMIT
    const initialLoop: LoopEvent[] = []
    for (let i = 0; i < LOOP_LIMIT; i += 1) {
      initialLoop.push(makeLoopEv(`seed-${i}`))
    }
    __injectMockEvent({
      sessionId: 's-1',
      kind: 'loop',
      ts: 1000,
      data: initialLoop,
    })
    for (let i = 0; i < NOTICE_LIMIT; i += 1) {
      __injectMockEvent({
        sessionId: 's-1',
        kind: 'notice',
        ts: 1000 + i,
        data: { level: 'info', text: `notice-${i}` },
      })
    }

    stubSendCommand(async () => ({
      ok: true,
      notices: [
        { level: 'info', text: 'fresh-notice-1' },
        { level: 'info', text: 'fresh-notice-2' },
      ],
    }))

    await actions.sendCommand('s-1', '/tools')

    const rt = getSessionStoreSnapshot().sessions.get('s-1')!
    expect(rt.loopBuffer).toHaveLength(LOOP_LIMIT)
    expect(rt.loopTs).toHaveLength(LOOP_LIMIT)
    expect(rt.loopBuffer[rt.loopBuffer.length - 2].text).toBe('/tools')
    expect(rt.loopBuffer[rt.loopBuffer.length - 1].text).toContain('fresh-notice-1')

    expect(rt.notices).toHaveLength(NOTICE_LIMIT)
    expect(rt.notices[rt.notices.length - 1].text).toBe('fresh-notice-2')
    expect(rt.notices[0].text).toBe('notice-2')
  })
})

describe('PromptInput slash Enter execution rules', () => {
  it('executes exact no-arg commands immediately even when replacement includes trailing space', () => {
    expect(shouldExecuteCommandOnEnter('/help', { replacement: '/help ' })).toBe(true)
    expect(shouldExecuteCommandOnEnter('/status', { replacement: '/status' })).toBe(true)
    expect(shouldExecuteCommandOnEnter('/tools', { replacement: '/tools ' })).toBe(true)
    expect(shouldExecuteCommandOnEnter('/audit', { replacement: '/audit' })).toBe(true)
    expect(shouldExecuteCommandOnEnter('/clear', { replacement: '/clear ' })).toBe(true)
    expect(shouldExecuteCommandOnEnter('/workflow reverse', { replacement: '/workflow reverse' })).toBe(true)
  })

  it('completes instead of executing for partial commands or commands requiring arguments', () => {
    expect(shouldExecuteCommandOnEnter('/he', { replacement: '/help ' })).toBe(false)
    expect(shouldExecuteCommandOnEnter('/st', { replacement: '/status' })).toBe(false)
    expect(shouldExecuteCommandOnEnter('/theme', { replacement: '/theme ' })).toBe(false)
    expect(shouldExecuteCommandOnEnter('/decode', { replacement: '/decode ' })).toBe(false)
    expect(shouldExecuteCommandOnEnter('/scan', { replacement: '/scan ' })).toBe(false)
    expect(shouldExecuteCommandOnEnter('/goal', { replacement: '/goal ' })).toBe(false)
    expect(shouldExecuteCommandOnEnter('/decode base64', { replacement: '/decode base64 ' })).toBe(false)
  })

  it('executes exact completed command with argument when no further arg is expected', () => {
    expect(shouldExecuteCommandOnEnter('/theme amber', { replacement: '/theme amber' })).toBe(true)
    expect(shouldExecuteCommandOnEnter('/phase next', { replacement: '/phase next' })).toBe(true)
  })
})

describe('DemoBackend command & shell escape coverage', () => {
  it('lists all 10 themes in /help, rejects unknown /xyz with ok=false, and handles !cmd shell escape', async () => {
    const backend = new DemoBackend()
    setDemoEventsOnly(true)
    setDemoAppAPI(backend)
    resetSessionStoreForDemo()
    try {
      const created = await actions.createSession({
        workspace: '/demo/welcome',
        role: 'auto',
        workflow: 'auto',
        mock: true,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const sid = created.value.id

      const helpRes = await actions.sendCommand(sid, '/help')
      expect(helpRes.ok).toBe(true)
      if (helpRes.ok) {
        const joined = helpRes.value.notices.map((n) => n.text).join('\n')
        for (const theme of ['deck', 'amber', 'matrix', 'mono', 'obsidian', 'nord', 'dracula', 'solarized', 'crimson', 'paper']) {
          expect(joined).toContain(theme)
        }
      }

      const unknownRes = await actions.sendCommand(sid, '/xyz')
      expect(unknownRes.ok).toBe(false)
      if (!unknownRes.ok) {
        expect(unknownRes.error).toBe('未知命令: /xyz — 输入 /help 查看可用命令')
      }
      expect(getSessionStoreSnapshot().toast?.tone).toBe('err')

      const shellRes = await actions.sendPrompt(sid, '!ls -la')
      expect(shellRes.ok).toBe(true)
      const rt = getSessionStoreSnapshot().sessions.get(sid)!
      const hasShellReply = rt.loopBuffer.some((ev) => ev.type === 'reply' && ev.text.includes('chall.js'))
      expect(hasShellReply).toBe(true)
    } finally {
      backend.dispose()
      setDemoAppAPI(null)
      setDemoEventsOnly(false)
      resetSessionStoreForDemo()
    }
  })
})
