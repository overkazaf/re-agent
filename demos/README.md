# 0xAF-Re Demos

This directory contains safe local workspaces for learning the CLI without
touching a real target or using network access.

## Welcome

`welcome/` is the first-run demo. It includes a tiny token checker plus a few
text artifacts so a new user can practice the normal 0xAF-Re loop:

1. list files,
2. inspect artifacts,
3. form a hypothesis,
4. run a local verification command,
5. optionally write a solve note with `--write`.

From the project root:

```bash
bun src/cli.ts --welcome
bun src/cli.ts --workspace ./demos/welcome
```
