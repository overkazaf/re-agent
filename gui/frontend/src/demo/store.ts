// Demo Sandbox Coordinator — manages Demo Mode lifecycle, scenario seeding,
// step completion tracking (from manual actions or auto-play), and clean
// isolation from real Wails desktop sessions.
import { useSyncExternalStore } from 'react'
import { hasRealWailsBackend, setDemoAppAPI } from '../lib/api'
import { setDemoEventsOnly } from '../lib/events'
import {
  actions as sessionActions,
  getSessionStoreSnapshot,
  resetSessionStoreForDemo,
  restoreSessionsFromDemo,
  stashSessionsForDemo,
} from '../store/sessions'
import {
  getShellStoreSnapshot,
  resetShellStoreForDemo,
  restoreShellsFromDemo,
  shellActions,
  stashShellsForDemo,
} from '../store/shells'
import { DemoBackend } from './backend'
import {
  DEMO_SCENARIOS,
  getScenario,
  isScenarioId,
  type DemoScenarioId,
} from './scenarios'
import {
  emitDemoSignal,
  onDemoSignal,
  requestPromptFill,
  requestSidebarDialog,
  type DemoSignal,
} from './signals'

export interface DemoStoreSnapshot {
  active: boolean
  isStandaloneBrowser: boolean
  scenarioId: DemoScenarioId
  stepIndex: number
  completedSteps: Readonly<Record<string, boolean>>
  collapsed: boolean
  launcherOpen: boolean
  busy: boolean
  lastHint: string | null
}

const backend = new DemoBackend()

let state: DemoStoreSnapshot = {
  active: false,
  isStandaloneBrowser: !hasRealWailsBackend(),
  scenarioId: 'welcome-approval',
  stepIndex: 0,
  completedSteps: {},
  collapsed: false,
  launcherOpen: false,
  busy: false,
  lastHint: null,
}

const listeners = new Set<() => void>()
let signalUnsub: (() => void) | null = null
let runSeq = 0

function setState(patch: Partial<DemoStoreSnapshot>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): DemoStoreSnapshot {
  return state
}

export function useDemoStore(): DemoStoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function getDemoStoreSnapshot(): DemoStoreSnapshot {
  return state
}

// ---------- step completion matching ----------

function stepKey(scenarioId: DemoScenarioId, stepId: string): string {
  return `${scenarioId}:${stepId}`
}

function markStepDone(scenarioId: DemoScenarioId, stepId: string, hint?: string): void {
  const key = stepKey(scenarioId, stepId)
  const completedSteps = state.completedSteps[key]
    ? state.completedSteps
    : { ...state.completedSteps, [key]: true }

  const scenario = getScenario(scenarioId)
  let nextIdx = state.stepIndex
  if (state.scenarioId === scenarioId) {
    const curStep = scenario.steps[state.stepIndex]
    if (curStep && curStep.id === stepId) {
      const nextUnfinished = scenario.steps.findIndex(
        (st, i) => i > state.stepIndex && !completedSteps[stepKey(scenarioId, st.id)],
      )
      if (nextUnfinished >= 0) {
        nextIdx = nextUnfinished
      } else {
        const anyUnfinished = scenario.steps.findIndex(
          (st) => !completedSteps[stepKey(scenarioId, st.id)],
        )
        if (anyUnfinished >= 0) nextIdx = anyUnfinished
      }
    }
  }

  setState({
    completedSteps,
    stepIndex: nextIdx,
    ...(hint !== undefined ? { lastHint: hint } : {}),
  })
}

