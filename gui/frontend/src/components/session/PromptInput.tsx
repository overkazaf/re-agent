// WS4 prompt input: auto-growing textarea (1-6 lines), SlashPalette over
// api.completions (builtin fallback table in browser-dev), Enter sends /
// Shift+Enter newline, queue hint bar driven by hud.queueCount, and a
// non-blocking `!` shell-escape warning (GUI v1 has no shell passthrough).
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api'
import { pushEsc } from '../../lib/escStack'
import { actions, hasBackend } from '../../store/sessions'
import { emitDemoSignal, onPromptFill } from '../../demo/signals'
import { Spinner } from '../crt'
import { REPickerDialog } from '../re'

const LINE_H = 19
const MAX_LINES = 6

interface PaletteItem {
  label: string
  desc?: string
  replacement: string
}

// Offline stand-in for internal/ui SlashCompletions (help.go entries).
const BUILTIN: PaletteItem[] = [
  { cmd: '/help', desc: 'Show the command deck' },
  { cmd: '/theme', desc: 'Switch palette (deck/amber/matrix/mono)' },
  { cmd: '/workflow', desc: 'Pick RE workflow mode' },
  { cmd: '/phase', desc: 'Show or advance the RE workflow phase' },
  { cmd: '/model', desc: 'Override a provider model' },
  { cmd: '/planner', desc: 'Set the planner provider' },
  { cmd: '/executor', desc: 'Set the executor provider' },
  { cmd: '/think', desc: 'Fold or expand the streamed reasoning' },
  { cmd: '/tasks', desc: 'Fold or expand the live task list' },
  { cmd: '/queue', desc: 'Manage queued prompts' },
  { cmd: '/compact', desc: 'Fold the session into a summary' },
  { cmd: '/sessions', desc: 'List recent sessions' },
  { cmd: '/new', desc: 'Clear the current session and start a fresh one' },
].map(({ cmd, desc }) => ({ label: cmd, desc, replacement: `${cmd} ` }))

function builtinCompletions(line: string): PaletteItem[] {
  const words = line.trim().split(/\s+/)
  if (words.length > 1 || /\s$/.test(line)) return [] // no arg data offline
  const frag = words[0] || '/'
  const hits = BUILTIN.filter((it) => it.label.startsWith(frag))
  return hits.length > 0 ? hits : BUILTIN
}

function fromApi(lines: string[]): PaletteItem[] {
  return lines.map((s) => ({ label: s, replacement: s }))
}

