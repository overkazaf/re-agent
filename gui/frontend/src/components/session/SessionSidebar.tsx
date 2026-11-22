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
  minWidth: 22,
  height: 20,
  padding: '0 5px',
  fontSize: 11,
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
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.1em',
          padding: '6px 10px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ flexShrink: 0 }}>SESSIONS · {list.length}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button
            type="button"
            className="ix-icon-btn"
            onClick={() => setShowNew(true)}
            title="new session"
            aria-label="new session"
            data-hint="新建分析会话"
            data-hint-kbd={`${mod}⇧N`}
            data-hint-side="bottom"
            style={{ ...headerBtnStyle, color: 'var(--accent)', fontWeight: 600 }}
          >
            +
          </button>
          <button
            type="button"
            className="ix-icon-btn"
            onClick={() => setShowResume(true)}
            title="resume saved session"
            aria-label="resume saved session"
            data-hint="恢复历史会话"
            data-hint-side="bottom"
            style={headerBtnStyle}
          >
            ↻
          </button>
          <button
            type="button"
            className="ix-icon-btn"
            onClick={() => setShowConfig(true)}
            disabled={!active}
            title={active ? 'session config' : '无 active session'}
            aria-label="session config"
            data-hint={active ? '当前会话设置（模型路由 / 轮次 / 压缩）' : '暂无活跃会话'}
            data-hint-side="bottom"
            style={headerBtnStyle}
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
              data-hint="清除筛选"
              aria-label="Clear session filter"
            >
              ✕
            </button>
          )}
        </div>
      )}

      <div
        ref={listRef}
        style={{ overflow: 'auto', minHeight: 0, flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 3 }}
      >
        {list.length === 0 && (
          <div style={{ color: 'var(--faint)', fontSize: 11.5, padding: '10px 8px', lineHeight: 1.6 }}>
            暂无会话 · 点击右上角 + 新建
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
          const routeLine = `${rt.info.planner || '—'} → ${rt.info.executor || '—'}${rt.info.workflow ? ` · ${rt.info.workflow}` : ''}`
          const rowHint = `${rt.info.workspace}\n${routeLine}${queue > 0 ? `\n队列中：${queue} 条指令` : ''}`

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
              data-hint={rowHint}
              data-hint-side="right"
              tabIndex={0}
              aria-current={activeRt ? 'true' : undefined}
              className={cardClass}
              onClick={() => activateSession(rt.info.id)}
              onKeyDown={(e) => onCardKeyDown(e, idx, rt.info.id, rt.lifecycle, wsName)}
            >
              <span style={needsApproval ? { animation: 'ws4pulse 1.2s ease-in-out infinite' } : undefined}>
                <StatusBadge state={badgeState(needsApproval ? 'awaiting_approval' : rt.lifecycle)} />
              </span>
              <span
                style={{
                  color: activeRt ? 'var(--accent)' : needsApproval ? 'var(--warn)' : 'var(--text)',
                  fontWeight: activeRt || needsApproval ? 600 : 400,
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {wsName}
              </span>
              {needsApproval ? (
                <span className="ix-state-pill ix-state-pill--approval">审批</span>
              ) : isRunning ? (
                <span className="ix-state-pill ix-state-pill--running">运行</span>
              ) : null}
              {queue > 0 && (
                <span style={{ color: 'var(--accent)', fontSize: 10.5, flexShrink: 0 }}>⠿{queue}</span>
              )}
              <button
                type="button"
                className="ix-close-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  requestClose(rt.info.id, rt.lifecycle, wsName)
                }}
                title="close session"
                data-hint="关闭此会话"
                data-hint-side="right"
              >
                ✕
              </button>
            </div>
          )
        })}

        {/* --- SHELLS --- */}
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              color: 'var(--muted)',
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.1em',
              padding: '0 4px 5px',
            }}
          >
            <span>SHELLS · {shellList.length}</span>
            <button
              type="button"
              className="ix-icon-btn"
              onClick={() => void shellActions.open(active?.info.workspace ?? null)}
              disabled={!hasBackend()}
              title={active ? `在 ${basename(active.info.workspace)} 开 shell` : '开一个 shell（$HOME）'}
              data-hint={active ? `在 ${basename(active.info.workspace)} 打开内置终端` : '打开内置 PTY 终端（$HOME）'}
              data-hint-side="right"
              style={{ ...headerBtnStyle, color: 'var(--violet)', fontSize: 10.5 }}
            >
              + sh
            </button>
          </div>
          {shellList.length === 0 ? (
            <div style={{ color: 'var(--faint)', fontSize: 11, padding: '2px 4px' }}>
              点击 + sh 打开内置终端
            </div>
          ) : (
            shellList.map((sh) => {
              const activeSh = sh.id === activeShellId
              return (
                <div
                  key={sh.id}
                  tabIndex={0}
                  data-hint={`内置终端 · ${sh.cwd}`}
                  data-hint-side="right"
                  onClick={() => shellActions.setActive(sh.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      shellActions.setActive(sh.id)
                    }
                  }}
                  className={`ix-sidebar-item${activeSh ? ' ix-sidebar-item--active' : ''}`}
                  style={{
                    borderColor: activeSh ? 'color-mix(in srgb, var(--violet) 42%, var(--border-subtle))' : undefined,
                    borderLeftColor: activeSh ? 'var(--violet)' : undefined,
                    marginBottom: 2,
                  }}
                >
                  <span style={{ color: 'var(--violet)', fontSize: 11.5 }}>⌘</span>
                  <span
                    style={{
                      color: activeSh ? 'var(--violet)' : 'var(--text)',
                      fontWeight: activeSh ? 600 : 400,
                      fontSize: 12,
                      flex: 1,
                      minWidth: 0,
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
                    data-hint="关闭终端"
                    data-hint-side="right"
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
