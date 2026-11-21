// Phase 3 integration — the real composition. BootSplash probes the Wails
// bridge, then AppShell slots fill from the session store: one live session
// drives Dashboard/Transcript/Prompt, its pending approval floats as an
// overlay, and the side rail carries the RE HUD, queue, and notice log.
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { AppShell } from './components/shell/AppShell'
import { BootSplash, PanelBox, type BootProbe } from './components/crt'
import { DemoCoachBar, DemoLauncherDialog } from './components/demo'
import { Dashboard } from './components/panels'
import {
  BinaryTerrainPanel,
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
import {
  ExperimentWizard,
  HypothesisWizard,
  ReviewWizard,
  SuggestionBar,
  VerificationWizard,
} from './components/wizard'
import { ShellView } from './components/terminal/ShellView'
import { ForensicTheater, type HoloHudData } from './three'
import { useTheaterFallback, type TheaterFallbackReason } from './three/useTheaterFallback'
import { THEME_NAMES, ThemeProvider, useTheme, type ThemeName } from './theme/ThemeContext'
import { actions, hasRealBackend, pushSessionToast, useSessionRuntime, useSessionStore } from './store/sessions'
import { sceneActions, useSceneStore } from './store/scene'
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

type ViewMode = 'theater' | 'classic'
const VIEW_MODE_KEY = '0xaf-view-mode'

const FALLBACK_TEXT: Record<TheaterFallbackReason['kind'], string> = {
  'no-webgl': '3D 剧场需要 WebGL 支持，已切回经典视图',
  'reduced-motion': '检测到系统「减弱动效」偏好，已切回经典视图',
  'low-fps': '3D 场景帧率持续过低，已切回经典视图（稍后可手动再进）',
}

/** 只在 theater 模式下挂载的降级哨兵（null 渲染，纯副作用）。 */
function TheaterFallbackWatch({ onFallback }: { onFallback: (r: TheaterFallbackReason) => void }) {
  useTheaterFallback(onFallback)
  return null
}

function CommandCenter() {
  const probes = useBootProbes()
  const [booted, setBooted] = useState(false)
  const { sessions, activeId, toast } = useSessionStore()
  const { shells, activeShellId } = useShellStore()
  const demo = useDemoStore()
  const scene = useSceneStore()
  const active = useSessionRuntime(activeId)
  const { themes, theme, setTheme } = useTheme()
  const activeShell = activeShellId ? shells.get(activeShellId) : null
  const [ledgerModal, setLedgerModal] = useState<{ tab: LedgerTab; highlightId?: string } | null>(null)
  const [workbenchModal, setWorkbenchModal] = useState<{ tab: WorkbenchTab; hypId?: string } | null>(null)
  const [centerView, setCenterView] = useState<'dashboard' | 'graph' | 'terrain'>('dashboard')
  const [graphMode, setGraphMode] = useState<GraphViewMode>('pipeline')
  const [expandDashKey, setExpandDashKey] = useState(0)
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_MODE_KEY) === 'classic' ? 'classic' : 'theater',
  )
  // e2e / 无头环境确定性：?noFallback=1 关闭自动降级哨兵（WebGL 软件渲染帧率必挂 30fps）
  const noFallback = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noFallback')

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode)
    } catch {
      /* private mode 等 — 记不住就每次默认 theater */
    }
  }, [viewMode])

  // reconcile 桥：3D 剧场的唯一数据喂入口。sessions 快照每个事件批都会换
  // 引用，这里随之重算派生场景；重活（场景树渲染）由 useThrottledScene 250ms 节流兜住。
  useEffect(() => {
    const ids = [...sessions.keys()]
    const ticks = new Map(ids.map((id) => [id, sessions.get(id)?.latestTick ?? null]))
    sceneActions.reconcile(ids, ticks)
  }, [sessions])

  const onTheaterFallback = useCallback((reason: TheaterFallbackReason) => {
    setViewMode('classic')
    pushSessionToast('info', FALLBACK_TEXT[reason.kind])
  }, [])

  const openGraph = (mode: GraphViewMode) => {
    setGraphMode(mode)
    setCenterView('graph')
    setViewMode('classic') // 图谱是经典视图的舞台面；3D 剧场下点它即落地到经典+图谱
    setExpandDashKey((k) => k + 1)
  }

  const toggleCenterGraph = () => {
    if (viewMode === 'theater') {
      // 3D 剧场中「机制图谱」= 带着图谱意图落回经典视图
      openGraph('pipeline')
      return
    }
    setCenterView((cur) => {
      const next = cur === 'graph' ? 'dashboard' : 'graph'
      if (next === 'graph') setExpandDashKey((k) => k + 1)
      return next
    })
  }

  const toggleCenterTerrain = () => {
    if (viewMode === 'theater') {
      setCenterView('terrain')
      setViewMode('classic')
      setExpandDashKey((k) => k + 1)
      return
    }
    setCenterView((cur) => {
      const next = cur === 'terrain' ? 'dashboard' : 'terrain'
      if (next === 'terrain') setExpandDashKey((k) => k + 1)
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

  // 3D 剧场的全息面板数据（低频摘要：think 尾 3 条 / token 累计 / 队列深度）
  const usage = active?.latestTick?.flow.usage
  const holoHud: HoloHudData | null = active
    ? {
        thinkLines: active.thinkLines.slice(-3),
        tokensUsed: usage ? usage.input + usage.output + usage.thinking + usage.cacheRead + usage.cacheWrite : null,
        queueCount: active.latestTick?.hud.queueCount ?? null,
      }
    : null

  return (
    <>
      <AppShell
        live={live}
        expandDashboardKey={expandDashKey}
        banner={
          // 演示教练条与建议条可叠加：建议条是引导主线的「永远可见的线头」，
          // 不该被 demo 模式独占的 banner 槽挤掉（它自己会在 none/dismiss 时静默）。
          <>
            {demo.active && <DemoCoachBar graphOpen={centerView === 'graph'} onToggleGraph={toggleCenterGraph} />}
            <SuggestionBar />
          </>
        }
        topRight={
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={() => setViewMode((m) => (m === 'theater' ? 'classic' : 'theater'))}
              title={
                viewMode === 'theater'
                  ? '切回经典 2D 布局（五维仪表 / 图谱 / 账本）'
                  : '进入 3D 取证剧场（作战室 + 引导式假设主线）'
              }
              style={viewMode === 'theater' ? theaterBtnActiveStyle : theaterBtnStyle}
            >
              {viewMode === 'theater' ? '▣ 经典视图' : '◈ 3D 剧场'}
            </button>
            {viewMode === 'classic' && centerView !== 'dashboard' && (
              <button
                type="button"
                onClick={() => setCenterView('dashboard')}
                title="切回五维实时仪表盘 (FLOW / TOOLS / PLAN / THINK / TELE)"
                style={graphBtnActiveStyle}
              >
                ▣ 五维仪表
              </button>
            )}
            <button
              type="button"
              onClick={toggleCenterTerrain}
              title="二进制地形图（段/RWX/熵值曲线/内嵌载荷/反分析热点/补丁 Diff）与动静证据对齐视图"
              style={viewMode === 'classic' && centerView === 'terrain' ? terrainBtnActiveStyle : terrainBtnStyle}
            >
              ◫ 二进制解剖
            </button>
            {!(viewMode === 'classic' && centerView === 'graph') && (
              <button
                type="button"
                onClick={() => openGraph('pipeline')}
                title="以图谱形式查看假设、证据、仲裁审核与安全沙箱协同机制（3D 剧场下将切至经典视图）"
                style={graphBtnStyle}
              >
                ◈ 机制图谱
              </button>
            )}
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
          viewMode === 'theater' ? (
            <>
              {!noFallback && <TheaterFallbackWatch onFallback={onTheaterFallback} />}
              <ForensicTheater hud={holoHud} onExitToClassic={() => setViewMode('classic')} />
            </>
          ) : centerView === 'terrain' ? (
            <BinaryTerrainPanel
              sessionId={activeId}
              ledger={active?.latestTick?.ledger}
              onOpenLedger={(tab, highlightId) => setLedgerModal({ tab, highlightId })}
            />
          ) : centerView === 'graph' ? (
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
      {/* 引导式向导（3D 剧场与经典视图共用入口：HUD 建议条 / 场景节点 / 侧栏）。
          各组件自读 sceneStore.wizard 并按 stage 自门控，这里只负责挂载时机。 */}
      {scene.wizard && (
        <>
          <HypothesisWizard />
          <ExperimentWizard />
          <VerificationWizard />
          <ReviewWizard />
        </>
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

const theaterBtnStyle: CSSProperties = {
  background: 'rgba(34, 211, 238, 0.08)',
  color: 'var(--accent)',
  border: '1px solid var(--accent-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 8px',
  cursor: 'pointer',
}

const theaterBtnActiveStyle: CSSProperties = {
  background: 'rgba(34, 211, 238, 0.16)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  boxShadow: '0 0 12px var(--accent-dim)',
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

const terrainBtnStyle: CSSProperties = {
  background: 'rgba(245, 158, 11, 0.08)',
  color: 'var(--warn)',
  border: '1px solid rgba(245, 158, 11, 0.45)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 8px',
  cursor: 'pointer',
}

const terrainBtnActiveStyle: CSSProperties = {
  background: 'rgba(245, 158, 11, 0.18)',
  color: 'var(--warn)',
  border: '1px solid var(--warn)',
  boxShadow: '0 0 10px rgba(245, 158, 11, 0.35)',
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
