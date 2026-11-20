// Curated interactive demo scenarios covering the 5 signature 0xAF-Re GUI cases.
// Each scenario seeds realistic local sessions and defines step-by-step goals
// that complete automatically whether the user operates manually or clicks auto-play.

export type DemoScenarioId =
  | 'welcome-approval'
  | 're-workflow'
  | 'multi-queue-stop'
  | 'commands-themes'
  | 'shell-lab'

export type DemoAutoKind =
  | 'prompt'
  | 'command'
  | 're-picker'
  | 'approve-allow'
  | 'switch-session'
  | 'queue-pair'
  | 'interrupt-demo'
  | 'open-settings'
  | 'open-shell'
  | 'shell-cmd'
  | 'return-session'

export interface DemoStep {
  id: string
  title: string
  target: string
  guide: string
  fillText?: string
  extraPrompt?: string
  shellCmd?: string
  autoKind: DemoAutoKind
  autoLabel?: string
}

export interface DemoSeedSession {
  workspace: string
  role: string
  workflow: string
  /** Optional pre-seeded RE state & history so the scenario starts mid-flight when useful. */
  preset?: 'android-sign-ready'
}

export interface DemoScenario {
  id: DemoScenarioId
  index: number
  title: string
  subtitle: string
  duration: string
  tags: string[]
  summary: string
  seeds: DemoSeedSession[]
  steps: DemoStep[]
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'welcome-approval',
    index: 1,
    title: '入门解谜 + 工具审批门',
    subtitle: 'demos/welcome/chall.js',
    duration: '~2 min',
    tags: ['5-PANEL', 'THINK', 'PLAN', 'APPROVAL'],
    summary:
      '从零走一遍 0xAF-Re 标准逆向闭环：五面板实时联动（FLOW / TOOLS / PLAN / THINK / TELE），并在高危命令处弹出审批门，亲自体验 allow 与 deny 的真实分叉。',
    seeds: [{ workspace: '/demo/welcome', role: 'auto', workflow: 'auto' }],
    steps: [
      {
        id: 'triage',
        title: '初筛解码',
        target: 'FLOW / PLAN',
        guide: '发送首条分析指令，观察顶部 FLOW 数据包、TOOLS 工具树、PLAN 任务卡与 THINK 推理流解出预期 token。',
        fillText: '分析当前目录的 chall.js，定位编码算法并还原预期 token',
        autoKind: 'prompt',
        autoLabel: '自动发送',
      },
      {
        id: 'trigger-gate',
        title: '触发审批门',
        target: 'APPROVAL',
        guide: '要求 Agent 本地执行验证并写报告，这会命中 exec/write 安全策略并弹出 TOOL APPROVAL 风险卡片（默认聚焦 deny 防误触）。',
        fillText: "运行 node chall.js '0xaf{warmup_deck}' 验证令牌，并将结果写入 notes/solve.md",
        autoKind: 'prompt',
        autoLabel: '自动触发',
      },
      {
        id: 'decide',
        title: '审批决策',
        target: 'ALLOW / DENY',
        guide: '在弹窗点击 allow 放行执行（或按 Esc / 点 deny 体验拦截分叉，拦截后仍可重发对比两条分支结果）。',
        autoKind: 'approve-allow',
        autoLabel: '点 allow 放行',
      },
    ],
  },
  {
    id: 're-workflow',
    index: 2,
    title: '三模型协同 · 契约/证据/仲裁/审计/Writeup 闭环',
    subtitle: 'deepseek + codex + glm · carrier.bin',
    duration: '~3 min',
    tags: ['DEEPSEEK·CODEX·GLM', 'SANDBOX', 'ARBITRATOR', 'WRITEUP'],
    summary:
      '严格对齐文章六大核心环节：/goal 契约锚定 → /cap 能力沙箱 → ev_NNN 一等账本 → H-NNN 反证折半与级联纠偏（破除 Commits to a story）→ glm 零上下文隔离审计 → 硬闸门解锁可溯源 Writeup 分析报告（推荐打开「◈ 协同图谱」体验放大、思考过程回放与 Writeup 工坊！）。',
    seeds: [{ workspace: '/demo/reverse-lab', role: 'auto', workflow: 'off' }],
    steps: [
      {
        id: 'open-picker',
        title: '契约与入轨',
        target: '① /goal + /cap',
        guide: '输入 /workflow reverse 选择样本类型（推荐 Firmware blob），由宿主锁定样本指纹并自动拉起默认拒网的能力沙箱（network=deny）。',
        fillText: '/workflow reverse',
        autoKind: 're-picker',
        autoLabel: '打开选择器',
      },
      {
        id: 'carve',
        title: '静态取证与假设',
        target: '③ ev_NNN · ④ H-NNN',
        guide: 'codex 静态雕刻盖章 ev_001..ev_004 入账，deepseek 建立 H-001/H-002 与派生子假设 H-003，宿主仲裁器触发 single-view 单视角提醒。',
        fillText: '对 carrier.bin 做文件分诊与内嵌特征提取，建立初步假设',
        autoKind: 'prompt',
        autoLabel: '自动执行',
      },
      {
        id: 'correlate',
        title: '沙箱拦截与反证级联',
        target: '② SANDBOX · ④ ARBITRATOR',
        guide: '能力沙箱阻断越权外联（cap=network denied），动态解压报错触发宿主置信度折半淘汰 H-002 并级联 H-003→reevaluate（阻断幻觉圆谎），重放确立 H-004。',
        fillText: '读取 artifact.txt 解码 Base64 并与 carrier.bin 动态结论交叉验证',
        autoKind: 'prompt',
        autoLabel: '自动执行',
      },
      {
        id: 'audit',
        title: 'GLM 隔离对抗审计',
        target: '⑤ AUDITOR · glm',
        guide: '运行 /audit 唤醒独立第三席位 glm（零对话、零工具），对假设栈逐条签发 SUPPORT/CHALLENGE 裁定并落盘 audit_finding，打通全部 /goal 门禁。',
        fillText: '/audit',
        autoKind: 'command',
        autoLabel: '运行 /audit (glm)',
      },
      {
        id: 'writeup',
        title: '生成可溯源 Writeup',
        target: '⑥ WRI [9/9] · WRITEUP',
        guide: 'WRI 硬闸门已解锁！生成全证据锚定（[H-NNN] + [ev_NNN]）的结构化逆向分析报告并归档至 notes/writeup.md（也可在图谱「✎ Writeup 工坊」预览/导出）。',
        fillText: '基于已审计的证据账本与假设栈生成结构化 Writeup 分析报告并写入 notes/writeup.md',
        autoKind: 'prompt',
        autoLabel: '生成 Writeup',
      },
    ],
  },
  {
    id: 'multi-queue-stop',
    index: 3,
    title: '多会话并发 + 队列 + 中断',
    subtitle: 'android-sign & elf-packer',
    duration: '~2 min',
    tags: ['MULTI-SESSION', 'QUEUE', 'INTERRUPT'],
    summary:
      '同时驾驭多个隔离的逆向会话：左侧栏自由切换不串台，长任务运行中继续输入自动排队（⠿ queued），并可随时按 ■ stop 安全中止当前回合。',
    seeds: [
      { workspace: '/demo/android-sign', role: 'auto', workflow: 'reverse', preset: 'android-sign-ready' },
      { workspace: '/demo/elf-packer', role: 'auto', workflow: 'ctf' },
    ],
    steps: [
      {
        id: 'switch',
        title: '切换会话',
        target: 'SIDEBAR',
        guide: '在左侧 SESSIONS 栏点击 android-sign 再切回 elf-packer，感受两路会话的转录、仪表盘与 RE HUD 完全隔离。',
        autoKind: 'switch-session',
        autoLabel: '自动切换',
      },
      {
        id: 'queue',
        title: '运行中排队',
        target: 'QUEUE',
        guide: '在 elf-packer 启动深度扫描，并在 ● running 期间立刻再提交一条追问，观察输入框上方 ⠿ queued (1) 与右侧 QUEUE 面板。',
        fillText: '深度扫描 crackme_x64：检查 ELF 头、区段熵、加壳特征与反调试点',
        extraPrompt: '补充列出所有可疑导出符号与反调试导入函数',
        autoKind: 'queue-pair',
        autoLabel: '演示排队',
      },
      {
        id: 'interrupt',
        title: '实时中断',
        target: '■ STOP',
        guide: '发起全量控制流分析后，在运行中点击输入框左下角红色 ■ stop 按钮（Interrupt），立即安全中止而不关闭会话。',
        fillText: '对 crackme_x64 执行全量控制流与 OLLVM 反平坦化分析（长任务）',
        autoKind: 'interrupt-demo',
        autoLabel: '演示中断',
      },
    ],
  },
  {
    id: 'commands-themes',
    index: 4,
    title: '斜杠命令 + 主题 + 配置/恢复',
    subtitle: 'Direct Tools · CRT Themes · Resume',
    duration: '~2 min',
    tags: ['SLASH /', 'PURE-GO TOOLS', 'THEMES', 'RESUME'],
    summary:
      '体验不走 LLM 的直调命令（/scan /decode /inspect /goal /cap）、四套 CRT 荧光配色切换、⚙ 模型路由设置以及 resume 恢复历史会话。',
    seeds: [{ workspace: '/demo/reverse-lab', role: 'auto', workflow: 'auto' }],
    steps: [
      {
        id: 'slash-direct',
        title: '直调命令',
        target: '/ PALETTE · NOTICES',
        guide: '在输入框敲 / 查看补全面板，运行 /decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9（支持任意真实 Base64！）或 /scan carrier.bin。',
        fillText: '/decode base64 ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9',
        autoKind: 'command',
        autoLabel: '运行 /decode',
      },
      {
        id: 'theme',
        title: '切换主题',
        target: 'TOPBAR · THEME',
        guide: '运行 /theme amber（或点击右上角 theme 下拉框）体验 deck / amber / matrix / mono 四套 CRT 荧光管配色。',
        fillText: '/theme amber',
        autoKind: 'command',
        autoLabel: '切 amber 主题',
      },
      {
        id: 'config-resume',
        title: '配置与恢复',
        target: '⚙ CONFIG · RESUME',
        guide: '点击左侧栏 ⚙ 调整 planner/executor 路由并保存，或点击 resume 从历史列表恢复一场已完成的逆向会话。',
        autoKind: 'open-settings',
        autoLabel: '打开 ⚙ 设置',
      },
    ],
  },
  {
    id: 'shell-lab',
    index: 5,
    title: '内置 PTY 终端与双屏协同',
    subtitle: 'xterm.js · /demo/welcome',
    duration: '~1 min',
    tags: ['PTY SHELL', 'XTERM', 'WORKFLOW'],
    summary:
      '不离开工作台直接开终端做手工验证：点击侧栏 + sh 启动内置 xterm.js 终端，真实执行 ls / cat / node chall.js，并可随时在终端与 Agent 仪表盘间无损切换。',
    seeds: [{ workspace: '/demo/welcome', role: 'auto', workflow: 'auto' }],
    steps: [
      {
        id: 'open-shell',
        title: '启动终端',
        target: 'SIDEBAR · + SH',
        guide: '点击左侧栏 SHELLS 区的 + sh 按钮，在当前 workspace（/demo/welcome）打开内置 xterm.js 终端。',
        autoKind: 'open-shell',
        autoLabel: '打开 + sh',
      },
      {
        id: 'run-verify',
        title: '终端实操',
        target: 'SHELL · XTERM',
        guide: "在终端里自由输入 ls -la、cat chall.js，再执行 node chall.js '0xaf{warmup_deck}' 查看真实校验输出（accepted）。",
        shellCmd: "node chall.js '0xaf{warmup_deck}'",
        autoKind: 'shell-cmd',
        autoLabel: '自动输入验证',
      },
      {
        id: 'switch-back',
        title: '双屏切回',
        target: 'SESSIONS ↔ SHELLS',
        guide: '点击左侧栏 SESSIONS 中的 welcome 切回 Agent 仪表盘（终端留在后台存活，随时点 SHELLS 行可无缝返回）。',
        autoKind: 'return-session',
        autoLabel: '切回仪表盘',
      },
    ],
  },
]

export function getScenario(id: DemoScenarioId): DemoScenario {
  return DEMO_SCENARIOS.find((s) => s.id === id) ?? DEMO_SCENARIOS[0]
}

export function isScenarioId(value: string | null | undefined): value is DemoScenarioId {
  return DEMO_SCENARIOS.some((s) => s.id === value)
}
