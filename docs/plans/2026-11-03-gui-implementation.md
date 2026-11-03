# 0xAF-Re GUI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本计划按工作流（WS1-WS4）并行执行：Phase 1 = WS1 ∥ WS2，Phase 2 = WS3 ∥ WS4，Phase 3 = 主会话集成。

**Goal:** 0xAF-Re 的 Wails 桌面 GUI——CRT 视觉、多 session 并发、复用 core 内核。

**Architecture:** `gui/` 包做翻译层（SessionManager + 事件桥 + 审批桥 + 命令 collector），core 层原样复用；React+TS 前端纯渲染，由 `gui:event` 推送驱动。

**Tech Stack:** Go 1.21+（现有模块）/ Wails v2 / React 18 + TypeScript + Vite / @fontsource/jetbrains-mono / react-markdown。

**设计文档:** `docs/plans/2026-11-03-gui-design.md`（先读它）

---

## 0. 冻结契约（所有 agent 必须遵守，不许单方面更改）

### 0.1 目录所有权（谁改谁的，越界 = 冲突）

```
主会话（集成者）独占:  gui/App.tsx 集成, gui/frontend/src/App.tsx, wails.json, package.json
WS1 (Go 桥接层):      gui/*.go, internal/core/agentloop.go(仅加 tag), internal/types/types.go(仅加 tag),
                      internal/app/commands.go(仅 notice sink 重构), internal/gui_* 测试
WS2 (视觉系统):       gui/frontend/src/styles/*, src/theme/*, src/components/crt/*, src/components/shell/*
WS3 (Dashboard):      gui/frontend/src/components/panels/*, src/dev/panels*.tsx(dev 页)
WS4 (交互层):         gui/frontend/src/store/*, src/components/session/*, src/components/re/*, src/dev/interact*.tsx
只读共享(脚手架产物):  src/lib/types.ts, src/lib/events.ts, src/lib/api.ts, src/dev/mock.ts
                      ——发现类型缺口→报告主会话，不许自行修改
```

### 0.2 Wails 绑定 API（App 结构方法面，前端唯一调用入口）

```go
// gui/app.go —— 全部返回 (result, error)，error 非 nil 时前端弹 toast
StartSession(opts StartOptions) (SessionInfo, error)
  // StartOptions{ Workspace string `json:"workspace"`, Role string `json:"role"`,
  //   Workflow string `json:"workflow"`, Mock bool `json:"mock"` }
  // Mock=true 时全部 provider 换 mock（对应 --smoke）
ResumeSession(id string) (SessionInfo, error)   // id 支持 hash/前缀/路径，走 ResolveSession
ListSessions() ([]SessionSummaryDTO, error)     // 直接映射 core.ListSessions
CloseSession(id string) error
SendPrompt(id, text string) error               // running 中自动入 Queue，否则开新 turn
SendCommand(id, line string) (CommandResultDTO, error)  // 斜杠命令，输出经 collector
Approve(id, requestID, decision string) error   // decision: allow|allow-always|deny|deny-always
GetState(id string) (TickDTO, error)            // 初始拉取/切 tab 重同步
Completions(line string) ([]string, error)      // 复用 internal/ui SlashCompletions，零重复
GetThemes() ([]string, error)                   // = ui.ThemeNames
```

### 0.3 事件契约（Go → 前端，单一通道）

```
EventsEmit("gui:event", payload)  payload = { sessionId string, kind string, ts int64, data any }

kind = "loop"    data = LoopEvent JSON（已加 tag；progress 类 50ms 批量合并为 data 数组 → data: LoopEvent[]）
kind = "tick"    data = TickDTO（90ms 节流 + 状态变化即发）
kind = "approval" data = ApprovalDTO{ requestID, toolName, risk, summary, argsPreview }
kind = "notice"  data = NoticeDTO{ level: "info"|"error", text }
kind = "lifecycle" data = { state: "idle"|"running"|"awaiting_approval"|"closed" }

TickDTO = {
  flow: FlowDTO      // ui.FlowState 映射（见 0.4）
  hud: HudDTO        // { phase, frame, elapsedMs, stats: TokenUsage, spark []float64,
                     //   route{planner,executor,active}, queueCount, planDisplay, thinkDisplay }
  re: ReDTO|null     // REHudModel 映射：{ sampleType, phase, phaseIndex, phaseCount, hypotheses, evidence }
  plan: PlanSnapshot // 最后一次 plan 快照
}
```

