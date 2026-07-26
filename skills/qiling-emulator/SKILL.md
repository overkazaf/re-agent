---
name: qiling-emulator
description: Generate Qiling Framework scripts for full-system emulation, binary analysis, rootkit detection, and reverse engineering. Supports ARM/ARM64/x86/x64/MIPS with OS-level emulation (Linux, Windows, macOS, Android, QNX, UEFI). Use for SO/ELF/PE emulation, syscall hooking, firmware analysis, and white-box cryptanalysis (DFA/DCA).
---

# Qiling Emulator Skill

A skill for generating Qiling Framework scripts to emulate binaries with full OS-level support, including syscalls, file systems, and dynamic linking.

## Overview

Qiling is a high-level binary emulation framework built on top of Unicorn Engine. Unlike Unicorn (which only emulates CPU instructions), Qiling provides:

- **OS-Level Emulation**: Full syscall handling for Linux, Windows, macOS, Android, QNX, UEFI
- **File System Emulation**: Virtual file system with rootfs support
- **Dynamic Linking**: Automatic library loading and relocation
- **Multi-Architecture**: ARM, ARM64, x86, x86-64, MIPS
- **Rich Hooking**: Address hooks, syscall hooks, API hooks, memory hooks
- **Snapshot/Restore**: Save and restore emulation state for fuzzing and DFA
- **GDB Support**: Built-in GDB server for debugging

**GitHub:** https://github.com/qilingframework/qiling
**Docs:** https://docs.qiling.io

## Installation

```bash
pip install qiling

# For development version
pip install git+https://github.com/qilingframework/qiling.git
```

### Rootfs Setup

Qiling requires a rootfs (root filesystem) to emulate OS-level features:

```bash
# Download rootfs examples from Qiling repo
git clone https://github.com/qilingframework/qiling.git
# Rootfs located at: qiling/examples/rootfs/

# Structure example (Linux ARM64):
# rootfs/arm64_linux/
# ├── lib/
# │   ├── ld-linux-aarch64.so.1
# │   ├── libc.so.6
# │   ├── libdl.so.2
# │   ├── libpthread.so.0
# │   └── ...
# ├── usr/lib/
# ├── etc/
# └── proc/
```

## Basic Workflow

### Step 1: Initialize Qiling Instance

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE

# Basic ELF emulation
ql = Qiling(
    argv=["/path/to/binary", "arg1", "arg2"],
    rootfs="/path/to/rootfs/arm64_linux",
    verbose=QL_VERBOSE.DEBUG  # OFF, DEFAULT, DEBUG, DUMP, DISASM
)

# Run emulation
ql.run()
```

### Step 2: Configure Environment

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE, QL_ARCH, QL_OS

# Explicit architecture/OS
ql = Qiling(
    argv=["/path/to/binary"],
    rootfs="/path/to/rootfs",
    archtype=QL_ARCH.ARM64,
    ostype=QL_OS.LINUX,
    verbose=QL_VERBOSE.DEFAULT
)

# Set environment variables
ql.env = {"LD_LIBRARY_PATH": "/lib:/usr/lib"}

# Add file mapping
ql.add_fs_mapper("/dev/urandom", "/dev/urandom")
```

### Step 3: Add Hooks

```python
# Address hook
def my_hook(ql):
    ql.log.info(f"Hit address 0x{ql.arch.regs.pc:x}")
    # Read register
    r0 = ql.arch.regs.read("x0")  # ARM64
    ql.log.info(f"X0 = 0x{r0:x}")

ql.hook_address(my_hook, target_address)

# Run
ql.run()
```

## Common Patterns

### Pattern 1: Linux ELF Emulation

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE

def emulate_elf(binary_path, rootfs_path, args=None):
    argv = [binary_path] + (args or [])
    ql = Qiling(argv=argv, rootfs=rootfs_path, verbose=QL_VERBOSE.DEFAULT)

    # Hook a specific address
    base = ql.loader.images[0].base  # Get base address of main binary

    def on_target(ql):
        x0 = ql.arch.regs.read("x0")
        ql.log.info(f"Target function called, arg0=0x{x0:x}")

    ql.hook_address(on_target, base + 0x1234)

    ql.run()
