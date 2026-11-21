import { describe, expect, it } from 'vitest'
import type { ApprovalDTO, LoopEvent, SessionSummaryDTO } from '../../lib/types'
import {
  analyzeApproval,
  countTranscriptEvents,
  filterTranscriptIndices,
  formatRelativeTime,
  inferSessionBadge,
  isVerboseToolPayload,
  validateMaxTurns,
  validateWorkspacePath,
} from './usabilityHelpers'

function makeEvent(over: Partial<LoopEvent>): LoopEvent {
  return {
    type: 'progress',
    turn: 1,
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
    ...over,
  }
}

describe('transcript usability helpers', () => {
  const sample: LoopEvent[] = [
    makeEvent({ type: 'user', text: 'inspect carrier.bin' }),
    makeEvent({ type: 'wire', phase: 'send', model: 'codex-sol', tokens: 1200 }),
    makeEvent({ type: 'tool_start', name: 'strings', args: { file: 'carrier.bin' }, preview: 'strings carrier.bin' }),
    makeEvent({ type: 'tool_end', name: 'strings', ok: true, ms: 42, preview: '0xaf{found_it}' }),
    makeEvent({ type: 'tool_end', name: 'run_command', ok: false, ms: 3, error: 'denied by sandbox' }),
    makeEvent({ type: 'reply', text: 'Found flag `0xaf{found_it}` at 0x401000', textChars: 38 }),
  ]

  it('counts all forensic categories accurately', () => {
    expect(countTranscriptEvents(sample)).toEqual({
      all: 6,
      assistant: 2,
      tools: 3,
      system: 1,
      errors: 1,
    })
  })

  it('filters by category and free-text query across args/errors/replies', () => {
    expect(filterTranscriptIndices(sample, 'errors', '')).toEqual([4])
    expect(filterTranscriptIndices(sample, 'tools', '0xaf{found_it}')).toEqual([3])
    expect(filterTranscriptIndices(sample, 'all', 'sandbox')).toEqual([4])
    expect(filterTranscriptIndices(sample, 'assistant', '0x401000')).toEqual([5])
    expect(filterTranscriptIndices(sample, 'system', 'codex')).toEqual([1])
  })

  it('detects verbose tool payloads for collapsible rendering', () => {
    expect(isVerboseToolPayload('short output', null)).toBe(false)
    expect(isVerboseToolPayload('line1\nline2', null)).toBe(true)
    expect(isVerboseToolPayload('a'.repeat(120), null)).toBe(true)
    expect(isVerboseToolPayload('short', { a: 1, b: 2 })).toBe(true)
  })
})

describe('approval forensic analyzer', () => {
  it('extracts working dir, file targets, and risk signals', () => {
    const dto: ApprovalDTO = {
      requestID: 'apr-0001',
      toolName: 'run_command',
      risk: 'exec',
      summary: 'cwd=/tmp/re-lab run curl check',
      argsPreview: 'curl --version > smoke-ok.txt',
    }
    const res = analyzeApproval(dto)
    expect(res.meta.levelLabel).toBe('EXECUTION')
    expect(res.workingDir).toBe('/tmp/re-lab')
    expect(res.targets).toContain('smoke-ok.txt')
    expect(res.signals).toContain('Network tool or remote URL referenced')
    expect(res.signals).toContain('Redirects output to a file')
  })

  it('detects cd working dir and read-only risk meta', () => {
    const dto: ApprovalDTO = {
      requestID: 'apr-0002',
      toolName: 'read_file',
      risk: 'read',
      summary: 'read binary header',
      argsPreview: 'cd /demo/welcome && head -n 5 chall.js',
    }
    const res = analyzeApproval(dto)
    expect(res.meta.tone).toBe('ok')
    expect(res.workingDir).toBe('/demo/welcome')
    expect(res.targets).toContain('chall.js')
  })

  it('keeps relative multi-segment paths intact without slicing at slash', () => {
    const dto: ApprovalDTO = {
      requestID: 'apr-0003',
      toolName: 'run_command',
      risk: 'exec',
      summary: 'verify and write',
      argsPreview: "command: node chall.js '0xaf{warmup_deck}'\nwrite: notes/solve.md (342 bytes)",
    }
    const res = analyzeApproval(dto)
    expect(res.targets).toContain('chall.js')
    expect(res.targets).toContain('notes/solve.md')
    expect(res.targets).not.toContain('/solve.md')
  })
})

describe('dialog validation & resume metadata helpers', () => {
  it('validates workspace paths with actionable guidance', () => {
    expect(validateWorkspacePath('').level).toBe('info')
    expect(validateWorkspacePath('/tmp/ws').level).toBe('ok')
    expect(validateWorkspacePath('~/projects').level).toBe('ok')
    expect(validateWorkspacePath('relative/dir').level).toBe('warn')
    expect(validateWorkspacePath('bad\npath').valid).toBe(false)
  })

  it('validates maxTurns range 1..200', () => {
    expect(validateMaxTurns(30)).toBeNull()
    expect(validateMaxTurns(1)).toBeNull()
    expect(validateMaxTurns(200)).toBeNull()
    expect(validateMaxTurns(0)).not.toBeNull()
    expect(validateMaxTurns(201)).not.toBeNull()
  })

  it('formats relative times and infers session badges', () => {
    const now = Date.parse('2026-11-22T12:00:00Z')
    expect(formatRelativeTime('2026-11-22T11:59:30Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-11-22T11:45:00Z', now)).toBe('15m ago')
    expect(formatRelativeTime('2026-11-22T09:00:00Z', now)).toBe('3h ago')
    expect(formatRelativeTime('2026-11-20T12:00:00Z', now)).toBe('2d ago')

    const row: SessionSummaryDTO = {
      id: 's1',
      hash: 'a9f3c1e2',
      updatedAt: '2026-11-22T11:00:00Z',
      messages: 12,
      workspace: '/demo/android-sign',
      firstPrompt: 'trace JNI_OnLoad',
    }
    expect(inferSessionBadge(row).label).toBe('RE · APK')
  })
})
