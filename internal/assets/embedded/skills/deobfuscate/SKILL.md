---
name: deobfuscate
description: Deobfuscate and explain obfuscated code for analysis and understanding. Identifies obfuscation types, restores variable names, and explains core logic. Use for code analysis, security research, and reverse engineering assistance.
---

# Code Deobfuscation Skill

A skill for analyzing and deobfuscating code to understand its true functionality, restoring readable variable names and explaining the core logic.

## Workflow Overview

### Step 1: Identify Obfuscation Type

**Common Obfuscation Techniques:**

| Technique | Indicators | Language |
|-----------|------------|----------|
| **Name Mangling** | `a`, `b`, `_0x1234`, `Il1` | All |
| **String Encoding** | Base64, hex, char codes | All |
| **Control Flow** | Switch statements, goto jumps | All |
| **Dead Code** | Unreachable branches | All |
| **Opaque Predicates** | Always true/false conditions | All |
| **Array Mapping** | `arr[0]` for function calls | JavaScript |
| **Eval/Exec** | Dynamic code execution | JS/Python |
| **Packing** | Compressed/encrypted code | JS |
| **ProGuard** | `a.b.c.d()` short names | Java/Android |
| **PyArmor** | `__pyarmor__` markers | Python |

**Detection Patterns:**

```javascript
// JavaScript Obfuscation Indicators
var _0x1234 = ['string1', 'string2'];  // Array-based string hiding
eval(atob('base64string'));             // Base64 + eval
(function(_0x1234, _0x5678) {...})();   // IIFE with mangled params
String.fromCharCode(72,101,108,108,111); // Char code strings
```

```python
# Python Obfuscation Indicators
exec(__import__('base64').b64decode('...'))  # Base64 exec
eval(compile('...', '<string>', 'exec'))     # Dynamic compilation
__import__('zlib').decompress(...)           # Compressed code
```

```java
// Java/Android Obfuscation Indicators
class a { void b(String c) {...} }  // ProGuard naming
String a = new String(new byte[]{...});  // Byte array strings
Class.forName("...").getMethod("...").invoke(...)  // Reflection
```

### Step 2: Restore Variable Names

**Naming Strategy Based on Context:**

| Context | Original | Suggested Name |
|---------|----------|----------------|
| Loop counter | `a`, `_0x1` | `i`, `index`, `count` |
| Array | `b`, `_0x2` | `items`, `list`, `data` |
| Function param | `c`, `_0x3` | Based on usage |
| HTTP response | `d` | `response`, `result` |
| User input | `e` | `input`, `userInput` |
| Encrypted data | `f` | `encrypted`, `cipher` |
| Key | `g` | `key`, `secretKey` |
| URL | `h` | `url`, `endpoint` |
| Callback | `i` | `callback`, `handler` |
| Config | `j` | `config`, `options` |

**Analysis Techniques:**

1. **Track Data Flow**
   - Follow where variables are assigned
   - See how they're used (math, string ops, API calls)

2. **Identify API Calls**
   ```javascript
   // Before
   _0x1234['fetch'](_0x5678)

   // After analyzing _0x1234 = window
   window.fetch(url)
   ```

3. **Decode String Tables**
   ```javascript
   // Before
   var _0xabc = ['aGVsbG8=', 'd29ybGQ='];
   console.log(atob(_0xabc[0]));  // 'hello'

   // After
   console.log('hello');
   ```

4. **Simplify Expressions**
   ```javascript
   // Before
   var a = !![]; // true
   var b = ![];  // false
   var c = +[];  // 0
   var d = +!![]; // 1

   // After
   var a = true;
   var b = false;
   var c = 0;
   var d = 1;
   ```

### Step 3: Explain Core Logic

**Documentation Template:**

```markdown
## Deobfuscated Code Analysis

### Original Purpose
{{DESCRIPTION_OF_WHAT_CODE_DOES}}

### Key Functions

#### Function: {{ORIGINAL_NAME}} → {{NEW_NAME}}
- **Purpose**: {{PURPOSE}}
- **Parameters**:
  - `{{PARAM_1}}` ({{TYPE}}): {{DESCRIPTION}}
- **Returns**: {{RETURN_TYPE}} - {{RETURN_DESCRIPTION}}
- **Side Effects**: {{SIDE_EFFECTS}}

### Data Flow
1. {{STEP_1}}
2. {{STEP_2}}
3. {{STEP_3}}

### Security Concerns
- {{CONCERN_1}}
- {{CONCERN_2}}

### Deobfuscated Code
```{{LANGUAGE}}
{{CLEAN_CODE}}
```
```

