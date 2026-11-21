// WS4 prompt input: auto-growing textarea (1-6 lines), fuzzy SlashPalette over
// api.completions (enriched with descriptions + builtin fallback), command/prompt
// history navigation (Up/Down on first/last line), drag-and-drop binary path
// insertion, mode/queue/stop/send affordances, and non-blocking `!` warning.
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api'
import { pushEsc } from '../../lib/escStack'
import { actions, hasBackend } from '../../store/sessions'
import { emitDemoSignal, onPromptFill } from '../../demo/signals'
import { Spinner } from '../crt'
import { REPickerDialog } from '../re'
import {
  fuzzyMatch,
  IX_EVENT_FOCUS_PROMPT,
  IX_EVENT_OPEN_RE_PICKER,
  splitHighlightSegments,
} from '../shell/shortcuts'
import '../shell/interaction.css'

const LINE_H = 19
const MAX_LINES = 6
const HISTORY_KEY = '0xaf-prompt-history-v1'
const HISTORY_LIMIT = 50

interface PaletteItem {
  label: string
  desc?: string
  replacement: string
  matchIndices?: number[]
}

const BUILTIN_DEFS: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: '/help', desc: 'Show the command deck' },
  { cmd: '/theme', desc: 'Switch palette (deck/amber/matrix/mono)' },
  { cmd: '/workflow', desc: 'Pick RE workflow mode (/workflow reverse)' },
  { cmd: '/phase', desc: 'Show or advance the RE workflow phase' },
  { cmd: '/audit', desc: 'Run isolated adversarial evidence audit' },
  { cmd: '/decode', desc: 'Direct decode/deobfuscate helper' },
  { cmd: '/scan', desc: 'Scan binary artifacts, strings & signatures' },
  { cmd: '/inspect', desc: 'Inspect section headers & binary metadata' },
  { cmd: '/entropy', desc: 'Compute section entropy & packed regions' },
  { cmd: '/anti', desc: 'Detect anti-debug / anti-analysis hotspots' },
  { cmd: '/diff', desc: 'Inspect binary patch diff & byte deltas' },
  { cmd: '/goal', desc: 'Inspect or configure RE goal criteria' },
  { cmd: '/cap', desc: 'Inspect sandbox capability policy' },
  { cmd: '/tools', desc: 'List available reverse-engineering tools' },
  { cmd: '/model', desc: 'Override a provider model' },
  { cmd: '/planner', desc: 'Set the planner provider' },
  { cmd: '/executor', desc: 'Set the executor provider' },
  { cmd: '/think', desc: 'Fold or expand the streamed reasoning' },
  { cmd: '/tasks', desc: 'Fold or expand the live task list' },
  { cmd: '/queue', desc: 'Manage queued prompts' },
  { cmd: '/compact', desc: 'Fold the session into a summary' },
  { cmd: '/sessions', desc: 'List recent sessions' },
  { cmd: '/new', desc: 'Clear the current session and start a fresh one' },
]

const CMD_DESC_MAP = new Map<string, string>(BUILTIN_DEFS.map((d) => [d.cmd, d.desc]))

const BUILTIN: PaletteItem[] = BUILTIN_DEFS.map(({ cmd, desc }) => ({
  label: cmd,
  desc,
  replacement: `${cmd} `,
}))

