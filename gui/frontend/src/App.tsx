// Phase 3 integration — the real composition. BootSplash probes the Wails
// bridge, then AppShell slots fill from the session store: one live session
// drives Dashboard/Transcript/Prompt, its pending approval floats as an
// overlay, and the side rail carries the RE HUD, queue, and notice log.
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { AppShell } from './components/shell/AppShell'
import { BootSplash, PanelBox, type BootProbe } from './components/crt'
import { DemoCoachBar, DemoLauncherDialog } from './components/demo'
import { Dashboard } from './components/panels'
import {
  GovernanceGraphPanel,
  HypothesisWorkbenchDialog,
  LedgerDetailDialog,
  LedgerPanel,
  QueuePanel,
  REHudPanel,
  type GraphViewMode,
  type LedgerTab,
  type WorkbenchTab,
} from './components/re'
import { ApprovalDialog, PromptInput, SessionSidebar, TranscriptStream } from './components/session'
import { ShellView } from './components/terminal/ShellView'
import { THEME_NAMES, ThemeProvider, useTheme, type ThemeName } from './theme/ThemeContext'
import { actions, hasRealBackend, useSessionRuntime, useSessionStore } from './store/sessions'
import { useShellStore } from './store/shells'
import { demoActions, useDemoStore } from './demo/store'
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

/** Probe the backend once; BootSplash plays the sequence when the list lands.
 *  In a standalone browser (no Wails bridge) or with ?demo=1 / ?case=...,
 *  automatically boots the interactive Demo Sandbox so every feature works live. */
