---
name: keystone-assembler
description: Use when assembling instructions to machine code, generating shellcode, patching binaries with new instructions, or building code injection payloads. Supports ARM/ARM64/x86/x64/MIPS/PPC/SPARC/SystemZ.
---

# Keystone Assembler Skill

A skill for using the Keystone assembler engine to convert assembly instructions into machine code bytes.

## Overview

Keystone is a lightweight multi-architecture assembler framework. It is the assembler counterpart to Capstone (disassembler) and pairs with Unicorn (emulator) for the complete reverse engineering triad.

- **Capstone**: Bytes -> Assembly (disassembler)
- **Keystone**: Assembly -> Bytes (assembler)
- **Unicorn**: Execute Bytes (emulator)

**GitHub:** https://github.com/keystone-engine/keystone

## Installation

```bash
pip install keystone-engine
```

## Quick Reference

| Architecture | Keystone Constant | Mode |
|--------------|-------------------|------|
| ARM32 | `KS_ARCH_ARM` | `KS_MODE_ARM` / `KS_MODE_THUMB` |
| ARM64 | `KS_ARCH_ARM64` | `KS_MODE_LITTLE_ENDIAN` |
| x86 | `KS_ARCH_X86` | `KS_MODE_32` |
| x86-64 | `KS_ARCH_X86` | `KS_MODE_64` |
| MIPS32 | `KS_ARCH_MIPS` | `KS_MODE_MIPS32` |
| MIPS64 | `KS_ARCH_MIPS` | `KS_MODE_MIPS64` |
| PPC32 | `KS_ARCH_PPC` | `KS_MODE_PPC32` |
| PPC64 | `KS_ARCH_PPC` | `KS_MODE_PPC64` |
| SPARC | `KS_ARCH_SPARC` | `KS_MODE_SPARC32` |
| SystemZ | `KS_ARCH_SYSTEMZ` | `KS_MODE_BIG_ENDIAN` |

## Basic Usage

```python
from keystone import *

# Initialize assembler (ARM64)
ks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)

# Assemble single instruction
encoding, count = ks.asm("mov x0, #0x41")
print(f"Bytes: {bytes(encoding).hex()}")
print(f"Instructions assembled: {count}")

# Assemble multiple instructions
code = """
    sub sp, sp, #0x40
    stp x29, x30, [sp, #0x30]
    add x29, sp, #0x30
    mov x0, #1
    ret
"""
encoding, count = ks.asm(code)
print(f"Shellcode ({len(encoding)} bytes): {bytes(encoding).hex()}")
```

## Common Patterns

### Pattern 1: Multi-Architecture Assembler

```python
from keystone import *

class Assembler:
    ARCH_MAP = {
        'arm': (KS_ARCH_ARM, KS_MODE_ARM),
        'thumb': (KS_ARCH_ARM, KS_MODE_THUMB),
        'arm64': (KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN),
        'x86': (KS_ARCH_X86, KS_MODE_32),
        'x64': (KS_ARCH_X86, KS_MODE_64),
        'mips32': (KS_ARCH_MIPS, KS_MODE_MIPS32 + KS_MODE_LITTLE_ENDIAN),
        'mips32be': (KS_ARCH_MIPS, KS_MODE_MIPS32 + KS_MODE_BIG_ENDIAN),
    }

    def __init__(self, arch='arm64'):
        arch_info = self.ARCH_MAP.get(arch)
        if not arch_info:
            raise ValueError(f"Unknown arch: {arch}")
        self.ks = Ks(*arch_info)
        self.arch = arch

    def assemble(self, code, addr=0):
        """Assemble instructions and return bytes"""
        try:
            encoding, count = self.ks.asm(code, addr)
            return bytes(encoding), count
        except KsError as e:
            print(f"Assembly error: {e}")
            return None, 0

    def assemble_hex(self, code, addr=0):
        """Assemble and return hex string"""
        result, count = self.assemble(code, addr)
        if result:
            return result.hex()
        return None

# Usage
asm = Assembler('arm64')
shellcode, count = asm.assemble("""
    mov x0, #0
    mov x8, #93
    svc #0
""")
print(f"Shellcode: {shellcode.hex()}")
```

