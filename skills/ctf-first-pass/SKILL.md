---
name: ctf-first-pass
description: Offline first-pass workflow for unknown CTF artifacts: classify, fingerprint, strings, entropy, carving, and next experiment selection.
tags: ctf triage reverse forensics pwn crypto
---

# CTF First Pass

Use this when the artifact type is unclear or the operator says "triage", "look at this challenge", "find the flag path", or "what kind of CTF is this".

## Workflow

1. Start with `ctf_triage` on the artifact or workspace directory.
2. If it is binary-like, run `binary_mitigations`, `extract_symbols`, `strings`, and `entropy_scan`.
3. If it is data-like, run `find_bytes` for flag markers and `carve_artifacts` for embedded files.
4. If it contains encoded strings, use `ctf_decode` on the best candidates before guessing algorithms.
5. End with a concise hypothesis: category, likely primitive, and the smallest next local experiment.

## Decision Hints

- High entropy plus low printable ratio: packed, compressed, encrypted, or embedded ciphertext.
- Dangerous imports or `/bin/sh`: pwn path, inspect mitigations and call sites.
- Base64/hex-looking strings near crypto words: decode first, then inspect keys/IV/mode.
- Multiple magic offsets: forensics/carving path.
- APK/DEX/SO indicators: switch to `android-apk-frida`.

## Handoff Rules

- ELF/Mach-O/PE, crackme, or exploitability path: read `native-pwn-re`.
- Android APK/Dex/SO: read `android-apk-frida`, then `jadx`, `radare2-reverse`, or `unidbg` as evidence narrows.
- JavaScript/WASM/browser crypto: read `web-wasm-crypto`.
- Obfuscated native algorithm that needs instruction-level execution: read `unicorn-emulator`.
- Finished analysis or flag path: read `re-writeup` for the report structure.

## Useful Direct Commands

```text
/scan ./artifact
/entropy ./artifact
/carve ./artifact
/findbytes ./artifact flag{
/decode auto <candidate>
```
