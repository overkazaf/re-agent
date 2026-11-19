---
name: android-apk-frida
description: Android APK/SO reverse workflow with JADX, packer/framework checks, anti-debug/root/frida detection, and Frida hook planning.
tags: android apk dex frida hook jni
---

# Android APK + Frida

Use this for APK, DEX, Android native `.so`, Java method hooks, JNI tracing, or app crypto/signature analysis.

## Workflow

1. Run `apk_inspect` (`/apk`) on the APK to identify package/application class (from binary `AndroidManifest.xml`), DEX count, native `.so` ABIs, packers, and frameworks.
2. Run `binary_inspect` (`/inspect`) and `anti_analysis` (`/anti`) on extracted native `.so` libraries to map `.init_array` constructors, `JNI_OnLoad`, `Java_*` exports, and anti-Frida/anti-debug checks.
3. Decompile with `/retool jadx summary app.apk` (or `jadx -d jadx_out app.apk`) and search sources for crypto, token, sign, encrypt, decrypt, login, root, emulator, debug, and frida.
4. Use `frida_hook_template` (`/hook`) to generate a hook scaffold only after class/method/module targets are known.
5. Verify recovered algorithms with `verify_artifact` or offline emulation (`unidbg` / `unicorn-emulator`).

## Handoff Rules

- Mostly Java/Dex or manifest/resource analysis: read `jadx`.
- Native `.so` static analysis, `.init_array`, or JNI registration: read `analyze-so`, `radare2-reverse`, or `native-pwn-re`.
- JNI signature or app signing function emulation: read `unidbg`.
- Small isolated native function emulation: read `unicorn-emulator`.
- Browser/API signature logic found in WebView assets: read `web-crypto-analyzer` or `wasm-reverser`.

## JADX Fast Path

```bash
jadx -d jadx_out app.apk
rg -n "Cipher|MessageDigest|sign|token|encrypt|decrypt" jadx_out/sources
rg -n "Debug.isDebuggerConnected|TracerPid|ptrace|frida|xposed|substrate" jadx_out/sources -i
```

## Frida Hook Targets

- Java: `com.example.Crypto.sign(java.lang.String, byte[])`
- Native export: `libfoo.so!Java_com_example_Crypto_sign`
- Native address: `libfoo.so+0x1234`

Prefer observation hooks first: log args, returns, stack trace, and byte arrays. Patch return values only when the hypothesis is already tested.