function handleSignal(sig: DemoSignal): void {
  if (!state.active) return
  const sid = state.scenarioId

  if (sid === 'welcome-approval') {
    if (sig.type === 'turn_completed' && sig.kind === 'welcome_triage') {
      markStepDone(sid, 'triage', '✓ 令牌 0xaf{warmup_deck} 已解码！下一步触发工具审批门。')
    } else if (sig.type === 'approval_requested') {
      markStepDone(sid, 'trigger-gate', '⚠ TOOL APPROVAL 已弹出！请亲自点选 allow 或 deny 观察分支。')
    } else if (sig.type === 'approval_decided') {
      const denied = sig.decision === 'deny' || sig.decision === 'deny-always'
      markStepDone(
        sid,
        'decide',
        denied
          ? '✓ 已体验 deny 拦截分支（未落盘）！可再次触发并选 allow 对比放行路径。'
          : '✓ 审批放行完成！验证通过并已写入 notes/solve.md。',
      )
    }
    return
  }

  if (sid === 're-workflow') {
    if (sig.type === 're_workflow_started') {
      markStepDone(
        sid,
        'open-picker',
        `✓ 已激活 RE 工作流（样本：${sig.sampleType}）并挂载 /goal 能力沙箱（network=deny）。`,
      )
    } else if (sig.type === 'turn_completed' && sig.kind === 're_carve') {
      markStepDone(
        sid,
        'carve',
        '✓ codex-sol 建立 H-001..H-003，ds 静态取证 E:4，宿主仲裁器发出 single-view 提醒（▸DYN [3/9]）。',
      )
    } else if (sig.type === 'turn_completed' && sig.kind === 're_verify') {
      markStepDone(
        sid,
        'correlate',
        '✓ 沙箱拦截外联 (cap=network) · 仲裁反证折半淘汰 H-002 并级联 H-003→reevaluate · 确立 H-004（▸VER [7/9]）。',
      )
    } else if (sig.type === 'audit_completed') {
      markStepDone(
        sid,
        'audit',
        '✓ 独立第三席位 glm-5.3 隔离对抗审计 PASS！/goal 3/3 达标，已解锁第 5 步 Writeup 报告交付。',
      )
    } else if (sig.type === 'writeup_completed' || (sig.type === 'turn_completed' && sig.kind === 're_writeup')) {
      markStepDone(
        sid,
        'writeup',
        '✓ 可溯源逆向报告 notes/writeup.md 已生成！点击上方「◈ 协同图谱」可放大检视、回放思考轨迹或在 Writeup 工坊导出。',
      )
    }
    return
  }

  if (sid === 'multi-queue-stop') {
    if (sig.type === 'session_switched') {
      markStepDone(sid, 'switch', `✓ 已切换至 ${sig.workspace.split('/').pop()}，转录与仪表盘完全隔离。`)
    } else if (sig.type === 'prompt_sent' && sig.queued) {
      markStepDone(sid, 'queue', '✓ 追问已自动进入 QUEUE 排队，当前回合结束后将自动接力执行！')
    } else if (sig.type === 'interrupted') {
      markStepDone(sid, 'interrupt', '✓ 当前回合已安全中止（interrupted），会话与上下文完好保留。')
    }
    return
  }

  if (sid === 'commands-themes') {
    if (sig.type === 'command_sent') {
      const cmd = sig.line.trim().split(/\s+/)[0]?.toLowerCase()
      if (
        cmd &&
        ['/decode', '/scan', '/inspect', '/anti', '/entropy', '/diff', '/goal', '/cap', '/tools', '/help'].includes(cmd)
      ) {
        markStepDone(sid, 'slash-direct', `✓ 直调命令 ${cmd} 完成，结果已落地右侧 NOTICES。`)
      }
    } else if (sig.type === 'theme_changed') {
      markStepDone(sid, 'theme', `✓ 主题已实时切换为 ${sig.theme} 荧光管。`)
    } else if (sig.type === 'settings_saved') {
      markStepDone(sid, 'config-resume', '✓ 路由配置已保存！也可以点击左侧 resume 恢复历史会话。')
    } else if (sig.type === 'session_resumed') {
      markStepDone(sid, 'config-resume', '✓ 历史会话已恢复（含转录、计划与 RE 账本状态）。')
    }
    return
  }

  if (sid === 'shell-lab') {
    if (sig.type === 'shell_opened') {
      markStepDone(sid, 'open-shell', '✓ 内置 PTY 终端已启动！试试 ls -la 或 node chall.js \'0xaf{warmup_deck}\'。')
    } else if (sig.type === 'shell_command') {
      if (sig.command.includes('chall.js') || sig.command.includes('node')) {
        markStepDone(sid, 'run-verify', '✓ 本地终端校验完成！点击左侧 SESSIONS 中的 welcome 即可无缝切回仪表盘。')
      } else {
        setState({
          lastHint: `› 已执行 "${sig.command}" — 再试试 node chall.js '0xaf{warmup_deck}' 完成本步`,
        })
      }
    } else if (sig.type === 'returned_to_session') {
      markStepDone(sid, 'switch-back', '✓ 已切回 Agent 仪表盘，终端仍在左侧 SHELLS 后台保活。')
    }
  }
}

// ---------- scenario seeding ----------

