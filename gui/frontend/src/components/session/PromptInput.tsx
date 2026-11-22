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
import { api, isDemoAppActive } from '../../lib/api'
import { pushEsc } from '../../lib/escStack'
import { actions, hasBackend, pushSessionToast } from '../../store/sessions'
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

const NO_ARG_COMMANDS = new Set([
  '/help',
  '/status',
  '/tools',
  '/skills',
  '/providers',
  '/audit',
  '/phase',
  '/clear',
  '/tasks',
  '/queue',
  '/writeup',
  '/compact',
  '/sessions',
  '/new',
  '/version',
  '/workflow reverse',
  '/workflow off',
])

const ARG_REQUIRED_COMMANDS = new Set([
  '/theme',
  '/decode',
  '/scan',
  '/inspect',
  '/anti',
  '/diff',
  '/entropy',
  '/mitigations',
  '/hex',
  '/goal',
  '/cap',
  '/workflow',
  '/model',
  '/planner',
  '/executor',
  '/auditor',
  '/think',
])

export function shouldExecuteCommandOnEnter(
  rawValue: string,
  item: { replacement: string } | undefined,
): boolean {
  if (!item) return true
  const typed = rawValue.trim().toLowerCase()
  const target = item.replacement.trim().toLowerCase()
  if (!typed || typed !== target) return false
  if (NO_ARG_COMMANDS.has(typed)) return true
  if (ARG_REQUIRED_COMMANDS.has(typed)) return false
  return !item.replacement.endsWith(' ')
}

const BUILTIN_DEFS: ReadonlyArray<{ cmd: string; desc: string; takesArg?: boolean }> = [
  { cmd: '/help', desc: 'Show the command deck' },
  { cmd: '/status', desc: 'Show active session, workflow & tool status' },
  { cmd: '/theme', desc: 'Switch theme (deck/amber/matrix/nord/dracula/paper…)', takesArg: true },
  { cmd: '/workflow', desc: 'Pick RE workflow mode (/workflow reverse)', takesArg: true },
  { cmd: '/phase', desc: 'Show or advance the RE workflow phase' },
  { cmd: '/audit', desc: 'Run isolated adversarial evidence audit' },
  { cmd: '/writeup', desc: 'Generate evidence-cited reverse-engineering writeup' },
  { cmd: '/decode', desc: 'Direct decode/deobfuscate helper', takesArg: true },
  { cmd: '/scan', desc: 'Scan binary artifacts, strings & signatures', takesArg: true },
  { cmd: '/inspect', desc: 'Inspect section headers & binary metadata', takesArg: true },
  { cmd: '/entropy', desc: 'Compute section entropy & packed regions', takesArg: true },
  { cmd: '/anti', desc: 'Detect anti-debug / anti-analysis hotspots', takesArg: true },
  { cmd: '/diff', desc: 'Inspect binary patch diff & byte deltas', takesArg: true },
  { cmd: '/hex', desc: 'Dump hex bytes at target offset', takesArg: true },
  { cmd: '/mitigations', desc: 'Check binary hardening & mitigations', takesArg: true },
  { cmd: '/goal', desc: 'Inspect or configure RE goal criteria', takesArg: true },
  { cmd: '/cap', desc: 'Inspect sandbox capability policy', takesArg: true },
  { cmd: '/tools', desc: 'List available reverse-engineering tools' },
  { cmd: '/skills', desc: 'List loaded reverse-engineering skills' },
  { cmd: '/providers', desc: 'Show planner / executor / auditor routing' },
  { cmd: '/model', desc: 'Override a provider model', takesArg: true },
  { cmd: '/planner', desc: 'Set the planner provider', takesArg: true },
  { cmd: '/executor', desc: 'Set the executor provider', takesArg: true },
  { cmd: '/auditor', desc: 'Set the auditor provider', takesArg: true },
  { cmd: '/think', desc: 'Fold or expand the streamed reasoning', takesArg: true },
  { cmd: '/tasks', desc: 'Show or toggle the live task list' },
  { cmd: '/queue', desc: 'Manage queued prompts' },
  { cmd: '/compact', desc: 'Fold the session into a summary' },
  { cmd: '/clear', desc: 'Clear the current transcript stream' },
  { cmd: '/sessions', desc: 'List recent sessions' },
  { cmd: '/version', desc: 'Show 0xAF-Re build & tool version' },
  { cmd: '/new', desc: 'Clear the current session and start a fresh one' },
]

const CMD_DESC_MAP = new Map<string, string>(BUILTIN_DEFS.map((d) => [d.cmd, d.desc]))