```

### Pattern 2: Windows PE Emulation

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE

ql = Qiling(
    argv=[r"rootfs/x86_windows/bin/target.exe"],
    rootfs=r"rootfs/x86_windows",
    verbose=QL_VERBOSE.DEFAULT
)

# Hook Windows API
def hook_MessageBoxA(ql, address, params):
    ql.log.info(f"MessageBoxA: {params}")
    return 1  # IDOK

ql.os.set_api("MessageBoxA", hook_MessageBoxA)
ql.run()
```

### Pattern 3: Android SO Emulation

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE

# Emulate Android native library
ql = Qiling(
    argv=["/path/to/libnative.so"],
    rootfs="rootfs/arm64_android",
    verbose=QL_VERBOSE.DEBUG
)

# Map additional libraries
ql.add_fs_mapper("/system/lib64", "rootfs/arm64_android/system/lib64")

# Hook JNI function
base = ql.loader.images[0].base

def hook_jni_func(ql):
    # Read JNIEnv* (first arg)
    jni_env = ql.arch.regs.read("x0")
    # Read jobject (second arg)
    obj = ql.arch.regs.read("x1")
    # Read actual args
    arg0 = ql.arch.regs.read("x2")
    ql.log.info(f"JNI function called, arg=0x{arg0:x}")

ql.hook_address(hook_jni_func, base + 0x1234)
ql.run()
```

### Pattern 4: Shellcode Emulation

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE, QL_ARCH, QL_OS

shellcode = bytes.fromhex("31c050682f2f7368682f62696e89e3505389e1b00bcd80")

ql = Qiling(
    code=shellcode,
    archtype=QL_ARCH.X86,
    ostype=QL_OS.LINUX,
    rootfs="rootfs/x86_linux",
    verbose=QL_VERBOSE.DISASM
)
ql.run()
```

### Pattern 5: Firmware / UEFI Analysis

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE, QL_ARCH, QL_OS

ql = Qiling(
    argv=["/path/to/firmware.bin"],
    rootfs="rootfs/arm_uefi",
    archtype=QL_ARCH.ARM,
    ostype=QL_OS.UEFI,
    verbose=QL_VERBOSE.DEBUG
)

# Profile boot sequence
ql.run()
```

## Hooking API

### Address Hooks

```python
# Simple address hook
def hook_fn(ql):
    ql.log.info("Address hit!")

ql.hook_address(hook_fn, address)

# Hook with callback on return
def hook_entry(ql):
    ql.log.info("Function entry")

def hook_exit(ql):
    ret = ql.arch.regs.read("x0")  # ARM64 return value
    ql.log.info(f"Function returned: 0x{ret:x}")

ql.hook_address(hook_entry, func_start)
ql.hook_address(hook_exit, func_end)
```

### Code Hooks (Range)

```python
# Hook all code in a range
def trace_hook(ql, address, size):
    ql.log.info(f"  0x{address:08x}")

ql.hook_code(trace_hook, begin=start_addr, end=end_addr)
```

### Syscall Hooks

```python
# Hook specific syscall
def hook_open(ql, path, flags, mode):
    ql.log.info(f"open({path}, {flags:#x}, {mode:#o})")
    # Return custom fd or let it pass through

ql.os.set_syscall("open", hook_open)

# Hook all syscalls
def hook_all_syscalls(ql, *args):
    ql.log.info(f"Syscall: {ql.os.syscall_name}")

ql.hook_syscall(hook_all_syscalls)
```

### Memory Hooks

```python
from unicorn import UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE

def hook_mem_read(ql, access, address, size, value):
    ql.log.info(f"Memory READ at 0x{address:x}, size={size}")

def hook_mem_write(ql, access, address, size, value):
    ql.log.info(f"Memory WRITE at 0x{address:x}, size={size}, value=0x{value:x}")

ql.hook_mem_read(hook_mem_read)
ql.hook_mem_write(hook_mem_write)
```

### Interrupt Hooks

```python
def hook_intr(ql, intno):
    ql.log.info(f"Interrupt: {intno}")

