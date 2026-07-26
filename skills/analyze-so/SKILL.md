---
name: analyze-so
description: Analyze Android/Linux SO (shared library) files using radare2. Generates comprehensive reports including file info, imports/exports, symbols, strings, security features, and JNI functions. Use for reverse engineering, malware analysis, or security assessment.
---

# Radare2 SO/ELF Analysis Skill

A skill for analyzing Android native libraries (.so) and Linux shared objects using radare2, generating comprehensive analysis reports.

## Prerequisites

- **radare2** must be installed:
  ```bash
  # macOS
  brew install radare2

  # Linux (Debian/Ubuntu)
  sudo apt install radare2

  # From source
  git clone https://github.com/radareorg/radare2
  cd radare2 && sys/install.sh
  ```

## Quick Start

Run the analysis script on a target SO file:

```bash
# Basic usage
./analyze_so.sh /path/to/libexample.so

# With custom output directory
./analyze_so.sh /path/to/libexample.so ./output
```

## Analysis Script Location

```
.claude/skills/analyze-so/analyze_so.sh
```

## Generated Output

The script generates two output files:

1. **`<filename>_analysis.txt`** - Human-readable comprehensive report
2. **`<filename>_analysis.json`** - JSON data for programmatic processing

## Report Sections

### Section 1: File Information
- Binary architecture (ARM, ARM64, x86, etc.)
- Endianness
- File type (DYN for shared library)
- Compiler info
- Entry points

### Section 2: Sections & Segments
- `.text` - Executable code
- `.data` - Initialized data
- `.bss` - Uninitialized data
- `.rodata` - Read-only data
- `.plt/.got` - Dynamic linking
- Entropy analysis (detect packing)

### Section 3: Imports
Lists all external functions the library depends on:
- libc functions (malloc, free, memcpy, etc.)
- System calls
- External library dependencies

### Section 4: Exports
Lists all functions exposed by the library:
- Public API functions
- JNI native methods (for Android)

### Section 5: Symbols
Complete symbol table including:
- Function symbols
- Object symbols
- Global/local symbols

### Section 6: Relocations
Dynamic relocation entries for:
- PLT entries
- GOT entries
- Data relocations

### Section 7: Libraries & Dependencies
Linked shared libraries:
- libc.so
- libm.so
- liblog.so (Android)
- Custom libraries

### Section 8: Strings Analysis
- Total string count
- Sample strings
- **Interesting strings detection:**
  - URLs (http, https, ftp)
  - File paths (/data/, /system/)
  - Sensitive keywords (password, secret, key, token, api)
  - Library references (.so, .dex, .apk)

### Section 9: Function Analysis
- Automatic function detection (aaa)
- Function list with addresses
- Function count

### Section 10: Cross References
- References to main functions
- Call graph information

### Section 11: Security Features
| Feature | Description |
|---------|-------------|
| **NX (No-Execute)** | Stack/heap non-executable |
| **Canary** | Stack canary protection |
| **PIC/PIE** | Position-independent code |
| **RELRO** | Relocation read-only (partial/full) |
| **Stripped** | Debug symbols removed |

### Section 12: JNI Functions (Android)
Detects Android native methods:
- `Java_*` prefixed functions
- `JNI_OnLoad` / `JNI_OnUnload`
- Native method registration patterns

### Section 13: Analysis Summary
Quick overview with key metrics:
- Import/Export/Symbol/String/Function counts
- Security feature summary
- JNI detection result

## Radare2 Command Reference

| Command | Description |
|---------|-------------|
| `iI` | Binary info |
| `ih` | File header |
| `ie` | Entry points |
| `iS` | Sections |
| `iSS` | Segments |
| `ii` | Imports |
| `iE` | Exports |
| `is` | Symbols |
| `ir` | Relocations |
| `il` | Libraries |
| `izz` | All strings |
| `aaa` | Auto-analyze |
| `afl` | List functions |
| `axt @addr` | Xrefs to address |
| `pdf @func` | Disassemble function |
| `pdc @func` | Decompile function |

