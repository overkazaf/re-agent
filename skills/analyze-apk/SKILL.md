---
name: analyze-apk
description: Perform initial APK analysis using standardized scripts. Checks for packers/protectors, identifies frameworks, lists key classes, and generates analysis reports. Use for Android app security assessment and reverse engineering preparation.
---

# APK Analyzer Skill

A comprehensive skill for performing initial analysis of Android APK files, identifying protection mechanisms, frameworks, and key components.

## Prerequisites

```bash
# Required tools
# - apktool: APK decompilation
# - jadx: DEX to Java decompilation
# - aapt2: Android Asset Packaging Tool
# - dex2jar: DEX to JAR conversion
# - file: File type detection

# Install on macOS
brew install apktool jadx apktool

# Or download manually from:
# - apktool: https://ibotpeaches.github.io/Apktool/
# - jadx: https://github.com/skylot/jadx
```

## Workflow Overview

### Step 1: Check Packer/Protector

Identify if the APK is protected by common packers:

```bash
# Extract and check for packer signatures
unzip -q {{APK_FILE}} -d {{OUTPUT_DIR}}/extracted

# Check for common packer signatures
```

**Common Packers to Detect:**

| Packer | Signature Files/Patterns |
|--------|-------------------------|
| **360加固** | `libjiagu.so`, `libjiagu_x86.so`, `libjiagu_a64.so` |
| **腾讯乐固** | `libshell*.so`, `libtup.so`, `libexec.so`, `libexecmain.so` |
| **梆梆加固** | `libsecexe.so`, `libsecmain.so`, `libDexHelper.so` |
| **爱加密** | `libexec.so`, `libexecmain.so`, `ijiami` in assets |
| **娜迦加固** | `libedog.so`, `libfdog.so` |
| **通付盾** | `libegis.so` |
| **网易易盾** | `libnesec.so` |
| **顶象** | `libx3g.so` |
| **数字联盟** | `libdl-common.so` |

**Detection Script:**

```bash
# Check native libraries
find {{OUTPUT_DIR}}/extracted/lib -name "*.so" 2>/dev/null | while read so; do
    basename "$so"
done

# Check assets folder
ls -la {{OUTPUT_DIR}}/extracted/assets/ 2>/dev/null

# Check for encrypted DEX
file {{OUTPUT_DIR}}/extracted/classes*.dex
```

### Step 2: Identify Framework

Detect the development framework used:

**Framework Signatures:**

| Framework | Detection Method |
|-----------|-----------------|
| **React Native** | `assets/index.android.bundle`, `libreactnativejni.so` |
| **Flutter** | `libflutter.so`, `libapp.so` |
| **Cordova/PhoneGap** | `assets/www/`, `cordova.js` |
| **Xamarin** | `assemblies/`, `libmonodroid.so`, `libmonosgen-2.0.so` |
| **Unity** | `libunity.so`, `assets/bin/Data/` |
| **Cocos2d** | `libcocos2d*.so` |
| **WeChat Mini Program** | `wxapkg` files in assets |
| **UniApp** | `assets/apps/`, `__UNI__` prefix |
| **Native Java/Kotlin** | Standard DEX without above signatures |

**Detection Commands:**

```bash
# Check for React Native
[ -f "{{OUTPUT_DIR}}/extracted/assets/index.android.bundle" ] && echo "React Native detected"

# Check for Flutter
find {{OUTPUT_DIR}}/extracted -name "libflutter.so" 2>/dev/null

# Check for Unity
find {{OUTPUT_DIR}}/extracted -name "libunity.so" 2>/dev/null

# Check manifest for framework hints
aapt2 dump badging {{APK_FILE}} | grep -E "native-code|uses-library"
```

### Step 3: List Key Classes

Extract and categorize important classes:

```bash
# Decompile with jadx
jadx -d {{OUTPUT_DIR}}/jadx {{APK_FILE}}

# Or use apktool for smali
apktool d {{APK_FILE}} -o {{OUTPUT_DIR}}/apktool -f
```

**Key Classes to Identify:**

1. **Application Class**
   ```bash
   grep -r "extends Application" {{OUTPUT_DIR}}/jadx/sources/
   ```

