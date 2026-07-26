---
name: vmp-restore
description: Restore and analyze Virtual Machine Protection (VMP) in native binaries. Handle VMProtect, Themida, Code Virtualizer. Extract VM handlers, trace bytecode, reconstruct original code. Use for malware analysis and software protection research.
---

# VMP (Virtual Machine Protection) Restoration

A skill for analyzing and restoring code protected by virtual machine-based protectors like VMProtect, Themida, and Code Virtualizer.

## Workflow Overview

### Step 1: Identify VMP Type

**Common VMP Protectors:**

| Protector | Signature | Characteristics |
|-----------|-----------|-----------------|
| **VMProtect** | `.vmp0`, `.vmp1` sections | Stack-based VM, complex handlers |
| **Themida/WinLicense** | `.themida` section | Register-based VM, anti-debug |
| **Code Virtualizer** | `.cv` section | Oreans family |
| **Enigma Protector** | `.enigma` section | Custom VM |
| **Safengine** | `.sedata` section | Chinese protector |
| **Custom** | Various | App-specific VMs |

**Detection Script (IDA):**

```python
# IDA Python - Detect VMP type
def detect_vmp():
    """Detect Virtual Machine Protection type"""

    vmp_signatures = {
        'vmprotect': {
            'sections': ['.vmp0', '.vmp1', '.vmp2'],
            'patterns': [
                b'\x68....\x68....\xE8',  # push push call (VM entry)
                b'\x9C\x60',               # pushfd pushad
            ]
        },
        'themida': {
            'sections': ['.themida', '.winlice'],
            'patterns': [
                b'\xEB.\xEB.',  # Anti-disasm jumps
            ]
        },
        'code_virtualizer': {
            'sections': ['.cv', '.oreans'],
            'patterns': []
        }
    }

    results = {
        'detected': None,
        'confidence': 0,
        'indicators': []
    }

    # Check sections
    for seg_ea in idautils.Segments():
        seg_name = idc.get_segm_name(seg_ea)
        for vmp_name, sigs in vmp_signatures.items():
            if seg_name in sigs['sections']:
                results['detected'] = vmp_name
                results['confidence'] += 50
                results['indicators'].append(f"Section: {seg_name}")

    # Check patterns
    for vmp_name, sigs in vmp_signatures.items():
        for pattern in sigs['patterns']:
            addr = ida_search.find_binary(0, idc.BADADDR, pattern, 16, idc.SEARCH_DOWN)
            if addr != idc.BADADDR:
                results['detected'] = vmp_name
                results['confidence'] += 30
                results['indicators'].append(f"Pattern at {hex(addr)}")

    return results
```

### Step 2: VMProtect Analysis

#### 2.1 VMProtect Architecture

```
VM Entry:
    push bytecode_addr
    push vm_context
    call vm_entry

VM Structure:
    ┌─────────────────┐
    │   VM Context    │ ← Virtual registers, flags
    ├─────────────────┤
    │   VM Stack      │ ← Operand stack
    ├─────────────────┤
    │   Bytecode      │ ← Encrypted VM instructions
    ├─────────────────┤
    │   Dispatcher    │ ← Fetch-decode-execute loop
    ├─────────────────┤
    │   Handlers      │ ← Opcode implementations
    └─────────────────┘
```

#### 2.2 VM Context Structure

```c
// Typical VMProtect context (x86)
struct VMContext {
    uint32_t vm_regs[16];      // Virtual registers
    uint32_t vm_flags;         // Virtual flags
    uint32_t vm_sp;            // VM stack pointer
    uint32_t vm_ip;            // VM instruction pointer
    uint8_t* bytecode;         // Pointer to bytecode
    uint32_t handler_table;    // Handler lookup table
    uint8_t key;               // Decryption key (rolling)
};

// x64 extended context
struct VMContext64 {
    uint64_t vm_regs[16];
    uint64_t vm_rflags;
    uint64_t vm_rsp;
    uint64_t vm_rip;
    // ... additional fields
};
```

#### 2.3 Handler Identification

