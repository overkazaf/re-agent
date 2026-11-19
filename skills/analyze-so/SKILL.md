---
name: analyze-so
description: Analyze Android/Linux SO (shared library) and ELF binaries using 0xAF-Re native binary tools and radare2. Covers headers, sections, .init_array constructors, JNI registration, mitigations, anti-analysis checks, and targeted decompilation.
tags: elf so shared-library android linux jni init-array
---

# SO / ELF Shared Library Analysis

Use this workflow to triage and reverse Android native libraries (`.so`) and Linux shared objects cleanly without blind full-binary `aaa` loops.

## 0xAF-Re Native Fast Path

Start with 0xAF-Re's built-in pure-Go binary tools before shelling out:

1. **Structural triage (`binary_inspect` / `/inspect <lib.so>`)**:
   - Inspect architecture, endianness, SONAME, `DT_NEEDED` libraries, RPATH/RUNPATH, `.init_array` / `.ctors` constructors, section entropies, RWX segments, imported symbols, and exported `JNI_OnLoad` / `Java_*` symbols.
2. **Mitigations & anti-analysis (`binary_mitigations` + `anti_analysis` / `/anti <lib.so>`)**:
   - Check NX, stack canary, PIE/PIC, RELRO, fortify, stripped status, UPX/OLLVM/packer markers, `ptrace`/`TracerPid`/`frida-agent` checks, and direct ARM64 `svc #0` syscalls.
3. **Entropy & byte markers (`entropy_scan`, `find_bytes`)**:
   - Identify encrypted `.rodata`/custom sections or crypto S-boxes/constants.

## Targeted Radare2 / Ghidra Follow-Up

Once candidate addresses or symbols are identified, use `reverse_toolkit` (`/retool`) for bounded queries:

- `/retool radare2 info libexample.so` — binary metadata (`iI; ie; iS`)
- `/retool radare2 exports libexample.so` — exported functions (`iE`)
- `/retool radare2 imports libexample.so` — external calls (`ii`)
- `/retool radare2 relocs libexample.so` — GOT/PLT relocations (`ir`)
- `/retool radare2 functions libexample.so` — function table (`aa; afl`)
- `/retool radare2 disasm libexample.so symbol=JNI_OnLoad` — disassemble target symbol/address
- `/retool radare2 decompile libexample.so address=0x1234` — decompile a single function (`pdg`/`pdc`)
- `/retool radare2 xrefs libexample.so address=0x5678` — cross-references (`axt`)
- `/retool ghidra summary libexample.so` — headless Ghidra function & C decompilation export

## Android `.so` Checklist

1. **Pre-JNI constructors (`.init_array`)**:
   - Anti-Frida threads, string decryption, and self-integrity checks almost always run in `.init_array` before `JNI_OnLoad`. Inspect every pointer reported by `binary_inspect` under `Initializers`.
2. **JNI registration**:
   - Static binding exports `Java_<pkg>_<Class>_<method>`.
   - Obfuscated apps register methods dynamically inside `JNI_OnLoad` via ` (*env)->RegisterNatives(env, clazz, methods, count)` (`JNINativeMethod` triples: `{name, signature, fnPtr}`).
3. **Direct syscalls**:
   - When `anti_analysis` reports inline `svc #0` instructions in `.text`, libc hooks (`openat`, `read`, `ptrace`) will be bypassed; trace with Stalker, seccomp/ptrace, or emulate offline via `unidbg` / `unicorn-emulator`.

## Usage

```text
/inspect libnative-lib.so
/anti libnative-lib.so
/skill analyze-so Analyze JNI_OnLoad and RegisterNatives table in libnative-lib.so
```
