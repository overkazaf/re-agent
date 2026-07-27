---
name: native-pwn-re
description: Native ELF/Mach-O/PE reverse and pwn workflow: mitigations, symbols, imports, strings, xrefs, offsets, and exploitability hypotheses.
tags: elf macho pe pwn native binary radare2 ghidra
---

# Native Pwn / Reverse

Use this for ELF/Mach-O/PE binaries, crackmes, native `.so` libraries, and pwn-style CTF challenges.

## Workflow

1. Run `ctf_triage` and `binary_mitigations`.
2. Use `extract_symbols` to collect imports, exports, and function names.
3. Search suspicious strings: password, flag, key, usage, `/bin/sh`, format strings, and error messages.
4. Use `find_bytes` for known constants or decoded strings to locate offsets.
5. If external tools are available, prefer cached radare2/Ghidra workflows for deeper xrefs and decompilation.
6. Keep experiments reproducible and annotate addresses, offsets, architecture, endianness, and mitigations.

## Radare2 Fast Path

```bash
r2 -A ./chall
afl
izz
axt @ str.password
pdf @ main
```

For large binaries, cache analysis under `~/.cache/r2_analysis/<sha256-prefix>` before repeating expensive `aaa` analysis.

## Handoff Rules

- Need deeper radare2 commands, xrefs, debugging, or patch bytes: read `radare2-reverse`.
- Need decompiler-style navigation and the tool is available: read `ghidra`.
- Need to emulate a small native routine or shellcode: read `unicorn-emulator`.
- Need Android JNI/SO execution with Java callbacks: read `unidbg`.

## Pwn Checklist

- RELRO, canary, NX, PIE, stripped.
- Inputs and length checks.
- Format string sinks: `printf(user)`, `fprintf`, `syslog`.
- Overflow sinks: `gets`, `strcpy`, `strcat`, `sprintf`, unchecked `read`.
- Command sinks: `system`, `popen`, `execve`.
- Useful strings and gadgets only after the primitive is understood.