**Example Deobfuscation:**

**Before (Obfuscated):**
```javascript
var _0x1234=['log','Hello'];(function(_0x5678,_0x9abc){var _0xdef0=function(_0x1111){while(--_0x1111){_0x5678['push'](_0x5678['shift']());}};_0xdef0(++_0x9abc);}(_0x1234,0x64));var _0x2222=function(_0x3333,_0x4444){_0x3333=_0x3333-0x0;var _0x5555=_0x1234[_0x3333];return _0x5555;};console[_0x2222('0x0')](_0x2222('0x1'));
```

**After (Deobfuscated):**
```javascript
// String table after rotation: ['Hello', 'log']
// _0x2222(0) = 'Hello', _0x2222(1) = 'log'

console.log('Hello');
```

**Analysis:**
- Uses array-based string hiding
- Rotates array by 100 positions (0x64)
- Custom accessor function `_0x2222` retrieves strings by index
- Core functionality: Simply prints "Hello" to console

## Common Deobfuscation Patterns

### JavaScript eval/Function Unpacking

```javascript
// Before
eval(function(p,a,c,k,e,d){...}('packed_code'))

// Approach: Replace eval with console.log to see unpacked code
console.log(function(p,a,c,k,e,d){...}('packed_code'))
```

### Base64 Decoding

```javascript
// Before
eval(atob('Y29uc29sZS5sb2coJ0hlbGxvJyk='))

// Decode: console.log('Hello')
console.log('Hello')
```

### Hex String Decoding

```javascript
// Before
var s = "\x48\x65\x6c\x6c\x6f";

// After
var s = "Hello";
```

### Unicode Escape Decoding

```javascript
// Before
var s = "\u0048\u0065\u006c\u006c\u006f";

// After
var s = "Hello";
```

### JSFuck Style

```javascript
// Before
[][(![]+[])[+[]]+(![]+[])[!+[]+!+[]]...]

// These map to specific characters
// [] = array, ![] = false, +[] = 0, !![] = true
// Reconstructs strings character by character
```

## Tools Reference

| Tool | Language | Purpose |
|------|----------|---------|
| **de4js** | JavaScript | Online JS deobfuscator |
| **JStillery** | JavaScript | JS unpacker |
| **beautifier.io** | JS/CSS/HTML | Code formatting |
| **CFR/Procyon/JADX** | Java | Java decompilers |
| **uncompyle6** | Python | Bytecode decompiler |
| **dnSpy/ILSpy** | C#/.NET | .NET decompiler |
| **Ghidra/IDA** | Binary | Reverse engineering |
| **CyberChef** | Multiple | Encoding/decoding |

## Example Usage

```
/deobfuscate

// Paste obfuscated code here
var _0x1234=...
```

This will:
1. Identify the obfuscation technique used
2. Restore meaningful variable/function names
3. Explain what the code actually does
4. Provide clean, readable version

## Output Format

```markdown
## Obfuscation Analysis

**Type**: {{OBFUSCATION_TYPE}}
**Complexity**: {{LOW/MEDIUM/HIGH}}
**Language**: {{LANGUAGE}}

## Original Code
```{{LANG}}
{{ORIGINAL}}
```

## Deobfuscated Code
```{{LANG}}
{{DEOBFUSCATED}}
```

## Explanation
{{DETAILED_EXPLANATION}}

## Variable Mapping
| Original | Renamed | Purpose |
|----------|---------|---------|
| _0x1234 | strings | String lookup table |
| _0x5678 | decode | String decoder function |

## Security Notes
{{SECURITY_OBSERVATIONS}}
```

## Tips

1. Start by identifying the string hiding mechanism
2. Look for patterns in variable naming
3. Trace function calls to understand flow
4. Use browser dev tools for JS (set breakpoints)
5. Replace `eval` with `console.log` to see decoded output
6. Check for anti-debugging traps before running
7. Document assumptions made during analysis
