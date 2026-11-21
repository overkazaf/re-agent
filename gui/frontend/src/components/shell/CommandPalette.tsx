// Global keyboard-first Command Palette (Cmd/Ctrl+K):
// Fuzzy-searchable command launcher covering views, panes, themes, sessions,
// RE workflows, and slash commands. Integrated with escStack for predictable
// LIFO dismissal and clean focus restoration.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { pushEsc } from '../../lib/escStack'
import { formatChord, fuzzyMatch, isMacPlatform, splitHighlightSegments } from './shortcuts'
import './interaction.css'

export interface CommandItem {
  id: string
  group: string
  label: string
  desc?: string
  icon?: string
  keywords?: string
  shortcut?: readonly string[]
  badge?: string
  badgeTone?: 'ok' | 'warn'
  /** If true, the command handles its own focus target so palette won't restore old focus */
  managesFocus?: boolean
  run: () => void
}

interface RankedCommand {
  item: CommandItem
  score: number
  labelIndices: number[]
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: readonly CommandItem[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)
  const skipRestoreRef = useRef(false)
  const mac = useMemo(() => isMacPlatform(), [])

  // Register on shared Esc stack (top-of-stack priority)
  useEffect(() => pushEsc(onClose), [onClose])

  // Capture focus on mount, restore on unmount unless command redirected focus
  useEffect(() => {
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      if (!skipRestoreRef.current && prevFocusRef.current?.isConnected) {
        prevFocusRef.current.focus({ preventScroll: true })
      }
    }
  }, [])

  const ranked = useMemo<RankedCommand[]>(() => {
    const q = query.trim()
    if (!q) {
      return commands.map((item) => ({ item, score: 0, labelIndices: [] }))
    }
    const hits: RankedCommand[] = []
    const qLower = q.toLowerCase()
    for (const item of commands) {
      const mLabel = fuzzyMatch(q, item.label)
      const labelWordHit = item.label.toLowerCase().includes(qLower)
      // For metadata (group/desc/keywords), require substring or per-token match so
      // scattered single characters across long Chinese/English descriptions don't create noise
      const tokens = qLower.split(/\s+/).filter(Boolean)
      const metaHaystack = `${item.group} ${item.desc ?? ''} ${item.keywords ?? ''}`.toLowerCase()
      const metaTokenHit = tokens.every((tok) => metaHaystack.includes(tok))

      // Reject overly scattered fuzzy matches on label (e.g. matching 5 chars across 35 chars)
      const labelSpan =
        mLabel.indices.length > 1
          ? mLabel.indices[mLabel.indices.length - 1] - mLabel.indices[0]
          : 0
      const labelTight =
        mLabel.matched &&
        (labelWordHit || mLabel.indices.length <= 2 || labelSpan <= mLabel.indices.length * 3)

      if (!labelTight && !metaTokenHit) continue
      const score = (labelTight ? mLabel.score + (labelWordHit ? 90 : 40) : 0) + (metaTokenHit ? 30 : 0)
      hits.push({
        item,
        score,
        labelIndices: labelTight ? mLabel.indices : [],
      })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits
  }, [commands, query])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  useEffect(() => {
    if (activeIdx >= ranked.length && ranked.length > 0) {
      setActiveIdx(ranked.length - 1)
    }
  }, [activeIdx, ranked.length])

  // Scroll active item smoothly into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  function execute(entry: RankedCommand | undefined) {
    if (!entry) return
    if (entry.item.managesFocus) {
      skipRestoreRef.current = true
    }
    onClose()
    // Run after closing palette so dialogs / focus targets mount cleanly on top
    queueMicrotask(() => entry.item.run())
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      if (ranked.length > 0) setActiveIdx((i) => (i + 1) % ranked.length)
      return
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      if (ranked.length > 0) setActiveIdx((i) => (i - 1 + ranked.length) % ranked.length)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setActiveIdx(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      if (ranked.length > 0) setActiveIdx(ranked.length - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      execute(ranked[activeIdx])
    }
  }

  // Group items only when query is empty so relevance ordering stays crisp during search
  const showGroups = query.trim().length === 0

  return (
    <div
      className="ix-palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="ix-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        data-testid="command-palette"
      >
        <div className="ix-palette-header">
          <span className="ix-palette-prompt" aria-hidden>
            &gt;
          </span>
          <input
            ref={inputRef}
            type="text"
            className="ix-palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入命令、视图、主题、会话或操作… (fuzzy search)"
            aria-label="Search commands"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="ix-palette-count">
            {ranked.length}/{commands.length}
          </span>
          <span className="ix-kbd">ESC</span>
        </div>

        <div ref={listRef} className="ix-palette-list" role="listbox" aria-label="Command results">
          {ranked.length === 0 ? (
            <div className="ix-palette-empty">
              未匹配到「{query}」— 试试 <code>graph</code> / <code>radar</code> / <code>theme</code> / <code>sidebar</code>
            </div>
          ) : (
            ranked.map((entry, idx) => {
              const prevGroup = idx > 0 ? ranked[idx - 1].item.group : null
              const needHeader = showGroups && entry.item.group !== prevGroup
              const isActive = idx === activeIdx
              const segments = splitHighlightSegments(entry.item.label, entry.labelIndices)
              return (
                <div key={entry.item.id}>
                  {needHeader && <div className="ix-palette-group">{entry.item.group}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-cmd-idx={idx}
                    className={`ix-palette-item${isActive ? ' ix-palette-item--active' : ''}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => execute(entry)}
                  >
                    <span className="ix-palette-item-main">
                      <span className="ix-palette-icon" aria-hidden>
                        {entry.item.icon ?? '›'}
                      </span>
                      <span className="ix-palette-titles">
                        <span className="ix-palette-label">
                          {segments.map((seg, si) =>
                            seg.hit ? (
                              <span key={si} className="ix-palette-match">
                                {seg.text}
                              </span>
                            ) : (
                              <span key={si}>{seg.text}</span>
                            ),
                          )}
                        </span>
                        {entry.item.desc && <span className="ix-palette-desc">{entry.item.desc}</span>}
                      </span>
                    </span>
                    <span className="ix-palette-right">
                      {entry.item.badge && (
                        <span
                          className={`ix-palette-badge${
                            entry.item.badgeTone === 'warn' ? ' ix-palette-badge--warn' : ''
                          }`}
                        >
                          {entry.item.badge}
                        </span>
                      )}
                      {entry.item.shortcut && (
                        <span className="ix-shortcut-keys">
                          {formatChord(entry.item.shortcut, mac).map((k, ki) => (
                            <kbd key={ki} className="ix-kbd">
                              {k}
                            </kbd>
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="ix-palette-footer">
          <span>↑↓ 选择 · ⏎ 执行 · esc 关闭</span>
          <span>0xAF·RE COMMAND DECK</span>
        </div>
      </div>
    </div>
  )
}
