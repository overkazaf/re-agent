# PLAN 面板：让 0xAF-Re 显示 planner/executor 的任务清单

日期：2026-07-26
状态：已确认，待实现

## 问题

0xAF-Re 双模型分工（planner=codex，executor=claude），但操作者看不到模型在计划什么。
终端里只有 spinner、thinking 窗口和工具调用行，一次多步 RE 任务跑到哪一步、还剩什么，全靠猜。

## 约束（决定方案的关键事实）

- 默认配置下两个 provider 都是 `cli-tmux` 类型，而 `CliTmuxProvider.complete()` 恒定返回
  `toolCalls: []`——外部 CLI 自己做工具调用，宿主侧的 `reverse-tools` 只在 prompt 里被列举，
  不会真的被 codex/claude CLI 调用。因此纯宿主侧的 `update_plan` 工具在默认路径上永远不触发。
- 但两个 CLI 各自都会产出计划，且都流经 `StdoutTail` 已经在 tail 的那条 JSONL：
  - Codex 二进制内含 `UpdatePlanArgs{explanation, plan: [PlanItemArg{step, status}]}`、
    `TurnPlanStep`、`TurnPlanUpdatedNotification`；标记计数：`update_plan`×33、`plan_update`×7、
    `todo_list`×1 —— 新旧两种事件外壳都存在，必须都兼容。
  - Claude Code 走 `TodoWrite` 的 `tool_use` block。
- `stream.ts` 目前把这些全丢了：`translateClaude` 只处理 `stream_event` 和 `result`，
  连携带完整 tool_use input 的 `type: "assistant"` 事件都没接。

## 方案

从 CLI 事件流采集为主（默认配置即生效、且能拿到执行中的实时状态变更），
宿主侧 `update_plan` 工具为辅（覆盖 `claude-api` / `codex-api` / `glm` 等真 API provider），
两条路汇入同一个 `PlanTracker`。

**范围：纯可观测。** 不改 `AgentLoop` 的控制流，计划不参与调度。

### 数据模型（`src/types.ts`）

```ts
type PlanStepStatus = "pending" | "in_progress" | "completed";
interface PlanStep { text: string; status: PlanStepStatus }
interface PlanSnapshot { steps: PlanStep[]; source: string; note?: string; updatedAt: number }
```

`ProviderProgress` 增加 `kind: "plan"` 与 `plan` / `planNote` 字段；
`ToolContext` 增加 `onPlan?` 回调。

### 采集（`src/providers/stream.ts`）

`StreamEventKind` 增加 `"plan"`，三条解析路径：

| 来源 | 事件形状 |
|---|---|
| Claude (Task*) | `TaskCreate{subject}` + `TaskUpdate{taskId,status}`，id 由 tool_result 文本 `Task #N created successfully: X` 绑定 |
| Claude (TodoWrite) | `type:"assistant"` → `message.content[]` 中 `tool_use && name==="TodoWrite"` → `input.todos[] = {content, status}` |
| Codex 旧壳 | `msg.type === "plan_update"` → `{explanation, plan:[{step, status}]}` |
| Codex 新壳 | `item.completed` 且 item 类型为 `todo_list` → `items:[{text, completed}]` |

> **实测修正（2026-07-26）**：本机 Claude Code 2.1.220 **没有 `TodoWrite` 工具**，任务清单是
> `TaskCreate` / `TaskUpdate` 这一对，且是**增量**语义而非整表替换——所以 Claude 侧的解析必须在
> `StreamParser` 里维护一张回合内的任务表。`TodoWrite` 路径予以保留，因为其他版本/配置仍可能有它。
> 这条是抓真实事件流验出来的，不是推测：单跑一次 `claude -p --output-format stream-json` 让它建
> 3 条任务并改状态，日志里只有 `TaskCreate` / `TaskUpdate`。第一次端到端联调时正是因为这个差异，
> 整条链路一个 plan 事件都没产生。

每步的 `startedAt` / `completedAt` 由 `PlanTracker` 打戳（按 provider id 优先、否则按文本匹配上一版），
解析层永远不碰时间——HUD 的每步耗时和进度条都来自这里。

全部沿用现有 `translate*` 的"多布局兼容、认不出就忽略"风格：结构对不上返回 `[]`，
不抛异常。计划是装饰层，任何解析失败都不得让一次 run 失败。

### 状态（`src/core/plan.ts`）

`PlanTracker.update()` 在内容与上次相同时返回 `undefined`，天然去抖，
避免重复重绘和重复落盘。计划**跨回合保留**（CLI session 是 resume 的，
下一轮常接着改同一份 todo），新计划整体替换旧的，不做 merge。

### 渲染（`src/ui/hud.ts` + `src/ui/plan.ts` + `src/ui/live.ts`）

最终落地为 HUD 仪表盘而非独立小面板：左列任务清单，右列遥测（吞吐 sparkline、token、耗时、
当前阶段），头部是 planner → executor 路由链和整体进度条。`hud.ts` 是纯函数
（`HudModel → string[]`），`live.ts` 只管状态、采样和擦除游标，`plan.ts` 的静态归档复用同一套
原语，保证归档快照和实时面板不会视觉漂移。

采样刻意与 `setStats` 解耦：按固定 400ms 节拍从 90ms 帧计时器上取样（调用本身是突发的），
16 格环形缓冲；样本不足 2 个或窗口最大值为 0 时不画——平铺的 `▁` 会把"停滞"谎报成"正在跑"。

原设计中的方案（保留，作为对照）：

`renderPlan()` 产出面板行，被常驻面板和回合末归档快照复用。
glyph：`✔`(ok) / 当前 spinner 帧(accent) / `○`(faint)。

`LivePane` 的 render body 从 `[...thinkingLines(), statusLine()]`
变成 `[...planLines(), ...thinkingLines(), statusLine()]`。
现有 `clear()` 按 `drawn` 行数逐行上擦，行数变化天然兼容。

**折叠**：步骤 ≤8 全显示；超了把已完成的压成一行 `✔ N done`，
保证 in_progress 及之后的始终可见，避免长计划把 thinking 窗口和 status 行挤出屏幕。

**非 TTY**（`--print` / 管道 / CI）：只存不画，回合结束静态打印一次最终快照。

### 持久化与命令

session jsonl 增加 `{"type":"plan","data":{steps,source,note}}` 记录（去抖后才写，可完整回放演进）。
新增 `/plan` 命令打印当前快照。

## 测试

仓库此前零测试。最脆的部分恰好是纯函数（解析外部事件形状），因此引入 `bun test`：

- `src/providers/stream.test.ts` —— 真实 JSONL 片段做 fixture，覆盖三种计划形态 + 畸形 JSON 不崩。
- `src/core/plan.test.ts` —— 去抖与计数。

## 不做

- 计划驱动调度（planner 出计划 → executor 逐条执行）。改动面涉及 `AgentLoop` 核心控制流
  与失败/重试/中断语义，另开一期。
- 从回复正文解析 ```plan 代码块。只能得到最终快照、没有执行中打勾，与本功能目标相悖。
