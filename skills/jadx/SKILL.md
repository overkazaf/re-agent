---
name: jadx
description: Use when analyzing APK files, decompiling Android apps, searching for classes/methods/strings in APK, or extracting resources. Triggers on keywords like APK, Android app analysis, decompile, dex.
---

# jadx - Android APK Decompiler CLI

## Overview

jadx decompiles Android APK/DEX files to Java source code. Use CLI for automated extraction and searching.

## Java Environment Setup

jadx requires Java 11+. If you encounter version errors, set JAVA_HOME:

```bash
# macOS - Use Java 17 (recommended)
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home

# Or find available Java versions
/usr/libexec/java_home -V

# Run jadx with specific Java version
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home jadx -d output/ app.apk
```

**IMPORTANT:** Always prefix jadx commands with `JAVA_HOME=...` when running from CLI to avoid version conflicts.

## Quick Reference

| Task | Command |
|------|---------|
| Full decompile | `jadx -d output/ app.apk` |
| Source only (no resources) | `jadx -d output/ -r app.apk` |
| Resources only (no source) | `jadx -d output/ -s app.apk` |
| Single class | `jadx --single-class com.example.ClassName -d output/ app.apk` |
| With deobfuscation | `jadx -d output/ --deobf app.apk` |
| Export as Gradle project | `jadx -e -d output/ app.apk` |
| JSON output (for parsing) | `jadx -d output/ --output-format json app.apk` |
| Quiet mode | `jadx -q -d output/ app.apk` |
| Multi-threaded | `jadx -j 16 -d output/ app.apk` |

## Search Workflows

jadx CLI doesn't have built-in search. Use this two-step workflow:

### 1. Decompile First
```bash
# Full decompile for comprehensive search
jadx -d /tmp/apk_output app.apk

# Or source-only for faster decompilation
jadx -d /tmp/apk_output -r app.apk
```

### 2. Search with grep/ripgrep

**Search for string literals:**
```bash
rg -n "api_key" /tmp/apk_output/sources/
rg -n "https://" /tmp/apk_output/sources/
```

**Search for class names:**
```bash
rg -n "class.*Crypto" /tmp/apk_output/sources/
rg -l "implements.*Serializable" /tmp/apk_output/sources/
```

**Search for method calls:**
```bash
rg -n "\.encrypt\(" /tmp/apk_output/sources/
rg -n "getSharedPreferences" /tmp/apk_output/sources/
```

**Search in resources:**
```bash
rg -n "password" /tmp/apk_output/resources/
rg "android:name" /tmp/apk_output/resources/AndroidManifest.xml
```

### 3. Extract Single Class (when you know the target)
```bash
# Faster than full decompile when you know the class
jadx --single-class com.example.crypto.AESUtil --single-class-output AESUtil.java app.apk
```

## Common Analysis Tasks

### Find Entry Points
```bash
# List activities, services, receivers from manifest
rg "android:name.*activity" /tmp/apk_output/resources/AndroidManifest.xml -i
rg "<activity|<service|<receiver|<provider" /tmp/apk_output/resources/AndroidManifest.xml
```

### Find Hardcoded Secrets
```bash
rg -n "api[_-]?key|secret|password|token" /tmp/apk_output/sources/ -i
rg -n "-----BEGIN" /tmp/apk_output/  # Certificates/keys
rg -n "eyJ" /tmp/apk_output/sources/  # JWT tokens (base64)
```

### Find Network Endpoints
```bash
rg -n "https?://[^\"\s]+" /tmp/apk_output/sources/ -o
rg -n "\.api\.|/api/" /tmp/apk_output/sources/
```

### Find Crypto Operations
```bash
rg -n "Cipher\.|MessageDigest\.|SecretKey" /tmp/apk_output/sources/
rg -n "AES|RSA|DES|MD5|SHA" /tmp/apk_output/sources/
```

### Find Native Libraries
```bash
# List loaded native libs
rg -n "System\.loadLibrary\|System\.load\(" /tmp/apk_output/sources/
# Check lib directory
ls /tmp/apk_output/resources/lib/
```

## Deobfuscation Options

```bash
# Basic deobfuscation (rename short names)
jadx -d output/ --deobf app.apk

# With ProGuard mapping file
jadx -d output/ --mappings-path mapping.txt app.apk

# Custom min/max name length thresholds
jadx -d output/ --deobf --deobf-min 2 --deobf-max 40 app.apk
```

## Output Modes

```bash
# Java source (default)
jadx -d output/ app.apk

# JSON format (machine-readable)
jadx -d output/ --output-format json app.apk

# Control flow graph (for analysis)
jadx -d output/ --cfg app.apk
```

## Handling Failures

```bash
# Show bad/incomplete decompilation
jadx -d output/ --show-bad-code app.apk

# Fallback mode for problematic code
jadx -d output/ -m fallback app.apk

# Simple mode (linearized, with gotos)
jadx -d output/ -m simple app.apk
```

## Supported Input Formats

- `.apk` - Android application
- `.dex` - Dalvik executable
- `.jar` - Java archive
- `.class` - Java class file
- `.aar` - Android archive
- `.aab` - Android App Bundle
- `.smali` - Smali assembly
- `.xapk`, `.apkm` - Split APK formats

## Tips

1. **Speed**: Use `-r` (no resources) for faster source-only decompilation
2. **Memory**: Use `-j N` to control thread count on memory-constrained systems
3. **Obfuscated apps**: Always try `--deobf` first for better readability
4. **Single class**: Use `--single-class` when you only need specific classes
5. **Quiet scripts**: Use `-q` for scripting to suppress progress output
