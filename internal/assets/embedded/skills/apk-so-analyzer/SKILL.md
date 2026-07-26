---
name: apk-so-analyzer
description: Use when extracting and analyzing SO files from APK. Extracts specified SO from APK, analyzes exports/imports using radare2, shows cross-references. Supports keyword filtering for targeted analysis. Triggers on APK SO analysis, native library extraction, export function analysis.
---

# APK SO Analyzer

Extract specified SO files from APK and analyze them with radare2, focusing on exports and cross-references. Supports **keyword filtering** for targeted analysis of specific functions.

## Prerequisites

- **unzip**: APK extraction
- **radare2**: SO analysis
  ```bash
  # macOS
  brew install radare2

  # Linux
  sudo apt install radare2
  ```

## Usage Syntax

```
/apk-so-analyzer <apk_path> <so_name1> [so_name2...] [--filter <keyword>] [--filter-type <type>]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<apk_path>` | Yes | Path to APK file |
| `<so_name>` | Yes | One or more SO file names to analyze |
| `--filter <keyword>` | No | Filter functions by keyword (case-insensitive) |
| `--filter-type <type>` | No | Filter type: `jni`, `class`, `method`, `all` (default: all) |

### Filter Types

| Type | Description | Example Match |
|------|-------------|---------------|
| `jni` | JNI functions only | `Java_com_*`, `JNI_OnLoad` |
| `class` | Match class/namespace names | `QbshAudFprinter::*` |
| `method` | Match method names | `*::process(*)` |
| `all` | Match anywhere in function name | Any containing keyword |

## Examples

```bash
# Basic analysis - all exports
/apk-so-analyzer ./app.apk libnative.so

# Multiple SO files
/apk-so-analyzer ./app.apk libfp.so libfph.so

# Filter by keyword - only functions containing "encrypt"
/apk-so-analyzer ./app.apk libnative.so --filter encrypt

# Filter JNI functions only
/apk-so-analyzer ./app.apk libnative.so --filter-type jni

# Filter specific class methods
/apk-so-analyzer ./app.apk libfph.so --filter QbshAudFprinter --filter-type class

# Filter by method name pattern
/apk-so-analyzer ./app.apk libfph.so --filter process --filter-type method

# Combine filters
/apk-so-analyzer ./app.apk libfph.so --filter Fingerprint --filter-type jni
```

## Workflow

```
APK + SO Names + [Filter]
         │
         ▼
┌────────────────────┐
│ 1. Extract APK     │
│    (unzip)         │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ 2. Find SO Files   │
│    (lib/*/*.so)    │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ 3. R2 Analysis     │
│  - Exports (iE)    │
│  - Apply Filter    │
│  - Xrefs (axt)     │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ 4. Generate Report │
│  (Filtered View)   │
└────────────────────┘
```

## Quick Commands

### Step 1: Extract APK and Find SO

```bash
# Create temp directory
WORK_DIR=$(mktemp -d)
APK_FILE="/path/to/app.apk"
SO_NAME="libnative.so"

# Extract APK
unzip -q "$APK_FILE" -d "$WORK_DIR"

# Find specified SO file (all architectures)
find "$WORK_DIR/lib" -name "$SO_NAME" 2>/dev/null
```

### Step 2: Analyze with Radare2 (with filtering)

**List all exports:**
```bash
r2 -q -c "iE" "$SO_PATH"
```

**Filter exports by keyword:**
```bash
# Case-insensitive filter
r2 -q -c "iE" "$SO_PATH" | grep -i "keyword"
```

**Filter JNI functions only:**
```bash
r2 -q -c "iE" "$SO_PATH" | grep -E "Java_|JNI_OnLoad|JNI_OnUnload"
```

**Filter by class name (demangled):**
```bash
r2 -q -c "iE" "$SO_PATH" | grep -i "ClassName::"
```

**Analyze and list functions (filtered):**
```bash
r2 -q -c "aaa; afl" "$SO_PATH" | grep -i "keyword"
```

**Get cross-references for filtered exports:**
```bash
KEYWORD="encrypt"
r2 -q -c "iE" "$SO_PATH" | grep -i "$KEYWORD" | while read line; do
  addr=$(echo "$line" | awk '{print $2}')
  name=$(echo "$line" | awk '{print $NF}')
  if [ -n "$addr" ] && [[ "$addr" =~ ^0x ]]; then
    echo "=== $name ($addr) ==="
    r2 -q -c "aaa; axt @ $addr" "$SO_PATH" 2>/dev/null
  fi
done
```

