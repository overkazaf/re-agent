---
name: unicorn-emulator
description: Generate Unicorn Engine scripts for CPU emulation, binary analysis, algorithm extraction, and reverse engineering. Supports ARM/ARM64/x86/x64 architectures. Use for SO function emulation, encryption algorithm recovery, and obfuscation analysis.
---

# Unicorn Emulator Skill

A skill for generating Unicorn Engine scripts to emulate CPU instructions and analyze binary code.

## Overview

Unicorn Engine is a lightweight multi-architecture CPU emulator framework based on QEMU. This skill helps generate Python scripts for:

- **Binary Analysis**: Emulate and trace code execution
- **Algorithm Extraction**: Recover encryption/decryption algorithms from native code
- **SO Function Emulation**: Execute Android/Linux shared library functions
- **Deobfuscation**: Analyze obfuscated code through emulation
- **CTF Challenges**: Solve reverse engineering challenges

## Supported Architectures

| Architecture | Unicorn Constant | Description |
|-------------|------------------|-------------|
| ARM | `UC_ARCH_ARM` | 32-bit ARM (Thumb supported) |
| ARM64 | `UC_ARCH_ARM64` | 64-bit ARM (AArch64) |
| x86 | `UC_ARCH_X86` + `UC_MODE_32` | 32-bit Intel/AMD |
| x86-64 | `UC_ARCH_X86` + `UC_MODE_64` | 64-bit Intel/AMD |
| MIPS | `UC_ARCH_MIPS` | MIPS32/MIPS64 |

## Workflow

### Step 1: Analyze Binary

Before emulation, gather information:
- Target architecture and endianness
- Function address and size
- Required memory regions
- Input parameters and calling convention

### Step 2: Setup Emulator

```python
from unicorn import *
from unicorn.arm_const import *  # or arm64_const, x86_const

# Initialize emulator
mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)  # Example: ARM Thumb mode

# Map memory regions
CODE_BASE = 0x10000
STACK_BASE = 0x80000
DATA_BASE = 0x100000

mu.mem_map(CODE_BASE, 0x10000)   # Code segment
mu.mem_map(STACK_BASE, 0x10000)  # Stack
mu.mem_map(DATA_BASE, 0x10000)   # Data/Heap
```

### Step 3: Load Code and Data

```python
# Load binary code
with open("target.so", "rb") as f:
    code = f.read()
mu.mem_write(CODE_BASE, code)

# Setup initial registers
mu.reg_write(UC_ARM_REG_SP, STACK_BASE + 0x8000)  # Stack pointer
mu.reg_write(UC_ARM_REG_R0, param1)  # First parameter
mu.reg_write(UC_ARM_REG_R1, param2)  # Second parameter
mu.reg_write(UC_ARM_REG_LR, 0)       # Return address (stop condition)
```

### Step 4: Add Hooks (Optional)

```python
# Instruction trace hook
def hook_code(mu, address, size, user_data):
    print(f"Executing: 0x{address:x}, size={size}")

mu.hook_add(UC_HOOK_CODE, hook_code)

# Memory access hook
def hook_mem(mu, access, address, size, value, user_data):
    if access == UC_MEM_WRITE:
        print(f"Write: 0x{address:x} = 0x{value:x}")
    else:
        print(f"Read: 0x{address:x}")

mu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, hook_mem)
```

### Step 5: Execute

```python
try:
    # Start emulation
    mu.emu_start(START_ADDRESS, END_ADDRESS)

    # Read result
    result = mu.reg_read(UC_ARM_REG_R0)
    print(f"Result: 0x{result:x}")

except UcError as e:
    print(f"Emulation error: {e}")
```

## Common Patterns

### Pattern 1: ARM Function Emulation

```python
from unicorn import *
from unicorn.arm_const import *

def emulate_arm_function(code, func_offset, arg0, arg1):
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)

    # Memory layout
    CODE_BASE = 0x10000
    STACK_BASE = 0x80000

    mu.mem_map(CODE_BASE, 0x100000)
    mu.mem_map(STACK_BASE, 0x10000)

    # Load code
    mu.mem_write(CODE_BASE, code)

    # Setup registers (ARM calling convention)
    mu.reg_write(UC_ARM_REG_SP, STACK_BASE + 0x8000)
    mu.reg_write(UC_ARM_REG_R0, arg0)
    mu.reg_write(UC_ARM_REG_R1, arg1)
    mu.reg_write(UC_ARM_REG_LR, 0)  # Return to address 0

    # Execute
    start_addr = CODE_BASE + func_offset
    mu.emu_start(start_addr, 0, timeout=10000000)

    return mu.reg_read(UC_ARM_REG_R0)
```

### Pattern 2: ARM64 with Memory Hooks

