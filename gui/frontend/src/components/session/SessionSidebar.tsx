// WS4 session list: lifecycle badge (● running / ◐ awaiting approval / ○ idle),
// quick filter/search, keyboard roving navigation, unmistakable approval/busy cues,
// planner→executor routing line, queue badge, active-session glow, and PTY shells.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { actions, hasBackend, useSessionStore } from '../../store/sessions'
import { shellActions, useShellStore } from '../../store/shells'
import { emitDemoSignal, onSidebarDialogRequest } from '../../demo/signals'
import type { LifecycleState } from '../../lib/types'
import { StatusBadge } from '../crt'
import { IX_EVENT_FOCUS_SIDEBAR_SEARCH, modGlyph } from '../shell/shortcuts'
import { Btn, Dialog } from './Dialog'
import { NewSessionDialog } from './NewSessionDialog'
import { ResumeDialog } from './ResumeDialog'
import { SettingsDialog } from './SettingsDialog'
import '../shell/interaction.css'

function badgeState(lifecycle: LifecycleState): 'ok' | 'pending' | 'off' {
  if (lifecycle === 'running') return 'ok'
  if (lifecycle === 'awaiting_approval') return 'pending'
  return 'off'
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : p
}

const headerBtnStyle: CSSProperties = {
  background: 'none',
  border: '1px solid var(--rule)',
  color: 'var(--muted)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 5px',
}

