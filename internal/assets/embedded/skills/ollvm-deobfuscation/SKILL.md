---
name: ollvm-deobfuscation
description: Reverse engineer OLLVM (Obfuscator-LLVM) protected binaries. Handle control flow flattening, bogus control flow, instruction substitution, and string encryption. Use for Android SO analysis and native code reverse engineering.
---

# OLLVM Deobfuscation Techniques

A skill for analyzing and deobfuscating binaries protected with OLLVM (Obfuscator-LLVM) and similar LLVM-based obfuscators.

## Workflow Overview

### Step 1: Identify OLLVM Obfuscation

**OLLVM Obfuscation Types:**

| Type | Flag | Description | Difficulty |
|------|------|-------------|------------|
| **Control Flow Flattening (CFF)** | `-mllvm -fla` | Converts CFG to switch-dispatcher | High |
| **Bogus Control Flow (BCF)** | `-mllvm -bcf` | Adds fake conditional branches | Medium |
| **Instruction Substitution (SUB)** | `-mllvm -sub` | Replaces instructions with equivalents | Low |
| **String Encryption** | `-mllvm -sobf` | Encrypts string literals | Medium |
| **Split Basic Blocks** | `-mllvm -split` | Splits blocks into smaller pieces | Low |

**Detection in IDA/Ghidra:**

```python
# IDA Python - Detect CFF pattern
def detect_cff():
    """Detect Control Flow Flattening"""
    indicators = {
        'switch_dispatcher': False,
        'state_variable': False,
        'single_exit': False,
        'large_switch': False
    }

    for func_ea in Functions():
        func = ida_funcs.get_func(func_ea)
        if not func:
            continue

        # Check for large switch statements
        switch_info = ida_nalt.get_switch_info(func_ea)
        if switch_info and switch_info.ncases > 10:
            indicators['large_switch'] = True

        # Check for state variable pattern
        # mov reg, [state_var]
        # cmp reg, case_value
        # Pattern analysis...

    return indicators

# Detect BCF (Bogus Control Flow)
def detect_bcf():
    """Detect opaque predicates"""
    suspicious_conds = []

    for func_ea in Functions():
        for head in Heads(func_ea, ida_funcs.get_func(func_ea).end_ea):
            if idc.print_insn_mnem(head) in ['jz', 'jnz', 'je', 'jne']:
                # Check if condition is always true/false
                # x * (x + 1) % 2 == 0 (always true)
                # x^2 >= 0 (always true for real numbers)
                pass

    return suspicious_conds
```

### Step 2: Control Flow Flattening (CFF) Analysis

#### 2.1 CFF Structure

```
Original CFG:          Flattened CFG:
    Entry                  Entry
      |                      |
   [Block1]              [State=1]
      |                      |
   [Block2]  ------>    [Dispatcher]<----+
      |                   /  |  \         |
   [Block3]          [B1] [B2] [B3]       |
      |                 \   |   /         |
    Exit                 [Update]--------+
                            |
                          Exit
```

#### 2.2 CFF Recovery with IDA

