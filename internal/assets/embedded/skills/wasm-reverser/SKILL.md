---
name: wasm-reverser
description: Reverse engineer WebAssembly (WASM) modules. Analyze binary structure, extract functions, decompile to readable code, and understand WASM-JS interactions. Use for web security research and algorithm extraction.
---

# WebAssembly Reverse Engineering

A skill for analyzing and reverse engineering WebAssembly modules in web applications.

## Workflow Overview

### Step 1: Locate WASM Modules

**Detection Methods:**

```javascript
// Method 1: Network tab filter
// DevTools > Network > Filter: wasm

// Method 2: Search for instantiation
// Search source for: WebAssembly.instantiate, WebAssembly.compile

// Method 3: Hook WebAssembly API
(function interceptWasm() {
    const originalInstantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = async function(bufferSource, importObject) {
        console.group('WASM Instantiation Intercepted');
        console.log('Buffer size:', bufferSource.byteLength || bufferSource.length);
        console.log('Imports:', importObject);

        const result = await originalInstantiate.call(this, bufferSource, importObject);

        console.log('Exports:', Object.keys(result.instance.exports));
        console.groupEnd();

        // Save for analysis
        window.__wasmModule = result;
        return result;
    };
})();
```

### Step 2: Extract WASM Binary

```javascript
// Method 1: Intercept and download
(function downloadWasm() {
    const originalFetch = window.fetch;
    window.fetch = async function(url, options) {
        const response = await originalFetch.apply(this, arguments);

        if (url.toString().includes('.wasm')) {
            const clone = response.clone();
            const buffer = await clone.arrayBuffer();

            // Download as file
            const blob = new Blob([buffer], { type: 'application/wasm' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = url.toString().split('/').pop();
            a.click();

            console.log('WASM downloaded:', url);
        }

        return response;
    };
})();

// Method 2: Extract from memory
(function extractFromMemory() {
    // If already loaded, get from module
    if (window.__wasmModule) {
        const memory = window.__wasmModule.instance.exports.memory;
        console.log('Memory size:', memory.buffer.byteLength);
    }
})();
```

### Step 3: Analyze WASM Structure

#### 3.1 WASM Binary Format

```
WASM Magic Number: 00 61 73 6D (0asm)
Version: 01 00 00 00 (v1)

Section IDs:
0  - Custom section (name, debug info)
1  - Type section (function signatures)
2  - Import section (imported functions)
3  - Function section (function declarations)
4  - Table section (indirect call tables)
5  - Memory section (linear memory)
6  - Global section (global variables)
7  - Export section (exported items)
8  - Start section (entry point)
9  - Element section (table initialization)
10 - Code section (function bodies)
11 - Data section (memory initialization)
```

#### 3.2 Using wasm2wat (Text Format)

```bash
# Convert binary to text format
wasm2wat module.wasm -o module.wat

# Example WAT output:
(module
  (type (;0;) (func (param i32 i32) (result i32)))
  (func (;0;) (type 0) (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add)
  (export "add" (func 0)))
```

#### 3.3 Using wasm-decompile (Pseudo-code)

```bash
# Decompile to more readable format
wasm-decompile module.wasm -o module.dcmp

# Example output:
function add(a:int, b:int):int {
  return a + b
}
```

### Step 4: Analyze Exports and Imports

```javascript
// Analyze WASM instance in browser
(function analyzeWasm(instance) {
    const exports = instance.exports;
    const analysis = {
        functions: [],
        memory: null,
        tables: [],
        globals: []
    };

    Object.entries(exports).forEach(([name, value]) => {
        if (typeof value === 'function') {
            analysis.functions.push({
                name: name,
                length: value.length,  // Parameter count
                toString: value.toString()
            });
        } else if (value instanceof WebAssembly.Memory) {
            analysis.memory = {
                name: name,
                initial: value.buffer.byteLength,
                type: 'Memory'
            };
        } else if (value instanceof WebAssembly.Table) {
            analysis.tables.push({
                name: name,
                length: value.length,
                type: 'Table'
            });
        } else if (value instanceof WebAssembly.Global) {
            analysis.globals.push({
                name: name,
                value: value.value,
                type: 'Global'
            });
        }
    });

    console.log('WASM Analysis:', analysis);
    return analysis;
})(window.__wasmModule?.instance);
```

### Step 5: Hook WASM Functions

```javascript
// Hook exported WASM functions for analysis
(function hookWasmExports(instance) {
    const exports = instance.exports;
    const hooked = {};

    Object.entries(exports).forEach(([name, func]) => {
        if (typeof func === 'function') {
            hooked[name] = function(...args) {
                console.log(`[WASM] ${name} called with:`, args);
                const result = func.apply(this, args);
                console.log(`[WASM] ${name} returned:`, result);
                return result;
            };

            // Preserve original for direct access
            hooked[name].__original = func;
        } else {
            hooked[name] = func;
        }
    });

    return hooked;
})(window.__wasmModule?.instance);
```

### Step 6: Memory Analysis