```python
# IDA Python - Extract VMProtect handlers
class VMPHandlerExtractor:
    def __init__(self, vm_entry):
        self.vm_entry = vm_entry
        self.handlers = {}
        self.dispatcher = None
        self.handler_table = None

    def find_dispatcher(self):
        """Find the main dispatcher loop"""
        # Pattern: fetch opcode, lookup handler, call/jmp
        #
        # mov al, [esi]     ; Fetch opcode
        # inc esi           ; Advance IP
        # xor al, key       ; Decrypt
        # movzx eax, al
        # jmp [handler_table + eax*4]  ; Dispatch

        patterns = [
            # Direct table jump
            b'\xFF\x24\x85',  # jmp dword ptr [eax*4 + table]
            b'\xFF\x24\x8D',  # jmp dword ptr [ecx*4 + table]
            # Indirect
            b'\xFF\xE0',      # jmp eax
            b'\xFF\xE1',      # jmp ecx
        ]

        for pattern in patterns:
            addr = ida_search.find_binary(
                self.vm_entry,
                self.vm_entry + 0x10000,
                pattern,
                16,
                idc.SEARCH_DOWN
            )
            if addr != idc.BADADDR:
                self.dispatcher = addr
                return addr

        return None

    def extract_handler_table(self):
        """Extract handler addresses from table"""
        if not self.dispatcher:
            return []

        # Find table reference
        # Example: jmp [table + eax*4]
        # Extract table address

        handlers = []
        # Read handler table entries
        for i in range(256):  # Max 256 opcodes
            handler_addr = ida_bytes.get_dword(self.handler_table + i * 4)
            if handler_addr and ida_funcs.get_func(handler_addr):
                handlers.append({
                    'opcode': i,
                    'address': handler_addr,
                    'size': self.get_handler_size(handler_addr)
                })

        return handlers

    def analyze_handler(self, handler_addr):
        """Analyze single handler to determine operation"""
        semantics = {
            'type': 'unknown',
            'operation': None,
            'operands': []
        }

        # Analyze instruction pattern
        mnemonics = []
        ea = handler_addr
        for _ in range(30):  # Analyze first 30 instructions
            mnem = idc.print_insn_mnem(ea)
            if mnem:
                mnemonics.append(mnem)
            ea = idc.next_head(ea)

        # Pattern matching for common operations
        mnem_str = ' '.join(mnemonics)

        if 'add' in mnemonics and 'pop' in mnemonics[:5]:
            semantics['type'] = 'arithmetic'
            semantics['operation'] = 'ADD'
        elif 'sub' in mnemonics and 'pop' in mnemonics[:5]:
            semantics['type'] = 'arithmetic'
            semantics['operation'] = 'SUB'
        elif 'push' in mnemonics[:3] and mnemonics.count('push') > mnemonics.count('pop'):
            semantics['type'] = 'push'
        elif 'pop' in mnemonics[:3] and mnemonics.count('pop') > mnemonics.count('push'):
            semantics['type'] = 'pop'
        elif 'jmp' in mnemonics or 'call' in mnemonics:
            semantics['type'] = 'control_flow'

        return semantics

    def dump_handlers(self):
        """Dump all handlers with semantics"""
        for opcode, info in self.handlers.items():
            semantics = self.analyze_handler(info['address'])
            print(f"Opcode 0x{opcode:02X}: {semantics['type']}/{semantics['operation']} @ {hex(info['address'])}")
```

### Step 3: Bytecode Tracing

#### 3.1 Dynamic Tracing with Frida

```javascript
// Frida script for VMProtect bytecode tracing
const vmpTrace = {
    handlers: {},
    trace: [],
    vmContext: null,

    hookDispatcher(dispatcherAddr) {
        Interceptor.attach(ptr(dispatcherAddr), {
            onEnter: function(args) {
                // Read current opcode
                const opcode = this.context.eax & 0xFF;  // Adjust based on VM

                // Read VM context
                const ctx = {
                    opcode: opcode,
                    ip: this.context.esi.toInt32(),  // Adjust
                    sp: this.context.edi.toInt32(),  // Adjust
                    regs: []
                };

                vmpTrace.trace.push(ctx);

                if (vmpTrace.trace.length % 1000 === 0) {
                    console.log(`[VMP] Traced ${vmpTrace.trace.length} instructions`);
                }
            }
        });
    },

    hookHandler(opcode, handlerAddr) {
        Interceptor.attach(ptr(handlerAddr), {
            onEnter: function(args) {
                console.log(`[Handler 0x${opcode.toString(16)}] Enter`);

                // Dump stack
                const sp = this.context.edi;  // Adjust to VM stack register
                console.log(`  Stack[0]: ${sp.readU32()}`);
                console.log(`  Stack[1]: ${sp.add(4).readU32()}`);
            },
            onLeave: function(retval) {
                console.log(`[Handler 0x${opcode.toString(16)}] Leave`);
            }
        });
    },

    analyzePatterns() {
        // Find repeated patterns in trace
        const patterns = {};

        for (let i = 0; i < this.trace.length - 5; i++) {
            const pattern = this.trace.slice(i, i + 5)
                .map(t => t.opcode.toString(16))
                .join('-');

            patterns[pattern] = (patterns[pattern] || 0) + 1;
        }

        // Sort by frequency
        return Object.entries(patterns)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
    }
};

// Usage:
// vmpTrace.hookDispatcher(0x401000);
// vmpTrace.hookHandler(0x12, 0x402000);
```