```python
# IDA Python - CFF Deobfuscation
import idaapi
import ida_bytes
import ida_funcs
import idc

class CFFDeobfuscator:
    def __init__(self, func_ea):
        self.func_ea = func_ea
        self.func = ida_funcs.get_func(func_ea)
        self.state_var = None
        self.dispatcher = None
        self.blocks = {}
        self.transitions = []

    def find_dispatcher(self):
        """Find the main dispatcher (switch statement)"""
        for head in idautils.Heads(self.func.start_ea, self.func.end_ea):
            switch_info = ida_nalt.get_switch_info(head)
            if switch_info:
                self.dispatcher = head
                return True
        return False

    def find_state_variable(self):
        """Find the state variable used in dispatcher"""
        # Look for: mov reg, [var]; cmp reg, const pattern
        # before the switch jump
        if not self.dispatcher:
            return None

        # Analyze instructions before dispatcher
        ea = self.dispatcher
        for _ in range(20):  # Look back 20 instructions
            ea = idc.prev_head(ea)
            if ea == idc.BADADDR:
                break

            mnem = idc.print_insn_mnem(ea)
            if mnem == 'mov':
                op1 = idc.get_operand_type(ea, 1)
                if op1 == idc.o_mem:
                    self.state_var = idc.get_operand_value(ea, 1)
                    return self.state_var

        return None

    def extract_blocks(self):
        """Extract real blocks from flattened function"""
        switch_info = ida_nalt.get_switch_info(self.dispatcher)
        if not switch_info:
            return

        # Get all case targets
        for case_idx in range(switch_info.ncases):
            case_value = switch_info.lowcase + case_idx
            target = switch_info.jumps + (case_idx * switch_info.jmpsize)
            target_ea = ida_bytes.get_dword(target)

            self.blocks[case_value] = {
                'address': target_ea,
                'next_state': self.find_next_state(target_ea)
            }

    def find_next_state(self, block_ea):
        """Find what state this block transitions to"""
        if not self.state_var:
            return None

        # Look for: mov [state_var], new_value
        ea = block_ea
        end_ea = block_ea + 0x100  # Search within block

        while ea < end_ea:
            mnem = idc.print_insn_mnem(ea)
            if mnem == 'mov':
                op0_type = idc.get_operand_type(ea, 0)
                op0_val = idc.get_operand_value(ea, 0)

                if op0_type == idc.o_mem and op0_val == self.state_var:
                    op1_type = idc.get_operand_type(ea, 1)
                    if op1_type == idc.o_imm:
                        return idc.get_operand_value(ea, 1)

            ea = idc.next_head(ea)

        return None

    def build_cfg(self):
        """Reconstruct the original control flow graph"""
        cfg = {}

        for state, block in self.blocks.items():
            next_state = block['next_state']
            if next_state is not None:
                cfg[state] = next_state

        return cfg

    def deobfuscate(self):
        """Main deobfuscation routine"""
        print(f"[*] Analyzing function at {hex(self.func_ea)}")

        if not self.find_dispatcher():
            print("[-] Dispatcher not found")
            return False

        print(f"[+] Dispatcher at {hex(self.dispatcher)}")

        self.find_state_variable()
        if self.state_var:
            print(f"[+] State variable at {hex(self.state_var)}")

        self.extract_blocks()
        print(f"[+] Found {len(self.blocks)} blocks")

        cfg = self.build_cfg()
        print(f"[+] Reconstructed CFG: {cfg}")

        return True

# Usage in IDA:
# deob = CFFDeobfuscator(here())
# deob.deobfuscate()
```

#### 2.3 Symbolic Execution for CFF

```python
# Using angr for symbolic CFF recovery
import angr
import claripy

def recover_cff_with_angr(binary_path, func_addr):
    """Use symbolic execution to recover CFF"""

    proj = angr.Project(binary_path, auto_load_libs=False)

    # Create initial state at function entry
    state = proj.factory.blank_state(addr=func_addr)

    # Create simulation manager
    simgr = proj.factory.simulation_manager(state)

    # Track all reachable blocks
    reachable_blocks = set()
    transitions = []

    def track_blocks(state):
        reachable_blocks.add(state.addr)

    # Explore with block tracking
    simgr.explore(
        find=lambda s: False,  # Explore all paths
        avoid=[],
        step_func=track_blocks,
        n=1000  # Limit steps
    )

    return reachable_blocks, transitions
```

### Step 3: Bogus Control Flow (BCF) Removal

#### 3.1 Opaque Predicate Patterns