### 0.4 FlowDTO 字段（ui.FlowState 一一对应，snake_case json tag）

`stage, turn, provider, model, endpoint, messages, sentTokens, usage{input,output,thinking,cacheRead,cacheWrite,costUsd}, pendingCalls, activeTool, toolMs, toolsOk, toolsFailed, toolRuns[]{id,name,argsText,preview,status,startedAt,finishedAt,ms,ok}, replyChars, compactedDrop, compactedElide, hasCompacted, plan{done,total,source}, planKind, error, frame, packets[][]int, since`

stage 枚举: `idle|send|wait|think|calls|tool|write|done|error`

### 0.5 前端类型与主题 token

- `src/lib/types.ts` 定义 0.2-0.4 全部 TS 类型（脚手架已生成，只读）
- 主题 CSS 变量（4 套，`data-theme` 切换）：每套 11 色 `--accent --accent-dim --violet --violet-dim --ok --warn --err --text --muted --faint --rule` + 每套专属 `--bg --bg-panel --glow-strength`。RGB 值必须取自 internal/ui/theme.go:42-101 的 tone 定义，禁止自创色值
- 主题名: `deck | amber | matrix | mono`

---

## Phase 0.5 — 脚手架（主会话已完成后再放并行 agent）

Task A: 装 Wails CLI ✓（go install github.com/wailsapp/wails/v2/cmd/wails@latest）
Task B: `gui/` 骨架 + wails.json + gui/frontend npm 工程（React-TS-Vite）+ 只读共享文件（lib/types.ts, lib/events.ts, lib/api.ts, dev/mock.ts）+ 各目录 index.ts 占位
Task C: 验证 `wails build` 全绿 + 提交——**这是并行开工的门禁**

## Phase 1 — WS1（Go 桥接层）∥ WS2（视觉系统）

### WS1 任务（agent: go-bridge）

前置阅读: docs/plans/2026-11-03-gui-design.md、internal/app/repl.go:205-400（onEvent 闭包=翻译权威文档）、internal/ui/flow.go:204（Apply 状态机）

1. **core 加 json tag**：internal/core/agentloop.go:23 LoopEvent 全字段、internal/types/types.go:438 ProviderProgress 全字段（驼峰→snake_case tag，字段名不动）。`go build ./...` 绿。commit `feat(gui): json tags on core event types`
2. **gui/dto.go**：FlowState→FlowDTO、REHudModel→ReDTO 映射函数 + 表驱动测试（构造 FlowState 各 stage 断言 DTO 字段）。commit
3. **gui/manager.go**：SessionManager。镜像 app.Run 组装序列（config.Load → providers → tools 注册 → MCP → NewAgentLoop），每 session {id, cancel, loop, flowModel, subscribers, pendingApprovals, queue}；New/Resume/Close + 生命周期测试（mock provider 开 turn → 收到 loop 事件流 → Close 清理无泄漏 goroutine，用 runtime.NumGoroutine 前后对比）。commit
4. **gui/events.go**：事件桥。OnEvent → kind=loop 发射（progress 50ms 合并批）；90ms ticker 组 TickDTO 发 kind=tick；事件时序测试（fake clock）。commit
5. **gui/approval.go**：channel 包装 Confirm；pending 注册表 requestID→chan；Approve() 投递；Close 时全部 pending 返回 deny；测试：模拟工具审批往返。commit
6. **gui/command.go**：internal/app/commands.go 重构——emitNotice/emitError 提取为 `State.noticeSink func(level, text string)` 字段（默认 nil=现行为），GUI 设自己的 sink 收集为 NoticeDTO。`handleCommand` 其余逻辑不动。测试：mock session 上跑 `/help` 收集到 notice。commit
7. **gui/app.go + gui/main.go**：App 绑定结构（契约 0.2 全方法）+ Wails 入口（窗口 1440×900、bg #05080c 防白闪、AssetServer 指向 frontend/dist）。`wails build` 绿。commit