#### 3.2 x64dbg Tracing Script

```javascript
// x64dbg script for VMP tracing
var vmDispatcher = 0x00401000;  // Set dispatcher address
var traceLog = [];

function traceVM() {
    // Set conditional breakpoint at dispatcher
    bp(vmDispatcher);

    // On breakpoint hit
    bpcnd(vmDispatcher, function() {
        var opcode = al;  // Or appropriate register
        var vmIP = esi;   // Or appropriate register

        traceLog.push({
            opcode: opcode,
            ip: vmIP,
            eax: eax,
            ebx: ebx,
            ecx: ecx,
            edx: edx
        });

        return true;  // Continue execution
    });
}

function dumpTrace() {
    for (var i = 0; i < traceLog.length; i++) {
        var entry = traceLog[i];
        log(sprintf("0x%02X @ 0x%08X | EAX=0x%08X",
            entry.opcode, entry.ip, entry.eax));
    }
}
```

### Step 4: Handler Semantics Recovery

```python
# Symbolic execution for handler analysis
import angr
import claripy

class VMPHandlerAnalyzer:
    def __init__(self, binary_path):
        self.proj = angr.Project(binary_path, auto_load_libs=False)

    def analyze_handler(self, handler_addr, vm_context_addr):
        """Symbolically execute handler to determine semantics"""

        # Create symbolic VM state
        state = self.proj.factory.blank_state(addr=handler_addr)

        # Make VM context symbolic
        vm_stack = claripy.BVS('vm_stack', 64 * 32)  # 32 stack slots
        vm_regs = [claripy.BVS(f'vm_r{i}', 32) for i in range(16)]

        # Set up memory
        state.memory.store(vm_context_addr, claripy.Concat(*vm_regs))

        # Execute handler
        simgr = self.proj.factory.simulation_manager(state)
        simgr.run(n=100)

        # Analyze output state
        for state in simgr.deadended:
            self.extract_semantics(state, vm_regs)

    def extract_semantics(self, final_state, original_regs):
        """Extract what the handler did"""

        operations = []

        # Check which registers changed
        for i, orig_reg in enumerate(original_regs):
            new_val = final_state.memory.load(vm_context_addr + i * 4, 4)

            if not new_val.structurally_match(orig_reg):
                # Register was modified
                operations.append({
                    'type': 'modify_reg',
                    'reg': i,
                    'expression': new_val
                })

        return operations
```

### Step 5: Code Reconstruction

#### 5.1 Bytecode to IR Conversion

