// Pure usability helpers shared across TranscriptStream, ApprovalDialog,
// NewSessionDialog, ResumeDialog, and SettingsDialog.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalDTO, LoopEvent, SessionSummaryDTO } from '../../lib/types'

// ---------- clipboard ----------

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to execCommand fallback
  }
  if (typeof document === 'undefined') return false
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

export function useCopyFeedback(timeoutMs = 1600): {
  copiedKey: string | null
  copy: (key: string, text: string) => void
} {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const copy = useCallback(
    (key: string, text: string) => {
      void copyToClipboard(text).then((ok) => {
        if (!ok) return
        setCopiedKey(key)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          setCopiedKey((cur) => (cur === key ? null : cur))
          timerRef.current = null
        }, timeoutMs)
      })
    },
    [timeoutMs],
  )

  return { copiedKey, copy }
}

// ---------- TranscriptStream filtering & search ----------

export type TranscriptFilter = 'all' | 'assistant' | 'tools' | 'system' | 'errors'

export interface TranscriptCounts {
  all: number
  assistant: number
  tools: number
  system: number
  errors: number
}

export function isErrorEvent(ev: LoopEvent): boolean {
  if (ev.type === 'tool_end' && !ev.ok) return true
  if (ev.error && ev.error.trim().length > 0) return true
  return false
}

export function matchesTranscriptFilter(ev: LoopEvent, filter: TranscriptFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'assistant':
      return ev.type === 'reply' || ev.type === 'user'
    case 'tools':
      return ev.type === 'tool_start' || ev.type === 'tool_end'
    case 'system':
      return (
        ev.type === 'turn' ||
        ev.type === 'wire' ||
        ev.type === 'plan' ||
        ev.type === 'compaction' ||
        ev.type === 'progress'
      )
    case 'errors':
      return isErrorEvent(ev)
  }
}

export function countTranscriptEvents(events: readonly LoopEvent[]): TranscriptCounts {
  const counts: TranscriptCounts = { all: 0, assistant: 0, tools: 0, system: 0, errors: 0 }
  for (const ev of events) {
    counts.all += 1
    if (matchesTranscriptFilter(ev, 'assistant')) counts.assistant += 1
    if (matchesTranscriptFilter(ev, 'tools')) counts.tools += 1
    if (matchesTranscriptFilter(ev, 'system')) counts.system += 1
    if (isErrorEvent(ev)) counts.errors += 1
  }
  return counts
}

export function eventSearchText(ev: LoopEvent): string {
  const parts: string[] = [ev.type]
  if (ev.text) parts.push(ev.text)
  if (ev.name) parts.push(ev.name)
  if (ev.preview) parts.push(ev.preview)
  if (ev.error) parts.push(ev.error)
  if (ev.model) parts.push(ev.model)
  if (ev.endpoint) parts.push(ev.endpoint)
  if (ev.phase) parts.push(ev.phase)
  if (ev.reason) parts.push(ev.reason)
  if (ev.args) {
    try {
      parts.push(JSON.stringify(ev.args))
    } catch {
      // ignore cyclic args
    }
  }
  if (ev.progress) {
    if (ev.progress.kind) parts.push(ev.progress.kind)
    if (ev.progress.text) parts.push(ev.progress.text)
    if (ev.progress.tool) parts.push(ev.progress.tool)
  }
  if (ev.snapshot?.steps?.length) {
    for (const s of ev.snapshot.steps) {
      if (s.text) parts.push(s.text)
    }
  }
  return parts.join(' ').toLowerCase()
}

export function filterTranscriptIndices(
  events: readonly LoopEvent[],
  filter: TranscriptFilter,
  query: string,
): number[] {
  const q = query.trim().toLowerCase()
  const indices: number[] = []
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (!matchesTranscriptFilter(ev, filter)) continue
    if (q && !eventSearchText(ev).includes(q)) continue
    indices.push(i)
  }
  return indices
}

export function isVerboseToolPayload(text: string, args?: Record<string, unknown> | null): boolean {
  if (text.includes('\n') || text.length > 96) return true
  if (args && Object.keys(args).length > 1) return true
  return false
}

// ---------- ApprovalDialog forensic risk framing ----------

export interface ApprovalRiskMeta {
  tone: 'ok' | 'warn' | 'err' | 'violet'
  levelLabel: string
  category: string
  guidance: string
}

export const APPROVAL_RISK_META: Record<ApprovalDTO['risk'], ApprovalRiskMeta> = {
  read: {
    tone: 'ok',
    levelLabel: 'READ-ONLY',
    category: 'Low Impact',
    guidance: 'Inspects files or state without modifying the workspace.',
  },
  write: {
    tone: 'warn',
    levelLabel: 'FS WRITE',
    category: 'Modifies Workspace',
    guidance: 'Creates, patches, or overwrites files on disk.',
  },
  exec: {
    tone: 'violet',
    levelLabel: 'EXECUTION',
    category: 'Runs Host Process',
    guidance: 'Executes a shell command or binary with local permissions.',
  },
  network: {
    tone: 'err',
    levelLabel: 'NETWORK',
    category: 'External Egress',
    guidance: 'Contacts remote hosts or transfers data outside the sandbox.',
  },
}

