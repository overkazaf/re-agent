# 0xAF-Re

A terminal agent for authorized reverse-engineering and CTF work. It combines a
planner model, an executor model, local RE tools, workflow modes, queued prompts,
and a live view of each turn in one static Go binary.

**Language:** English | [中文](README.zh-CN.md)

**Links:** [Project page](https://overkazaf.github.io/re-agent/) · [Architecture](docs/ARCHITECTURE.md) · [Architecture diagrams](docs/diagrams/) · [Comparison diagram](docs/diagrams/07-vs-oh-my-pi.svg)

<p align="center">
  <img src="docs/shots/live.svg" alt="A live mid-turn frame with a dataflow diagram, a HUD, task progress, and token telemetry." width="900">
</p>

## Table of Contents

- [Overview](#overview)
- [Developer Highlights](#developer-highlights)
- [Project Motivation](#project-motivation)
- [Install](#install)
- [Quick Start](#quick-start)
- [Basic Demos](#basic-demos)
- [Workflow Modes](#workflow-modes)
- [Providers and Models](#providers-and-models)
- [Skills and Knowledge](#skills-and-knowledge)
- [Safety](#safety)
- [Common Commands](#common-commands)
- [More Docs](#more-docs)

## Bilingual Map

The English and Chinese READMEs keep the same structure for quick switching.

| English | 中文 |
| --- | --- |
| [Overview](#overview) | [概览](README.zh-CN.md#概览) |
| [Developer Highlights](#developer-highlights) | [开发者亮点](README.zh-CN.md#开发者亮点) |
| [Project Motivation](#project-motivation) | [项目动机](README.zh-CN.md#项目动机) |
| [Install](#install) | [安装](README.zh-CN.md#安装) |
| [Quick Start](#quick-start) | [快速开始](README.zh-CN.md#快速开始) |
| [Basic Demos](#basic-demos) | [基础 Demos](README.zh-CN.md#基础-demos) |
| [Workflow Modes](#workflow-modes) | [Workflow 模式](README.zh-CN.md#workflow-模式) |
| [Providers and Models](#providers-and-models) | [Provider 与模型](README.zh-CN.md#provider-与模型) |
| [Skills and Knowledge](#skills-and-knowledge) | [Skills 与知识库](README.zh-CN.md#skills-与知识库) |
| [Safety](#safety) | [安全策略](README.zh-CN.md#安全策略) |
| [Common Commands](#common-commands) | [常用命令](README.zh-CN.md#常用命令) |
| [More Docs](#more-docs) | [更多文档](README.zh-CN.md#更多文档) |

## Overview

- **Local first:** slash commands run file triage, strings, entropy, carving,
  APK inspection, mitigations, and reverse-tool inventory directly on your disk.
- **Two seats:** planner and executor providers can be different models or
  vendors. Switch them at runtime with `/planner`, `/executor`, and `/model`.
- **Visible turns:** the HUD shows route, phase, task list, tools, token counts,
  and timing while the turn is still running.
- **Scoped by default:** reads stay inside the workspace; writes, network, and
  sensitive actions need explicit policy changes.
- **Installable binary:** prompts and built-in skills are embedded, while
  project-local files can override them when `OXAF_RE_HOME` points at a checkout.

For the full design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For the
visual overview, see [the architecture diagrams](docs/diagrams/).

## Developer Highlights

If you build agents, 0xAF-Re is a compact RE-focused reference implementation:
one Go binary with provider routing, tool governance, live telemetry,
prompt/skill overrides, queueing, and audit logs. It is small enough to read,
but opinionated enough to show the parts most agent demos skip.

- **Single-file install feel:** one static binary, one Go dependency, no Node or
  browser runtime in the critical path.
- **Composable model seats:** planner, executor, and researcher can use
  different providers, models, and editable prompts.
- **Evidence-first workflows:** specialist routes use GPT Cyber / CC CVP / Grok
  style subscriptions directly; caveman mode isolates ordinary executors to
  read-only local evidence packets.
- **Visible agent loop:** HUD, trace lines, token/timing telemetry, task state,
  and JSONL sessions make each turn debuggable.
- **Hackable surface area:** built-in RE tools, MCP tools, skills, knowledge
  import, project-local overrides, and runtime queue editing.

## Project Motivation

0xAF-Re grew out of daily authorized RE/CTF work where coding-agent risk
controls tightened and general models became more cautious around
reverse-engineering language. The goal is not to hide intent. The agent keeps
work local, authorized, and auditable, then improves the experience by splitting
roles and composing models.

- **Model composition:** use one model for planning, another for tool execution,
  and a researcher role for background context.
- **Specialist routes:** GPT Cyber, Claude Code CVP, Grok, or similar
  security-research-friendly routes make `workflow auto` smoother.
- **Ordinary-provider path:** caveman mode narrows the task into local evidence
  packets so cautious executors can still collect file facts safely.
- **Roadmap:** local models and reproducible benchmark cases will be added so
  provider/workflow quality can be measured and improved over time.

## Install

```bash
go install github.com/overkazaf/re-agent/cmd/0xaf@v0.1.2
0xaf --version
0xaf --welcome
```

From source:

```bash
git clone https://github.com/overkazaf/re-agent
cd re-agent
make build
./bin/0xaf --version
```

`go install ...@v0.1.2` is the recommended install path. `@main` can lag behind
through the Go module proxy cache, and `@latest` resolves to the newest tag.

## Quick Start

```bash
0xaf --smoke                    # offline wiring check, no API key required
0xaf --workspace ./demos/reverse-lab
```

Inside the REPL:

```text
/scan artifact.txt
/decode auto ZmxhZ3s...
/policy
/help
```

The default route uses local CLIs when available. Check what 0xAF-Re can see:

```bash
0xaf auth status
codex login status
claude auth status --text
```

## Basic Demos

Use the built-in demo workspace first, then replace paths with your own files.

| Goal | Start With |
| --- | --- |
| Open the guided tour | `0xaf --welcome` |
| Verify offline wiring | `0xaf --smoke` |
| Start a demo workspace | `0xaf --workspace ./demos/reverse-lab` |
| Identify an unknown file | `/scan ./chall` |
| Check binary protections | `/mitigations ./chall` |
| Find packed or encrypted regions | `/entropy ./chall` |
| Carve embedded payloads | `/carve ./blob` |
| Decode a token or flag-like string | `/decode auto ZmxhZ3s...` |
| Inspect an APK | `/apk ./app.apk` |
| Check local RE tools | `/retool inventory` |
| Ask for a solve plan | `0xaf --role planner -p "triage ./chall and propose next checks"` |
| Run delegated local evidence mode | `0xaf --workflow caveman -p "triage ./app.apk"` |

The fast path does not need a model: `/scan`, `/decode`, `/entropy`,
`/mitigations`, `/carve`, and `/apk` are direct local tools.

## Workflow Modes

Workflow mode is explicit. Default `off` sends prompts unchanged.

| Mode | Use When | Behavior |
| --- | --- | --- |
| `off` | default | no workflow wrapper |
| `auto` | mixed machines | use specialist if a GPT Cyber / CC CVP-style route is configured, otherwise caveman |
| `specialist` | authorized cyber/CVP-style provider | plan, use skills and local tools, preserve evidence |
| `caveman` | ordinary providers | planner writes a bounded packet; executor starts fresh with a narrow read-only evidence toolset |

```text
/workflow auto
/workflow caveman
0xaf --workflow specialist -p "triage ./app.apk"
```

The "delegated local evidence mode" demo is the `caveman` workflow. It means the
host splits one operator request into two model calls:

1. **Planner phase:** the planner sees the full authorized RE/CTF task and
   writes a short plan plus an `EXECUTOR_PACKET`.
2. **Executor phase:** the executor starts in a fresh isolated context. It sees
   only that packet, a dedicated executor system prompt, and a narrowed read-only
   toolset for local evidence.
3. **Evidence collection:** the executor can list/read/search files, identify
   file type, hash, strings, byte ranges, entropy, symbols/imports, mitigations,
   carved signatures, and APK structure.
4. **Merge:** 0xAF-Re appends both phases to the same session transcript and
   returns a combined `planner->executor` result.

`auto` is a resolver: it uses `specialist` when a GPT Cyber / CC CVP-style
provider marker is configured; otherwise it selects `caveman`. True delegated
caveman runs when role is `auto` and no provider is pinned. If you explicitly
set `/role planner`, `/role executor`, or force one provider, 0xAF-Re respects
that choice and only wraps the prompt.

Caveman mode is not translation, ciphering, or prompt laundering. It keeps the
ordinary executor focused on workspace-local file facts and refuses unsafe live
target, credential, persistence, deployment, or network work.

About provider safety systems: 0xAF-Re does not bypass model policy checks or
guarantee that a provider will not classify a turn. It reduces false positives
for authorized local RE by changing what each role legitimately needs to see:

- the planner sees the full authorized objective and produces a bounded packet
- the executor sees only workspace paths and evidence-collection steps
- the executor tool list is read-only and local
- the session transcript keeps both phases auditable
- unsafe requests are refused instead of being hidden in alternate wording

## Providers and Models

Planner, executor, and researcher are roles. Providers are replaceable seats.

```text
/planner deepseek
/executor claude-api
/researcher grok
/agent auto
/model deepseek deepseek-reasoner
/model planner gpt-5.3-codex-high
```

HTTP providers use model overrides in the request body. Built-in CLI providers
inject `--model`; custom CLI configs can use the `{model}` placeholder.

Role prompts are editable at runtime:

```text
/prompt list
/prompt show planner
/prompt path executor
/prompt edit researcher
/prompt set executor <text>
/prompt reset system
/prompt reload
```

Editable targets are `system`, `planner`, `executor`, and `researcher`.
`/prompt edit` seeds the file from the embedded prompt, opens `$VISUAL` or
`$EDITOR`, and reloads immediately. With a detected project root it writes under
`prompts/`; otherwise it writes under `~/.0xaf-re-agent/prompts/`.

Minimal config override:

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

Copy `config.example.json` to `agent.config.json` for a full local config.

## Skills and Knowledge

Built-in skills cover common RE paths: CTF first pass, Android APK + Frida,
native pwn/RE, Web/WASM crypto, radare2, Ghidra, JADX, Unicorn, unidbg, and
local playbooks.

```text
/skills
/skill android-apk-frida inspect this APK
```

Add your own skill:

```bash
export OXAF_RE_HOME=/path/to/re-agent
mkdir -p "$OXAF_RE_HOME/skills/my-unpacker"
$EDITOR "$OXAF_RE_HOME/skills/my-unpacker/SKILL.md"
```

Index local notes:

```bash
go run ./cmd/import-knowledge ~/notes/re ~/notes/ctf
```

Query them:

```text
/know frida ssl pinning
/know raw frida ssl
/know read <entry-id>
```

## Safety

Default policy:

- reads stay inside the workspace
- writes are off
- network commands are off
- credential-shaped paths are blocked
- destructive shell patterns are blocked

Useful flags:

```bash
0xaf --approval always-ask
0xaf --write
0xaf --allow-network
0xaf --yolo
```

Inside the REPL:

```text
/policy
/approval
```

## Common Commands

| Command | Purpose |
| --- | --- |
| `/help` | command deck |
| `/scan <path>` | local CTF/file triage |
| `/decode auto <text>` | try common encodings |
| `/mitigations <path>` | native binary protections |
| `/retool inventory` | check radare2/JADX/Ghidra/Unicorn/unidbg availability |
| `/queue list` | show queued prompts |
| `/queue edit <id> <text>` | edit queued work before it runs |
| `/queue cancel <id>` | cancel queued work |
| `/tasks collapse` / `/tasks expand` | fold or expand the live task list |
| `/prompt edit <role>` | edit system, planner, executor, or researcher prompts |
| `/sessions` / `/continue` / `/resume <id>` | resume prior work |
| `!<command>` | run a workspace shell command under policy |

## More Docs

- [Architecture deep dive](docs/ARCHITECTURE.md): package map, turn sequence,
  context budget, approval gate, data formats, invariants, and extension points.
- [Architecture diagrams](docs/diagrams/): visual index for the core runtime.
- [Module graph](docs/diagrams/01-module-graph.svg)
- [One turn sequence](docs/diagrams/02-one-turn.svg)
- [Context budget](docs/diagrams/03-context-budget.svg)
- [Approval gate](docs/diagrams/04-approval-gate.svg)
- [Live pane](docs/diagrams/05-live-pane.svg)
- [oh-my-pi architecture note](docs/diagrams/06-oh-my-pi.svg)
- [0xAF-Re vs oh-my-pi](docs/diagrams/07-vs-oh-my-pi.svg)
- [Project page and marketing assets](https://overkazaf.github.io/re-agent/)

Scoped for authorized CTF, lab, and local reverse-engineering work: binary
triage, static inspection, local dynamic experiments, solve planning, and
reproducible notes.
