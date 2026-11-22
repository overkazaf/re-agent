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
import { BootSplash, PanelBox, ProSelect, type BootProbe, type ProSelectOption } from './components/crt'
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
import { requestPromptFill, requestSidebarDialog } from './demo/signals'
import { api } from './lib/api'
import { hasEscHandler } from './lib/escStack'
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const layoutCtrlRef = useRef<ShellLayoutController | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_MODE_KEY) === 'classic' ? 'classic' : 'theater',
  )
  // e2e / 无头环境确定性：?noFallback=1 关闭自动降级哨兵（WebGL 软件渲染帧率必挂 30fps）
  const noFallback = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noFallback')
  const mod = modGlyph()

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
        group: 'Views & Stages',
        label: '五维实时仪表盘 (Classic Dashboard)',
        desc: 'FLOW / TOOLS / PLAN / THINK / TELE 经典 2D 视图',
        icon: '▣',
        keywords: 'classic 2d dashboard flow tools plan think tele',
        shortcut: ['Mod', '1'],
        badge: !activeShell && viewMode === 'classic' && centerView === 'dashboard' ? 'ACTIVE' : undefined,
        run: openClassicDashboard,
      },
      {
        id: 'view-terrain',
        group: 'Views & Stages',
        label: '二进制解剖地形图 (Binary Forensic Radar)',
        desc: '段/RWX/熵值曲线/载荷热点/动静证据对齐',
        icon: '◫',
        keywords: 'binary terrain radar sections entropy hex patch',
        shortcut: ['Mod', '2'],
        badge: !activeShell && viewMode === 'classic' && centerView === 'terrain' ? 'ACTIVE' : undefined,
        run: openTerrain,
      },
      {
        id: 'view-graph-pipeline',
        group: 'Views & Stages',
        label: '机制协同图谱 (Governance Pipeline)',
        desc: 'Planner / Executor / Auditor / 能力沙箱 / 宿主仲裁协同图',
        icon: '◈',
        keywords: 'governance graph pipeline sandbox arbitrator',
        shortcut: ['Mod', '3'],
        badge: !activeShell && viewMode === 'classic' && centerView === 'graph' && graphMode === 'pipeline' ? 'ACTIVE' : undefined,
        run: () => openGraph('pipeline'),
      },
      {
        id: 'view-graph-dag',
        group: 'Views & Stages',
        label: '实时因果证据图谱 (Provenance DAG)',
        desc: '假设栈与不可篡改证据引用关系有向图',
        icon: '☍',
        keywords: 'dag provenance citation evidence hypotheses',
        run: () => openGraph('dag'),
      },
      {
        id: 'view-graph-writeup',
        group: 'Views & Stages',
        label: '过程总结与 Writeup 工坊',
        desc: '6 大认知环节对齐与可溯源报告生成',
        icon: '✎',
        keywords: 'writeup report summary export markdown',
        run: () => openGraph('writeup'),
      },
      {
        id: 'view-theater',
        group: 'Views & Stages',
        label: '3D 取证剧场 (Forensic Theater)',
        desc: '3D 作战室 + 引导式假设/实验/验证主线',
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
        group: 'Views & Stages',
        label: '返回 Agent 工作台会话视图',
        desc: '退出 PTY 终端全屏槽（后台终端保持运行）',
        icon: '↩',
        keywords: 'return session exit shell terminal',
        run: () => shellActions.setActive(null),
      })
    } else if (firstShell) {
      items.push({
        id: 'view-enter-shell',
        group: 'Views & Stages',
        label: `切至内置终端 (${basename(firstShell.cwd)})`,
        desc: '切换主区域至已开启的 PTY 终端',
        icon: '⌘',
        keywords: 'shell terminal pty xterm',
        run: () => shellActions.setActive(firstShell.id),
      })
    } else if (hasBackend()) {
      items.push({
        id: 'shell-new',
        group: 'Views & Stages',
        label: '启动新内置 PTY 终端 (+ sh)',
        desc: active ? `在 ${basename(active.info.workspace)} 打开交互终端` : '打开交互终端 ($HOME)',
        icon: '⌘',
        keywords: 'new shell terminal pty bash zsh',
        run: () => void shellActions.open(active?.info.workspace ?? null),
      })
    }

    // Workspace Panes & Display
    items.push(
      {
        id: 'pane-sidebar',
        group: 'Workspace Panes',
        label: layoutSnap?.sidebarCollapsed ? '展开左侧会话栏' : '折叠左侧会话栏',
        desc: '切换 SESSIONS / SHELLS 导航侧栏',
        icon: '◧',
        keywords: 'toggle sidebar sessions nav pane',
        shortcut: ['Mod', 'B'],
        run: () => layoutCtrlRef.current?.toggleSidebar(),
      },
      {
        id: 'pane-transcript',
        group: 'Workspace Panes',
        label: layoutSnap?.transcriptCollapsed ? '展开转录日志区' : '折叠转录日志区',
        desc: '切换底部实时转录流面板',
        icon: '⬓',
        keywords: 'toggle transcript stream log pane',
        shortcut: ['Mod', 'J'],
        run: () => layoutCtrlRef.current?.toggleTranscript(),
      },
      {
        id: 'pane-side',
        group: 'Workspace Panes',
        label: layoutSnap?.sideCollapsed ? '展开右侧 RE / 通知栏' : '折叠右侧 RE / 通知栏',
        desc: '切换 RE HUD / 账本 / 队列 / 通知侧轨',
        icon: '◨',
        keywords: 'toggle inspector right rail ledger hud notices',
        shortcut: ['Mod', '\\'],
        run: () => layoutCtrlRef.current?.toggleSide(),
      },
      {
        id: 'pane-dashboard',
        group: 'Workspace Panes',
        label: layoutSnap?.dashboardCollapsed ? '展开上方仪表盘区域' : '折叠上方仪表盘区域',
        desc: '折叠仪表盘以最大化转录阅读高度',
        icon: '⬒',
        keywords: 'toggle dashboard stage pane',
        shortcut: ['Mod', 'Shift', 'D'],
        run: () => layoutCtrlRef.current?.toggleDashboard(),
      },
      {
        id: 'pane-reset',
        group: 'Workspace Panes',
        label: '重置工作台分屏布局',
        desc: '恢复默认宽高度并展开全部面板',
        icon: '↺',
        keywords: 'reset layout default split panes',
        shortcut: ['Mod', 'Shift', '0'],
        run: () => layoutCtrlRef.current?.resetLayout(),
      },
      {
        id: 'display-fullscreen',
        group: 'Workspace Panes',
        label: layoutSnap?.fullscreen ? '退出系统真全屏' : '进入系统真全屏',
        desc: 'Browser / Wails 窗口级全屏切换',
        icon: '⛶',
        keywords: 'fullscreen maximize window',
        shortcut: ['Mod', 'Shift', 'F'],
        run: () => layoutCtrlRef.current?.toggleFullscreen(),
      },
      {
        id: 'theme-cycle',
        group: 'Workspace Panes',
        label: '循环切换界面主题 (Cycle Theme)',
        desc: `当前: ${getThemeMeta(theme).label} (${theme}) · 共 ${themes.length} 套专业主题`,
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
          label: `主题: ${meta.label} (${t})`,
          desc: `${meta.group} · ${meta.description}`,
          icon: meta.mode === 'light' ? '☀' : '◔',
          keywords: `theme ${t} ${meta.label} ${meta.group} ${meta.mode} palette color`,
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
        label: '新建 Session (+ new)',
        desc: '选择工作目录与角色配置启动新分析会话',
        icon: '+',
        keywords: 'new session create start workspace',
        shortcut: ['Mod', 'Shift', 'N'],
        managesFocus: true,
        run: () => requestSidebarDialog('new'),
      },
      {
        id: 'session-resume',
        group: 'Sessions & RE',
        label: '恢复历史会话 (Resume)',
        desc: '加载已归档的会话转录、计划与 RE 账本',
        icon: '↻',
        keywords: 'resume history saved session restore',
        managesFocus: true,
        run: () => requestSidebarDialog('resume'),
      },
      {
        id: 'session-filter',
        group: 'Sessions & RE',
        label: '筛选侧栏会话',
        desc: '聚焦左侧会话搜索框按目录/模型/状态筛选',
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
          label: '打开当前会话设置 (⚙ Config)',
          desc: '调整 planner/executor 路由、max turns 与压缩策略',
          icon: '⚙',
          keywords: 'settings config planner executor provider turns',
          managesFocus: true,
          run: () => requestSidebarDialog('settings'),
        },
        {
          id: 'prompt-focus',
          group: 'Sessions & RE',
          label: '聚焦 Prompt 输入框',
          desc: '立即切回命令/对话输入光标',
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
          label: '打开 RE 工作流选择器 (/workflow reverse)',
          desc: '按样本类型（APK / ELF / Firmware 等）启动 9 阶段逆向流水线',
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
          label: '打开证据账本与假设栈明细 (LEDGER)',
          desc: '检视 H-NNN 假设状态与 ev_NNN 不可篡改证据链',
          icon: '▤',
          keywords: 'ledger evidence hypotheses stack audit',
          managesFocus: true,
          run: () => setLedgerModal({ tab: 'hypotheses' }),
        },
        {
          id: 're-workbench',
          group: 'Sessions & RE',
          label: '打开假设实验与验证台 (Workbench)',
          desc: '建立可证伪假设、实跑实验入账或签发审查结论',
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
          label: '中止当前执行回合 (■ stop)',
          desc: '安全中断当前 turn（已排队 prompt 保留）',
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
        label: `跳转至等待审批的会话 (${awaitingSessions.length})`,
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
        label: `切换会话: ${ws}`,
        desc: `${rt.info.planner || '—'} → ${rt.info.executor || '—'}${rt.info.workflow ? ` · [${rt.info.workflow}]` : ''}`,
        icon: isAct ? '●' : '○',
        keywords: `session switch ${ws} ${rt.info.workspace} ${rt.info.workflow}`,
        badge: isApr ? 'APPROVAL' : isAct ? 'ACTIVE' : rt.lifecycle === 'running' ? 'LIVE' : undefined,
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
            group: 'Demo & Reference',
            label: '打开演示场景库 (◈ 场景库)',
            desc: '切换 5 个交互式逆向工程演示 Case',
            icon: '◈',
            keywords: 'demo cases scenarios launcher',
            managesFocus: true,
            run: () => demoActions.setLauncherOpen(true),
          }
        : {
            id: 'demo-enter',
            group: 'Demo & Reference',
            label: '进入交互式演示环境 (▷ 演示环境)',
            desc: '零配置体验 5 个逆向 Case（不污染真实会话）',
            icon: '▷',
            keywords: 'demo sandbox try interactive',
            run: () => void demoActions.enterDemo('welcome-approval', true),
          },
      {
        id: 'help-shortcuts',
        group: 'Demo & Reference',
        label: '查看键盘快捷键速查表',
        desc: '浏览全部视图、分屏、输入框与会话快捷键',
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
            <div className="ix-top-group" role="group" aria-label="View mode switcher">
              <button
                type="button"
                className="ix-btn"
                onClick={() => {
                  shellActions.setActive(null)
                  setViewMode((m) => (m === 'theater' ? 'classic' : 'theater'))
                }}
                title={
                  viewMode === 'theater'
                    ? `切回经典 2D 布局（五维仪表 / 图谱 / 账本 · ${mod}1）`
                    : `进入 3D 取证剧场（作战室 + 引导式假设主线 · ${mod}4）`
                }
                style={viewMode === 'theater' && !activeShell ? theaterBtnActiveStyle : theaterBtnStyle}
              >
                {viewMode === 'theater' ? '▣ 经典视图' : '◈ 3D 剧场'}
              </button>
              {viewMode === 'classic' && centerView !== 'dashboard' && (
                <button
                  type="button"
                  className="ix-btn"
                  onClick={openClassicDashboard}
                  title={`切回五维实时仪表盘 (FLOW / TOOLS / PLAN / THINK / TELE · ${mod}1)`}
                  style={graphBtnActiveStyle}
                >
                  ▣ 五维仪表
                </button>
              )}
              <button
                type="button"
                className="ix-btn"
                onClick={toggleCenterTerrain}
                title={`二进制地形图（段/RWX/熵值曲线/内嵌载荷/反分析热点/补丁 Diff · ${mod}2）`}
                style={!activeShell && viewMode === 'classic' && centerView === 'terrain' ? terrainBtnActiveStyle : terrainBtnStyle}
              >
                ◫ 二进制解剖
              </button>
              {!(viewMode === 'classic' && centerView === 'graph') && (
                <button
                  type="button"
                  className="ix-btn"
                  onClick={() => openGraph('pipeline')}
                  title={`以图谱形式查看假设、证据、仲裁审核与安全沙箱协同机制 (${mod}3)`}
                  style={graphBtnStyle}
                >
                  ◈ 机制图谱
                </button>
              )}
              {firstShell && (
                <button
                  type="button"
                  className="ix-btn"
                  onClick={() => shellActions.setActive(activeShell ? null : firstShell.id)}
                  title={activeShell ? '返回 Agent 分析工作台' : '切至已打开的内置 PTY 终端'}
                  style={activeShell ? shellBtnActiveStyle : shellBtnStyle}
                >
                  {activeShell ? '↩ 会话' : '⌘ 终端'}
                </button>
              )}
            </div>

            <button
              type="button"
              className="ix-top-btn ix-top-btn--cmd"
              onClick={() => {
                setShortcutsOpen(false)
                setPaletteOpen(true)
              }}
              title={`打开命令面板 (${mod}K)`}
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
              title={`键盘快捷键速查表 (? / ${mod}/)`}
              aria-label="Keyboard shortcuts"
            >
              ?
            </button>

            {demo.active ? (
              <button
                type="button"
                className="ix-btn"
                onClick={() => demoActions.setLauncherOpen(true)}
                title="打开演示场景库（5 个常见逆向 Case）"
                style={demoBtnActiveStyle}
              >
                ◈ 场景库
              </button>
            ) : (
              <button
                type="button"
                className="ix-btn"
                onClick={() => void demoActions.enterDemo('welcome-approval', true)}
                title="进入交互式演示沙盒（零配置体验 5 个常见逆向 Case）"
                style={demoBtnStyle}
              >
                ▷ 演示环境
              </button>
            )}
            <label style={{ color: 'var(--faint)', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              theme
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
                title={`切换界面主题 (${mod}⇧T 循环切换)`}
                testId="theme-select"
              />
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
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
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
      role="status"
      aria-live="polite"
      onClick={() => actions.dismissToast()}
      title="点击关闭提示"
      style={{
        position: 'fixed',
        top: 42,
        right: 12,
        zIndex: 70, // above command palette (65) and approval overlay (50)
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
    <PanelBox
      title={tail.length > 0 ? `notices · ${tail.length}` : 'notices'}
      accent={hasError ? 'err' : undefined}
      tier="secondary"
    >
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

const demoBtnStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
  color: 'var(--accent)',
  border: '1px solid var(--accent-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const demoBtnActiveStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--violet) 11%, transparent)',
  color: 'var(--violet)',
  border: '1px solid var(--violet-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const graphBtnStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--violet) 8%, transparent)',
  color: 'var(--violet)',
  border: '1px solid var(--violet-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const theaterBtnStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
  color: 'var(--accent)',
  border: '1px solid var(--accent-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const theaterBtnActiveStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  boxShadow: '0 0 calc(12px * var(--glow-strength)) var(--accent-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const graphBtnActiveStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  boxShadow: '0 0 calc(10px * var(--glow-strength)) var(--accent-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const terrainBtnStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--warn) 9%, transparent)',
  color: 'var(--warn)',
  border: '1px solid color-mix(in srgb, var(--warn) 45%, var(--rule))',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const terrainBtnActiveStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--warn) 18%, transparent)',
  color: 'var(--warn)',
  border: '1px solid var(--warn)',
  boxShadow: '0 0 calc(10px * var(--glow-strength)) color-mix(in srgb, var(--warn) 35%, transparent)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const shellBtnStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--violet) 9%, transparent)',
  color: 'var(--violet)',
  border: '1px solid var(--violet-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const shellBtnActiveStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--violet) 18%, transparent)',
  color: 'var(--violet)',
  border: '1px solid var(--violet)',
  boxShadow: '0 0 calc(10px * var(--glow-strength)) var(--violet-dim)',
  font: 'inherit',
  fontSize: 11,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const emptyDemoCtaStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--accent) 9%, transparent)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  boxShadow: '0 0 calc(12px * var(--glow-strength)) var(--accent-dim)',
  font: 'inherit',
  fontSize: 12,
  padding: '5px 14px',
  cursor: 'pointer',
}
