// Phase 3 integration — the real composition. BootSplash probes the Wails
// bridge, then AppShell slots fill from the session store: one live session
// drives Dashboard/Transcript/Prompt, its pending approval floats as an
// overlay, and the side rail carries the RE HUD, queue, and notice log.
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { AppShell } from './components/shell/AppShell'
import { BootSplash, PanelBox, type BootProbe } from './components/crt'
import { Dashboard } from './components/panels'
import { QueuePanel, REHudPanel } from './components/re'
import { ApprovalDialog, PromptInput, SessionSidebar, TranscriptStream } from './components/session'
import { ShellView } from './components/terminal/ShellView'
import { THEME_NAMES, ThemeProvider, useTheme, type ThemeName } from './theme/ThemeContext'
import { actions, hasBackend, useSessionRuntime, useSessionStore } from './store/sessions'
import { useShellStore } from './store/shells'
import { api } from './lib/api'
import type { NoticeDTO } from './lib/types'
import type { StoreToast } from './store/sessions'

// ---------- boot ----------

async function settled(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise
    return true
  } catch {
    return false
  }
}

/** Probe the backend once; BootSplash plays the sequence when the list lands. */
function useBootProbes(): BootProbe[] {
  const [probes, setProbes] = useState<BootProbe[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows: BootProbe[] = []
      const settle = () => {
        if (!cancelled) setProbes([...rows])
      }
      if (hasBackend()) {
        rows.push({ label: 'wails bridge', ok: true })
        settle()
        rows.push({ label: 'themes index', ok: await settled(api.getThemes()) })
        rows.push({ label: 'session index', ok: await settled(api.listSessions()) })
        settle()
      } else {
        // plain `vite dev` in a browser — demos still run, backend slots stay dark
        rows.push({ label: 'wails bridge', ok: false })
        rows.push({ label: 'themes index', ok: false })
        rows.push({ label: 'session index', ok: false })
        settle()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return probes
}

export default function App() {
  // The backend's theme list (= ui.ThemeNames) is authoritative once reachable;
  // until then the local constant mirrors it exactly.
  const [themes, setThemes] = useState<readonly ThemeName[]>(THEME_NAMES)
  useEffect(() => {
    if (!hasBackend()) return
    api
      .getThemes()
      .then((names) => {
        const valid = names.filter((n): n is ThemeName => (THEME_NAMES as readonly string[]).includes(n))
        if (valid.length > 0) setThemes(valid)
      })
      .catch(() => {})
  }, [])

  return (
    <ThemeProvider themes={themes}>
      <CommandCenter />
    </ThemeProvider>
  )
}

// ---------- command center ----------

function CommandCenter() {
  const probes = useBootProbes()
  const [booted, setBooted] = useState(false)
  const { sessions, activeId, toast } = useSessionStore()
  const { shells, activeShellId } = useShellStore()
  const active = useSessionRuntime(activeId)
  const { themes, theme, setTheme } = useTheme()
  const activeShell = activeShellId ? shells.get(activeShellId) : null

  if (!booted) {
    if (probes.length === 0) return null // power-on dark frame
    return <BootSplash probes={probes} onDone={() => setBooted(true)} />
  }

  const live = [...sessions.values()].filter(
    (rt) => rt.lifecycle === 'running' || rt.lifecycle === 'awaiting_approval',
  ).length
  const busy = active?.lifecycle === 'running' || active?.lifecycle === 'awaiting_approval'
  const queueCount = active?.latestTick?.hud.queueCount ?? 0

  return (
    <>
      <AppShell
        live={live}
        topRight={
          <label style={{ color: 'var(--faint)', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeName)} style={selectStyle}>
              {themes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        }
        sidebar={<SessionSidebar style={{ width: '100%' }} />}
        // shell mode: key includes the theme so the terminal palette re-reads
        // CSS vars on a theme switch
        main={
          activeShell ? (
            <ShellView key={`${theme}:${activeShell.id}`} shell={activeShell} />
          ) : undefined
        }
        dashboard={
          active?.latestTick ? (
            <Dashboard tick={active.latestTick} thinkLines={active.thinkLines} />
          ) : (
            <EmptySlot hint={sessions.size === 0 ? 'sidebar [+ new] 开机一个 session' : '发送第一条 prompt 唤醒链路'} />
          )
        }
        side={
          <div style={railStyle}>
            <REHudPanel re={active?.latestTick?.re ?? null} />
            <QueuePanel count={queueCount} />
            <NoticeLog notices={active?.notices ?? []} />
          </div>
        }
        transcript={
          active ? (
            <TranscriptStream runtime={active} />
          ) : (
            <EmptySlot hint="等待 session —— transcript 空载" />
          )
        }
        prompt={<PromptInput sessionId={activeId} running={busy} queueCount={queueCount} />}
      />

      {/* overlays live outside the grid so fixed positioning never inherits
          the flicker animation's containing block */}
      {active?.pendingApproval && (
        <ApprovalDialog approval={active.pendingApproval} sessionId={active.info.id} />
      )}
      {toast && <ToastStrip toast={toast} />}
    </>
  )
}

// ---------- toast ----------

function ToastStrip({ toast }: { toast: StoreToast }) {
  const tone = toast.tone === 'err' ? 'var(--err)' : toast.tone === 'ok' ? 'var(--ok)' : 'var(--rule)'
  const color = toast.tone === 'err' ? 'var(--err)' : toast.tone === 'ok' ? 'var(--ok)' : 'var(--muted)'
  return (
    <div
      onClick={() => actions.dismissToast()}
      style={{
        position: 'fixed',
        top: 42,
        right: 12,
        zIndex: 60, // above the approval overlay (50) so errors stay visible while a card is up
        maxWidth: 420,
        padding: '6px 12px',
        fontSize: 12,
        cursor: 'pointer',
        background: 'var(--bg-panel)',
        border: `1px solid ${tone}`,
        color,
        boxShadow: '0 0 18px rgba(0, 0, 0, 0.6)',
      }}
    >
      {toast.tone === 'err' ? '✗ ' : toast.tone === 'ok' ? '✓ ' : '› '}
      {toast.text}
    </div>
  )
}

// ---------- notice log (side rail) ----------

function NoticeLog({ notices }: { notices: NoticeDTO[] }) {
  const tail = notices.slice(-20)
  const hasError = tail.some((n) => n.level === 'error')
  return (
    <PanelBox title="notices" accent={hasError ? 'err' : undefined}>
      {tail.length === 0 ? (
        <div style={{ color: 'var(--faint)', fontSize: 11, padding: '4px 0' }}>
          ○ quiet — 命令输出与系统消息在此落地
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            padding: '2px 0',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {tail.map((n, i) => (
            <div
              key={`${i}-${n.text.slice(0, 16)}`}
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                color: n.level === 'error' ? 'var(--err)' : 'var(--muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
              title={n.text}
            >
              {n.level === 'error' ? '✗ ' : '› '}
              {n.text}
            </div>
          ))}
        </div>
      )}
    </PanelBox>
  )
}

// ---------- empty slot ----------

function EmptySlot({ hint }: { hint: string }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--faint)', fontSize: 12, textAlign: 'center', lineHeight: 2.2 }}>
        <div style={{ fontSize: 20, letterSpacing: '0.35em', color: 'var(--accent)' }} className="glow-accent">
          ░ NO SIGNAL ░
        </div>
        <div>{hint}</div>
      </div>
    </div>
  )
}

const railStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  height: '100%',
  minHeight: 0,
}

const selectStyle: CSSProperties = {
  background: 'var(--bg-panel)',
  color: 'var(--accent)',
  border: '1px solid var(--rule)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 4px',
  cursor: 'pointer',
}
