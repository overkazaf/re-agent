# 0xAF-Re GUI 设计文档

> 日期：2026-11-03 · 状态：已确认（用户批准：Wails 桌面应用 / 多 session 并发 / CRT 终端矩阵风 / v1 全功能）

## 目标

为 0xAF-Re 增加一个 Wails 桌面 GUI 版本：极客 CRT 视觉、多 session 并发监控、复用现有 core 内核，与 TUI 版共存。

## 已确认的决策

| 决策点 | 结论 |
| --- | --- |
| 技术形态 | Wails v2 桌面应用（Go 后端 + 系统 WebView），单仓单模块 |
| 多并发-产品 | GUI 内多 session 并发，每个 session 独立 AgentLoop + goroutine |
| 多并发-研发 | 4 个工作流（WS1-WS4）由并行 subagent 开发，契约先行 |
| 视觉风格 | CRT 终端矩阵风：扫描线、磷光辉光、等宽字体、ASCII 装饰、开机自检动画 |
| v1 范围 | 多 session 并发、实时 Dashboard、命令行+队列、审批门+会话管理+RE HUD |

## 总体架构

**翻译层，不重写内核。** core 层（agentloop/session/tools/workflow/providers）原样复用；app 层的 REPL 职责由 `gui/` 包接管：

```
gui/main.go        Wails 入口：窗口配置、AssetServer、App 绑定注册
gui/app.go         App 绑定结构（前端可调用的方法面，见契约）
gui/manager.go     SessionManager：新建/恢复/关闭 session；每 session 独立
                   goroutine + AgentLoop + FlowModel（规避 messages 无锁共享）
gui/events.go      事件桥：OnEvent 回调 → DTO JSON → Wails EventsEmit；
                   thinking 流 50ms 批量节流；90ms tick 快照（沿用 LivePane 节奏）
gui/approval.go    审批桥：同步 Confirm 回调 → channel 包装 → pending 注册表
gui/command.go     命令层：handleCommand 输出改道 collector（不 println），
                   全部斜杠命令语义零重复实现
gui/dto.go         ui.FlowState / HudModel → JSON DTO 映射
```

关键工程点：
- `LoopEvent` / `ProviderProgress` 补 json tag（对 core 的唯一侵入，纯增量）
- TUI 的 90ms LivePane 定时渲染逻辑不搬——前端只消费 `tick` 快照自行渲染
- 会话列表/恢复直接调 `ListSessions/ResolveSession/LoadSession` + `loop.Restore`
- mock 模式（`StartSession {mock:true}`，对应现有 `--smoke`）让 GUI 无 API key 可端到端演示
- Wails 资产内嵌，`make gui` 构建；`wails dev` 热重载开发

## 前端设计（CRT 终端矩阵风）

**布局**（1440×900 设计基准，最小 1100×700）：

```
┌────────────────────────────────────────────────────────────┐
│ ▓▒░ 0xAF·RE :: COMMAND CENTER          [theme] [● n live]  │  TopBar
├──────────┬─────────────────────────────────┬───────────────┤
│ SESSIONS │  ╭─ FLOW ─────────────────────╮ │ ╭─ RE HUD ──╮ │
│ ▶ s1 rev │  │ planner ⇉ executor 导线动画 │ │ │▸TRI→STA→…│ │
│   s2 ctf │  ╰───────────────────────────╯ │ │H:2 E:5    │ │
│   s3 ... │  ╭─ TOOLS ────────────────────╮ │ │假设/证据列表│ │
│          │  │ ├─ r2 aaa   ✓ 3.2s          │ │ ╰──────────╯ │
│ [+ new]  │  ╰───────────────────────────╯ │ ╭─ QUEUE ───╮ │
│          │  ╭─ PLAN ───────╮╭─ THINK ────╮ │ │2 pending  │ │
│ [resume] │  │▰▰▰▱▱ 3/7     ││思考流尾窗   │ │ ╰──────────╯ │
│          │  ╰─────────────╯╰────────────╯ │               │
├──────────┴─────────────────────────────────┴───────────────┤
│ TRANSCRIPT（trace 风格滚动行 + 回复 markdown）              │
├────────────────────────────────────────────────────────────┤
│ ❯ 输入框（slash 补全调色板 / 运行中自动转 queue）_          │  PromptBar
└────────────────────────────────────────────────────────────┘
```

**视觉语言**（从 internal/ui/theme.go 移植）：
- 4 主题 = CSS 变量组，11 tone 精确对齐 Go 调色板 RGB 值（deck 青紫 / amber 琥珀 CRT / matrix 绿磷光 / mono 无色相）
- CRT 特效层：扫描线（repeating-linear-gradient + 缓慢位移）、文字辉光（text-shadow 叠加）、四角托架框（╭╮╰╯ glyph + CSS border 混合）、轻微暗角 vignette、开机 power-on 动画、亚像素闪烁（低幅度，防晕）
- 字体：`@fontsource/jetbrains-mono` 本地打包（离线安全）
- 字形装饰沿用 TUI：`▰▱` 进度、`▁▂▃▄▅▆▇█` sparkline、`●◐○` 三态徽章、`├─└─` 树形、spinner braille 帧
- 开机动画：ASCII "0xAF" logo + 自检探针逐行点亮（config ✓ / providers ✓ / tools 24 ✓ / MCP …），对齐 splash.go 叙事

**事件驱动渲染**：前端无业务逻辑，全部由 `gui:event` 推送驱动；`tick` 快照驱动 Dashboard 动画，`loop` 事件驱动 transcript 流。

## 不做（v1 明确排除）

- 远程模式 GUI（remote SSH 面板）——沿用 CLI
- snapcompact PNG 归档查看器
- MCP 服务器管理 UI（MCP 工具正常出现在工具列表即可）
- 多窗口 / 拖拽分屏
- Windows/Linux 打包验证（macOS 优先，交叉编译留给后续）

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| Wails CLI 对子目录 wails.json 的 go.mod 定位 | Phase 0.5 脚手架阶段亲自验证 `wails build` 通过后才放并行 agent |
| handleCommand 深度耦合终端输出 | 最小重构：notice 输出改道 sink 函数，行为默认不变 |
| 并行 agent 文件冲突 | 契约冻结目录所有权（见实施计划），App.tsx 集成由主会话执行 |
| 同步审批回调阻塞 goroutine | channel 包装 + pending 注册表 + 会话关闭时清理 |