ql.hook_intr(hook_intr)
```

## Register Access

### ARM64 Registers

```python
# Read registers
x0 = ql.arch.regs.read("x0")
sp = ql.arch.regs.read("sp")
pc = ql.arch.regs.read("pc")
cpsr = ql.arch.regs.read("cpsr")

# Write registers
ql.arch.regs.write("x0", 0xdeadbeef)
ql.arch.regs.write("pc", new_address)

# Read all registers
ql.arch.regs.save()  # Returns dict of all registers
```

### ARM32 Registers

```python
r0 = ql.arch.regs.read("r0")
sp = ql.arch.regs.read("sp")
lr = ql.arch.regs.read("lr")
pc = ql.arch.regs.read("pc")

ql.arch.regs.write("r0", value)
```

### x86/x64 Registers

```python
# x86
eax = ql.arch.regs.read("eax")
esp = ql.arch.regs.read("esp")
eip = ql.arch.regs.read("eip")

# x64
rax = ql.arch.regs.read("rax")
rdi = ql.arch.regs.read("rdi")  # 1st arg (System V ABI)
rsi = ql.arch.regs.read("rsi")  # 2nd arg
```

## Memory Access

```python
# Read memory
data = ql.mem.read(address, size)

# Write memory
ql.mem.write(address, b"\x00" * 16)

# Map new memory
ql.mem.map(address, size, info="[my_region]")

# Search memory
results = ql.mem.search(b"\x41\x41\x41\x41")

# Read string from memory
s = ql.mem.string(address)

# Read pointer-sized value
ptr = ql.unpack(ql.mem.read(address, ql.arch.pointersize))
```

## Snapshot & Restore (Critical for DFA)

Qiling's snapshot feature is essential for Differential Fault Analysis:

```python
# Save state
state = ql.save()

# ... modify state, run with faults ...

# Restore state
ql.restore(state)
```

### DFA (Differential Fault Analysis) Pattern

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE
import random

def dfa_attack(binary_path, rootfs, func_addr, fault_range_start, fault_range_end):
    """
    White-box DFA attack using Qiling snapshot/restore.
    Injects single-byte faults during the last rounds of AES
    and collects faulty ciphertexts for key recovery.
    """
    results = []

    # Step 1: Get correct output (golden run)
    ql = Qiling(argv=[binary_path], rootfs=rootfs, verbose=QL_VERBOSE.OFF)
    base = ql.loader.images[0].base

    correct_output = None

    def capture_output(ql):
        nonlocal correct_output
        # Read output buffer (adjust register/address based on target)
        out_addr = ql.arch.regs.read("x0")
        correct_output = bytes(ql.mem.read(out_addr, 16))

    ql.hook_address(capture_output, base + func_addr + 0x100)  # after encryption
    ql.run()
    print(f"Correct output: {correct_output.hex()}")

    # Step 2: Fault injection campaign
    for fault_addr in range(fault_range_start, fault_range_end):
        for fault_value in range(256):
            # Create fresh instance or use snapshot
            ql = Qiling(argv=[binary_path], rootfs=rootfs, verbose=QL_VERBOSE.OFF)
            base = ql.loader.images[0].base

            # Save state just before the fault target
            saved_state = None

            def save_before_fault(ql):
                nonlocal saved_state
                saved_state = ql.save()

            ql.hook_address(save_before_fault, base + fault_range_start - 4)

            # Inject fault
            def inject_fault(ql):
                # Overwrite a byte in memory/register
                original = ql.mem.read(base + fault_addr, 1)
                ql.mem.write(base + fault_addr, bytes([fault_value]))

            ql.hook_address(inject_fault, base + fault_addr)

            # Capture faulty output
            faulty_output = None

            def capture_faulty(ql):
                nonlocal faulty_output
                out_addr = ql.arch.regs.read("x0")
                faulty_output = bytes(ql.mem.read(out_addr, 16))

            ql.hook_address(capture_faulty, base + func_addr + 0x100)

            try:
                ql.run()
                if faulty_output and faulty_output != correct_output:
                    results.append({
                        "fault_addr": fault_addr,
                        "fault_value": fault_value,
                        "faulty_output": faulty_output.hex(),
                        "correct_output": correct_output.hex()
                    })
            except Exception:
                pass

    return results
```

### DCA (Differential Computation Analysis) Pattern

