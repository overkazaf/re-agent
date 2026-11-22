// Phase 3 integration — the real composition. BootSplash probes the Wails
// bridge, then AppShell slots fill from the session store: one live session
// drives Dashboard/Transcript/Prompt, its pending approval floats as an
// overlay, the side rail carries the RE HUD/queue/notice log, and a global
// keyboard-first Command Palette (Cmd/Ctrl+K) + Shortcuts Cheat Sheet (?)
// orchestrate views, panes, themes, sessions, and RE workflows.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { AppShell, type ShellLayoutController } from './components/shell/AppShell'
import { CommandPalette, type CommandItem } from './components/shell/CommandPalette'
import { ShortcutsDialog } from './components/shell/ShortcutsDialog'
import {
  dispatchIxEvent,
  hasPrimaryMod,
  isEditableTarget,
  IX_EVENT_FOCUS_PROMPT,
  IX_EVENT_FOCUS_SIDEBAR_SEARCH,
  IX_EVENT_OPEN_RE_PICKER,
  modGlyph,
} from './components/shell/shortcuts'
import { BootSplash, HintOverlay, PanelBox, ProSelect, type BootProbe, type ProSelectOption } from './components/crt'
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
import { WelcomeGreetingCard } from './components/session/WelcomeGreetingCard'
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
import { getThemeMeta, THEME_NAMES, ThemeProvider, useTheme, type ThemeName } from './theme/ThemeContext'
import {
  actions,
  hasBackend,
  hasRealBackend,
  pushSessionToast,
  useSessionRuntime,
  useSessionStore,
} from './store/sessions'
import { sceneActions, useSceneStore } from './store/scene'
import { shellActions, useShellStore } from './store/shells'
import { demoActions, useDemoStore } from './demo/store'
import { onDemoSignal, requestPromptFill, requestSidebarDialog } from './demo/signals'
import { api } from './lib/api'
import { hasEscHandler } from './lib/escStack'
import {
  buildSessionMemorySnapshot,
  loadWorkbenchCache,
  recordRecentWorkspace,
  recordSessionMemory,
  updateWorkbenchPrefs,
  type CacheScope,
  type GreetingResponse,
  type GreetingSuggestion,
} from './lib/localCache'
import { loadProactiveGreeting } from './lib/proactiveGreeting'
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

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : p
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
  // Merge backend GetThemes() with the curated frontend THEME_NAMES so older
  // backends or mock E2E shims never truncate the 10-theme library to 4.
  const [themes, setThemes] = useState<readonly ThemeName[]>(THEME_NAMES)
  useEffect(() => {
    if (!hasRealBackend()) return
    api
      .getThemes()
      .then((names) => {
        const valid = names.filter((n): n is ThemeName => (THEME_NAMES as readonly string[]).includes(n))
        if (valid.length > 0) {
          const merged = [...valid, ...THEME_NAMES.filter((n) => !valid.includes(n))]
          setThemes(merged)
        }
      })
      .catch(() => {})
  }, [])

  return (
    <ThemeProvider themes={themes}>
      <CommandCenter />
      <HintOverlay />
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
  const [initialCache] = useState(() => loadWorkbenchCache())
  const [ledgerModal, setLedgerModal] = useState<{ tab: LedgerTab; highlightId?: string } | null>(null)
  const [workbenchModal, setWorkbenchModal] = useState<{ tab: WorkbenchTab; hypId?: string } | null>(null)
  const [centerView, setCenterView] = useState<'dashboard' | 'graph' | 'terrain'>(
    () => initialCache.prefs.centerView,
  )
  const [graphMode, setGraphMode] = useState<GraphViewMode>(() => initialCache.prefs.graphMode)
  const [expandDashKey, setExpandDashKey] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const layoutCtrlRef = useRef<ShellLayoutController | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_MODE_KEY) : null
      if (legacy === 'classic') return 'classic'
      if (legacy === 'theater') return 'theater'
    } catch {
      // ignore storage errors
    }
    return initialCache.prefs.activeView === 'classic' ? 'classic' : 'theater'
  })
  const [configuredModel, setConfiguredModel] = useState<string>(
    () => initialCache.prefs.configuredModel || '',
  )
  const [configuredProvider, setConfiguredProvider] = useState<string>(
    () => initialCache.prefs.configuredProvider || '',
  )
  const [greeting, setGreeting] = useState<GreetingResponse | null>(null)
  const [greetingRefreshing, setGreetingRefreshing] = useState(false)
  const [greetingDismissed, setGreetingDismissed] = useState(false)
  const [greetingRefreshSeq, setGreetingRefreshSeq] = useState(0)
  const greetingForceRef = useRef(false)
  const lastLiveModelRef = useRef('')
  const cacheScope: CacheScope = demo.active ? 'demo' : 'desktop'
  // e2e / 无头环境确定性：?noFallback=1 关闭自动降级哨兵（WebGL 软件渲染帧率必挂 30fps）
  const noFallback = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noFallback')
  const mod = modGlyph()

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode)
    } catch {
      /* private mode 等 — 记不住就每次默认 theater */
    }
    const layoutSnap = layoutCtrlRef.current?.getState()
    updateWorkbenchPrefs({
      activeView: activeShellId ? 'shell' : viewMode === 'classic' ? 'classic' : '3d',
      centerView,
      graphMode,
      ...(layoutSnap
        ? {
            paneLayout: {
              sidebarWidth: layoutSnap.sidebarWidth,
              sideWidth: layoutSnap.sideWidth,
              transcriptHeight: layoutSnap.transcriptHeight,
              sidebarCollapsed: layoutSnap.sidebarCollapsed,
              sideCollapsed: layoutSnap.sideCollapsed,
              dashboardCollapsed: layoutSnap.dashboardCollapsed,
              transcriptCollapsed: layoutSnap.transcriptCollapsed,
            },
          }
        : {}),
    })
  }, [viewMode, centerView, graphMode, activeShellId])

  // Persist compact investigation memory snapshots & recent workspaces cleanly
  // (strictly scope-isolated between real desktop sessions and Demo Sandbox).
  useEffect(() => {
    if (!booted) return
    const now = Date.now()
    for (const rt of sessions.values()) {
      recordSessionMemory(buildSessionMemorySnapshot(rt, cacheScope, now))
    }
    if (active && cacheScope === 'desktop') {
      recordRecentWorkspace(active.info.workspace)
      updateWorkbenchPrefs({ lastActiveSessionId: active.info.id })
    }
    const liveModel = active?.latestTick?.flow.model || active?.info.planner || ''
    const liveProvider = active?.latestTick?.flow.provider || active?.info.planner || ''
    if (liveModel && liveModel !== lastLiveModelRef.current) {
      lastLiveModelRef.current = liveModel
      setConfiguredModel(liveModel)
      setConfiguredProvider(liveProvider)
      if (cacheScope === 'desktop') {
        updateWorkbenchPrefs({ configuredModel: liveModel, configuredProvider: liveProvider })
      }
    }
  }, [booted, sessions, active, cacheScope])

  // Sync configured planner model from active session settings & react to settings_saved.
  const refreshConfiguredModel = useCallback(
    (sid: string | null) => {
      if (!sid || !hasBackend()) return
      api
        .getSettings(sid)
        .then((settings) => {
          const plannerName = settings.plannerProvider || settings.provider || settings.providerNames[0] || ''
          const info = settings.providers.find((p) => p.name === plannerName)
          const modelLabel = info?.model || plannerName
          if (modelLabel) {
            setConfiguredModel(modelLabel)
            setConfiguredProvider(plannerName)
            if (cacheScope === 'desktop') {
              updateWorkbenchPrefs({ configuredModel: modelLabel, configuredProvider: plannerName })
            }
          }
        })
        .catch(() => {})
    },
    [cacheScope],
  )

  useEffect(() => {
    if (!booted || !activeId) return
    refreshConfiguredModel(activeId)
  }, [booted, activeId, refreshConfiguredModel])

  useEffect(() => {
    return onDemoSignal((sig) => {
      if (sig.type === 'settings_saved') {
        refreshConfiguredModel(sig.sessionId)
        greetingForceRef.current = true
        setGreetingRefreshSeq((n) => n + 1)
      }
    })
  }, [refreshConfiguredModel])

  // Proactive startup greeting: instant cached / optimistic render + background LLM refresh.
  useEffect(() => {
    if (!booted) return
    let cancelled = false
    const force = greetingForceRef.current
    greetingForceRef.current = false
    setGreetingRefreshing(true)

    void loadProactiveGreeting({
      scope: cacheScope,
      configuredModel,
      configuredProvider,
      activeSessionId: activeId,
      activeWorkspace: active?.info.workspace ?? null,
      forceRefresh: force,
      onInstant: (instant) => {
        if (!cancelled) setGreeting(instant)
      },
    })
      .then((res) => {
        if (!cancelled) {
          setGreeting(res.response)
          setGreetingRefreshing(false)
        }
      })
      .catch(() => {
        if (!cancelled) setGreetingRefreshing(false)
      })

    return () => {
      cancelled = true
    }
  }, [booted, cacheScope, configuredModel, configuredProvider, activeId, active?.info.workspace, greetingRefreshSeq])

  const triggerGreetingRefresh = useCallback(() => {
    greetingForceRef.current = true
    setGreetingDismissed(false)
    setGreetingRefreshSeq((n) => n + 1)
  }, [])

  const handleGreetingSuggestion = useCallback(
    (suggestion: GreetingSuggestion) => {
      shellActions.setActive(null)
      switch (suggestion.actionKind) {
        case 'resume_session': {
          const targetId = suggestion.payload.trim()
          if (targetId && sessions.has(targetId)) {
            actions.setActive(targetId)
            return
          }
          if (targetId && hasBackend()) {
            void actions.resumeSession(targetId).then((res) => {
              if (!res.ok) requestSidebarDialog('resume')
            })
            return
          }
          requestSidebarDialog('resume')
          return
        }
        case 'run_command':
        case 'send_prompt': {
          if (!activeId) {
            requestSidebarDialog('new')
            return
          }
          if (suggestion.payload.trim()) {
            requestPromptFill({ text: suggestion.payload.trim(), autoSend: true })
          }
          return
        }
        case 'fill_prompt': {
          if (!activeId) {
            requestSidebarDialog('new')
            return
          }
          if (suggestion.payload.trim()) {
            requestPromptFill({ text: suggestion.payload.trim(), autoSend: false })
          }
          return
        }
        case 'open_re_picker': {
          if (!activeId) {
            requestSidebarDialog('new')
            return
          }
          requestAnimationFrame(() => dispatchIxEvent(IX_EVENT_OPEN_RE_PICKER))
          return
        }
        case 'new_session':
        default: {
          requestSidebarDialog('new')
        }
      }
    },
    [activeId, sessions],
  )

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

  const openGraph = useCallback((mode: GraphViewMode) => {
    shellActions.setActive(null)
    setGraphMode(mode)
    setCenterView('graph')
    setViewMode('classic') // 图谱是经典视图的舞台面；3D 剧场下点它即落地到经典+图谱
    setExpandDashKey((k) => k + 1)
  }, [])

  const openClassicDashboard = useCallback(() => {
    shellActions.setActive(null)
    setViewMode('classic')
    setCenterView('dashboard')
    setExpandDashKey((k) => k + 1)
  }, [])

  const openTerrain = useCallback(() => {
    shellActions.setActive(null)
    setCenterView('terrain')
    setViewMode('classic')
    setExpandDashKey((k) => k + 1)
  }, [])

  const openTheater = useCallback(() => {
    shellActions.setActive(null)
    setViewMode('theater')
  }, [])

  const toggleCenterGraph = useCallback(() => {
    if (viewMode === 'theater' || activeShellId) {
      openGraph('pipeline')
      return
    }
    setCenterView((cur) => {
      const next = cur === 'graph' ? 'dashboard' : 'graph'
      if (next === 'graph') setExpandDashKey((k) => k + 1)
      return next
    })
  }, [viewMode, activeShellId, openGraph])

  const toggleCenterTerrain = useCallback(() => {
    if (viewMode === 'theater' || activeShellId) {
      openTerrain()
      return
    }
    setCenterView((cur) => {
      const next = cur === 'terrain' ? 'dashboard' : 'terrain'
      if (next === 'terrain') setExpandDashKey((k) => k + 1)
      return next
    })
  }, [viewMode, activeShellId, openTerrain])

  const cycleTheme = useCallback(() => {
    if (themes.length === 0) return
    const idx = themes.indexOf(theme)
    const next = themes[(idx + 1) % themes.length]
    const meta = getThemeMeta(next)
    setTheme(next)
    pushSessionToast('info', `theme → ${meta.label} (${next})`)
  }, [themes, theme, setTheme])

  const themeOptions = useMemo<ProSelectOption<ThemeName>[]>(
    () =>
      themes.map((id) => {
        const meta = getThemeMeta(id)
        return {
          value: id,
          label: meta.label,
          group: meta.group,
          description: meta.description,
          swatches: meta.swatches,
          badge: meta.mode === 'light' ? 'LIGHT' : id === 'deck' ? 'DEFAULT' : undefined,
          keywords: `${id} ${meta.label} ${meta.group} ${meta.mode} ${meta.description}`,
        }
      }),
    [themes],
  )

  const awaitingSessions = useMemo(
    () => [...sessions.values()].filter((rt) => rt.lifecycle === 'awaiting_approval' || rt.pendingApproval != null),
    [sessions],
  )

  const jumpToApproval = useCallback(() => {
    const target = awaitingSessions[0]
    if (!target) return
    shellActions.setActive(null)
    actions.setActive(target.info.id)
  }, [awaitingSessions])

  // Global keyboard-first command deck shortcuts
  useEffect(() => {
    if (!booted) return
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()

      // Cmd/Ctrl+K or Cmd/Ctrl+Shift+P → Command Palette
      if (hasPrimaryMod(e) && !e.altKey && ((!e.shiftKey && key === 'k') || (e.shiftKey && key === 'p'))) {
        e.preventDefault()
        setShortcutsOpen(false)
        setPaletteOpen((open) => !open)
        return
      }

      // Cmd/Ctrl+/ → Keyboard Shortcuts Cheat Sheet
      if (hasPrimaryMod(e) && !e.altKey && !e.shiftKey && e.key === '/') {
        e.preventDefault()
        setPaletteOpen(false)
        setShortcutsOpen((open) => !open)
        return
      }

      // View mode hotkeys: Cmd/Ctrl + 1..4
      if (hasPrimaryMod(e) && !e.altKey && !e.shiftKey) {
        if (e.key === '1') {
          e.preventDefault()
          openClassicDashboard()
          return
        }
        if (e.key === '2') {
          e.preventDefault()
          openTerrain()
          return
        }
        if (e.key === '3') {
          e.preventDefault()
          openGraph('pipeline')
          return
        }
        if (e.key === '4') {
          e.preventDefault()
          openTheater()
          return
        }
      }

      // Cmd/Ctrl+Shift shortcuts: Theme cycle, New session, Sidebar search, RE picker
      if (hasPrimaryMod(e) && e.shiftKey && !e.altKey) {
        if (key === 't') {
          e.preventDefault()
          cycleTheme()
          return
        }
        if (key === 'n') {
          e.preventDefault()
          requestSidebarDialog('new')
          return
        }
        if (key === 's') {
          e.preventDefault()
          dispatchIxEvent(IX_EVENT_FOCUS_SIDEBAR_SEARCH)
          return
        }
        if (key === 'r' && activeId) {
          e.preventDefault()
          shellActions.setActive(null)
          dispatchIxEvent(IX_EVENT_OPEN_RE_PICKER)
          return
        }
      }

      // Single-key shortcuts only when outside editable fields and no overlay is active
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(e.target) || hasEscHandler()) return

      if (e.key === '?') {
        e.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (e.key === '/' && !activeShellId) {
        e.preventDefault()
        dispatchIxEvent(IX_EVENT_FOCUS_PROMPT)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [booted, activeId, activeShellId, openClassicDashboard, openTerrain, openGraph, openTheater, cycleTheme])

  const live = [...sessions.values()].filter(
    (rt) => rt.lifecycle === 'running' || rt.lifecycle === 'awaiting_approval',
  ).length
  const busy = active?.lifecycle === 'running' || active?.lifecycle === 'awaiting_approval'
  const queueCount = active?.latestTick?.hud.queueCount ?? 0

  // Command Palette catalog (computed lazily when open to keep idle renders zero-cost)
  const paletteCommands = useMemo<CommandItem[]>(() => {
    if (!paletteOpen) return []
    const layoutSnap = layoutCtrlRef.current?.getState()
    const items: CommandItem[] = [
      // Views & Stages
      {
        id: 'view-dashboard',
        group: 'Views',
        label: '经典五维仪表盘',
        icon: '▣',
        keywords: 'classic 2d dashboard flow tools plan think tele',
        shortcut: ['Mod', '1'],
        badge: !activeShell && viewMode === 'classic' && centerView === 'dashboard' ? 'ACTIVE' : undefined,
        run: openClassicDashboard,
      },
      {
        id: 'view-terrain',
        group: 'Views',
        label: '二进制解剖地形图',
        icon: '◫',
        keywords: 'binary terrain radar sections entropy hex patch',
        shortcut: ['Mod', '2'],
        badge: !activeShell && viewMode === 'classic' && centerView === 'terrain' ? 'ACTIVE' : undefined,
        run: openTerrain,
      },
      {
        id: 'view-graph-pipeline',
        group: 'Views',
        label: '机制协同图谱',
        icon: '◈',
        keywords: 'governance graph pipeline sandbox arbitrator',
        shortcut: ['Mod', '3'],
        badge: !activeShell && viewMode === 'classic' && centerView === 'graph' && graphMode === 'pipeline' ? 'ACTIVE' : undefined,
        run: () => openGraph('pipeline'),
      },
      {
        id: 'view-graph-dag',
        group: 'Views',
        label: '因果证据图谱 (DAG)',
        icon: '☍',
        keywords: 'dag provenance citation evidence hypotheses',
        run: () => openGraph('dag'),
      },
      {
        id: 'view-graph-writeup',
        group: 'Views',
        label: 'Writeup 报告工坊',
        icon: '✎',
        keywords: 'writeup report summary export markdown',
        run: () => openGraph('writeup'),
      },
      {
        id: 'view-theater',
        group: 'Views',
        label: '3D 取证剧场',
        icon: '◈',
        keywords: '3d theater webgl holographic warroom',
        shortcut: ['Mod', '4'],
        badge: !activeShell && viewMode === 'theater' ? 'ACTIVE' : undefined,
        run: openTheater,
      },
    ]

    // Shell view toggle / launch
    const firstShell = [...shells.values()][0]
    if (activeShell) {
      items.push({
        id: 'view-exit-shell',
        group: 'Views',
        label: '返回会话工作台',
        icon: '↩',
        keywords: 'return session exit shell terminal',
        run: () => shellActions.setActive(null),
      })
    } else if (firstShell) {
      items.push({
        id: 'view-enter-shell',
        group: 'Views',
        label: `切至内置终端 (${basename(firstShell.cwd)})`,
        icon: '⌘',
        keywords: 'shell terminal pty xterm',
        run: () => shellActions.setActive(firstShell.id),
      })
    } else if (hasBackend()) {
      items.push({
        id: 'shell-new',
        group: 'Views',
        label: '新建内置终端',
        desc: active ? basename(active.info.workspace) : '$HOME',
        icon: '⌘',
        keywords: 'new shell terminal pty bash zsh',
        run: () => void shellActions.open(active?.info.workspace ?? null),
      })
    }

    // Workspace Panes & Display
    items.push(
      {
        id: 'pane-sidebar',
        group: 'Layout',
        label: layoutSnap?.sidebarCollapsed ? '展开左侧会话栏' : '折叠左侧会话栏',
        icon: '◧',
        keywords: 'toggle sidebar sessions nav pane',
        shortcut: ['Mod', 'B'],
        run: () => layoutCtrlRef.current?.toggleSidebar(),
      },
      {
        id: 'pane-transcript',
        group: 'Layout',
        label: layoutSnap?.transcriptCollapsed ? '展开转录日志' : '折叠转录日志',
        icon: '⬓',
        keywords: 'toggle transcript stream log pane',
        shortcut: ['Mod', 'J'],
        run: () => layoutCtrlRef.current?.toggleTranscript(),
      },
      {
        id: 'pane-side',
        group: 'Layout',
        label: layoutSnap?.sideCollapsed ? '展开右侧栏' : '折叠右侧栏',
        icon: '◨',
        keywords: 'toggle inspector right rail ledger hud notices',
        shortcut: ['Mod', '\\'],
        run: () => layoutCtrlRef.current?.toggleSide(),
      },
      {
        id: 'pane-dashboard',
        group: 'Layout',
        label: layoutSnap?.dashboardCollapsed ? '展开上方工作区' : '折叠上方工作区',
        icon: '⬒',
        keywords: 'toggle dashboard stage pane',
        shortcut: ['Mod', 'Shift', 'D'],
        run: () => layoutCtrlRef.current?.toggleDashboard(),
      },
      {
        id: 'pane-reset',
        group: 'Layout',
        label: '重置分屏布局',
        icon: '↺',
        keywords: 'reset layout default split panes',
        shortcut: ['Mod', 'Shift', '0'],
        run: () => layoutCtrlRef.current?.resetLayout(),
      },
      {
        id: 'display-fullscreen',
        group: 'Layout',
        label: layoutSnap?.fullscreen ? '退出全屏' : '进入全屏',
        icon: '⛶',
        keywords: 'fullscreen maximize window',
        shortcut: ['Mod', 'Shift', 'F'],
        run: () => layoutCtrlRef.current?.toggleFullscreen(),
      },
      {
        id: 'theme-cycle',
        group: 'Layout',
        label: '循环切换主题',
        desc: `${getThemeMeta(theme).label} (${theme})`,
        icon: '◐',
        keywords: 'cycle theme color palette crt phosphor light dark paper',
        shortcut: ['Mod', 'Shift', 'T'],
        run: cycleTheme,
      },
      ...themes.map((t) => {
        const meta = getThemeMeta(t)
        return {
          id: `theme-set-${t}`,
          group: 'Themes',
          label: `${meta.label}`,
          desc: `${meta.group} · ${t}`,
          icon: meta.mode === 'light' ? '☀' : '◔',
          keywords: `theme ${t} ${meta.label} ${meta.group} ${meta.mode} ${meta.description} palette color`,
          badge: t === theme ? 'ACTIVE' : meta.mode === 'light' ? 'LIGHT' : undefined,
          run: () => setTheme(t),
        }
      }),
    )

    // Sessions & RE Workflows
    items.push(
      {
        id: 'session-new',
        group: 'Sessions & RE',
        label: '新建会话',
        icon: '+',
        keywords: 'new session create start workspace',
        shortcut: ['Mod', 'Shift', 'N'],
        managesFocus: true,
        run: () => requestSidebarDialog('new'),
      },
      {
        id: 'session-resume',
        group: 'Sessions & RE',
        label: '恢复历史会话',
        icon: '↻',
        keywords: 'resume history saved session restore',
        managesFocus: true,
        run: () => requestSidebarDialog('resume'),
      },
      {
        id: 'session-filter',
        group: 'Sessions & RE',
        label: '筛选会话列表',
        icon: '⌕',
        keywords: 'filter search sessions sidebar',
        shortcut: ['Mod', 'Shift', 'S'],
        managesFocus: true,
        run: () => dispatchIxEvent(IX_EVENT_FOCUS_SIDEBAR_SEARCH),
      },
    )

    if (activeId) {
      items.push(
        {
          id: 'session-settings',
          group: 'Sessions & RE',
          label: '当前会话设置',
          icon: '⚙',
          keywords: 'settings config planner executor provider turns',
          managesFocus: true,
          run: () => requestSidebarDialog('settings'),
        },
        {
          id: 'prompt-focus',
          group: 'Sessions & RE',
          label: '聚焦输入框',
          icon: '›',
          keywords: 'focus prompt input chat textarea',
          shortcut: ['/'],
          managesFocus: true,
          run: () => {
            shellActions.setActive(null)
            requestAnimationFrame(() => dispatchIxEvent(IX_EVENT_FOCUS_PROMPT))
          },
        },
        {
          id: 're-picker',
          group: 'Sessions & RE',
          label: '逆向工作流选择器',
          icon: '◬',
          keywords: 'reverse workflow picker sample apk elf firmware',
          shortcut: ['Mod', 'Shift', 'R'],
          managesFocus: true,
          run: () => {
            shellActions.setActive(null)
            requestAnimationFrame(() => dispatchIxEvent(IX_EVENT_OPEN_RE_PICKER))
          },
        },
        {
          id: 're-ledger',
          group: 'Sessions & RE',
          label: '证据账本与假设栈',
          icon: '▤',
          keywords: 'ledger evidence hypotheses stack audit',
          managesFocus: true,
          run: () => setLedgerModal({ tab: 'hypotheses' }),
        },
        {
          id: 're-workbench',
          group: 'Sessions & RE',
          label: '假设实验与验证台',
          icon: '⚗',
          keywords: 'hypothesis experiment workbench verify review',
          managesFocus: true,
          run: () => setWorkbenchModal({ tab: 'hypothesis' }),
        },
      )

      if (busy) {
        items.push({
          id: 'session-interrupt',
          group: 'Sessions & RE',
          label: '中止当前回合',
          icon: '■',
          keywords: 'stop interrupt abort cancel turn',
          badge: 'RUNNING',
          badgeTone: 'warn',
          run: () => void actions.interrupt(activeId),
        })
      }
    }

    if (awaitingSessions.length > 0) {
      items.push({
        id: 'jump-approval',
        group: 'Sessions & RE',
        label: `跳转至待审批会话 (${awaitingSessions.length})`,
        desc: basename(awaitingSessions[0].info.workspace),
        icon: '◐',
        keywords: 'approval gate pending tool confirm',
        badge: 'APPROVAL',
        badgeTone: 'warn',
        run: jumpToApproval,
      })
    }

    // Quick session switcher entries
    for (const rt of sessions.values()) {
      const ws = basename(rt.info.workspace)
      const isAct = rt.info.id === activeId && !activeShell
      const isApr = rt.lifecycle === 'awaiting_approval' || rt.pendingApproval != null
      items.push({
        id: `switch-session-${rt.info.id}`,
        group: 'Switch Session',
        label: ws,
        desc: `${rt.info.planner || '—'} → ${rt.info.executor || '—'}${rt.info.workflow ? ` · ${rt.info.workflow}` : ''}`,
        icon: isAct ? '●' : '○',
        keywords: `session switch ${ws} ${rt.info.workspace} ${rt.info.workflow}`,
        badge: isApr ? '审批' : isAct ? 'ACTIVE' : rt.lifecycle === 'running' ? '运行' : undefined,
        badgeTone: isApr ? 'warn' : 'ok',
        run: () => {
          shellActions.setActive(null)
          actions.setActive(rt.info.id)
        },
      })
    }

    // Demo & Help
    items.push(
      demo.active
        ? {
            id: 'demo-launcher',
            group: 'Demo & Help',
            label: '打开演示场景库',
            icon: '◈',
            keywords: 'demo cases scenarios launcher',
            managesFocus: true,
            run: () => demoActions.setLauncherOpen(true),
          }
        : {
            id: 'demo-enter',
            group: 'Demo & Help',
            label: '进入交互式演示环境',
            icon: '▷',
            keywords: 'demo sandbox try interactive',
            run: () => void demoActions.enterDemo('welcome-approval', true),
          },
      {
        id: 'help-shortcuts',
        group: 'Demo & Help',
        label: '键盘快捷键速查表',
        icon: '?',
        keywords: 'shortcuts keybindings hotkeys help cheat sheet',
        shortcut: ['Mod', '/'],
        managesFocus: true,
        run: () => setShortcutsOpen(true),
      },
    )

    // Quick Slash Commands for active session
    if (activeId) {
      const quickSlashes: Array<{ cmd: string; desc: string; autoSend?: boolean }> = [
        { cmd: '/audit', desc: '触发独立第三席位对抗审计', autoSend: true },
        { cmd: '/phase', desc: '查看或推进当前 RE 阶段', autoSend: true },
        { cmd: '/help', desc: '打印命令总览至 NOTICES', autoSend: true },
        { cmd: '/scan', desc: '扫描样本特征与字符串', autoSend: false },
        { cmd: '/entropy', desc: '分析二进制段熵值与加壳区域', autoSend: false },
        { cmd: '/compact', desc: '压缩当前会话上下文摘要', autoSend: true },
      ]
      for (const s of quickSlashes) {
        items.push({
          id: `slash-${s.cmd}`,
          group: 'Quick Slash Commands',
          label: s.cmd,
          desc: s.desc,
          icon: '/',
          keywords: `slash command ${s.cmd} ${s.desc}`,
          managesFocus: !s.autoSend,
          run: () => {
            shellActions.setActive(null)
            requestPromptFill({ text: s.autoSend ? s.cmd : `${s.cmd} `, autoSend: Boolean(s.autoSend) })
          },
        })
      }
    }

    return items
  }, [
    paletteOpen,
    activeShell,
    viewMode,
    centerView,
    graphMode,
    shells,
    active,
    activeId,
    busy,
    themes,
    theme,
    setTheme,
    cycleTheme,
    sessions,
    awaitingSessions,
    jumpToApproval,
    demo.active,
    openClassicDashboard,
    openTerrain,
    openGraph,
    openTheater,
  ])

  if (!booted) {
    if (probes.length === 0) return null // power-on dark frame
    return <BootSplash probes={probes} onDone={() => setBooted(true)} />
  }

  // 3D 剧场的全息面板数据（低频摘要：think 尾 3 条 / token 累计 / 队列深度）
  const usage = active?.latestTick?.flow.usage
  const holoHud: HoloHudData | null = active
    ? {
        thinkLines: active.thinkLines.slice(-3),
        tokensUsed: usage ? usage.input + usage.output + usage.thinking + usage.cacheRead + usage.cacheWrite : null,
        queueCount: active.latestTick?.hud.queueCount ?? null,
      }
    : null

  const activeLabel = activeShell
    ? basename(activeShell.cwd)
    : active
      ? basename(active.info.workspace)
      : undefined
  const activeModeBadge = activeShell
    ? 'SHELL'
    : active?.latestTick?.re?.phase
      ? active.latestTick.re.phase.slice(0, 3).toUpperCase()
      : active?.info.workflow
        ? active.info.workflow.toUpperCase()
        : undefined

  const firstShell = [...shells.values()][0]

  return (
    <>
      <AppShell
        live={live}
        awaitingApprovalCount={awaitingSessions.length}
        onJumpToApproval={jumpToApproval}
        activeLabel={activeLabel}
        activeModeBadge={activeModeBadge}
        expandDashboardKey={expandDashKey}
        layoutRef={layoutCtrlRef}
        banner={
          // 演示教练条与建议条可叠加：建议条是引导主线的「永远可见的线头」，
          // 不该被 demo 模式独占的 banner 槽挤掉（它自己会在 none/dismiss 时静默）。
          <>
            {demo.active && <DemoCoachBar graphOpen={centerView === 'graph'} onToggleGraph={toggleCenterGraph} />}
            <SuggestionBar />
          </>
        }
        topRight={
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <div className="ix-seg-group" role="group" aria-label="View mode switcher">
              <button
                type="button"
                data-testid="view-classic"
                className={`ix-seg-btn${!activeShell && viewMode === 'classic' && centerView === 'dashboard' ? ' ix-seg-btn--active' : ''}`}
                onClick={openClassicDashboard}
                aria-label={viewMode === 'theater' ? '▣ 经典视图' : '▣ 五维仪表'}
                aria-pressed={!activeShell && viewMode === 'classic' && centerView === 'dashboard'}
                data-hint="经典 2D 工作台（五维实时仪表盘）"
                data-hint-kbd={`${mod}1`}
              >
                经典
              </button>
              <button
                type="button"
                data-testid="view-terrain"
                className={`ix-seg-btn${!activeShell && viewMode === 'classic' && centerView === 'terrain' ? ' ix-seg-btn--active' : ''}`}
                onClick={toggleCenterTerrain}
                aria-label="◫ 二进制解剖"
                aria-pressed={!activeShell && viewMode === 'classic' && centerView === 'terrain'}
                data-hint="二进制解剖地形图（段 / 熵值 / 热点 / Diff）"
                data-hint-kbd={`${mod}2`}
              >
                解剖
              </button>
              <button
                type="button"
                data-testid="view-graph"
                className={`ix-seg-btn${!activeShell && viewMode === 'classic' && centerView === 'graph' ? ' ix-seg-btn--active' : ''}`}
                onClick={() => openGraph('pipeline')}
                aria-pressed={!activeShell && viewMode === 'classic' && centerView === 'graph'}
                data-hint="机制协同与实时因果证据图谱"
                data-hint-kbd={`${mod}3`}
              >
                ◈ 机制图谱
              </button>
              <button
                type="button"
                data-testid="view-theater"
                className={`ix-seg-btn${!activeShell && viewMode === 'theater' ? ' ix-seg-btn--active' : ''}`}
                onClick={openTheater}
                aria-label="◈ 3D 剧场"
                aria-pressed={!activeShell && viewMode === 'theater'}
                data-hint="3D 取证剧场与引导式假设主线"
                data-hint-kbd={`${mod}4`}
              >
                3D
              </button>
              {firstShell && (
                <button
                  type="button"
                  data-testid="view-shell"
                  className={`ix-seg-btn${activeShell ? ' ix-seg-btn--active' : ''}`}
                  onClick={() => shellActions.setActive(activeShell ? null : firstShell.id)}
                  aria-label={activeShell ? '↩ 会话' : '⌘ 终端'}
                  aria-pressed={Boolean(activeShell)}
                  data-hint={activeShell ? '返回 Agent 分析会话' : '切至已开启的内置 PTY 终端'}
                >
                  终端
                </button>
              )}
            </div>

            <span className="ix-top-sep" aria-hidden />

            {demo.active ? (
              <button
                type="button"
                className="ix-top-btn ix-top-btn--demo-active"
                onClick={() => demoActions.setLauncherOpen(true)}
                data-hint="切换 5 个交互式逆向演示场景"
              >
                ◈ 场景库
              </button>
            ) : (
              <button
                type="button"
                className="ix-top-btn ix-top-btn--demo"
                onClick={() => void demoActions.enterDemo('welcome-approval', true)}
                data-hint="进入零配置交互式演示沙盒"
              >
                ▷ 演示环境
              </button>
            )}

            <label
              className="ix-theme-label"
              data-hint="切换界面配色主题"
              data-hint-kbd={`${mod}⇧T`}
            >
              <span className="sr-only">theme</span>
              <ProSelect<ThemeName>
                value={theme}
                options={themeOptions}
                onChange={setTheme}
                size="sm"
                align="right"
                showTriggerBadge={false}
                popoverMinWidth={296}
                searchPlaceholder="Search 10 themes (e.g. paper, nord, violet)…"
                ariaLabel="Theme"
                testId="theme-select"
              />
            </label>

            <span className="ix-top-sep" aria-hidden />

            <button
              type="button"
              className="ix-top-btn ix-top-btn--cmd"
              onClick={() => {
                setShortcutsOpen(false)
                setPaletteOpen(true)
              }}
              data-hint="打开命令面板"
              data-hint-kbd={`${mod}K`}
              aria-label="Open command palette"
            >
              <span>{mod}K</span>
            </button>
            <button
              type="button"
              className="ix-top-btn ix-top-btn--help"
              onClick={() => {
                setPaletteOpen(false)
                setShortcutsOpen(true)
              }}
              data-hint="键盘快捷键速查表"
              data-hint-kbd={`? / ${mod}/`}
              aria-label="Keyboard shortcuts"
            >
              ?
            </button>
            {activeId && (
              <button
                type="button"
                className="ix-top-btn ix-top-btn--help"
                onClick={() => requestSidebarDialog('settings')}
                data-hint="当前会话设置（模型路由 / 轮次 / 压缩）"
                aria-label="当前会话设置"
              >
                ⚙
              </button>
            )}
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
            <TranscriptStream
              runtime={active}
              hasGreeting={Boolean(greeting)}
              greetingDismissed={greetingDismissed}
              onRevealGreeting={() => setGreetingDismissed(false)}
              greetingNode={
                <WelcomeGreetingCard
                  greeting={greeting}
                  refreshing={greetingRefreshing}
                  dismissed={greetingDismissed}
                  compact={active.loopBuffer.length > 0}
                  showRestorePill={active.loopBuffer.length === 0}
                  onDismiss={() => setGreetingDismissed(true)}
                  onRestore={() => setGreetingDismissed(false)}
                  onRefresh={triggerGreetingRefresh}
                  onSelectSuggestion={handleGreetingSuggestion}
                />
              }
            />
          ) : greeting ? (
            <div className="wgc-nosession-pane">
              <WelcomeGreetingCard
                greeting={greeting}
                refreshing={greetingRefreshing}
                dismissed={greetingDismissed}
                onDismiss={() => setGreetingDismissed(true)}
                onRestore={() => setGreetingDismissed(false)}
                onRefresh={triggerGreetingRefresh}
                onSelectSuggestion={handleGreetingSuggestion}
              />
              <div className="wgc-nosession-foot">
                <span>○ 等待 session —— transcript 空载</span>
              </div>
            </div>
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
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
      {toast && <ToastStrip toast={toast} />}
    </>
  )
}

// ---------- toast ----------

function ToastStrip({ toast }: { toast: StoreToast }) {
  const tone = toast.tone === 'err' ? 'var(--err)' : toast.tone === 'ok' ? 'var(--ok)' : 'var(--border-strong)'
  const color = toast.tone === 'err' ? 'var(--err)' : toast.tone === 'ok' ? 'var(--ok)' : 'var(--text)'
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => actions.dismissToast()}
      data-hint="点击关闭提示"
      data-hint-side="left"
      style={{
        position: 'fixed',
        top: 46,
        right: 12,
        zIndex: 70, // above command palette (65) and approval overlay (50)
        maxWidth: 420,
        padding: '7px 12px',
        fontSize: 12,
        cursor: 'pointer',
        background: 'var(--surface-3)',
        border: `1px solid ${tone}`,
        borderRadius: 'var(--radius-md)',
        color,
        boxShadow: 'var(--shadow-popover)',
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
    <PanelBox
      title={tail.length > 0 ? `notices · ${tail.length}` : 'notices'}
      accent={hasError ? 'err' : undefined}
      tier="secondary"
    >
      {tail.length === 0 ? (
        <div style={{ color: 'var(--faint)', fontSize: 11, padding: '4px 0' }}>
          ○ 暂无系统通知
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
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
      <div style={{ color: 'var(--faint)', fontSize: 12, textAlign: 'center', lineHeight: 2.1 }}>
        <div style={{ fontSize: 18, letterSpacing: '0.28em', color: 'var(--accent)' }} className="glow-accent">
          ░ NO SIGNAL ░
        </div>
        <div>{hint}</div>
        {showDemoCta && (
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={() => void demoActions.enterDemo('welcome-approval', false)}
              style={emptyDemoCtaStyle}
            >
              ▷ 快速体验交互式演示环境
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

const emptyDemoCtaStyle: CSSProperties = {
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  border: '1px solid var(--border-accent)',
  borderRadius: 'var(--radius-sm)',
  font: 'inherit',
  fontSize: 12,
  padding: '6px 14px',
  cursor: 'pointer',
}