```python
# Common opaque predicates in OLLVM
opaque_predicates = {
    # x * (x + 1) % 2 == 0  (always true, product of consecutive integers)
    'consecutive_product': r'mul.*add.*and.*1.*cmp.*0',

    # x^2 >= 0 (always true)
    'square_nonneg': r'mul.*cmp.*0',

    # (x | 1) != 0 (always true)
    'or_one': r'or.*1.*cmp.*0',

    # 2 * x == x + x (always true)
    'double_add': r'shl.*1.*add.*cmp',
}

# IDA pattern matching for BCF
def find_opaque_predicates(func_ea):
    """Find and mark opaque predicates"""
    results = []

    func = ida_funcs.get_func(func_ea)

    for head in idautils.Heads(func.start_ea, func.end_ea):
        # Look for conditional jumps
        if idc.print_insn_mnem(head) not in ['jz', 'jnz', 'je', 'jne', 'jl', 'jg']:
            continue

        # Analyze the condition
        # Check previous instructions for opaque predicate patterns
        pattern = analyze_condition_pattern(head)

        if is_opaque(pattern):
            results.append({
                'address': head,
                'type': pattern['type'],
                'always': pattern['always_true']
            })

    return results

def patch_opaque_predicate(addr, always_true):
    """Patch opaque predicate to unconditional jump or NOP"""
    if always_true:
        # Change conditional to unconditional jump
        jmp_target = idc.get_operand_value(addr, 0)
        # Patch with JMP
    else:
        # NOP out the jump (fall through)
        ida_bytes.patch_bytes(addr, b'\x90' * idc.get_item_size(addr))
```

### Step 4: Instruction Substitution Recovery

```python
# Common OLLVM instruction substitutions
substitutions = {
    # a + b  =>  a - (-b)
    'add_to_sub': {
        'pattern': ['neg', 'sub'],
        'original': 'add'
    },

    # a - b  =>  a + (-b)
    'sub_to_add': {
        'pattern': ['neg', 'add'],
        'original': 'sub'
    },

    # a ^ b  =>  (a & ~b) | (~a & b)
    'xor_expanded': {
        'pattern': ['not', 'and', 'not', 'and', 'or'],
        'original': 'xor'
    },

    # a & b  =>  ~(~a | ~b)
    'and_demorgan': {
        'pattern': ['not', 'not', 'or', 'not'],
        'original': 'and'
    },

    # a | b  =>  ~(~a & ~b)
    'or_demorgan': {
        'pattern': ['not', 'not', 'and', 'not'],
        'original': 'or'
    }
}

def simplify_substitutions(func_ea):
    """Identify and simplify instruction substitutions"""
    simplified = []

    func = ida_funcs.get_func(func_ea)
    instructions = list(idautils.Heads(func.start_ea, func.end_ea))

    for i, ea in enumerate(instructions):
        for sub_name, sub_info in substitutions.items():
            pattern = sub_info['pattern']

            if i + len(pattern) > len(instructions):
                continue

            # Check if pattern matches
            matched = True
            for j, expected_mnem in enumerate(pattern):
                actual_mnem = idc.print_insn_mnem(instructions[i + j])
                if actual_mnem != expected_mnem:
                    matched = False
                    break

            if matched:
                simplified.append({
                    'start': ea,
                    'end': instructions[i + len(pattern) - 1],
                    'type': sub_name,
                    'original': sub_info['original']
                })

    return simplified
```

### Step 5: String Decryption

```python
# OLLVM string encryption recovery
def find_encrypted_strings(binary_path):
    """Find and decrypt OLLVM encrypted strings"""

    # Common patterns:
    # 1. XOR with key
    # 2. Custom encryption function called at init
    # 3. .init_array / .ctors execution

    encrypted_strings = []

    # Look for .init_array section
    # These often contain string decryption functions

    # Pattern: Function that writes to data section
    # mov byte ptr [addr], decoded_char

    return encrypted_strings

def decrypt_string_xor(encrypted, key):
    """Simple XOR decryption"""
    decrypted = bytearray()
    for i, b in enumerate(encrypted):
        decrypted.append(b ^ key[i % len(key)])
    return bytes(decrypted)

# Frida script for dynamic string decryption
frida_string_decrypt = """
// Hook string decryption function
Interceptor.attach(Module.findExportByName(null, "decrypt_string"), {
    onEnter: function(args) {
        this.encrypted = args[0];
        this.key = args[1];
    },
    onLeave: function(retval) {
        console.log("[String] Decrypted: " + Memory.readUtf8String(retval));
    }
});

// Alternative: Hook memcpy/strcpy after decryption
Interceptor.attach(Module.findExportByName(null, "memcpy"), {
    onEnter: function(args) {
        this.dest = args[0];
        this.size = args[2].toInt32();
    },
    onLeave: function(retval) {
        if (this.size > 4 && this.size < 256) {
            try {
                var str = Memory.readUtf8String(this.dest, this.size);
                if (str && /^[\\x20-\\x7e]+$/.test(str)) {
                    console.log("[memcpy] Potential string: " + str);
                }
            } catch(e) {}
        }
    }
});
"""
```