export interface ApprovalForensics {
  meta: ApprovalRiskMeta
  workingDir: string | null
  targets: string[]
  signals: string[]
}

export function analyzeApproval(approval: ApprovalDTO): ApprovalForensics {
  const meta = APPROVAL_RISK_META[approval.risk] ?? APPROVAL_RISK_META.exec
  const raw = `${approval.argsPreview || ''}\n${approval.summary || ''}`

  // Working directory detection (cwd=..., dir=..., or leading `cd <dir> &&`)
  let workingDir: string | null = null
  const cwdMatch = raw.match(/(?:^|[\s,{])(?:cwd|workdir|dir)\s*[:=]\s*["']?([^"'\s,}]+)/i)
  if (cwdMatch?.[1]) {
    workingDir = cwdMatch[1]
  } else {
    const cdMatch = (approval.argsPreview || '').match(/^\s*cd\s+([^\s;&|]+)/)
    if (cdMatch?.[1]) workingDir = cdMatch[1]
  }

  // Extract notable target paths / URLs / redirected outputs (whole tokens, never mid-path slices)
  const preview = approval.argsPreview || ''
  const targetSet = new Set<string>()
  for (const m of preview.matchAll(/(?:^|[\s'"(=])(https?:\/\/[^\s'"]+|(?:~\/|\.\.?\/|\/|[a-zA-Z0-9_.-]+\/)[a-zA-Z0-9_./-]+|[a-zA-Z0-9_.-]+\.(?:bin|elf|so|apk|js|py|c|go|md|txt|json|sh|exe|dll|dylib))/g)) {
    const tok = (m[1] || '').replace(/[),.;:'"]+$/, '')
    if (tok.length > 1) targetSet.add(tok)
  }

  // Heuristic safety signals (non-blocking visual highlights)
  const signals: string[] = []
  if (/(?:^|[\s;|&])(?:rm|unlink|shred)\b/.test(preview)) signals.push('Destructive delete operation')
  if (/(?:^|[\s;|&])(?:sudo|su|chmod|chown)\b/.test(preview)) signals.push('Privilege or permission change')
  if (/(?:^|[\s;|&])(?:curl|wget|nc|ncat|ssh|scp|python3?\s+-m\s+http)\b|https?:\/\//.test(preview)) {
    signals.push('Network tool or remote URL referenced')
  }
  if (/(?:>>?)\s*\S+/.test(preview)) signals.push('Redirects output to a file')
  if (/\|/.test(preview)) signals.push('Shell pipeline')

  return {
    meta,
    workingDir,
    targets: Array.from(targetSet).slice(0, 6),
    signals,
  }
}

// ---------- Dialog validation & session metadata ----------

export function validateWorkspacePath(raw: string): { valid: boolean; level: 'ok' | 'warn' | 'info'; message: string } {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { valid: true, level: 'info', message: '留空将自动使用 $HOME 目录（不会落到系统根目录 /）' }
  }
  if (/[\n\r\0]/.test(trimmed)) {
    return { valid: false, level: 'warn', message: '路径包含非法换行或控制字符' }
  }
  if (!trimmed.startsWith('/') && !trimmed.startsWith('~') && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return {
      valid: true,
      level: 'warn',
      message: '建议使用绝对路径（/… 或 ~/…）或点击 browse…，避免相对路径歧义',
    }
  }
  return { valid: true, level: 'ok', message: `✓ 路径格式有效：${trimmed}` }
}

export function validateMaxTurns(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    return 'max turns 需为 1–200 之间的整数'
  }
  return null
}

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso.slice(0, 19).replace('T', ' ')
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return iso.slice(0, 10)
}

export function inferSessionBadge(row: SessionSummaryDTO): { label: string; tone: 'accent' | 'violet' | 'ok' | 'warn' } {
  const hay = `${row.workspace} ${row.firstPrompt}`.toLowerCase()
  if (/(android|apk|jni|\.so\b|dalvik|smali)/.test(hay)) return { label: 'RE · APK', tone: 'violet' }
  if (/(firmware|carrier\.bin|elf|packer|crackme|reverse|逆向|解包|binary)/.test(hay)) {
    return { label: 'RE · BIN', tone: 'accent' }
  }
  if (/(ctf|flag\{|0xaf\{|chall\.js|warmup)/.test(hay)) return { label: 'CTF', tone: 'ok' }
  if (/(audit|verify|writeup)/.test(hay)) return { label: 'AUDIT', tone: 'warn' }
  return { label: 'SESSION', tone: 'accent' }
}