const BUILTIN: PaletteItem[] = BUILTIN_DEFS.map(({ cmd, desc, takesArg }) => ({
  label: cmd,
  desc,
  replacement: takesArg ? `${cmd} ` : cmd,
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
  const canSend = Boolean(value.trim()) && !busy

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
    placeCaretAtEnd()
  }

  async function sendText(raw: string) {
    const text = raw.trim()
    if (!text || busy) return
    if (!sessionId) {
      setDismissed(true)
      setSendError('请先新建或选择一个会话')
      pushSessionToast('err', '请先新建或选择一个会话（左侧 + new）')
      return
    }
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
    setDismissed(true)
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
      if (e.key === 'Tab') {
        e.preventDefault()
        applyCompletion(items[active])
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (shouldExecuteCommandOnEnter(value, items[active])) {
          setDismissed(true)
          void send()
        } else {
          applyCompletion(items[active])
        }
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
        border: `1px solid ${flashGlow || dragOver ? 'var(--accent)' : running ? 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' : 'transparent'}`,
        boxShadow: flashGlow || dragOver ? '0 0 12px var(--accent-soft)' : 'none',
        background: 'transparent',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      {dragOver && (
        <div className="ix-drop-overlay" aria-live="polite">
          <span>◫</span>
          <span>释放以插入文件路径</span>
        </div>
      )}

      {sessionId && rePicker && (
        <REPickerDialog sessionId={sessionId} onClose={() => setRePicker(false)} />
      )}

      {/* queue hint — driven by hud.queueCount via the queueCount prop */}
      {running && queueCount > 0 && (
        <div
          style={{
            color: 'var(--accent)',
            fontSize: 11,
            padding: '5px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--accent-soft)',
          }}
        >
          ⠿ queued ({queueCount}) · 运行中提交的指令将自动排队
        </div>
      )}

      {/* shell escape hint — non-blocking */}
      {shellEscape && (
        <div
          style={{
            color: 'var(--warn)',
            fontSize: 11,
            padding: '5px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--warn-soft)',
          }}
        >
          {isDemoAppActive()
            ? '⚡ 演示沙盒支持 !cmd 快速模拟执行（完整交互终端请点左侧 + sh）'
            : '⚠ GUI 不支持 ! 逃逸，请使用左侧 + sh 内置终端'}
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
            className="ix-slash-popover"
            style={{
              bottom: anchor.bottom,
              left: anchor.left,
              width: anchor.width,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '5px 10px',
                fontSize: 10,
                letterSpacing: '0.08em',
                color: 'var(--faint)',
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--surface-2)',
                position: 'sticky',
                top: 0,
              }}
            >
              <span>COMMANDS · {items.length}</span>
              <span>↑↓ 选择 · Tab 补全 · ⏎ 执行/插入 · Esc 关闭</span>
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
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    background: i === active ? 'var(--accent-soft)' : 'transparent',
                    borderLeft: `2px solid ${i === active ? 'var(--accent)' : 'transparent'}`,
                  }}
                >
                  <span style={{ color: 'var(--accent)', minWidth: 104, fontWeight: i === active ? 600 : 500 }}>
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
        placeholder={running ? '当前回合运行中，输入内容将自动排队…' : '输入指令、/ 命令或拖入文件…'}
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
          padding: '10px 12px',
          overflow: 'auto',
          minHeight: LINE_H + 20,
        }}
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          fontSize: 10.5,
          color: 'var(--faint)',
          padding: '4px 12px 6px',
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          {running ? (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--accent)' }}>
                <Spinner ms={90} /> running
              </span>
              <button
                type="button"
                className="ix-prompt-stop-btn"
                onClick={() => void stop()}
                title="abort the current turn (queue survives)"
                data-hint="中止当前回合（队列中指令保留）"
                data-hint-side="top"
              >
                ■ stop
              </button>
            </>
          ) : (
            <span>○ idle</span>
          )}
          {modeBadge && !running && <span className={modeBadge.cls}>{modeBadge.label}</span>}
          {histCursor >= 0 && (
            <span
              className="ix-prompt-mode"
              data-hint="正在浏览历史输入，按 ↓ 返回草稿"
              data-hint-side="top"
            >
              {history.length - histCursor}/{history.length}
            </span>
          )}
          {sendError && (
            <span style={{ color: 'var(--err)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ✗ {sendError}
            </span>
          )}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span className="ix-prompt-hint">/ 命令 · ↑↓ 历史 · Enter 发送</span>
          <button
            type="button"
            className="ix-prompt-send-btn"
            disabled={!canSend}
            onMouseDown={(e) => {
              e.preventDefault()
            }}
            onClick={() => {
              setDismissed(true)
              void send()
            }}
            data-hint={
              !sessionId
                ? '请先在左侧新建或选择一个会话（+ new）'
                : running
                  ? '将当前指令加入执行队列'
                  : isSlashMode
                    ? '执行当前斜杠命令（Enter）'
                    : '发送给当前会话（Shift+Enter 换行）'
            }
            data-hint-kbd="Enter"
            data-hint-side="top"
          >
            {isSlashMode && !running ? '执行' : running ? '排队' : '发送'}
          </button>
        </span>
      </div>
    </div>
  )
}
