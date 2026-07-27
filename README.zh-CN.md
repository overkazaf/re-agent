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

## 安装

```bash
go install github.com/overkazaf/re-agent/cmd/0xaf@v0.1.2
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

推荐固定安装 `@v0.1.2`。`@main` 可能受 Go module proxy 缓存影响，`@latest` 会解析到最新 tag。

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

caveman 不是翻译、暗语、编码或 prompt laundering；它是宿主级委派，让 executor 专注本地文件证据。

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
Web/WASM crypto、radare2、Ghidra、JADX、Unicorn、unidbg 和本地 playbook。

```text
/skills
/skill android-apk-frida inspect this APK
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
| `/retool inventory` | 检查 radare2/JADX/Ghidra/Unicorn/unidbg 可用性 |
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