### WS2 任务（agent: crt-visual）

前置阅读: docs/plans/2026-11-03-gui-design.md、internal/ui/theme.go:38-112、internal/ui/splash.go、internal/ui/hud.go:38-63（字形表）

1. **styles/tokens.css**：4 主题 × 11 色 CSS 变量（RGB 从 theme.go 逐 tone 抄录）+ `--bg --bg-panel --glow-strength --scanline-opacity` 每套专属；`:root[data-theme="X"]` 选择器。commit `feat(gui): CRT design tokens from Go palettes`
2. **styles/crt.css**：扫描线层（fixed overlay, repeating-linear-gradient 2px 周期 + 8s 缓慢位移动画）、辉光工具类（.glow-accent/.glow-ok/... text-shadow 双层）、暗角 vignette、亚像素闪烁（opacity 0.985-1.0, 4s steps）、开机 power-on（scaleY + brightness 关键帧 400ms）。prefers-reduced-motion 全部降级。commit
3. **styles/base.css**：reset + body 等宽字体栈（JetBrains Mono 优先）+ 滚动条 CRT 化（细、accent 色）。commit
4. **theme/ThemeContext.tsx**：主题 state + `data-theme` 挂 documentElement + GetThemes() 绑定读取。commit
5. **components/crt/**（每个一文件 + index.ts 桶导出）：
   - PanelBox：`{title, accent?, children}` → ╭─ TITLE ─╮ 角框（CSS border + corner glyph 伪元素）
   - CornerFrame：四角托架装饰容器
   - GlowText：`{tone}` 辉光文字
   - Sparkline：`{data:number[], w?, h?}` SVG `▁▂▃▄▅▆▇█` 风格条形
   - ProgressChip：`{done, total}` `▰▰▰▱▱` 8 格 + 百分比
   - StatusBadge：`{state}` `● ◐ ○` 三态（ok/pending/off）
   - BootSplash：ASCII "0xAF" 大字 + 自检探针行逐条点亮（props: probes {label, ok}[], done 回调）+ power-on 动画
   - Spinner：braille 帧 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 90ms/帧
   commit
6. **components/shell/AppShell.tsx**：布局网格骨架（TopBar / 左 Sidebar 槽 / 中 Dashboard 槽 / 右副栏槽 / Transcript 槽 / PromptBar 槽，CSS grid 命名区域，min 1100×700 自适应收缩）；TopBar 组件（logo `▓▒░ 0xAF·RE :: COMMAND CENTER`、主题切换、live session 计数徽章）。**只管布局与视觉，槽位内容用 `children`/slot props，不 import WS3/WS4 组件**。dev 页 `src/dev/shell-demo.tsx` 全槽位塞占位块。commit
7. `npm run build`（tsc）绿 + dev 页目检清单写进 commit message。commit

## Phase 2 — WS3（Dashboard 面板）∥ WS4（交互层）

### WS3 任务（agent: dashboard-panels）

前置阅读: docs/plans/2026-11-03-gui-implementation.md 契约节、internal/ui/dashboard.go:127-302、internal/ui/flow.go:204（Apply）、src/lib/types.ts、src/dev/mock.ts

全部组件消费 `TickDTO.flow/hud/plan` 纯渲染，无自有业务状态。每个面板 = PanelBox 包裹。dev 页 `src/dev/panels-demo.tsx` 用 mock.ts 数据逐面板展示 + stage 全枚举矩阵。

1. **FlowPanel**：planner⇉executor 双导线 + 数据包粒子动画（CSS animation，packet 偏移用 `packets` 数组）、stage 徽章、provider/model 行、`Frame` 驱动 spinner、error 状态红辉光。commit
2. **ToolsPanel**：toolRuns 卡片列表（`├─ name args ✓ 3.2s / └─ preview` 树形），running 行 Spinner + accent 辉光，failed 红。commit
3. **PlanPanel**：PlanSnapshot 渲染——completed 折叠 `✔ N done`、in_progress `◈`、pending `○`；ProgressChip；planKind 变化闪烁（open|write|step → ok/accent/violet）。commit
4. **ThinkPanel**：thinking 尾窗（等宽，底部锚定，最新 N 行，展开/收起 3 行↔24 行），打字机不透明度渐变尾行。commit
5. **TelePanel**：Sparkline（输出吞吐）+ token 四计数 + cost `$0.0xx` + elapsed 时钟 + compacted 徽章（hasCompacted 时 `⌢ -N msgs`）。commit
6. **Dashboard/index.tsx**：五面板 grid 组合（响应式：窄则 PLAN/THINK 上下叠），接受 TickDTO prop。commit
7. `npm run build` 绿。commit

### WS4 任务（agent: interaction-layer）

前置阅读: 契约节、internal/app/repl.go:727-767（liveInputController 白名单）、internal/ui/help.go:23-92（命令表）、internal/ui/rehud.go、internal/workflow/phase.go:10-23（7 相枚举）

1. **store/sessions.ts**：轻量 store（useSyncExternalStore 模式，不引状态库）：sessions map、activeId、每 session 的 tick/loop/approval 事件缓冲、订阅 gui:event 分发。事件订阅在首个 session 创建时 EventsOn 一次。commit `feat(gui): session store over wails events`
2. **SessionSidebar**：session 列表（lifecycle 徽章 ● 运行 / ◐ 审批中 / ○ idle）、[+ new]（弹 NewSessionDialog：workspace/role/workflow/mock 开关）、[resume]（ListSessions 列表+搜索）、关闭按钮（运行中需确认）。commit
3. **TranscriptStream**：loop 事件 → trace 风格行（`t+6.3s ↻ wire send` glyphs：↻ wire / ◈ plan / ⚙ tool / ✓✗ 结果）+ reply 块 react-markdown 渲染 + 自动滚动（用户上滚时暂停）。commit
4. **PromptInput**：多行自适应输入框；`/` 触发 SlashPalette（Completions() 绑定 + 候选列表 ↑↓ Enter）；运行中提交自动转 queue（提示条 `⠿ queued (N)`）；`!` 前缀警告 shell 逃逸在 GUI v1 不支持。commit
5. **ApprovalDialog**：approval 事件弹卡（toolName/risk 色 read=ok write=warn network=err exec=violet / argsPreview 滚动窗）+ 四按钮 allow / allow-always / deny / deny-always + Esc=deny；awaiting_approval 时 session 徽章闪烁。commit
6. **REHudPanel + QueuePanel**：RE 七相条 `▸TRI → STA → DYN → EVD → INT → HYP → WRU`（当前 ▸ accent 加粗、过去 muted、未来 faint）+ H:N E:5 计数 + 假设/证据列表；QueuePanel 待执行 prompt 列表。commit
7. `npm run build` 绿 + interact dev 页。commit

## Phase 3 — 集成（主会话）

1. App.tsx 组装：AppShell + 各槽位接 WS3/WS4 组件；BootSplash 首启探针（config/providers/tools 计数）
2. `wails build` + `wails dev` 冒烟：mock session 开 turn → 五面板动 → 审批往返 → resume
3. TUI 回归：`go build ./... && go vet ./...`、`bin/0xaf --smoke` 正常（core tag 重构未破坏 TUI）
4. Makefile `make gui` 目标 + README GUI 节
5. 全部通过 → 汇报

## 测试策略

- Go：每任务表驱动测试（dto 映射、manager 生命周期、审批往返、事件时序、command sink），`go test ./gui/... ./internal/...`
- 前端：`npm run build`（tsc 严格）+ dev 页 mock 数据目检；v1 不引 vitest（视觉组件，目检更有效）
- 端到端：mock provider（--smoke 等价）开真 turn 走通全链路