```python
from unicorn import *
from unicorn.arm64_const import *

class ARM64Emulator:
    def __init__(self):
        self.mu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        self.setup_memory()
        self.setup_hooks()

    def setup_memory(self):
        self.mu.mem_map(0x0, 0x1000000)  # 16MB
        self.mu.reg_write(UC_ARM64_REG_SP, 0x800000)

    def setup_hooks(self):
        self.mu.hook_add(UC_HOOK_MEM_UNMAPPED, self.hook_unmapped)

    def hook_unmapped(self, mu, access, address, size, value, user_data):
        print(f"Unmapped memory access at 0x{address:x}")
        # Auto-map missing memory
        page_start = address & ~0xFFF
        mu.mem_map(page_start, 0x1000)
        return True  # Continue execution
```

### Pattern 3: x86/x64 Emulation

```python
from unicorn import *
from unicorn.x86_const import *

def emulate_x64(code, rdi, rsi, rdx):
    mu = Uc(UC_ARCH_X86, UC_MODE_64)

    BASE = 0x400000
    STACK = 0x7fff0000

    mu.mem_map(BASE, 0x100000)
    mu.mem_map(STACK - 0x10000, 0x20000)

    mu.mem_write(BASE, code)

    # x64 calling convention (System V AMD64 ABI)
    mu.reg_write(UC_X86_REG_RSP, STACK)
    mu.reg_write(UC_X86_REG_RDI, rdi)  # 1st arg
    mu.reg_write(UC_X86_REG_RSI, rsi)  # 2nd arg
    mu.reg_write(UC_X86_REG_RDX, rdx)  # 3rd arg

    # Push return address
    mu.mem_write(STACK, b'\x00' * 8)

    mu.emu_start(BASE, BASE + len(code))

    return mu.reg_read(UC_X86_REG_RAX)
```

### Pattern 4: Android JNI Function Emulation

```python
from unicorn import *
from unicorn.arm64_const import *
import lief

class AndroidEmulator:
    def __init__(self, so_path):
        self.mu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        self.so = lief.parse(so_path)
        self.base = 0x10000000
        self.load_so()

    def load_so(self):
        # Map SO file
        so_size = self.align(self.so.virtual_size)
        self.mu.mem_map(self.base, so_size)

        # Load segments
        for segment in self.so.segments:
            if segment.type == lief.ELF.SEGMENT_TYPES.LOAD:
                offset = segment.virtual_address
                self.mu.mem_write(self.base + offset, bytes(segment.content))

    def get_symbol_address(self, name):
        for sym in self.so.symbols:
            if sym.name == name:
                return self.base + sym.value
        return None

    def align(self, size, alignment=0x1000):
        return (size + alignment - 1) & ~(alignment - 1)
```

## Hook Types

| Hook Type | Description | Use Case |
|-----------|-------------|----------|
| `UC_HOOK_CODE` | Instruction execution | Tracing, debugging |
| `UC_HOOK_BLOCK` | Basic block execution | Performance tracing |
| `UC_HOOK_MEM_READ` | Memory read | Data flow analysis |
| `UC_HOOK_MEM_WRITE` | Memory write | Data flow analysis |
| `UC_HOOK_MEM_FETCH` | Instruction fetch | Code coverage |
| `UC_HOOK_MEM_UNMAPPED` | Unmapped memory access | Auto-mapping |
| `UC_HOOK_INTR` | Interrupts/syscalls | Syscall emulation |

## Register Constants

### ARM32
- `UC_ARM_REG_R0` - `UC_ARM_REG_R12`: General purpose
- `UC_ARM_REG_SP` (R13): Stack pointer
- `UC_ARM_REG_LR` (R14): Link register
- `UC_ARM_REG_PC` (R15): Program counter
- `UC_ARM_REG_CPSR`: Current program status

### ARM64
- `UC_ARM64_REG_X0` - `UC_ARM64_REG_X30`: General purpose
- `UC_ARM64_REG_SP`: Stack pointer
- `UC_ARM64_REG_PC`: Program counter
- `UC_ARM64_REG_LR` (X30): Link register

### x86-64
- `UC_X86_REG_RAX`, `RBX`, `RCX`, `RDX`: General purpose
- `UC_X86_REG_RSI`, `RDI`: Source/Destination index
- `UC_X86_REG_RSP`, `RBP`: Stack/Base pointer
- `UC_X86_REG_R8` - `UC_X86_REG_R15`: Extended registers
- `UC_X86_REG_RIP`: Instruction pointer

## Example Usage

```
/unicorn-emulator arm64 decrypt_func 0x1234 --args "0xdeadbeef,16"
```

This will generate a complete emulation script for the specified function.

## Tips

1. **Start Simple**: Begin with minimal memory mapping and add regions as needed
2. **Use Hooks**: Add instruction hooks for debugging complex code
3. **Handle Syscalls**: Implement syscall handlers for functions that call the OS
4. **Check Alignment**: Ensure memory addresses are properly aligned
5. **Timeout**: Always set a timeout to prevent infinite loops
6. **State Inspection**: Save/restore emulator state for iterative analysis

## Dependencies

```bash
pip install unicorn capstone keystone-engine lief
```

## Output

Generated scripts are saved to:
```
unicorn_scripts/{arch}_{function_name}.py
```