```javascript
// Analyze WASM memory
(function analyzeMemory(instance) {
    const memory = instance.exports.memory;
    if (!memory) {
        console.log('No memory export found');
        return;
    }

    const buffer = new Uint8Array(memory.buffer);

    // Find strings in memory
    function findStrings(minLength = 4) {
        const strings = [];
        let current = '';
        let start = 0;

        for (let i = 0; i < buffer.length; i++) {
            const char = buffer[i];
            if (char >= 32 && char < 127) {
                if (current.length === 0) start = i;
                current += String.fromCharCode(char);
            } else {
                if (current.length >= minLength) {
                    strings.push({ offset: start, value: current });
                }
                current = '';
            }
        }

        return strings;
    }

    // Dump memory region
    function hexdump(offset, length) {
        const slice = buffer.slice(offset, offset + length);
        let output = '';

        for (let i = 0; i < slice.length; i += 16) {
            const hex = Array.from(slice.slice(i, i + 16))
                .map(b => b.toString(16).padStart(2, '0'))
                .join(' ');
            const ascii = Array.from(slice.slice(i, i + 16))
                .map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.')
                .join('');
            output += `${(offset + i).toString(16).padStart(8, '0')}  ${hex.padEnd(48)}  ${ascii}\n`;
        }

        return output;
    }

    console.log('Memory size:', buffer.length);
    console.log('Strings found:', findStrings());
    console.log('First 256 bytes:', hexdump(0, 256));

    return { findStrings, hexdump, buffer };
})(window.__wasmModule?.instance);
```

## Output Format

```markdown
## WebAssembly Analysis Report

### Module Overview
- **File Size**: {{SIZE}} bytes
- **WASM Version**: {{VERSION}}
- **Exported Functions**: {{COUNT}}
- **Imported Functions**: {{COUNT}}
- **Memory**: {{PAGES}} pages ({{BYTES}} bytes)
- **Source Language**: {{RUST/C/C++/GO/UNKNOWN}}

### Exports

| Name | Type | Parameters | Return |
|------|------|------------|--------|
| {{NAME}} | function | {{PARAMS}} | {{RET}} |
| memory | Memory | {{INITIAL}} pages | - |

### Imports

| Module | Name | Type | Signature |
|--------|------|------|-----------|
| {{MOD}} | {{NAME}} | {{TYPE}} | {{SIG}} |

### Decompiled Functions

#### Function: {{NAME}}
```wat
{{WAT_CODE}}
```

Pseudo-code:
```
{{PSEUDO_CODE}}
```

Analysis:
- Purpose: {{DESCRIPTION}}
- Algorithm: {{ALGORITHM}}
- Security notes: {{NOTES}}

### Memory Layout

| Section | Offset | Size | Content |
|---------|--------|------|---------|
| Data | 0x{{OFF}} | {{SIZE}} | {{DESC}} |

### Strings Found
| Offset | Value |
|--------|-------|
| 0x{{OFF}} | {{STRING}} |

### Security Observations
- {{OBSERVATION_1}}
- {{OBSERVATION_2}}

### JS-WASM Interface
```javascript
// How JavaScript interacts with this WASM
{{INTERFACE_CODE}}
```
```

## Tools Reference

| Tool | Purpose | Installation |
|------|---------|--------------|
| **WABT** | Binary toolkit (wasm2wat, wat2wasm) | `brew install wabt` |
| **wasm-decompile** | Pseudo-code decompilation | Part of WABT |
| **Ghidra + WASM plugin** | Full decompilation | Ghidra + extension |
| **IDA Pro + wasm loader** | Disassembly | IDA Pro plugin |
| **Wasmer** | WASM runtime | `curl https://get.wasmer.io -sSfL \| sh` |
| **wasm-objdump** | Section analysis | Part of WABT |
| **Binaryen** | WASM optimization toolkit | `npm install -g binaryen` |

## Command Line Analysis

```bash
# List sections
wasm-objdump -h module.wasm

# Show disassembly
wasm-objdump -d module.wasm

# Show all details
wasm-objdump -x module.wasm

# Convert to text
wasm2wat module.wasm -o module.wat

# Decompile to pseudo-code
wasm-decompile module.wasm -o module.dcmp

# Validate module
wasm-validate module.wasm

# Optimize (for readability)
wasm-opt module.wasm -O0 -o module_readable.wasm
```

## Common WASM Patterns

### Emscripten-compiled Code

```javascript
// Typical Emscripten setup
var Module = {
    onRuntimeInitialized: function() {
        // WASM ready
    },
    ccall: function(name, returnType, argTypes, args) {
        // Call C function
    },
    cwrap: function(name, returnType, argTypes) {
        // Wrap C function
    }
};

// Emscripten exports pattern
Module._malloc(size);
Module._free(ptr);
Module.HEAP8, Module.HEAP16, Module.HEAP32;
Module.HEAPU8, Module.HEAPU16, Module.HEAPU32;
Module.HEAPF32, Module.HEAPF64;
```

### Rust-compiled Code (wasm-bindgen)

```javascript
// wasm-bindgen pattern
import init, { greet } from './pkg/module.js';

async function run() {
    await init();
    greet("World");
}

// Internal structure
__wbindgen_*  // wasm-bindgen internals
__wbg_*       // JavaScript glue functions
```

## Usage

```
/wasm-reverser

[Provide WASM URL or paste base64-encoded WASM binary]
```

This will:
1. Download and analyze WASM binary
2. Extract function signatures
3. Decompile to readable code
4. Analyze memory layout
5. Identify cryptographic or security-relevant operations
6. Document JS-WASM interface