export function PromptInput({
  sessionId,
  running,
  queueCount = 0,
  style,
}: {
  sessionId: string | null
  running: boolean
  queueCount?: number
  style?: CSSProperties
}) {
  const [value, setValue] = useState('')
  const [items, setItems] = useState<PaletteItem[]>([])
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // bare "/workflow reverse" opens the GUI picker instead of hitting the
  // backend block — the argument form flows through send() normally
  const [rePicker, setRePicker] = useState(false)
  const [flashGlow, setFlashGlow] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const fetchSeq = useRef(0)
  // the palette portal-mounts to document.body: the prompt cell has
  // overflow:hidden and an absolute child popping above it gets clipped by
  // every ancestor edge. Anchor it to the input box's on-screen rect instead.
  const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number } | null>(null)

  const paletteOpen = value.startsWith('/') && !dismissed && items.length > 0
  const shellEscape = value.startsWith('!')

  // auto-grow 1..6 lines
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, LINE_H * MAX_LINES + 10)}px`
  }, [value])

  // completions (debounced), api first with builtin fallback in browser-dev
  useEffect(() => {
    if (!value.startsWith('/') || dismissed) {
      setItems([])
      return
    }
    const seq = ++fetchSeq.current
    const t = setTimeout(async () => {
      if (!hasBackend()) {
        setItems(builtinCompletions(value))
        return
      }
      try {
        const lines = await api.completions(value)
        if (seq !== fetchSeq.current) return
        setItems(lines.length > 0 ? fromApi(lines) : [])
      } catch {
        if (seq !== fetchSeq.current) return
        setItems([])
      }
    }, 70)
    return () => clearTimeout(t)
  }, [value, dismissed])

  useEffect(() => {
    setActive(0)
  }, [items])

  // Esc closes the palette through the shared stack — a dialog above us wins
  useEffect(() => {
    if (!paletteOpen) return
    return pushEsc(() => setDismissed(true))
  }, [paletteOpen])

  // track the input box rect while the palette is open (window resizes and
  // textarea auto-growth both move it)
  useEffect(() => {
    if (!paletteOpen) {
      setAnchor(null)
      return
    }
    const measure = () => {
      const el = boxRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setAnchor({ left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [paletteOpen, value])

  function applyCompletion(item: PaletteItem) {
    setValue(item.replacement)
    setDismissed(true)
    taRef.current?.focus()
  }

  async function sendText(raw: string) {
    const text = raw.trim()
    if (!text || !sessionId || busy) return
    // the terminal RE picker has no GUI stdin — bare /workflow reverse opens
    // the native dialog (exact, case-insensitive match only)
    if (text.toLowerCase() === '/workflow reverse') {
      setValue('')
      setDismissed(true)
      setRePicker(true)
      emitDemoSignal({ type: 're_picker_opened' })
      return
    }
    setBusy(true)
    setSendError(null)
    const res = text.startsWith('/')
      ? await actions.sendCommand(sessionId, text)
      : await actions.sendPrompt(sessionId, text)
    setBusy(false)
    if (res.ok) setValue('')
    else setSendError(res.error)
  }

  async function send() {
    await sendText(value)
  }

  // Subscribe to Demo Coach prompt-fill requests (fill-only or auto-send)
  const sendTextRef = useRef(sendText)
  sendTextRef.current = sendText
  useEffect(() => {
    let glowTimer: ReturnType<typeof setTimeout> | null = null
    const unsub = onPromptFill((req) => {
      if (req.autoSend) {
        setValue(req.text)
        setDismissed(true)
        void sendTextRef.current(req.text)
        return
      }
      setValue(req.text)
      setDismissed(true)
      setSendError(null)
      setFlashGlow(true)
      if (glowTimer) clearTimeout(glowTimer)
      glowTimer = setTimeout(() => setFlashGlow(false), 900)
      taRef.current?.focus()
    })
    return () => {
      unsub()
      if (glowTimer) clearTimeout(glowTimer)
    }
  }, [])

  async function stop() {
    if (!sessionId || busy) return
    await actions.interrupt(sessionId)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (paletteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (a + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a - 1 + items.length) % items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyCompletion(items[active])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div
      ref={boxRef}
      style={{
        border: `1px solid ${flashGlow ? 'var(--accent)' : running ? 'var(--accent-dim)' : 'var(--rule)'}`,
        boxShadow: flashGlow ? '0 0 14px var(--accent-dim)' : 'none',
        background: 'var(--bg-panel)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      {sessionId && rePicker && (
        <REPickerDialog sessionId={sessionId} onClose={() => setRePicker(false)} />
      )}
      {/* queue hint — driven by hud.queueCount via the queueCount prop */}
      {running && queueCount > 0 && (
        <div style={{ color: 'var(--accent)', fontSize: 11, padding: '4px 10px', borderBottom: '1px solid var(--rule)' }}>
          ⠿ queued ({queueCount}) · 运行中提交的 prompt 自动排队
        </div>
      )}

      {/* shell escape warning — non-blocking */}
      {shellEscape && (
        <div style={{ color: 'var(--warn)', fontSize: 11, padding: '4px 10px', borderBottom: '1px solid var(--rule)' }}>
          ⚠ shell 逃逸在 GUI v1 不支持，请用 TUI
        </div>
      )}

      {/* slash palette — portal so overflow:hidden ancestors can't clip it */}
      {paletteOpen && anchor && createPortal(
        <div
          style={{
            position: 'fixed',
            bottom: anchor.bottom,
            left: anchor.left,
            width: anchor.width,
            border: '1px solid var(--accent-dim)',
            background: 'var(--bg-panel)',
            boxShadow: '0 0 18px rgba(0, 0, 0, 0.6)',
            maxHeight: 220,
            overflow: 'auto',
            zIndex: 30,
          }}
        >
          {items.map((it, i) => (
            <div
              key={it.label}
              onMouseDown={(e) => {
                e.preventDefault()
                applyCompletion(it)
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex',
                gap: 10,
                padding: '4px 10px',
                fontSize: 12,
                cursor: 'pointer',
                background: i === active ? 'rgba(34, 211, 238, 0.08)' : 'transparent',
                borderLeft: `2px solid ${i === active ? 'var(--accent)' : 'transparent'}`,
              }}
            >
              <span style={{ color: 'var(--accent)', minWidth: 90 }}>{it.label}</span>
              {it.desc && <span style={{ color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.desc}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}

      <textarea
        ref={taRef}
        value={value}
        rows={1}
        onChange={(e) => {
          setValue(e.target.value)
          setDismissed(false)
          setSendError(null)
        }}
        onKeyDown={onKeyDown}
        placeholder={running ? '⠿ turn running — prompt will queue…' : 'message 0xAF · / for commands'}
        spellCheck={false}
        style={{
          background: 'transparent',
          border: 'none',
          outline: 'none',
          resize: 'none',
          color: 'var(--text)',
          font: 'inherit',
          fontSize: 13,
          lineHeight: `${LINE_H}px`,
          padding: '8px 10px',
          overflow: 'auto',
          minHeight: LINE_H + 16,
        }}
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 10,
          color: 'var(--faint)',
          padding: '3px 10px',
          borderTop: '1px solid var(--rule)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {running ? (
            <>
              <Spinner ms={90} /> running
              <button
                onClick={() => void stop()}
                title="abort the current turn (queue survives)"
                style={{
                  background: 'none',
                  border: '1px solid var(--err)',
                  color: 'var(--err)',
                  font: 'inherit',
                  fontSize: 10,
                  padding: '0 6px',
                  cursor: 'pointer',
                }}
              >
                ■ stop
              </button>
            </>
          ) : (
            '○ idle'
          )}
          {sendError && <span style={{ color: 'var(--err)' }}>✗ {sendError}</span>}
        </span>
        <span>enter 发送 · shift+enter 换行 · / 命令 · esc 关面板</span>
      </div>
    </div>
  )
}