```python
from qiling import Qiling
from qiling.const import QL_VERBOSE
import numpy as np

def dca_trace_collection(binary_path, rootfs, func_addr, num_traces=256):
    """
    Collect execution traces for Differential Computation Analysis.
    Records memory writes during encryption for side-channel analysis.
    """
    traces = []

    for i in range(num_traces):
        ql = Qiling(argv=[binary_path], rootfs=rootfs, verbose=QL_VERBOSE.OFF)
        base = ql.loader.images[0].base

        trace_data = []

        # Prepare random plaintext
        plaintext = bytes([random.randint(0, 255) for _ in range(16)])

        # Write plaintext to input buffer
        def setup_input(ql):
            input_addr = ql.arch.regs.read("x0")
            ql.mem.write(input_addr, plaintext)

        ql.hook_address(setup_input, base + func_addr)

        # Record memory writes during encryption
        def trace_mem_write(ql, access, address, size, value):
            trace_data.append(value & 0xFF)

        ql.hook_mem_write(trace_mem_write)

        ql.run()
        traces.append({
            "plaintext": plaintext,
            "trace": trace_data
        })

    return traces
```

## Advanced Features

### GDB Server

```python
# Start with GDB server
ql = Qiling(
    argv=["/path/to/binary"],
    rootfs="/path/to/rootfs",
    verbose=QL_VERBOSE.DEFAULT
)
ql.debugger = "gdb:0.0.0.0:9999"
ql.run()

# Connect from GDB:
# $ gdb-multiarch
# (gdb) target remote localhost:9999
```

### Custom Syscall Handler

```python
from qiling.os.posix import syscall

def my_custom_read(ql, fd, buf, count):
    """Custom read syscall handler"""
    if fd == 3:  # Custom fd
        data = b"fake data from custom handler"
        ql.mem.write(buf, data[:count])
        return len(data[:count])
    # Fall back to default
    return syscall.ql_syscall_read(ql, fd, buf, count)

ql.os.set_syscall("read", my_custom_read)
```

### Multi-threading Support

```python
ql = Qiling(
    argv=["/path/to/binary"],
    rootfs="/path/to/rootfs",
    multithread=True,
    verbose=QL_VERBOSE.DEFAULT
)
ql.run()
```

### Code Coverage

```python
coverage = set()

def collect_coverage(ql, address, size):
    coverage.add(address)

ql.hook_code(collect_coverage)
ql.run()

print(f"Covered {len(coverage)} unique addresses")
# Export for visualization (e.g., lighthouse)
with open("coverage.txt", "w") as f:
    for addr in sorted(coverage):
        f.write(f"0x{addr:x}\n")
```

## Comparison: Qiling vs Unicorn vs Unidbg

| Feature | Qiling | Unicorn | Unidbg |
|---------|--------|---------|--------|
| CPU Emulation | Yes (via Unicorn) | Yes | Yes (via Unicorn) |
| OS Emulation | Yes (Linux/Win/macOS/Android/UEFI) | No | Android only |
| Syscall Handling | Built-in | Manual | Built-in |
| File System | Virtual rootfs | No | Partial |
| Dynamic Linking | Automatic | Manual | Automatic |
| Snapshot/Restore | Yes | Limited | Limited |
| Language | Python | C/Python | Java |
| GDB Debug | Built-in | No | Partial |
| Best For | Full-system emulation, firmware, DFA | Lightweight CPU emu | Android JNI |

## Tips

1. **Prepare rootfs carefully** - Missing libraries cause most failures
2. **Use QL_VERBOSE.DISASM** for instruction-level debugging
3. **Snapshot before fault injection** - Critical for DFA efficiency
4. **Hook syscalls** for anti-debug/anti-emulation bypass
5. **Map /proc/self/maps** and similar special files
6. **Use ql.mem.search()** to find data patterns in memory
7. **Set timeout** via `ql.run(timeout=10000000)` to prevent infinite loops
8. **Profile with hook_code** to identify hot paths

## Dependencies

```bash
pip install qiling capstone keystone-engine unicorn pefile
```

## Output

Generated scripts are saved to:
```
qiling_scripts/{arch}_{target_name}.py
```