2. **Main Activities**
   ```bash
   aapt2 dump badging {{APK_FILE}} | grep "launchable-activity"
   ```

3. **Network/API Classes**
   ```bash
   grep -rE "Retrofit|OkHttp|Volley|HttpClient" {{OUTPUT_DIR}}/jadx/sources/
   ```

4. **Encryption Classes**
   ```bash
   grep -rE "Cipher|SecretKey|AES|RSA|MD5|SHA" {{OUTPUT_DIR}}/jadx/sources/
   ```

5. **Authentication Classes**
   ```bash
   grep -rE "login|auth|token|session|password" {{OUTPUT_DIR}}/jadx/sources/ -i
   ```

6. **Storage Classes**
   ```bash
   grep -rE "SharedPreferences|SQLite|ContentProvider" {{OUTPUT_DIR}}/jadx/sources/
   ```

7. **Root/Emulator Detection**
   ```bash
   grep -rE "isRooted|Superuser|/system/app/Superuser|isEmulator|Build.FINGERPRINT" {{OUTPUT_DIR}}/jadx/sources/
   ```

### Step 4: Generate Report

Create a comprehensive analysis report:

```markdown
# APK Analysis Report

## Basic Information
- **Package Name**: {{PACKAGE_NAME}}
- **Version**: {{VERSION_NAME}} ({{VERSION_CODE}})
- **Min SDK**: {{MIN_SDK}}
- **Target SDK**: {{TARGET_SDK}}
- **File Size**: {{FILE_SIZE}}
- **SHA256**: {{SHA256_HASH}}

## Protection Status
- **Packer Detected**: {{PACKER_NAME}} / None
- **Obfuscation Level**: High / Medium / Low / None

## Framework
- **Type**: {{FRAMEWORK_TYPE}}
- **Evidence**: {{FRAMEWORK_EVIDENCE}}

## Key Components
### Activities ({{ACTIVITY_COUNT}})
{{ACTIVITY_LIST}}

### Services ({{SERVICE_COUNT}})
{{SERVICE_LIST}}

### Receivers ({{RECEIVER_COUNT}})
{{RECEIVER_LIST}}

### Providers ({{PROVIDER_COUNT}})
{{PROVIDER_LIST}}

## Permissions
### Dangerous Permissions
{{DANGEROUS_PERMISSIONS}}

### Normal Permissions
{{NORMAL_PERMISSIONS}}

## Security Findings
- [ ] Debuggable: {{IS_DEBUGGABLE}}
- [ ] Allow Backup: {{ALLOW_BACKUP}}
- [ ] Network Security Config: {{HAS_NETWORK_CONFIG}}
- [ ] Root Detection: {{HAS_ROOT_DETECTION}}
- [ ] SSL Pinning: {{HAS_SSL_PINNING}}

## Key Classes Identified
### Network/API
{{NETWORK_CLASSES}}

### Encryption
{{CRYPTO_CLASSES}}

### Authentication
{{AUTH_CLASSES}}

## Recommendations
{{RECOMMENDATIONS}}
```

## Quick Commands

```bash
# One-liner basic info
aapt2 dump badging {{APK_FILE}}

# List all permissions
aapt2 dump permissions {{APK_FILE}}

# Extract certificate info
keytool -printcert -jarfile {{APK_FILE}}

# Check if debuggable
aapt2 dump xmltree {{APK_FILE}} AndroidManifest.xml | grep debuggable

# Calculate hash
shasum -a 256 {{APK_FILE}}
```

## Example Usage

```
/analyze-apk /path/to/app.apk
```

This will:
1. Extract the APK and check for packers
2. Identify the development framework
3. List key classes and components
4. Generate a comprehensive analysis report

## Output Structure

```
apk_analysis/
├── extracted/           # Raw APK contents
├── jadx/               # Decompiled Java sources
├── apktool/            # Smali and resources
├── report.md           # Analysis report
└── findings.json       # Structured findings
```

## Tips

1. For packed APKs, try runtime dumping with Frida
2. Check `strings` output for hardcoded secrets
3. Analyze network traffic with mitmproxy
4. Use `dexdump` for detailed DEX analysis
5. Compare with previous versions for diff analysis