export function SessionSidebar({
  style,
  width = 236,
}: {
  style?: CSSProperties
  width?: number
}) {
  const { sessions, activeId } = useSessionStore()
  const { shells, activeShellId } = useShellStore()
  const [showNew, setShowNew] = useState(false)
  const [showResume, setShowResume] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [confirmClose, setConfirmClose] = useState<{ id: string; name: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return onSidebarDialogRequest((kind) => {
      if (kind === 'new') setShowNew(true)
      else if (kind === 'resume') setShowResume(true)
      else if (kind === 'settings') setShowConfig(true)
    })
  }, [])

  // Focus sidebar filter when Cmd/Ctrl+Shift+S is triggered globally
  useEffect(() => {
    const onFocusSearch = () => {
      setSearchOpen(true)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    window.addEventListener(IX_EVENT_FOCUS_SIDEBAR_SEARCH, onFocusSearch)
    return () => window.removeEventListener(IX_EVENT_FOCUS_SIDEBAR_SEARCH, onFocusSearch)
  }, [])

  function requestClose(id: string, lifecycle: LifecycleState, name: string) {
    if (lifecycle === 'running') {
      setConfirmClose({ id, name })
      return
    }
    void actions.closeSession(id)
  }

  function activateSession(id: string) {
    const wasInShell = activeShellId !== null
    actions.setActive(id)
    shellActions.setActive(null)
    if (wasInShell) {
      emitDemoSignal({ type: 'returned_to_session', sessionId: id })
    }
  }

  const list = [...sessions.values()]
  const active = activeId ? sessions.get(activeId) : undefined
  const shellList = [...shells.values()]

  const filteredList = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return list
    return list.filter((rt) => {
      const name = basename(rt.info.workspace).toLowerCase()
      const ws = rt.info.workspace.toLowerCase()
      const route = `${rt.info.planner} ${rt.info.executor} ${rt.info.workflow} ${rt.lifecycle}`.toLowerCase()
      return name.includes(q) || ws.includes(q) || route.includes(q)
    })
  }, [list, filterText])

  const showSearchBar = searchOpen || list.length > 1 || filterText.length > 0
  const mod = modGlyph()

  function focusCardAt(index: number) {
    const cards = listRef.current?.querySelectorAll<HTMLElement>('[data-session-card="true"]')
    if (!cards || cards.length === 0) return
    const wrapped = (index + cards.length) % cards.length
    cards[wrapped]?.focus()
  }

  function onCardKeyDown(
    e: KeyboardEvent<HTMLDivElement>,
    idx: number,
    id: string,
    lifecycle: LifecycleState,
    name: string,
  ) {
    if (e.target !== e.currentTarget) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusCardAt(idx + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusCardAt(idx - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activateSession(id)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      requestClose(id, lifecycle, name)
    }
  }

  return (
    <section
      style={{
        width,
        border: '1px solid var(--rule)',
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...style,
      }}
    >
      {/* pulse keyframes for awaiting-approval badges */}
      <style>{'@keyframes ws4pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }'}</style>

      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'nowrap',
          whiteSpace: 'nowrap',
          color: 'var(--muted)',
          fontSize: 11,
          letterSpacing: '0.12em',
          padding: '5px 10px',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <span style={{ flexShrink: 0 }}>SESSIONS · {list.length}</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="ix-btn"
            onClick={() => setShowNew(true)}
            title="new session"
            style={{ ...headerBtnStyle, color: 'var(--accent)' }}
          >
            + new
          </button>
          <button
            type="button"
            className="ix-btn"
            onClick={() => setShowResume(true)}
            title="resume saved session"
            style={headerBtnStyle}
          >
            resume
          </button>
          <button
            type="button"
            className="ix-btn"
            onClick={() => setShowConfig(true)}
            disabled={!active}
            title={active ? 'session config' : '无 active session'}
            style={{ ...headerBtnStyle, opacity: active ? 1 : 0.4, cursor: active ? 'pointer' : 'default' }}
          >
            ⚙
          </button>
        </span>
      </header>

      {/* Quick session filter (auto-shown when multiple sessions exist or toggled via Cmd+Shift+S) */}
      {showSearchBar && (
        <div className="ix-sidebar-search-wrap">
          <span style={{ color: 'var(--faint)', fontSize: 11 }} aria-hidden>
            ⌕
          </span>
          <input
            ref={searchRef}
            type="text"
            className="ix-sidebar-search"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (filterText) {
                  setFilterText('')
                } else {
                  setSearchOpen(false)
                  e.currentTarget.blur()
                }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                focusCardAt(0)
              }
            }}
            placeholder={`筛选会话… (${mod}⇧S)`}
            aria-label="Filter sessions"
            spellCheck={false}
          />
          {filterText && (
            <button
              type="button"
              className="ix-sidebar-clear"
              onClick={() => {
                setFilterText('')
                searchRef.current?.focus()
              }}
              title="清除筛选"
              aria-label="Clear session filter"
            >
              ✕
            </button>
          )}
        </div>
      )}

      <div
        ref={listRef}
        style={{ overflow: 'auto', minHeight: 0, flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        {list.length === 0 && (
          <div style={{ color: 'var(--faint)', fontSize: 12, padding: 8 }}>
            ○ no sessions —
            <br />
            [+ new] 开始一个
          </div>
        )}

        {list.length > 0 && filteredList.length === 0 && (
          <div style={{ color: 'var(--faint)', fontSize: 11, padding: 8 }}>
            未找到匹配「{filterText}」的会话
          </div>
        )}

        {filteredList.map((rt, idx) => {
          const activeRt = rt.info.id === activeId && activeShellId === null
          const queue = rt.latestTick?.hud.queueCount ?? 0
          const needsApproval = rt.lifecycle === 'awaiting_approval' || rt.pendingApproval != null
          const isRunning = rt.lifecycle === 'running'
          const wsName = basename(rt.info.workspace)

          const cardClass = [
            'ix-sidebar-item',
            activeRt ? 'ix-sidebar-item--active' : '',
            isRunning ? 'ix-sidebar-item--running' : '',
            needsApproval ? 'ix-sidebar-item--approval' : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <div
              key={rt.info.id}
              data-session-card="true"
              tabIndex={0}
              aria-current={activeRt ? 'true' : undefined}
              className={cardClass}
              onClick={() => activateSession(rt.info.id)}
              onKeyDown={(e) => onCardKeyDown(e, idx, rt.info.id, rt.lifecycle, wsName)}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={needsApproval ? { animation: 'ws4pulse 1.2s ease-in-out infinite' } : undefined}>
                  <StatusBadge state={badgeState(needsApproval ? 'awaiting_approval' : rt.lifecycle)} />
                </span>
                <span
                  style={{
                    color: activeRt ? 'var(--accent)' : needsApproval ? 'var(--warn)' : 'var(--text)',
                    fontWeight: activeRt || needsApproval ? 700 : 400,
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {wsName}
                </span>
                {needsApproval ? (
                  <span className="ix-state-pill ix-state-pill--approval" title="等待安全审批确认">
                    APPROVAL
                  </span>
                ) : isRunning ? (
                  <span className="ix-state-pill ix-state-pill--running" title="正在执行分析回合">
                    LIVE
                  </span>
                ) : null}
                {queue > 0 && (
                  <span style={{ color: 'var(--accent)', fontSize: 11 }} title={`${queue} prompts queued`}>
                    ⠿ {queue}
                  </span>
                )}
                <button
                  type="button"
                  className="ix-close-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    requestClose(rt.info.id, rt.lifecycle, wsName)
                  }}
                  title="close session"
                >
                  ✕
                </button>
              </span>
              <span style={{ color: 'var(--faint)', fontSize: 10, display: 'flex', gap: 6, minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {rt.info.planner || '—'} → {rt.info.executor || '—'}
                </span>
                {rt.info.workflow && <span style={{ color: 'var(--violet)' }}>[{rt.info.workflow}]</span>}
              </span>
            </div>
          )
        })}

        {/* --- SHELLS --- */}
        <div style={{ marginTop: 4, paddingTop: 6, borderTop: '1px solid var(--rule)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              color: 'var(--muted)',
              fontSize: 11,
              letterSpacing: '0.12em',
              padding: '0 2px 4px',
            }}
          >
            <span>SHELLS · {shellList.length}</span>
            <button
              type="button"
              className="ix-btn"
              onClick={() => void shellActions.open(active?.info.workspace ?? null)}
              disabled={!hasBackend()}
              title={active ? `在 ${basename(active.info.workspace)} 开 shell` : '开一个 shell（$HOME）'}
              style={{ ...headerBtnStyle, color: 'var(--violet)' }}
            >
              + sh
            </button>
          </div>
          {shellList.length === 0 ? (
            <div style={{ color: 'var(--faint)', fontSize: 11, padding: '0 2px' }}>
              ○ [+ sh] 开终端做其它操作
            </div>
          ) : (
            shellList.map((sh) => {
              const activeSh = sh.id === activeShellId
              return (
                <div
                  key={sh.id}
                  tabIndex={0}
                  onClick={() => shellActions.setActive(sh.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      shellActions.setActive(sh.id)
                    }
                  }}
                  className="ix-sidebar-item"
                  style={{
                    borderColor: activeSh ? 'var(--violet)' : 'var(--rule)',
                    borderLeftWidth: activeSh ? 3 : 2,
                    borderLeftColor: activeSh ? 'var(--violet)' : 'var(--rule)',
                    padding: '5px 8px',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ color: 'var(--violet)', fontSize: 12 }}>⌘</span>
                  <span
                    style={{
                      color: activeSh ? 'var(--violet)' : 'var(--text)',
                      fontWeight: activeSh ? 700 : 400,
                      fontSize: 12,
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={sh.cwd}
                  >
                    {basename(sh.cwd)}
                  </span>
                  <button
                    type="button"
                    className="ix-close-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      void shellActions.close(sh.id)
                    }}
                    title="kill shell"
                  >
                    ✕
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>

      {showNew && <NewSessionDialog onClose={() => setShowNew(false)} />}
      {showResume && <ResumeDialog onClose={() => setShowResume(false)} />}
      {showConfig && active && (
        <SettingsDialog
          sessionId={active.info.id}
          sessionName={basename(active.info.workspace)}
          onClose={() => setShowConfig(false)}
        />
      )}

      {confirmClose && (
        <Dialog title="close session" accent="warn" width={380} onClose={() => setConfirmClose(null)}>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            session <span style={{ color: 'var(--accent)' }}>{confirmClose.name}</span> 正在运行，确认关闭？
            <div style={{ color: 'var(--faint)', fontSize: 11 }}>关闭会中止当前 turn 并丢弃未消费的队列</div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn onClick={() => setConfirmClose(null)}>cancel</Btn>
            <Btn
              tone="err"
              onClick={() => {
                void actions.closeSession(confirmClose.id)
                setConfirmClose(null)
              }}
            >
              force close
            </Btn>
          </div>
        </Dialog>
      )}
    </section>
  )
}