function useBootProbes(): BootProbe[] {
  const [probes, setProbes] = useState<BootProbe[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows: BootProbe[] = []
      const settle = () => {
        if (!cancelled) setProbes([...rows])
      }
      const initial = demoActions.detectInitialDemo()
      if (initial.shouldAutoEnter) {
        rows.push({ label: 'demo sandbox', ok: true })
        settle()
        await demoActions.enterDemo(initial.caseId, false)
        rows.push({ label: '5 case scenarios', ok: true })
        rows.push({ label: 'themes index', ok: true })
        settle()
      } else if (hasRealBackend()) {
        rows.push({ label: 'wails bridge', ok: true })
        settle()
        rows.push({ label: 'themes index', ok: await settled(api.getThemes()) })
        rows.push({ label: 'session index', ok: await settled(api.listSessions()) })
        settle()
      } else {
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
    if (!hasRealBackend()) return
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
  const demo = useDemoStore()
  const active = useSessionRuntime(activeId)
  const { themes, theme, setTheme } = useTheme()
  const activeShell = activeShellId ? shells.get(activeShellId) : null
  const [ledgerModal, setLedgerModal] = useState<{ tab: LedgerTab; highlightId?: string } | null>(null)
  const [workbenchModal, setWorkbenchModal] = useState<{ tab: WorkbenchTab; hypId?: string } | null>(null)
  const [centerView, setCenterView] = useState<'dashboard' | 'graph'>('dashboard')
  const [graphMode, setGraphMode] = useState<GraphViewMode>('pipeline')
  const [expandDashKey, setExpandDashKey] = useState(0)

  const openGraph = (mode: GraphViewMode) => {
    setGraphMode(mode)
    setCenterView('graph')
    setExpandDashKey((k) => k + 1)
  }

  const toggleCenterGraph = () => {
    setCenterView((cur) => {
      const next = cur === 'graph' ? 'dashboard' : 'graph'
      if (next === 'graph') setExpandDashKey((k) => k + 1)
      return next
    })
  }

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
        expandDashboardKey={expandDashKey}
        banner={
          demo.active ? (
            <DemoCoachBar graphOpen={centerView === 'graph'} onToggleGraph={toggleCenterGraph} />
          ) : undefined
        }
        topRight={
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={toggleCenterGraph}
              title={
                centerView === 'graph'
                  ? '切回五维实时仪表盘 (FLOW / TOOLS / PLAN / THINK / TELE)'
                  : '以图谱形式查看假设、证据、仲裁审核与安全沙箱协同机制'
              }
              style={centerView === 'graph' ? graphBtnActiveStyle : graphBtnStyle}
            >
              {centerView === 'graph' ? '▣ 五维仪表' : '◈ 机制图谱'}
            </button>
            {demo.active ? (
              <button
                type="button"
                onClick={() => demoActions.setLauncherOpen(true)}
                title="打开演示场景库（5 个常见逆向 Case）"
                style={demoBtnActiveStyle}
              >
                ◈ 场景库
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void demoActions.enterDemo('welcome-approval', true)}
                title="进入交互式演示沙盒（零配置体验 5 个常见逆向 Case）"
                style={demoBtnStyle}
              >
                ▷ 演示环境
              </button>
            )}
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
          </div>
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
          centerView === 'graph' ? (
            <GovernanceGraphPanel
              tick={active?.latestTick ?? null}
              thinkLines={active?.thinkLines ?? []}
              workspace={active?.info.workspace}
              onRunAgentWriteup={
                activeId
                  ? () => {
                      void actions.sendPrompt(
                        activeId,
                        '基于已审计的证据账本与假设栈生成结构化 Writeup 分析报告并写入 notes/writeup.md',
                      )
                    }
                  : undefined
              }
              onOpenWorkbench={
                activeId ? (tab, hypId) => setWorkbenchModal({ tab, hypId }) : undefined
              }
              initialMode={graphMode}
            />
          ) : active?.latestTick ? (
            <Dashboard tick={active.latestTick} thinkLines={active.thinkLines} />
          ) : (
            <EmptySlot
              hint={sessions.size === 0 ? 'sidebar [+ new] 开机一个 session' : '发送第一条 prompt 唤醒链路'}
              showDemoCta={sessions.size === 0 && !demo.active}
            />
          )
        }
        side={
          <div style={railStyle}>
            <REHudPanel
              re={active?.latestTick?.re ?? null}
              onInspect={(tab) => setLedgerModal({ tab })}
              onOpenGraph={() => openGraph('pipeline')}
              onOpenWriteup={() => openGraph('writeup')}
            />
            <LedgerPanel
              ledger={active?.latestTick?.ledger}
              onOpenDetail={(tab, highlightId) => setLedgerModal({ tab, highlightId })}
              onOpenGraph={() => openGraph('dag')}
              onOpenWorkbench={
                activeId ? (tab, hypId) => setWorkbenchModal({ tab, hypId }) : undefined
              }
            />
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
      {demo.launcherOpen && (
        <DemoLauncherDialog onClose={() => demoActions.setLauncherOpen(false)} />
      )}
      {ledgerModal && (
        <LedgerDetailDialog
          ledger={active?.latestTick?.ledger}
          initialTab={ledgerModal.tab}
          initialHighlightId={ledgerModal.highlightId}
          onOpenWorkbench={
            activeId ? (tab, hypId) => setWorkbenchModal({ tab, hypId }) : undefined
          }
          onClose={() => setLedgerModal(null)}
        />
      )}
      {workbenchModal && activeId && (
        <HypothesisWorkbenchDialog
          sessionId={activeId}
          workspace={active?.info.workspace}
          ledger={active?.latestTick?.ledger}
          initialTab={workbenchModal.tab}
          initialHypId={workbenchModal.hypId}
          onClose={() => setWorkbenchModal(null)}
        />
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
    <PanelBox title="notices" accent={hasError ? 'err' : undefined} tier="secondary">
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

function EmptySlot({ hint, showDemoCta = false }: { hint: string; showDemoCta?: boolean }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--faint)', fontSize: 12, textAlign: 'center', lineHeight: 2.2 }}>
        <div style={{ fontSize: 20, letterSpacing: '0.35em', color: 'var(--accent)' }} className="glow-accent">
          ░ NO SIGNAL ░
        </div>
        <div>{hint}</div>
        {showDemoCta && (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => void demoActions.enterDemo('welcome-approval', false)}
              style={emptyDemoCtaStyle}
            >
              ▷ 快速体验交互式演示环境（5 个典型逆向 Case · 零配置）
            </button>
          </div>
        )}
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

const demoBtnStyle: CSSProperties = {
  background: 'rgba(34, 211, 238, 0.06)',
  color: 'var(--accent)',
  border: '1px solid var(--accent-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 8px',
  cursor: 'pointer',
}

const demoBtnActiveStyle: CSSProperties = {
  background: 'rgba(139, 92, 246, 0.1)',
  color: 'var(--violet)',
  border: '1px solid var(--violet-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 8px',
  cursor: 'pointer',
}

const graphBtnStyle: CSSProperties = {
  background: 'rgba(139, 92, 246, 0.08)',
  color: 'var(--violet)',
  border: '1px solid var(--violet-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 8px',
  cursor: 'pointer',
}

const graphBtnActiveStyle: CSSProperties = {
  background: 'rgba(34, 211, 238, 0.14)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  boxShadow: '0 0 10px var(--accent-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 8px',
  cursor: 'pointer',
}

const emptyDemoCtaStyle: CSSProperties = {
  background: 'rgba(34, 211, 238, 0.08)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  boxShadow: '0 0 12px var(--accent-dim)',
  font: 'inherit',
  fontSize: 12,
  padding: '5px 14px',
  cursor: 'pointer',
}
