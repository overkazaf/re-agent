# Welcome Demo Workspace

This is a harmless local warm-up challenge for 0xAF-Re. It is designed to make
the first session concrete without requiring API credentials, network access,
or a real reverse-engineering target.

## Files

- `chall.js`: a toy token checker with a lightly encoded expected token.
- `artifacts/session.log`: sample runtime clues.
- `artifacts/operator-notes.txt`: noisy notes that include useful hints.

## Suggested First Prompts

From the project root:

```bash
bun src/cli.ts --workspace ./demos/welcome \
  -p "Triage this workspace. List files, identify the challenge, and propose a first solve plan." \
  --role planner
```

Then ask for a solve:

```bash
bun src/cli.ts --workspace ./demos/welcome \
  -p "Recover the expected token from chall.js, verify it with a local command, and explain the check."
```

In the REPL, try the direct tools:

```text
/tools
/read chall.js
/run "node chall.js test"
```

Writes are disabled by default. When you want the agent to create notes:

```bash
bun src/cli.ts --workspace ./demos/welcome --write \
  -p "Create notes/solve.md with the triage, verification command, and recovered token."
```
