---
name: android-apk-frida
description: Android APK/SO reverse workflow with JADX, packer/framework checks, anti-debug/root/frida detection, and Frida hook planning.
tags: android apk dex jadx frida hook native so unidbg
---

# Android APK + Frida

Use this for APK, DEX, Android native `.so`, Java method hooks, JNI tracing, or app crypto/signature analysis.

## Workflow

1. Run `apk_inspect` on the APK to identify DEX files, native libs, packers, and frameworks.
2. Use `ctf_triage` on interesting `.dex`, `.so`, assets, or extracted blobs.
3. Search decompiled sources for crypto, token, sign, encrypt, decrypt, login, root, emulator, debug, and frida.
4. Use `frida_hook_template` to generate a hook scaffold only after class/method/module targets are known.
5. If native code is involved, combine `extract_symbols`, `binary_mitigations`, and JNI name search.

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