### Pattern 2: Shellcode Generator

```python
from keystone import *

class ShellcodeGenerator:
    """Generate architecture-specific shellcode."""

    @staticmethod
    def arm64_execve_binsh():
        """ARM64 Linux execve("/bin/sh") shellcode"""
        ks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)
        code = """
            // execve("/bin/sh", NULL, NULL)
            mov x1, xzr          // argv = NULL
            mov x2, xzr          // envp = NULL
            // Load "/bin/sh" into x0
            adr x0, binsh
            mov x8, #221         // __NR_execve
            svc #0
        binsh:
            .ascii "/bin/sh"
        """
        encoding, _ = ks.asm(code)
        return bytes(encoding)

    @staticmethod
    def x64_execve_binsh():
        """x86-64 Linux execve("/bin/sh") shellcode"""
        ks = Ks(KS_ARCH_X86, KS_MODE_64)
        code = """
            xor rsi, rsi          ; argv = NULL
            xor rdx, rdx          ; envp = NULL
            push rsi              ; null terminator
            mov rdi, 0x68732f6e69622f  ; "/bin/sh"
            push rdi
            mov rdi, rsp          ; rdi = pointer to "/bin/sh"
            mov al, 59            ; __NR_execve
            syscall
        """
        encoding, _ = ks.asm(code)
        return bytes(encoding)

    @staticmethod
    def arm_thumb_nop_sled(count=16):
        """ARM Thumb NOP sled"""
        ks = Ks(KS_ARCH_ARM, KS_MODE_THUMB)
        nops = "; ".join(["nop"] * count)
        encoding, _ = ks.asm(nops)
        return bytes(encoding)
```

### Pattern 3: Binary Patching

```python
from keystone import *
import struct

class BinaryPatcher:
    """Patch binary files with assembled instructions."""

    def __init__(self, filepath, arch='arm64'):
        self.filepath = filepath
        arch_map = {
            'arm': (KS_ARCH_ARM, KS_MODE_ARM),
            'thumb': (KS_ARCH_ARM, KS_MODE_THUMB),
            'arm64': (KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN),
            'x86': (KS_ARCH_X86, KS_MODE_32),
            'x64': (KS_ARCH_X86, KS_MODE_64),
        }
        self.ks = Ks(*arch_map[arch])

        with open(filepath, 'rb') as f:
            self.data = bytearray(f.read())

    def patch_at(self, offset, asm_code, addr=0):
        """Patch binary at file offset with assembled code"""
        encoding, count = self.ks.asm(asm_code, addr)
        patch = bytes(encoding)
        self.data[offset:offset + len(patch)] = patch
        return len(patch)

    def nop_at(self, offset, count=1):
        """Write NOP instructions at offset"""
        nops = "; ".join(["nop"] * count)
        return self.patch_at(offset, nops)

    def patch_branch(self, offset, target_addr, addr=0):
        """Patch with unconditional branch to target"""
        asm = f"b #{target_addr}"
        return self.patch_at(offset, asm, addr)

    def patch_return(self, offset, return_value=0):
        """Patch function to immediately return a value"""
        asm = f"""
            mov x0, #{return_value}
            ret
        """
        return self.patch_at(offset, asm)

    def save(self, output_path=None):
        """Save patched binary"""
        path = output_path or self.filepath + ".patched"
        with open(path, 'wb') as f:
            f.write(self.data)
        return path

# Usage
patcher = BinaryPatcher("libnative.so", arch='arm64')

# NOP out anti-debug check
patcher.nop_at(0x1234, count=4)

# Make function always return 1
patcher.patch_return(0x5678, return_value=1)

# Save
patcher.save("libnative_patched.so")
```

### Pattern 4: Code Injection / Trampoline

