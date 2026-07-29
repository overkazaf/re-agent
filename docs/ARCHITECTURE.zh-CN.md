# 0xAF-Re 架构

**语言:** [English](ARCHITECTURE.md) | 中文

> 面向准备扩展、审计或排障这个二进制的人。本文是中文精简版：
> 保留关键路径、包边界和实现不变量；完整英文长文见
> [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 目录

- [1. 总览](#1-总览)
- [2. 包结构](#2-包结构)
- [3. 一轮请求怎么跑](#3-一轮请求怎么跑)
- [4. 角色、provider 与模型](#4-角色provider-与模型)
- [5. Workflow 模式](#5-workflow-模式)
- [6. 上下文预算](#6-上下文预算)
- [7. 工具、MCP 与输出预算](#7-工具mcp-与输出预算)
- [8. 审批闸门](#8-审批闸门)
- [9. UI、队列与任务视图](#9-ui队列与任务视图)
- [10. Skills、知识库与 prompts](#10-skills知识库与-prompts)
- [11. 数据格式与恢复](#11-数据格式与恢复)
- [12. 扩展点](#12-扩展点)
- [13. 必须保持的不变量](#13-必须保持的不变量)
- [14. 图表](#14-图表)

---

## 1. 总览

`0xaf` 是一个静态 Go 二进制，入口在 `cmd/0xaf`。它把终端 REPL、模型
provider、本地逆向工具、MCP 工具、session JSONL、实时 HUD 和 workflow
调度放在同一个进程里。

核心是 `internal/core.AgentLoop.Run`。每一轮都会：

1. 从 session 取完整历史。
2. 按 provider 的上下文预算压缩要发送的视图。
3. 选择角色和 provider。
4. 发起模型请求。
5. 把 assistant 回复写回 JSONL。
6. 如果有 tool calls，就走审批闸门、执行工具、写入 tool result，然后进入下一轮。

模型没有 tool call 时，本次 operator 请求结束。触发中断、到达 `maxTurns` 或
provider 返回错误时，也会停止当前 run。

---

## 2. 包结构

| 包 | 职责 |
| --- | --- |
| `internal/types` | 全局数据模型：message、tool、provider、plan、policy、approval。应尽量保持零依赖。 |
| `internal/util` | 路径收敛、参数转换、截断、通用错误判断。 |
| `internal/assets` | 嵌入 `prompts/` 和 `skills/`，并解析项目根目录或 `OXAF_RE_HOME`。 |
| `internal/config` | 默认配置、`agent.config.json` 合并、UI 偏好、provider model 覆盖。 |
| `internal/auth` | 环境变量、`.env`、本地 secrets、CLI 登录状态探测。 |
| `internal/skills` | 读取内置 skills 和本地覆盖，生成 prompt catalog。 |
| `internal/knowledge` | 本地 RE 知识库搜索、上下文打包、引用检查。 |
| `internal/workflow` | `off` / `auto` / `specialist` / `caveman` 的选择、包装和委派逻辑。 |
| `internal/security` | 命令风险分级和 tier x mode 审批规则。 |
| `internal/plan` | 任务列表 tracker：清洗步骤、记录状态、统计进度。 |
| `internal/tools` | 24 个内置工具、子进程运行器、输出 spill 预算。 |
| `internal/mcp` | stdio JSON-RPC client，并把 MCP server tools 包装成统一 tool。 |
| `internal/providers` | Anthropic、OpenAI Responses、OpenAI-compatible Chat、CLI tmux、mock adapter。 |
| `internal/core` | Agent loop、context compaction、session、`!` shell escape。 |
| `internal/ui` | HUD、live pane、flow 图、trace、markdown、palette、splash。 |
| `internal/app` | CLI 参数、REPL、slash commands、队列、line editor、`--print`。 |

依赖方向的原则很简单：`app` 是组合根；`core` 调 tools/provider，但不依赖
UI；`ui` 消费 `core.LoopEvent`；工具通过 `types.ToolContext` 回调计划或审批，
不能反向拿 loop。

---

## 3. 一轮请求怎么跑

普通请求是单 provider 多 turn 循环：

1. REPL 或 `--print` 把 operator prompt 交给 `runWithWorkflow`。
2. workflow 决定是否改写 prompt，或是否进入 delegated caveman。
3. `AgentLoop.Run` 解析有效角色：显式 `/role` 优先；`auto` 根据执行类关键词在
   planner/executor 间路由。
4. provider 收到 system prompt、压缩后的历史、当前工具列表和 model 参数。
5. assistant 回复落盘；如果包含 tool call，工具统一经过 approval gate。
6. 工具结果也落盘，再进入下一 turn；无 tool call 就结束。

`--print` 和交互 REPL 用的是同一条 loop，只是渲染方式不同。

---

## 4. 角色、provider 与模型

当前有四个角色：

| 角色 | 默认用途 |
| --- | --- |
| `planner` | 策略、拆解、整体判断。 |
| `executor` | 本地文件检查、命令执行、工具调用。 |
| `researcher` | 背景知识、相似样本、术语和资料梳理。 |
| `auto` | 根据 prompt 自动路由到 planner 或 executor。 |

默认配置里 planner 是 `codex`，executor 是 `claude`，researcher 是 `codex`。
可以运行中切换：

```text
/planner deepseek
/executor claude-api
/researcher grok
/model planner gpt-5.3-codex-high
/model claude opus
```

`/model` 会更新 session 内的 provider model。HTTP provider 把 model 写进请求体；
CLI provider 会尝试通过 `{model}`、已有 `--model`、或内置 codex/claude 参数规则传给 CLI。

---

## 5. Workflow 模式

Workflow 是 RE 场景的高层调度模式，不是安全策略绕过层。
provider 的策略检查仍然生效；这里做的是把完整规划上下文和只读本地证据收集拆开，
降低授权本地逆向被误伤的概率，而不是隐藏意图。

| 模式 | 行为 |
| --- | --- |
| `off` | 不改写 prompt，直接按角色路由。 |
| `specialist` | 面向 GPT Cyber、CC CVP 或同类授权 RE provider：先计划，再用 skills 和本地工具推进。 |
| `auto` | 如果 provider/model/label/CLI 名称里能识别 cyber/CVP 标记，就走 `specialist`；否则走 `caveman`。 |
| `caveman` | 面向普通 provider：host 把一次请求拆成 planner phase 和隔离 executor phase。 |

delegated caveman 的关键点：

1. planner 看完整的授权任务，但只输出策略和 executor packet。
2. executor 开隔离上下文，只拿低敏本地证据包。
3. executor 工具面收窄到只读、本地证据收集：list/read/grep/file type/strings/hexdump/hash/symbols/entropy/mitigations/carve/APK 等。
4. executor 不接触完整目标语义，不做 exploitation、credential、persistence、deployment 或网络动作。
5. 最终结果把 planner 和 executor 的证据合并回 operator 视图。

这套设计的目的，是把 CTF/逆向任务拆成“完整规划”和“低敏本地证据收集”两个清晰上下文，而不是把任务翻译、编码或伪装。

具体执行链路：

1. `app.runWithWorkflow` 先调用 `workflow.ShouldDelegate`。只有 role 是
   `auto`、且没有固定 provider 时，`caveman` 才会进入两段委派；显式
   `/role planner`、`/role executor`、`/role researcher` 或强制 provider 时，
   只保留 workflow prompt wrapper。
2. planner run 使用 `DelegatedPlannerPrompt`，planner 能看到完整授权任务，但工具面只保留
   `update_plan`，输出必须包含短计划和 `EXECUTOR_PACKET`。
3. executor run 使用 `DelegatedExecutorPrompt`。它会提取 packet；提取失败时，根据 prompt
   里的本地路径生成 fallback packet。
4. executor run 传入 `Isolated: true`、`FreshSession: true`、专用 executor system prompt
   和收窄工具列表，所以 provider 只收到当前 packet，不收到 planner 的完整上下文。
5. `combineDelegatedResults` 把两段 usage、turns 和 provider label 合并成
   `planner->executor`，同时 session JSONL 仍保留完整两段记录。

---

## 6. 上下文预算

session JSONL 是完整记录；发给 provider 的只是预算内视图。

压缩策略：

- system prompt 单独处理。
- assistant tool call 与后续 tool result 保持相邻。
- 大 tool output 会 spill 到 artifact 文件；上下文里保留摘要、头尾和路径。
- 旧消息可被摘要替换，但最后一段交互尽量保留。
- 被截断或中断的 assistant 回复会追加可识别说明，避免下一轮误读。

原则是：磁盘记录要完整，模型上下文要可控，工具证据要能按路径重新读取。

---

## 7. 工具、MCP 与输出预算

内置 registry 有 24 个工具，覆盖：

- 文件：list/read/write/grep/file info/hexdump/hash。
- 二进制：strings、symbols/imports、entropy、mitigations、find bytes、carve。
- CTF：triage、decode。
- Android/RE：APK inspect、Frida hook template、reverse toolkit。
- 知识库与 skills：skill list/read、knowledge search/read。
- 元工具：update plan。

`reverse_toolkit` 包装常见外部工具的固定动作，例如 radare2/rizin、JADX、
apktool、binwalk、YARA、Ghidra headless、gdb/lldb、objdump/readelf/nm、
APKID/AAPT、Frida 模板、angr、Unicorn 和 unidbg 模板。

MCP server tools 会转成同样的 `types.Tool`，并复用相同的 spill budget 与审批闸门。

---

## 8. 审批闸门

所有本地 tool 和 `!` shell escape 都会经过 `internal/security`：

- 按动作分 tier：读、写、执行、网络、敏感等。
- 按当前 policy mode 判断是否允许、拒绝或询问。
- workspace 路径通过 `ResolveInside` 收敛，避免越界读写。
- 大输出不会直接灌进模型上下文，而是写 artifact 后给摘要。

这让 UI、REPL、模型 tool call 和手动 shell escape 用同一套规则。

---

## 9. UI、队列与任务视图

UI 通过 `core.LoopEvent` 驱动，不反向影响 loop。

运行中能看到：

- 当前 provider、role、phase、model。
- planner/executor/researcher 路由状态。
- tool call、approval、耗时、token 和 cache。
- `update_plan` 维护的任务列表。
- dataflow 图和 trace。

任务执行时可以继续输入：

```text
/queue add triage ./next.apk
/queue edit 2 triage ./next.apk with jadx first
/queue cancel 2
/tasks collapse
/tasks expand
/model executor claude-sonnet
```

队列只会在未执行前允许编辑或取消；当前 turn 完成后按顺序弹出下一条。

---

## 10. Skills、知识库与 prompts

内置 skills 面向常见逆向起手式，例如 APK/native、CTF first pass、
native pwn、Web/WASM crypto。`OXAF_RE_HOME` 指向源码 checkout 时，本地
`skills/<name>/SKILL.md` 可以覆盖嵌入版本。

role prompts 可运行中编辑：

```text
/prompt show researcher
/prompt edit planner
/prompt set executor <text>
/prompt reset system
/prompt reload
```

runtime prompt 保存在项目 `prompts/` 或 `~/.0xaf-re-agent/prompts/`，不需要重新编译二进制。

---

## 11. 数据格式与恢复

session 是 append-only JSONL。每条 message 带 role、content blocks、tool calls、
provider、model、时间和必要的 metadata。

恢复路径：

- `/sessions` 列出历史。
- `/continue` 接上最近 session。
- `/resume <id>` 接指定 session。

session repair 会检查 tool call 与 tool result 的关系，避免缺失结果把下一轮 provider
请求弄成非法 transcript。

---

## 12. 扩展点

常见扩展路径：

- 新 provider：实现 `types.Provider`，接收 `ProviderInput`，返回 `ProviderResponse`。
- 新工具：在 `internal/tools` 添加 `types.Tool`，注册到 `CreateReverseTools`。
- 新 role：扩展 `types.AgentRole`、默认 provider、prompt、路由和 UI 文案。
- 新 workflow：放在 `internal/workflow`，不要把策略散落到 REPL 或 provider adapter。
- 新页面文档：英文和中文都补入口链接，避免 GitHub Pages 与 README 分叉。

---

## 13. 必须保持的不变量

- `types` 不应反向依赖上层包。
- `core` 不导入 `ui`。
- 工具不能绕过 approval gate。
- 写盘、网络和敏感动作不能默认放开。
- 磁盘 transcript 要比模型上下文更完整。
- delegated caveman 的 executor 只能拿收窄后的本地证据包和工具面。
- README、docs site、架构文档应保持中英文可互相跳转。

---

## 14. 图表

- [中文架构图索引](diagrams/index.zh-CN.html)
- [English diagrams](diagrams/index.html)
- [模块依赖图](diagrams/01-module-graph.svg)
- [单轮时序](diagrams/02-one-turn.svg)
- [上下文预算](diagrams/03-context-budget.svg)
- [审批闸门](diagrams/04-approval-gate.svg)
- [实时面板](diagrams/05-live-pane.svg)
- [oh-my-pi 架构笔记](diagrams/06-oh-my-pi.svg)
- [0xAF-Re vs oh-my-pi](diagrams/07-vs-oh-my-pi.svg)
