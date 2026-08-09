# Architecture

0xAF-Re takes the useful architectural ideas from `oh-my-pi` and reduces them to a smaller reverse-engineering agent.

## Layers

1. **CLI / REPL**
   - `src/cli.ts`
   - `src/ui.ts`
   - Parses workspace, role, provider, and policy flags.
   - Supports role/provider switching with `/role`, `/agent`, `/planner`, and `/executor`.
   - Renders the terminal command deck, provider/tool tables, auth status, and prompt.

2. **Agent Loop**
   - `src/core/agent-loop.ts`
   - Keeps one normalized message history.
   - Calls the selected provider.
   - Executes tool calls.
   - Appends tool results and continues.

3. **Provider Adapters**
   - `src/providers/cli-tmux.ts` for local Codex CLI and Claude Code CLI launched through tmux.
   - `src/providers/openai-responses.ts` for direct Codex/OpenAI Responses API fallback.
   - `src/providers/openai-responses.ts` also backs xAI Grok through `https://api.x.ai/v1`.
   - `src/providers/anthropic.ts` for direct Claude API fallback.
   - `src/providers/openai-chat.ts` for DeepSeek/GLM/OpenAI-compatible gateways.
   - Each adapter translates the internal messages/tools to that provider's wire format.

4. **Auth Sources**
   - `src/auth.ts`
   - Loads process env, local `.env` files, and `~/.0xaf-re-agent/secrets.json`.
   - Provides `auth status`, `auth login <provider>`, and `auth logout <provider>`.

5. **Tool Registry**
   - `src/tools/reverse-tools.ts`
   - Reverse/CTF focused local tools.
   - Tools are data-in/data-out and receive a `ToolContext`.
   - Includes first-pass triage, decoding, entropy scanning, binary mitigation
     summaries, artifact carving, APK inspection, Frida hook templates, built-in
     skill access, and local knowledge search.

6. **Built-In Skills And Knowledge**
   - `skills/*/SKILL.md`
   - `src/skills.ts`
   - `src/knowledge.ts`
   - Skills are project-local workflows summarized into the system prompt and
     readable through `/skills`, `/skill`, `list_skills`, and `read_skill`.
   - Knowledge entries are imported with `scripts/import-knowledge.ts` into
     `knowledge/reverse-index.json` and retrieved through `/know`,
     `knowledge_search`, and `knowledge_read`.

7. **Policy**
   - `src/security/policy.ts`
   - Blocks common destructive commands, network tools by default, and sensitive paths by default.

8. **Session Persistence**
   - `src/core/session.ts`
   - Append-only JSONL for reproducibility.

## Routing Model

```text
role=planner  -> config.plannerProvider  -> codex by default
role=executor -> config.executorProvider -> claude by default
role=auto     -> prompt classifier       -> planner for analysis/planning, executor otherwise
```

By default `codex` and `claude` are local CLI/tmux providers, not HTTP API providers. Direct API modes are available as `codex-api` and `claude-api`.

An explicit `/agent <provider>` overrides role routing until `/agent auto`.
For example, `/agent grok` forces Grok as a cross-checking or alternate execution model without changing the default Codex/Claude route.

## Why This Shape

- Provider differences are isolated.
- Tool execution is normalized.
- Sessions are reproducible.
- Codex and Claude can be used as complementary agents instead of one monolithic model.
- Grok can be used as an extra reviewer or alternate model for solve-plan cross-checking.
- GLM/DeepSeek can be added as cheaper or local-compatible providers through the same chat adapter.