```python
from keystone import *

def build_trampoline(hook_addr, original_func, hook_func, arch='arm64'):
    """Build a trampoline for inline hooking"""
    ks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)

    # Trampoline: save regs, call hook, restore regs, jump to original
    trampoline = f"""
        // Save registers
        stp x29, x30, [sp, #-0x10]!
        stp x0, x1, [sp, #-0x10]!
        stp x2, x3, [sp, #-0x10]!

        // Call hook function
        ldr x16, ={hook_func:#x}
        blr x16

        // Restore registers
        ldp x2, x3, [sp], #0x10
        ldp x0, x1, [sp], #0x10
        ldp x29, x30, [sp], #0x10

        // Jump to original function
        ldr x16, ={original_func:#x}
        br x16
    """

    encoding, count = ks.asm(trampoline, hook_addr)
    return bytes(encoding)
```

### Pattern 5: Instruction Encoding Lookup

```python
from keystone import *
from capstone import *

def encode_decode(asm_str, arch='arm64'):
    """Assemble then disassemble to verify encoding"""
    # Assemble
    ks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)
    encoding, _ = ks.asm(asm_str)
    code = bytes(encoding)

    # Disassemble to verify
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    for insn in md.disasm(code, 0):
        print(f"ASM: {asm_str.strip()}")
        print(f"HEX: {code.hex()}")
        print(f"DIS: {insn.mnemonic} {insn.op_str}")

# Quick lookup
encode_decode("mov x0, #0x1337")
encode_decode("ret")
encode_decode("nop")
encode_decode("svc #0")
```

### Pattern 6: Capstone + Keystone + Unicorn Combo

```python
from keystone import *
from capstone import *
from unicorn import *
from unicorn.arm64_const import *

def assemble_and_emulate(asm_code):
    """Complete pipeline: assemble -> disassemble -> emulate"""

    # 1. Assemble
    ks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)
    encoding, count = ks.asm(asm_code)
    code = bytes(encoding)
    print(f"[ASM] {count} instructions, {len(code)} bytes")
    print(f"[HEX] {code.hex()}")

    # 2. Disassemble (verify)
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    print("[DIS]")
    for insn in md.disasm(code, 0x1000):
        print(f"  0x{insn.address:x}: {insn.mnemonic} {insn.op_str}")

    # 3. Emulate
    mu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
    BASE = 0x1000
    STACK = 0x80000

    mu.mem_map(BASE, 0x10000)
    mu.mem_map(STACK - 0x10000, 0x20000)
    mu.mem_write(BASE, code)
    mu.reg_write(UC_ARM64_REG_SP, STACK)

    mu.emu_start(BASE, BASE + len(code))

    x0 = mu.reg_read(UC_ARM64_REG_X0)
    print(f"[EMU] X0 = 0x{x0:x}")

    return x0

# Test
result = assemble_and_emulate("""
    mov x0, #42
    add x0, x0, #8
""")
print(f"Result: {result}")  # 50
```

## Error Handling

```python
from keystone import *

ks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)

try:
    encoding, count = ks.asm("invalid_instruction x0, x1")
except KsError as e:
    print(f"Error: {e}")
    print(f"Error code: {e.errno}")
    # KS_ERR_ASM_MNEMONICFAIL - invalid mnemonic
    # KS_ERR_ASM_EXPR_TOKEN - invalid expression token
    # KS_ERR_ASM_INVALIDOPERAND - invalid operand
```

## Assembler Syntax Notes

```python
# ARM64 syntax
ks = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN)
ks.asm("mov x0, #0x41")           # Immediate
ks.asm("ldr x0, [x1, #0x10]")    # Memory access
ks.asm("b #0x100")                # Branch (relative)
ks.asm("svc #0")                  # Supervisor call

# x86-64 syntax (Intel by default)
ks = Ks(KS_ARCH_X86, KS_MODE_64)
ks.asm("mov rax, 0x41")
ks.asm("push rbp")
ks.asm("syscall")

# Switch to AT&T syntax
ks.syntax = KS_OPT_SYNTAX_ATT
ks.asm("movq $0x41, %rax")

# Labels and directives
ks.asm("""
    jmp label1
    nop
label1:
    mov rax, 1
""")

# Data embedding
ks.asm('.byte 0x41, 0x42, 0x43')
ks.asm('.ascii "hello"')
ks.asm('.word 0x1234')
```

## Dependencies

```bash
pip install keystone-engine capstone unicorn
```