### Step 6: Automated Deobfuscation Tools

#### 6.1 D-810 (IDA Plugin)

```python
# D-810 configuration for OLLVM
d810_config = {
    'cff': {
        'enabled': True,
        'max_states': 100,
        'timeout': 30
    },
    'bcf': {
        'enabled': True,
        'pattern_matching': True
    },
    'sub': {
        'enabled': True,
        'peephole': True
    }
}

# Usage:
# 1. Install D-810 plugin
# 2. Edit > Plugins > D-810
# 3. Select target function
# 4. Choose deobfuscation passes
```

#### 6.2 OLLVM-Deobfuscator (Standalone)

```bash
# Using deflat.py for CFF
python3 deflat.py -f binary --addr 0x401000

# Using angr-based deobfuscator
python3 angr_deobf.py binary 0x401000 > deobfuscated.c
```

#### 6.3 Binary Ninja + OLLVM Deobfuscator

```python
# Binary Ninja script for OLLVM
from binaryninja import *

def deobfuscate_ollvm(bv, func):
    """Deobfuscate OLLVM-protected function"""

    # 1. Detect obfuscation type
    obf_type = detect_obfuscation(func)

    # 2. Apply appropriate deobfuscation
    if 'cff' in obf_type:
        recover_cff(bv, func)

    if 'bcf' in obf_type:
        remove_bcf(bv, func)

    if 'sub' in obf_type:
        simplify_sub(bv, func)

    # 3. Reanalyze function
    bv.update_analysis_and_wait()
```

## Output Format

```markdown
## OLLVM Deobfuscation Report

### Overview
- **Binary**: {{BINARY_NAME}}
- **Function**: {{FUNC_ADDR}}
- **Obfuscation Types**: CFF, BCF, SUB
- **Complexity**: {{LEVEL}}

### Obfuscation Analysis

#### Control Flow Flattening
- **Dispatcher**: {{ADDR}}
- **State Variable**: {{ADDR}}
- **Block Count**: {{N}}
- **Recovered Transitions**: {{N}}

#### Bogus Control Flow
- **Opaque Predicates Found**: {{N}}
- **Always True**: {{N}}
- **Always False**: {{N}}

#### Instruction Substitution
- **Substitutions Found**: {{N}}
- **Types**: ADD→SUB, XOR→AND/OR, etc.

### Recovered CFG

```
[Entry] → [Block1] → [Block2] → [Exit]
              ↓
          [Block3] → [Block4]
```

### Deobfuscated Pseudocode

```c
{{DECOMPILED_CODE}}
```

### Patches Applied
| Address | Original | Patched | Reason |
|---------|----------|---------|--------|
| {{ADDR}} | {{ORIG}} | {{NEW}} | {{REASON}} |

### Recommendations
1. {{REC_1}}
2. {{REC_2}}
```

## Tools Reference

| Tool | Purpose | Platform |
|------|---------|----------|
| **D-810** | IDA deobfuscator plugin | IDA Pro |
| **OLLVM-Deobfuscator** | Standalone tool | Python |
| **angr** | Symbolic execution | Python |
| **Triton** | Dynamic symbolic execution | Python |
| **Miasm** | Reverse engineering framework | Python |
| **Binary Ninja** | Alternative disassembler | GUI/API |
| **Ghidra** | Free disassembler | GUI/API |

## Usage

```
/ollvm-deobfuscation

[Provide binary path and function address]
```

This will:
1. Identify OLLVM obfuscation types
2. Analyze CFF structure
3. Detect and remove BCF
4. Simplify instruction substitutions
5. Generate deobfuscated output