**Decompile filtered functions:**
```bash
KEYWORD="fingerprint"
r2 -q -c "iE" "$SO_PATH" | grep -i "$KEYWORD" | while read line; do
  addr=$(echo "$line" | awk '{print $2}')
  name=$(echo "$line" | awk '{print $NF}')
  if [ -n "$addr" ] && [[ "$addr" =~ ^0x ]]; then
    echo "=== Decompiling: $name ($addr) ==="
    r2 -q -c "aaa; pdc @ $addr" "$SO_PATH" 2>/dev/null
  fi
done
```

## Radare2 Command Reference

| Command | Description |
|---------|-------------|
| `iE` | List exports |
| `iEq` | List export addresses only |
| `ii` | List imports |
| `is` | List symbols |
| `iz` | List strings in data section |
| `izz` | List all strings |
| `aaa` | Auto-analyze all |
| `afl` | List all functions |
| `axt @addr` | Xrefs TO address (who calls this) |
| `axf @addr` | Xrefs FROM address (what this calls) |
| `pdf @addr` | Disassemble function |
| `pdc @addr` | Decompile function (pseudo-C) |
| `agc @addr` | Call graph for function |

## Output Report Format

### Full Analysis (no filter)
```markdown
# SO Analysis Report: libnative.so

## Basic Info
- Architecture: ARM64
- File Size: 1.2 MB
- SHA256: abc123...

## Exports (286 functions)
[Full list...]
```

### Filtered Analysis
```markdown
# SO Analysis Report: libnative.so
## Filter: "encrypt" (type: all)

## Matching Exports (5 functions)
| Address    | Name                              | Type     |
|------------|-----------------------------------|----------|
| 0x00001234 | Java_com_example_Native_encrypt   | FUNC     |
| 0x00001500 | encryptData                       | FUNC     |
| 0x00001800 | AES_encrypt_block                 | FUNC     |
| ...        | ...                               | ...      |

## Cross References (filtered functions only)
[Only xrefs for matching functions...]

## Decompiled Code (filtered functions)
[Pseudo-C for matching functions...]
```

## Common Filter Patterns

### Security/Crypto Analysis
```bash
/apk-so-analyzer app.apk libcrypto.so --filter encrypt
/apk-so-analyzer app.apk libsecure.so --filter "aes\|des\|rsa\|sign\|verify"
```

### JNI Interface Discovery
```bash
/apk-so-analyzer app.apk libnative.so --filter-type jni
/apk-so-analyzer app.apk libnative.so --filter Java_com_example
```

### Audio/Media Processing
```bash
/apk-so-analyzer app.apk libaudio.so --filter "fft\|filter\|process"
/apk-so-analyzer app.apk libfph.so --filter pitch
```

### Network/API Functions
```bash
/apk-so-analyzer app.apk libnet.so --filter "http\|socket\|connect"
/apk-so-analyzer app.apk libapi.so --filter request
```

## Analysis Script

Use the provided `analyze_apk_so.sh` script:

```bash
# Basic usage
./analyze_apk_so.sh /path/to/app.apk libnative.so

# With output directory
./analyze_apk_so.sh /path/to/app.apk libnative.so ./output
```

**Script location:** `~/.claude/skills/apk-so-analyzer/analyze_apk_so.sh`

## Manual Deep Analysis

After initial report, dive deeper:

```bash
# Decompile specific function
r2 -q -c "aaa; pdc @ sym.Java_com_example_Native_encrypt" "$SO_PATH"

# Search for strings in function
r2 -q -c "aaa; pdf @ sym.target_func" "$SO_PATH" | grep -E "str\.|0x"

# Find function call graph
r2 -q -c "aaa; agc @ sym.target_func" "$SO_PATH"

# Search strings by pattern
r2 -q -c "izz~password\|secret\|key" "$SO_PATH"
```

## Tips

1. **Multi-arch**: Check lib/arm64-v8a/, lib/armeabi-v7a/, lib/x86/ for different builds
2. **JNI naming**: Functions starting with `Java_` are JNI native methods
3. **Symbol stripping**: If stripped, focus on exports and imports
4. **Large SO**: Use `-A` instead of `aaa` for faster (lighter) analysis
5. **Combine with Frida**: Use analysis results to create targeted hooks
6. **Use filters**: For large SO files, use `--filter` to focus on relevant functions
7. **Class analysis**: Use `--filter-type class` to find all methods of a C++ class
8. **Regex support**: Use `grep -E` patterns like `"aes\|des\|encrypt"` for multiple keywords
