// WS4 session list: lifecycle badge (● running / ◐ awaiting approval / ○ idle),
// planner→executor routing line, queue badge, active-session glow, close with
// confirm on running sessions. Store-driven — no props required.
// The SHELLS section below lists PTY shells; clicking one swaps the main area
// to the terminal (sessions data stays put in the store).
import { useEffect, useState, type CSSProperties } from 'react'
import { actions, useSessionStore } from '../../store/sessions'
import { shellActions, useShellStore } from '../../store/shells'
import { hasBackend } from '../../store/sessions'
import { emitDemoSignal, onSidebarDialogRequest } from '../../demo/signals'
import type { LifecycleState } from '../../lib/types'
import { StatusBadge } from '../crt'
import { Btn, Dialog } from './Dialog'
import { NewSessionDialog } from './NewSessionDialog'
import { ResumeDialog } from './ResumeDialog'
import { SettingsDialog } from './SettingsDialog'

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
  // in-app confirm: window.confirm always returns false inside Wails' WKWebView
  // (no WKUIDelegate), so a running session could never be closed
  const [confirmClose, setConfirmClose] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    return onSidebarDialogRequest((kind) => {
      if (kind === 'new') setShowNew(true)
      else if (kind === 'resume') setShowResume(true)
      else if (kind === 'settings') setShowConfig(true)
    })
  }, [])

  function requestClose(id: string, lifecycle: LifecycleState, name: string) {
    if (lifecycle === 'running') {
      setConfirmClose({ id, name })
      return
    }
    void actions.closeSession(id)
  }

  const list = [...sessions.values()]
  const active = activeId ? sessions.get(activeId) : undefined
  const shellList = [...shells.values()]

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
            onClick={() => setShowNew(true)}
            title="new session"
            style={{ ...headerBtnStyle, color: 'var(--accent)' }}
          >
            + new
          </button>
          <button
            onClick={() => setShowResume(true)}
            title="resume saved session"
            style={headerBtnStyle}
          >
            resume
          </button>
          <button
            onClick={() => setShowConfig(true)}
            disabled={!active}
            title={active ? 'session config' : '无 active session'}
            style={{ ...headerBtnStyle, opacity: active ? 1 : 0.4, cursor: active ? 'pointer' : 'default' }}
          >
            ⚙
          </button>
        </span>
      </header>

      <div style={{ overflow: 'auto', minHeight: 0, flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list.length === 0 && (
          <div style={{ color: 'var(--faint)', fontSize: 12, padding: 8 }}>
            ○ no sessions —
            <br />
            [+ new] 开始一个
          </div>
        )}

        {list.map((rt) => {
          const activeRt = rt.info.id === activeId
          const queue = rt.latestTick?.hud.queueCount ?? 0
          return (
            <div
              key={rt.info.id}
              onClick={() => {
                const wasInShell = activeShellId !== null
                actions.setActive(rt.info.id)
                // leaving shell mode — the main area shows the session again
                shellActions.setActive(null)
                if (wasInShell) {
                  emitDemoSignal({ type: 'returned_to_session', sessionId: rt.info.id })
                }
              }}
              style={{
                border: `1px solid ${activeRt ? 'var(--accent)' : 'var(--rule)'}`,
                boxShadow: activeRt ? '0 0 14px var(--accent-dim)' : 'none',
                background: 'rgba(5, 8, 12, 0.4)',
                padding: '7px 9px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={rt.lifecycle === 'awaiting_approval' ? { animation: 'ws4pulse 1.2s ease-in-out infinite' } : undefined}>
                  <StatusBadge state={badgeState(rt.lifecycle)} />
                </span>
                <span
                  style={{
                    color: activeRt ? 'var(--accent)' : 'var(--text)',
                    fontWeight: activeRt ? 700 : 400,
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {basename(rt.info.workspace)}
                </span>
                {queue > 0 && (
                  <span style={{ color: 'var(--accent)', fontSize: 11 }} title={`${queue} prompts queued`}>
                    ⠿ {queue}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    requestClose(rt.info.id, rt.lifecycle, basename(rt.info.workspace))
                  }}
                  title="close session"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--faint)',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 11,
                    padding: '0 2px',
                  }}
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
                  onClick={() => shellActions.setActive(sh.id)}
                  style={{
                    border: `1px solid ${activeSh ? 'var(--violet)' : 'var(--rule)'}`,
                    background: 'rgba(5, 8, 12, 0.4)',
                    padding: '5px 8px',
                    cursor: 'pointer',
                    display: 'flex',
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
                    onClick={(e) => {
                      e.stopPropagation()
                      void shellActions.close(sh.id)
                    }}
                    title="kill shell"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--faint)',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 11,
                      padding: '0 2px',
                    }}
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
