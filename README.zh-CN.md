# 0xAF-Re

一个面向授权逆向工程与 CTF 的终端 Agent。它把 planner 模型、executor 模型、本地逆向工具、
workflow 模式、任务队列和实时运行视图打包进一个静态 Go 二进制。

**语言:** [English](README.md) | 中文

**链接:** [项目主页](https://overkazaf.github.io/re-agent/index.zh-CN.html) · [架构文档](docs/ARCHITECTURE.zh-CN.md) · [架构图](docs/diagrams/index.zh-CN.html) · [对比图](docs/diagrams/07-vs-oh-my-pi.svg)

<p align="center">
  <img src="docs/shots/live.svg" alt="一轮运行中的实时画面：数据流图、HUD、任务进度和 token 遥测。" width="900">
</p>

## 目录

- [概览](#概览)
- [开发者亮点](#开发者亮点)
- [项目动机](#项目动机)
- [安装](#安装)
- [快速开始](#快速开始)
- [基础 Demos](#基础-demos)
- [Workflow 模式](#workflow-模式)
- [Provider 与模型](#provider-与模型)
- [Skills 与知识库](#skills-与知识库)
- [安全策略](#安全策略)
- [常用命令](#常用命令)
- [更多文档](#更多文档)

## 双语对照

中英文 README 保持同一结构，方便直接切换。

| 中文 | English |
| --- | --- |
| [概览](#概览) | [Overview](README.md#overview) |
| [开发者亮点](#开发者亮点) | [Developer Highlights](README.md#developer-highlights) |
| [项目动机](#项目动机) | [Project Motivation](README.md#project-motivation) |
| [安装](#安装) | [Install](README.md#install) |
| [快速开始](#快速开始) | [Quick Start](README.md#quick-start) |
| [基础 Demos](#基础-demos) | [Basic Demos](README.md#basic-demos) |
| [Workflow 模式](#workflow-模式) | [Workflow Modes](README.md#workflow-modes) |
| [Provider 与模型](#provider-与模型) | [Providers and Models](README.md#providers-and-models) |
| [Skills 与知识库](#skills-与知识库) | [Skills and Knowledge](README.md#skills-and-knowledge) |
| [安全策略](#安全策略) | [Safety](README.md#safety) |
| [常用命令](#常用命令) | [Common Commands](README.md#common-commands) |
| [更多文档](#更多文档) | [More Docs](README.md#more-docs) |

## 概览

- **本地优先:** 斜杠命令直接在本机做文件粗筛、strings、熵扫描、carve、APK 检查、保护检查和逆向工具盘点。
- **双角色:** planner 和 executor 可以用不同模型、不同厂商。运行中用 `/planner`、`/executor`、`/model` 切换。
- **过程可见:** HUD 会显示路由、阶段、任务列表、工具调用、token 和耗时。
- **默认收敛:** 默认只能读工作区；写盘、联网和敏感操作都需要显式放开。
- **单二进制:** prompt 和内置 skills 已嵌入；需要本地覆盖时，用 `OXAF_RE_HOME` 指向仓库目录。

完整设计见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)。图形化概览见
[中文架构图](docs/diagrams/index.zh-CN.html)。

## 开发者亮点

如果你在做 agent，0xAF-Re 是一个足够小、但关键部件齐全的 RE 场景参考实现：
单个 Go 二进制里包含 provider 路由、工具治理、实时遥测、prompt/skill 覆盖、
任务队列和审计日志。它不像 demo 那样只展示聊天，而是把 agent 真正落地时麻烦的部分也摊开。

- **安装像单文件工具:** 一个静态二进制，一个 Go 依赖，关键路径不需要 Node 或浏览器 runtime。
- **模型座位可组合:** planner、executor、researcher 可以接不同 provider、不同模型和不同 prompt。
- **证据优先 workflow:** 有 GPT Cyber / Claude Code CVP / Grok 类订阅就直走 specialist；
  普通模型走 caveman，只拿只读本地证据包。
- **过程可调试:** HUD、trace、token/耗时遥测、任务状态和 JSONL session 让每一轮都能复盘。
- **扩展面够直接:** 内置 RE 工具、MCP tools、skills、知识库导入、本地覆盖和运行中任务队列。

## 项目动机

0xAF-Re 源于作者日常授权 RE/CTF 工作里的痛点：CC 类 CLI 风控升级后，普通模型面对逆向语义也更容易过度谨慎，本地样本分析经常被打断。这个项目不做隐写、暗语或绕策略，而是把工作限定在授权、本地、可审计范围内，再通过角色拆分和多模型组合改善体验。

- **模型组合:** planner 负责路线，executor 负责工具，researcher 负责背景资料；三个角色可以接不同模型。
- **专用订阅加成:** 如果有 GPT Cyber、Claude Code CVP、Grok 或类似更适配安全研究/逆向的 route，`workflow auto` 会更顺。
- **普通 provider 也能跑:** caveman 模式把任务收窄成本地证据包，让谨慎的 executor 只收集文件事实。
- **后续计划:** 加入本地模型和可复现评测样例，用样例结果衡量不同 provider/workflow 的效果并迭代。

## 安装

```bash
go install github.com/overkazaf/re-agent/cmd/0xaf@v0.1.5
0xaf --version
0xaf --welcome
```

从源码构建：

```bash
git clone https://github.com/overkazaf/re-agent
cd re-agent
make build
./bin/0xaf --version
```

推荐固定安装 `@v0.1.5`。`@main` 可能受 Go module proxy 缓存影响，`@latest` 会解析到最新 tag。

## 快速开始

```bash
0xaf --smoke                    # 离线自检，不需要 API key
0xaf --workspace ./demos/reverse-lab
```

进入 REPL 后：

```text
/scan artifact.txt
/decode auto ZmxhZ3s...
/policy
/help
```

默认路由会优先复用本地 CLI 登录。检查当前可用状态：

```bash
0xaf auth status
codex login status
claude auth status --text
```

在 REPL 里用 `/auth` 查看同样状态。要跑原始 CLI 命令时加 `!`，例如
`!codex login status`。

## 基础 Demos

先用内置 demo 工作区熟悉流程，再把路径换成自己的样本。

| 目标 | 从这里开始 |
| --- | --- |
| 打开引导演示 | `0xaf --welcome` |
| 离线检查线路 | `0xaf --smoke` |
| 进入 demo 工作区 | `0xaf --workspace ./demos/reverse-lab` |
| 识别未知文件 | `/scan ./chall` |
| 查看二进制保护 | `/mitigations ./chall` |
| 找加壳、压缩或加密区段 | `/entropy ./chall` |
| 从 blob 里挖内嵌文件 | `/carve ./blob` |
| 解 token 或 flag-like 字符串 | `/decode auto ZmxhZ3s...` |
| 检查 APK | `/apk ./app.apk` |
| 检查本地逆向工具 | `/retool inventory` |
| 准备移动/API 抓包 | `/retool mitmproxy template api.example.test` |
| 让 planner 给 solve 思路 | `0xaf --role planner -p "粗筛 ./chall 并给下一步"` |
| 跑隔离本地证据模式 | `0xaf --workflow caveman -p "粗筛 ./app.apk"` |

最快路径不需要模型：`/scan`、`/decode`、`/entropy`、`/mitigations`、`/carve`、`/apk`
都是本地工具直出。

## Workflow 模式

workflow 需要显式打开。默认 `off` 会原样发送 prompt。

| 模式 | 适合什么时候 | 行为 |
| --- | --- | --- |
| `off` | 默认 | 不加 workflow wrapper |
| `auto` | 混合机器 | 检测到 GPT Cyber / CC CVP 类 route 就走 specialist，否则走 caveman |
| `specialist` | 授权 cyber/CVP 类 provider | 先计划，再用 skills 和本地工具推进，保留证据 |
| `caveman` | 普通 provider | planner 写本地证据包；executor 开新会话，只拿收窄后的只读证据工具 |

```text
/workflow auto
/workflow caveman
0xaf --workflow specialist -p "triage ./app.apk"
```

“跑隔离本地证据模式”指的就是 `caveman` workflow。它不是单纯改写 prompt，
而是宿主把一次请求拆成两个模型调用：

1. **planner 阶段:** planner 看到完整授权 RE/CTF 任务，输出短计划和 `EXECUTOR_PACKET`。
2. **executor 阶段:** executor 开新的隔离上下文，只看到这个 packet、专用 executor system prompt，以及收窄后的只读工具。
3. **证据收集:** executor 只能围绕工作区本地文件收集事实，例如 list/read/search、文件类型、hash、strings、hex 范围、熵、导入/符号、保护信息、carve 线索和 APK 结构。
4. **结果合并:** 0xAF-Re 把两段记录写进同一个 session transcript，并返回 `planner->executor` 的合并结果。

`auto` 是 resolver：检测到 GPT Cyber / CC CVP 类 provider 标记时走
`specialist`，否则选择 `caveman`。真正的 delegated caveman 只在 role 是
`auto`、且没有固定 provider 时触发；如果显式 `/role planner`、`/role executor`
或强制某个 provider，0xAF-Re 会尊重这个选择，只做 prompt wrapper。

caveman 不是翻译、暗语、编码或 prompt laundering。它让普通 executor 专注本地文件事实；
遇到 live target、凭据、持久化、部署或网络动作会拒绝，不会隐藏成其它说法。

关于模型风控和标记：0xAF-Re 不绕过 provider 的策略检查，也不保证某一轮不会被 provider
分类。它做的是降低授权本地 RE 被误伤的概率，让每个角色只看到自己确实需要的内容：

- planner 看到完整授权目标，并产出有边界的 packet
- executor 只看到工作区路径和证据收集步骤
- executor 的工具面是只读、本地的
- session transcript 保留两段完整记录，方便审计
- 不安全请求会被拒绝，而不是藏进其它说法

## Provider 与模型

planner、executor、researcher 是角色；provider 是可替换的座位。

```text
/planner deepseek
/executor claude-api
/researcher grok
/agent auto
/model deepseek deepseek-reasoner
/model planner gpt-5.3-codex-high
```

HTTP provider 会在请求体里覆盖 model。内置 CLI provider 会注入 `--model`；
自定义 CLI provider 可以在 `cliArgs` 里使用 `{model}` 占位符。

不同角色的 prompt 可以运行中编辑：

```text
/prompt list
/prompt show planner
/prompt path executor
/prompt edit researcher
/prompt set executor <text>
/prompt reset system
/prompt reload
```

可编辑目标是 `system`、`planner`、`executor`、`researcher`。`/prompt edit`
会从内置 prompt 初始化文件，打开 `$VISUAL` 或 `$EDITOR`，保存后立即 reload。
如果检测到项目根目录，会写到 `prompts/`；否则写到 `~/.0xaf-re-agent/prompts/`。

最小配置示例：

```json
{
  "plannerProvider": "codex",
  "executorProvider": "claude",
  "providers": {
    "deepseek": {
      "type": "openai-chat",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": ["DEEPSEEK_API_KEY"]
    }
  }
}
```

完整配置可以复制 `config.example.json` 到 `agent.config.json` 后修改。

## Skills 与知识库

内置 skills 覆盖常见逆向路径：CTF first pass、Android APK + Frida、native pwn/RE、
Web/WASM crypto、radare2、Ghidra、JADX、Burp/mitmproxy、angr、Unicorn、unidbg 和本地 playbook。

```text
/skills
/skill android-apk-frida inspect this APK
/skill proxy-capture capture api.example.test traffic
```

添加自己的 skill：

```bash
export OXAF_RE_HOME=/path/to/re-agent
mkdir -p "$OXAF_RE_HOME/skills/my-unpacker"
$EDITOR "$OXAF_RE_HOME/skills/my-unpacker/SKILL.md"
```

索引本地笔记：

```bash
go run ./cmd/import-knowledge ~/notes/re ~/notes/ctf
```

查询：

```text
/know frida ssl pinning
/know raw frida ssl
/know read <entry-id>
```

## 安全策略

默认策略：

- 只能读工作区内文件
- 不允许写盘
- 不允许网络命令
- 阻止像凭据的路径
- 阻止破坏性 shell 模式

常用开关：

```bash
0xaf --approval always-ask
0xaf --write
0xaf --allow-network
0xaf --yolo
```

REPL 内：

```text
/policy
/approval
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/help` | 命令面板 |
| `/scan <path>` | 本地 CTF/file 粗筛 |
| `/decode auto <text>` | 尝试常见编码 |
| `/mitigations <path>` | 查看二进制保护 |
| `/retool inventory` | 检查 radare2/JADX/Ghidra/Burp/mitmproxy/angr/Unicorn/unidbg 可用性 |
| `/retool angr template ./chall` | 生成 angr 符号执行 harness |
| `/retool frida template android_ssl_pinning` | 生成常见 Frida SSL/crypto/root/debug/native 模板 |
| `/retool mitmproxy template api.example.test` | 生成带 host 过滤的 mitmproxy 抓包 addon |
| `/retool burp template mobile` | 生成 Burp 移动/API 抓包检查清单 |
| `/queue list` | 查看待执行任务 |
| `/queue edit <id> <text>` | 修改尚未执行的任务 |
| `/queue cancel <id>` | 取消尚未执行的任务 |
| `/tasks collapse` / `/tasks expand` | 折叠或展开 live 任务列表 |
| `/prompt edit <role>` | 编辑 system、planner、executor、researcher prompt |
| `/sessions` / `/continue` / `/resume <id>` | 续接历史会话 |
| `!<command>` | 在工作区内按当前策略跑 shell 命令 |

## 更多文档

- [架构深挖](docs/ARCHITECTURE.zh-CN.md)：包结构、一轮对话、上下文预算、审批闸门、数据格式、不变量和扩展点。
- [架构图索引](docs/diagrams/index.zh-CN.html)：核心运行机制的图形化入口。
- [模块图](docs/diagrams/01-module-graph.svg)
- [单轮时序](docs/diagrams/02-one-turn.svg)
- [上下文预算](docs/diagrams/03-context-budget.svg)
- [审批闸门](docs/diagrams/04-approval-gate.svg)
- [实时面板](docs/diagrams/05-live-pane.svg)
- [oh-my-pi 架构笔记](docs/diagrams/06-oh-my-pi.svg)
- [0xAF-Re vs oh-my-pi](docs/diagrams/07-vs-oh-my-pi.svg)
- [项目主页和宣传图](https://overkazaf.github.io/re-agent/index.zh-CN.html)

本工具面向**已获授权**的 CTF、实验环境与本地逆向工作：二进制粗筛、静态分析、
本地动态实验、solve 计划，以及可复现的分析记录。