```python
# Convert VM bytecode to intermediate representation
class VMPDecompiler:
    def __init__(self, handler_semantics):
        self.handlers = handler_semantics
        self.ir = []

    def decompile_trace(self, trace):
        """Convert execution trace to IR"""

        for entry in trace:
            opcode = entry['opcode']
            handler = self.handlers.get(opcode)

            if not handler:
                self.ir.append(IRUnknown(opcode))
                continue

            # Generate IR based on handler semantics
            if handler['type'] == 'push_const':
                value = entry.get('immediate', 0)
                self.ir.append(IRPush(IRConst(value)))

            elif handler['type'] == 'push_reg':
                reg_idx = entry.get('reg_index', 0)
                self.ir.append(IRPush(IRReg(reg_idx)))

            elif handler['type'] == 'add':
                self.ir.append(IRBinOp('add', IRStackPop(), IRStackPop()))

            elif handler['type'] == 'pop_reg':
                reg_idx = entry.get('reg_index', 0)
                self.ir.append(IRAssign(IRReg(reg_idx), IRStackPop()))

            elif handler['type'] == 'jmp':
                target = entry.get('target', 0)
                self.ir.append(IRJump(target))

            elif handler['type'] == 'call':
                target = entry.get('target', 0)
                self.ir.append(IRCall(target))

        return self.ir

    def optimize_ir(self):
        """Apply optimization passes"""
        # Constant folding
        # Dead code elimination
        # Expression simplification
        pass

    def to_c_code(self):
        """Generate C-like pseudocode from IR"""
        code_lines = []

        for ir_node in self.ir:
            code_lines.append(ir_node.to_c())

        return '\n'.join(code_lines)

# IR node classes
class IRNode:
    def to_c(self):
        raise NotImplementedError

class IRPush(IRNode):
    def __init__(self, value):
        self.value = value
    def to_c(self):
        return f"push({self.value.to_c()})"

class IRBinOp(IRNode):
    def __init__(self, op, left, right):
        self.op = op
        self.left = left
        self.right = right
    def to_c(self):
        ops = {'add': '+', 'sub': '-', 'mul': '*', 'div': '/'}
        return f"({self.left.to_c()} {ops.get(self.op, '?')} {self.right.to_c()})"
```

### Step 6: Automated VMP Tools

#### 6.1 VMProtect Devirtualization Tools

| Tool | Description | Link |
|------|-------------|------|
| **NoVmp** | VMProtect devirtualizer | GitHub |
| **VMPAttack** | VMP analysis framework | Research |
| **vtil** | Virtual instruction lifting | GitHub |
| **SATURN** | Semantic-based devirtualization | Academic |
| **VMHunt** | VMProtect handler identification | Research |

#### 6.2 Using NoVmp

```bash
# NoVmp usage
novmp.exe target.exe -o devirtualized.exe

# With options
novmp.exe target.exe \
    --analyze-handlers \
    --dump-bytecode \
    --generate-ir \
    -o output.exe
```

#### 6.3 VTIL Integration

```cpp
// VTIL-based VMP analysis
#include <vtil/vtil>

void analyze_vmp(const std::string& binary_path, uint64_t vm_entry) {
    // Lift VMP bytecode to VTIL IR
    vtil::routine* routine = vtil::lift_routine(binary_path, vm_entry);

    // Apply optimization passes
    vtil::optimizer::apply_all(routine);

    // Generate output
    vtil::debug::dump(routine);
}
```

## Output Format

```markdown
## VMP Restoration Report

### Overview
- **Protector**: {{VMP_TYPE}}
- **Version**: {{VERSION}}
- **Protected Functions**: {{COUNT}}
- **Handler Count**: {{COUNT}}

### VM Architecture

#### Context Structure
```c
struct VMContext {
    {{CONTEXT_FIELDS}}
};
```

#### Handler Table
| Opcode | Address | Type | Semantics |
|--------|---------|------|-----------|
| 0x{{OP}} | {{ADDR}} | {{TYPE}} | {{SEM}} |

### Bytecode Analysis

#### Trace Summary
- **Total Instructions**: {{N}}
- **Unique Opcodes**: {{N}}
- **Loops Detected**: {{N}}

#### Common Patterns
| Pattern | Frequency | Likely Operation |
|---------|-----------|------------------|
| {{PAT}} | {{N}} | {{OP}} |

### Restored Code

```c
// Function: {{NAME}}
{{DECOMPILED_CODE}}
```

### Anti-Analysis Techniques
- {{TECHNIQUE_1}}
- {{TECHNIQUE_2}}

### Recommendations
1. {{REC_1}}
2. {{REC_2}}
```

## Best Practices

1. **Start with static analysis** - Identify VM components before tracing
2. **Trace small inputs first** - Build handler understanding incrementally
3. **Look for patterns** - VMs use consistent handler structures
4. **Use multiple tools** - Combine static and dynamic analysis
5. **Document handlers** - Build reference as you reverse
6. **Check for mutations** - Handlers may have multiple implementations
7. **Watch for anti-debug** - VMs often include protection

## Usage

```
/vmp-restore

[Provide binary path and VM entry point address]
```

This will:
1. Identify VMP type and version
2. Extract handler table
3. Analyze handler semantics
4. Trace bytecode execution
5. Generate restored code