async function seedScenario(scenarioId: DemoScenarioId): Promise<void> {
  const token = ++runSeq
  const scenario = getScenario(scenarioId)
  setState({
    scenarioId,
    stepIndex: 0,
    busy: true,
    lastHint: null,
  })

  backend.reset()
  resetSessionStoreForDemo()
  resetShellStoreForDemo()

  for (const seed of scenario.seeds) {
    if (token !== runSeq || !state.active) return
    const res = await sessionActions.createSession({
      workspace: seed.workspace,
      role: seed.role,
      workflow: seed.workflow,
      mock: true,
    })
    if (res.ok && seed.preset) {
      backend.seedPreset(res.value.id, seed.preset)
    }
  }

  if (token !== runSeq || !state.active) return
  sessionActions.dismissToast()
  setState({ busy: false })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findSessionByWorkspace(substr: string): string | null {
  const { sessions } = getSessionStoreSnapshot()
  for (const rt of sessions.values()) {
    if (rt.info.workspace.includes(substr)) return rt.info.id
  }
  return null
}

// ---------- public actions ----------

export const demoActions = {
  /** Parse ?demo=1 / ?case=<id> or auto-enable in standalone browser mode. */
  detectInitialDemo(): { shouldAutoEnter: boolean; caseId: DemoScenarioId } {
    let urlDemo = false
    let caseId: DemoScenarioId = 'welcome-approval'
    try {
      const params = new URLSearchParams(window.location.search)
      const qCase = params.get('case')
      if (isScenarioId(qCase)) {
        caseId = qCase
        urlDemo = true
      }
      if (params.get('demo') === '1' || params.get('demo') === 'true') {
        urlDemo = true
      }
    } catch {
      // ignore URL parse issues
    }
    const standalone = !hasRealWailsBackend()
    return { shouldAutoEnter: standalone || urlDemo, caseId }
  },

  async enterDemo(scenarioId?: DemoScenarioId, openLauncher = false): Promise<void> {
    const target = scenarioId ?? state.scenarioId
    if (!state.active) {
      // 同步置 __DEMO__：3D 剧场的 TheaterDebugBridge 在挂载 effect 里读它，
      // 必须在 CommandCenter（及其子组件）渲染前就位，e2e 的 zoneScreenPos 才可用。
      ;(window as unknown as { __DEMO__?: boolean }).__DEMO__ = true
      stashSessionsForDemo()
      stashShellsForDemo()
      setDemoEventsOnly(true)
      setDemoAppAPI(backend)
      if (!signalUnsub) {
        signalUnsub = onDemoSignal(handleSignal)
      }
      setState({
        active: true,
        isStandaloneBrowser: !hasRealWailsBackend(),
        launcherOpen: openLauncher,
      })
    } else if (openLauncher) {
      setState({ launcherOpen: true })
    }
    await seedScenario(target)
  },

  exitDemo(): void {
    if (!state.active || !hasRealWailsBackend()) return
    ;(window as unknown as { __DEMO__?: boolean }).__DEMO__ = undefined
    runSeq += 1
    backend.dispose()
    setDemoAppAPI(null)
    setDemoEventsOnly(false)
    if (signalUnsub) {
      signalUnsub()
      signalUnsub = null
    }
    restoreShellsFromDemo()
    restoreSessionsFromDemo()
    setState({
      active: false,
      launcherOpen: false,
      busy: false,
      lastHint: null,
    })
  },

  async selectScenario(scenarioId: DemoScenarioId): Promise<void> {
    if (!state.active) {
      await demoActions.enterDemo(scenarioId, false)
      return
    }
    setState({ launcherOpen: false })
    await seedScenario(scenarioId)
  },

  async resetScenario(): Promise<void> {
    if (!state.active) return
    const nextCompleted: Record<string, boolean> = {}
    const prefix = `${state.scenarioId}:`
    for (const [k, v] of Object.entries(state.completedSteps)) {
      if (!k.startsWith(prefix)) nextCompleted[k] = v
    }
    setState({ completedSteps: nextCompleted })
    await seedScenario(state.scenarioId)
  },

  setStepIndex(idx: number): void {
    const scenario = getScenario(state.scenarioId)
    const clamped = Math.max(0, Math.min(scenario.steps.length - 1, idx))
    setState({ stepIndex: clamped })
  },

  nextScenario(): void {
    const cur = DEMO_SCENARIOS.findIndex((s) => s.id === state.scenarioId)
    const next = DEMO_SCENARIOS[(cur + 1) % DEMO_SCENARIOS.length]
    void demoActions.selectScenario(next.id)
  },

  toggleCollapsed(): void {
    setState({ collapsed: !state.collapsed })
  },

  setLauncherOpen(open: boolean): void {
    setState({ launcherOpen: open })
  },

  /** Populate PromptInput with the current step's suggested text without sending. */
  fillCurrentStep(): void {
    const scenario = getScenario(state.scenarioId)
    const step = scenario.steps[state.stepIndex]
    if (!step) return
    if (step.fillText) {
      shellActions.setActive(null)
      requestPromptFill({ text: step.fillText, autoSend: false })
      return
    }
    if (step.shellCmd) {
      void demoActions.runCurrentStep()
    }
  },

  /** Execute the current step automatically so users can watch or take over anytime. */
  async runCurrentStep(): Promise<void> {
    if (!state.active || state.busy) return
    const scenario = getScenario(state.scenarioId)
    const step = scenario.steps[state.stepIndex]
    if (!step) return

    const token = runSeq
    const { activeId, sessions } = getSessionStoreSnapshot()

    switch (step.autoKind) {
      case 'prompt':
      case 'command':
      case 're-picker': {
        if (!step.fillText) return
        shellActions.setActive(null)
        requestPromptFill({ text: step.fillText, autoSend: true })
        return
      }

      case 'approve-allow': {
        if (!activeId) return
        const pending = backend.getPendingApproval(activeId)
        if (pending) {
          await sessionActions.approve(activeId, pending, 'allow')
        } else {
          // User jumped directly to Step 3 — trigger Step 2 first so the dialog appears
          const prev = scenario.steps.find((s) => s.id === 'trigger-gate')
          if (prev?.fillText) {
            shellActions.setActive(null)
            requestPromptFill({ text: prev.fillText, autoSend: true })
          }
        }
        return
      }

      case 'switch-session': {
        shellActions.setActive(null)
        const other = [...sessions.values()].find((rt) => rt.info.id !== activeId)
        if (other) {
          sessionActions.setActive(other.info.id)
        }
        return
      }

      case 'queue-pair': {
        shellActions.setActive(null)
        const elfId = findSessionByWorkspace('elf-packer') ?? activeId
        if (!elfId || !step.fillText) return
        sessionActions.setActive(elfId)
        setState({ busy: true })
        await sessionActions.sendPrompt(elfId, step.fillText)
        await sleep(550)
        if (token !== runSeq || !state.active) return
        if (step.extraPrompt) {
          await sessionActions.sendPrompt(elfId, step.extraPrompt)
        }
        setState({ busy: false })
        return
      }

      case 'interrupt-demo': {
        shellActions.setActive(null)
        const elfId = findSessionByWorkspace('elf-packer') ?? activeId
        if (!elfId || !step.fillText) return
        sessionActions.setActive(elfId)
        setState({ busy: true })
        await sessionActions.sendPrompt(elfId, step.fillText)
        await sleep(1100)
        if (token !== runSeq || !state.active) return
        await sessionActions.interrupt(elfId)
        setState({ busy: false })
        return
      }

      case 'open-settings': {
        shellActions.setActive(null)
        requestSidebarDialog('settings')
        return
      }

      case 'open-shell': {
        const ws = activeId ? sessions.get(activeId)?.info.workspace ?? '/demo/welcome' : '/demo/welcome'
        await shellActions.open(ws)
        return
      }

      case 'shell-cmd': {
        let { activeShellId, shells } = getShellStoreSnapshot()
        if (!activeShellId) {
          const first = [...shells.values()][0]
          if (first) {
            shellActions.setActive(first.id)
            activeShellId = first.id
          } else {
            const ws = activeId ? sessions.get(activeId)?.info.workspace ?? '/demo/welcome' : '/demo/welcome'
            await shellActions.open(ws)
            await sleep(260)
            activeShellId = getShellStoreSnapshot().activeShellId
          }
        }
        if (activeShellId && step.shellCmd) {
          backend.typeInShell(activeShellId, step.shellCmd)
        }
        return
      }

      case 'return-session': {
        shellActions.setActive(null)
        if (activeId) {
          emitDemoSignal({ type: 'returned_to_session', sessionId: activeId })
        }
      }
    }
  },
}