function builtinCompletions(line: string): PaletteItem[] {
  const words = line.trim().split(/\s+/)
  if (words.length > 1 || /\s$/.test(line)) return [] // no arg data offline
  const frag = words[0] || '/'
  if (frag === '/') return BUILTIN

  const scored: Array<{ item: PaletteItem; score: number }> = []
  for (const it of BUILTIN) {
    const mCmd = fuzzyMatch(frag, it.label)
    const mDesc = it.desc ? fuzzyMatch(frag.replace(/^\//, ''), it.desc) : { matched: false, score: -1, indices: [] }
    if (!mCmd.matched && !mDesc.matched) continue
    scored.push({
      item: { ...it, matchIndices: mCmd.matched ? mCmd.indices : [] },
      score: mCmd.matched ? mCmd.score + 50 : mDesc.score,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.length > 0 ? scored.map((s) => s.item) : BUILTIN
}

function fromApi(lines: string[], query: string): PaletteItem[] {
  const frag = query.trim().split(/\s+/)[0] || ''
  return lines.map((s) => {
    const cmd = s.trim().split(/\s+/)[0] || s.trim()
    const desc = CMD_DESC_MAP.get(cmd)
    const match = frag.length > 1 ? fuzzyMatch(frag, s) : null
    return {
      label: s,
      desc,
      replacement: s,
      matchIndices: match?.matched ? match.indices : [],
    }
  })
}

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(-HISTORY_LIMIT)
      : []
  } catch {
    return []
  }
}

function saveHistory(list: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-HISTORY_LIMIT)))
  } catch {
    // ignore storage limits
  }
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
  const [rePicker, setRePicker] = useState(false)
  const [flashGlow, setFlashGlow] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  // Prompt/command history navigation state
  const [history, setHistory] = useState<string[]>(loadHistory)
  const [histCursor, setHistCursor] = useState<number>(-1) // -1 = live draft, 0..N-1 = offset from end
  const draftRef = useRef('')

  const taRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const fetchSeq = useRef(0)
  const dragDepthRef = useRef(0)
  const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number } | null>(null)

  const paletteOpen = value.startsWith('/') && !dismissed && items.length > 0
  const shellEscape = value.startsWith('!')
  const isSlashMode = value.startsWith('/')
  const canSend = Boolean(value.trim()) && Boolean(sessionId) && !busy

  // auto-grow 1..6 lines
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, LINE_H * MAX_LINES + 10)}px`
  }, [value])

  // Global focus / RE-picker triggers from Command Palette & `/` shortcut
  useEffect(() => {
    const onFocusReq = () => {
      taRef.current?.focus()
    }
    const onPickerReq = () => {
      if (!sessionId) return
      setRePicker(true)
      emitDemoSignal({ type: 're_picker_opened' })
    }
    window.addEventListener(IX_EVENT_FOCUS_PROMPT, onFocusReq)
    window.addEventListener(IX_EVENT_OPEN_RE_PICKER, onPickerReq)
    return () => {
      window.removeEventListener(IX_EVENT_FOCUS_PROMPT, onFocusReq)
      window.removeEventListener(IX_EVENT_OPEN_RE_PICKER, onPickerReq)
    }
  }, [sessionId])

  // completions (debounced), api first with builtin fuzzy fallback in browser-dev
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
        setItems(lines.length > 0 ? fromApi(lines, value) : [])
      } catch {
        if (seq !== fetchSeq.current) return
        setItems([])
      }
    }, 60)
    return () => clearTimeout(t)
  }, [value, dismissed])

  useEffect(() => {
    setActive(0)
  }, [items])

  // Keep active slash item scrolled into view during Up/Down selection
  useEffect(() => {
    if (!paletteOpen) return
    const el = paletteRef.current?.querySelector<HTMLElement>(`[data-slash-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, paletteOpen])

  // Esc closes the palette through the shared stack — a dialog above us wins
  useEffect(() => {
    if (!paletteOpen) return
    return pushEsc(() => setDismissed(true))
  }, [paletteOpen])

  // track the input box rect while the palette is open
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

  function recordHistory(entry: string) {
    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === entry) return prev
      const next = prev.concat(entry).slice(-HISTORY_LIMIT)
      saveHistory(next)
      return next
    })
    setHistCursor(-1)
    draftRef.current = ''
  }

  function applyCompletion(item: PaletteItem) {
    setValue(item.replacement)
    setDismissed(true)
    setHistCursor(-1)
    taRef.current?.focus()
  }

  async function sendText(raw: string) {
    const text = raw.trim()
    if (!text || !sessionId || busy) return
    recordHistory(text)
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
        setHistCursor(-1)
        void sendTextRef.current(req.text)
        return
      }
      setValue(req.text)
      setDismissed(true)
      setHistCursor(-1)
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

  function placeCaretAtEnd() {
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      const len = el.value.length
      el.setSelectionRange(len, len)
    })
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

    // History navigation on first line (ArrowUp) / last line (ArrowDown)
    if (!paletteOpen && e.key === 'ArrowUp' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = e.currentTarget
      const beforeCaret = value.slice(0, el.selectionStart)
      if (!beforeCaret.includes('\n') && history.length > 0) {
        e.preventDefault()
        if (histCursor === -1) {
          draftRef.current = value
        }
        const nextCursor = Math.min(histCursor + 1, history.length - 1)
        setHistCursor(nextCursor)
        setValue(history[history.length - 1 - nextCursor])
        setDismissed(true)
        placeCaretAtEnd()
        return
      }
    }

    if (!paletteOpen && e.key === 'ArrowDown' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = e.currentTarget
      const afterCaret = value.slice(el.selectionEnd)
      if (!afterCaret.includes('\n') && histCursor >= 0) {
        e.preventDefault()
        const nextCursor = histCursor - 1
        setHistCursor(nextCursor)
        setValue(nextCursor < 0 ? draftRef.current : history[history.length - 1 - nextCursor])
        setDismissed(true)
        placeCaretAtEnd()
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // Drag-and-drop binary/file path insertion
  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    const names = Array.from(e.dataTransfer.files).map((f) => {
      const withPath = f as File & { path?: string }
      const raw = withPath.path || f.name
      return /\s/.test(raw) ? `"${raw}"` : raw
    })
    const snippet = names.join(' ')
    setValue((prev) => {
      const trimmed = prev.trim()
      return trimmed ? `${prev}${prev.endsWith(' ') ? '' : ' '}${snippet}` : `分析目标样本 ${snippet} `
    })
    setDismissed(true)
    setHistCursor(-1)
    setFlashGlow(true)
    setTimeout(() => setFlashGlow(false), 600)
    taRef.current?.focus()
    placeCaretAtEnd()
  }

  const modeBadge = shellEscape
    ? { label: 'SHELL !', cls: 'ix-prompt-mode ix-prompt-mode--shell' }
    : isSlashMode
      ? { label: 'CMD', cls: 'ix-prompt-mode ix-prompt-mode--cmd' }
      : running && value.trim().length > 0
        ? { label: 'QUEUE', cls: 'ix-prompt-mode ix-prompt-mode--queue' }
        : null

  return (
    <div
      ref={boxRef}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        border: `1px solid ${flashGlow || dragOver ? 'var(--accent)' : running ? 'var(--accent-dim)' : 'var(--rule)'}`,
        boxShadow: flashGlow || dragOver ? '0 0 14px var(--accent-dim)' : 'none',
        background: 'var(--bg-panel)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      {dragOver && (
        <div className="ix-drop-overlay" aria-live="polite">
          <span>◫</span>
          <span>释放以将样本 / 二进制文件路径插入 Prompt</span>
        </div>
      )}

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
          ⚠ shell 逃逸在 GUI v1 不支持，请用左侧 [+ sh] 内置终端或 TUI
        </div>
      )}

      {/* slash palette — portal so overflow:hidden ancestors can't clip it */}
      {paletteOpen &&
        anchor &&
        createPortal(
          <div
            ref={paletteRef}
            role="listbox"
            aria-label="Slash command completions"
            style={{
              position: 'fixed',
              bottom: anchor.bottom,
              left: anchor.left,
              width: anchor.width,
              border: '1px solid var(--accent-dim)',
              background: 'color-mix(in srgb, var(--bg) 82%, var(--bg-panel))',
              boxShadow: '0 0 20px rgba(0, 0, 0, 0.7)',
              maxHeight: 248,
              overflow: 'auto',
              zIndex: 35,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '3px 10px',
                fontSize: 10,
                letterSpacing: '0.08em',
                color: 'var(--faint)',
                borderBottom: '1px solid var(--rule)',
                background: 'color-mix(in srgb, var(--bg) 72%, transparent)',
                position: 'sticky',
                top: 0,
              }}
            >
              <span>COMMANDS · {items.length}</span>
              <span>↑↓ 选择 · tab/⏎ 插入 · esc 关闭</span>
            </div>
            {items.map((it, i) => {
              const segs = splitHighlightSegments(it.label, it.matchIndices ?? [])
              return (
                <div
                  key={it.label}
                  data-slash-idx={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applyCompletion(it)
                  }}
                  onMouseEnter={() => setActive(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '5px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    background: i === active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                    borderLeft: `2px solid ${i === active ? 'var(--accent)' : 'transparent'}`,
                  }}
                >
                  <span style={{ color: 'var(--accent)', minWidth: 104, fontWeight: i === active ? 600 : 400 }}>
                    {segs.map((seg, si) =>
                      seg.hit ? (
                        <span key={si} className="ix-palette-match">
                          {seg.text}
                        </span>
                      ) : (
                        <span key={si}>{seg.text}</span>
                      ),
                    )}
                  </span>
                  {it.desc && (
                    <span
                      style={{
                        color: i === active ? 'var(--muted)' : 'var(--faint)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 11,
                      }}
                    >
                      {it.desc}
                    </span>
                  )}
                </div>
              )
            })}
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
          setHistCursor(-1)
          setSendError(null)
        }}
        onKeyDown={onKeyDown}
        placeholder={
          running
            ? '⠿ turn running — prompt will queue · ↑ history'
            : 'message 0xAF · / commands · ↑ history · drop binary path'
        }
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
          gap: 8,
          fontSize: 10,
          color: 'var(--faint)',
          padding: '3px 10px',
          borderTop: '1px solid var(--rule)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {running ? (
            <>
              <Spinner ms={90} /> running
              <button
                type="button"
                className="ix-btn"
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
          {modeBadge && <span className={modeBadge.cls}>{modeBadge.label}</span>}
          {histCursor >= 0 && (
            <span className="ix-prompt-mode" title="正在浏览历史输入，按 ↓ 返回草稿">
              HIST {history.length - histCursor}/{history.length}
            </span>
          )}
          {sendError && (
            <span style={{ color: 'var(--err)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ✗ {sendError}
            </span>
          )}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span>enter 发送 · shift+enter 换行 · ↑↓ 历史 · / 命令</span>
          <button
            type="button"
            className="ix-prompt-send-btn ix-btn"
            disabled={!canSend}
            onClick={() => void send()}
            title={running ? '加入执行队列 (Enter)' : '发送给当前会话 (Enter)'}
          >
            {running ? '⠿ queue' : '⏎ send'}
          </button>
        </span>
      </div>
    </div>
  )
}