## Manual Analysis Examples

After running the script, you may want to perform deeper analysis:

### Disassemble a specific function
```bash
r2 -q -c "aaa; pdf @ sym.target_function" libexample.so
```

### Decompile a function (requires r2ghidra)
```bash
r2 -q -c "aaa; pdg @ sym.target_function" libexample.so
```

### Find cross-references to a function
```bash
r2 -q -c "aaa; axt @ sym.target_function" libexample.so
```

### Search for specific strings
```bash
r2 -q -c "/ password" libexample.so
```

### Analyze JNI function
```bash
r2 -q -c "aaa; pdf @ sym.Java_com_example_MainActivity_nativeMethod" libexample.so
```

### Export function list as JSON
```bash
r2 -q -c "aaa; aflj" libexample.so > functions.json
```

## Workflow

```
┌─────────────────────────────────────────────────┐
│                 User Input                       │
│           /analyze-so libexample.so             │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│           Run analyze_so.sh Script              │
│                                                  │
│  1. Validate file exists                        │
│  2. Check radare2 installation                  │
│  3. Calculate file hashes                       │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│           Radare2 Analysis                       │
│                                                  │
│  • Binary info (iI)                             │
│  • Sections (iS)                                │
│  • Imports (ii)                                 │
│  • Exports (iE)                                 │
│  • Symbols (is)                                 │
│  • Strings (izz)                                │
│  • Functions (aaa + afl)                        │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│           Generate Reports                       │
│                                                  │
│  • libexample.so_analysis.txt (human-readable)  │
│  • libexample.so_analysis.json (machine)        │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│           AI Summary & Analysis                  │
│                                                  │
│  • Identify library purpose                     │
│  • Highlight security concerns                  │
│  • Note suspicious patterns                     │
│  • Recommend further analysis                   │
└─────────────────────────────────────────────────┘
```

## Example Usage

```
/analyze-so /path/to/libnative-lib.so
```

The assistant will:

1. **Run the analysis script** to generate the report
2. **Read and parse the report**
3. **Provide a summary** including:
   - Library purpose/functionality
   - Key imports (what system functions it uses)
   - Key exports (what APIs it exposes)
   - Security posture (NX, canary, RELRO, etc.)
   - Interesting strings (URLs, paths, credentials)
   - JNI functions (for Android libraries)
   - Potential security concerns
   - Recommendations for deeper analysis

## Interpreting Results

### Security Feature Analysis

| Status | Meaning | Risk |
|--------|---------|------|
| NX enabled | Stack not executable | Good |
| NX disabled | Stack executable | High risk (ROP not needed) |
| Canary found | Stack overflow protection | Good |
| No canary | No stack protection | Medium risk |
| Full RELRO | GOT read-only | Good |
| Partial RELRO | Some GOT protection | Medium |
| No RELRO | GOT writable | High risk |
| PIC/PIE | ASLR compatible | Good |
| Not stripped | Debug symbols present | Info leak |

### Suspicious Indicators

Watch for these patterns:
- **Anti-debugging**: ptrace, /proc/self/status reads
- **Root detection**: su, /system/app/Superuser
- **Packing**: High entropy sections, UPX signatures
- **Crypto**: AES, RSA, base64 functions
- **Network**: socket, connect, SSL functions
- **File access**: open, read, write to sensitive paths
- **Dynamic loading**: dlopen, dlsym

## Tips

1. **Large libraries**: Analysis may take time; use `-A` instead of `aaa` for lighter analysis
2. **Stripped binaries**: Focus on imports/exports when symbols are removed
3. **Packed libraries**: Check section entropy; high entropy suggests packing
4. **Android**: Look for `JNI_OnLoad` which often contains initialization logic
5. **Follow-up**: Use IDA Pro or Ghidra for detailed reverse engineering
