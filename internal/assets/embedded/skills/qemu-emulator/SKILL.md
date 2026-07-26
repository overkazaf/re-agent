---
name: qemu-emulator
description: Use QEMU for full-system and user-mode emulation, cross-architecture binary execution, firmware analysis, and kernel debugging. Supports ARM/ARM64/x86/x64/MIPS/RISC-V/PPC. Use for running foreign-arch binaries, debugging with GDB, snapshot-based fuzzing, and embedded system emulation.
---

# QEMU Emulator Skill

A skill for using QEMU to emulate full systems or run individual binaries across different CPU architectures.

## Overview

QEMU (Quick EMUlator) is an open-source machine emulator and virtualizer. It operates in two modes:

- **User-mode emulation (`qemu-<arch>`)**: Run individual foreign-arch binaries on the host without a full OS
- **System-mode emulation (`qemu-system-<arch>`)**: Emulate a complete machine with CPU, memory, peripherals

**Official Site:** https://www.qemu.org
**Docs:** https://www.qemu.org/docs/master/

## Installation

```bash
# macOS
brew install qemu

# Ubuntu/Debian
sudo apt install qemu-user qemu-system qemu-user-static

# Arch Linux
sudo pacman -S qemu-full

# Check version
qemu-system-aarch64 --version
qemu-aarch64 --version
```

## User-Mode Emulation

Run foreign-architecture Linux binaries directly on the host.

### Basic Usage

```bash
# Run ARM64 binary
qemu-aarch64 ./binary_arm64

# Run ARM32 binary
qemu-arm ./binary_arm32

# Run MIPS binary
qemu-mips ./binary_mips

# Run x86 binary on ARM host
qemu-i386 ./binary_x86

# Run RISC-V binary
qemu-riscv64 ./binary_riscv64
```

### With Shared Libraries (Cross-compilation rootfs)

```bash
# Specify library search path
qemu-aarch64 -L /usr/aarch64-linux-gnu ./binary_arm64

# With environment variables
qemu-aarch64 -L /usr/aarch64-linux-gnu -E LD_LIBRARY_PATH=/lib:/usr/lib ./binary_arm64

# Static binary (no library needed)
qemu-aarch64 ./binary_arm64_static
```

### GDB Debugging (User-mode)

```bash
# Start binary with GDB server on port 1234
qemu-aarch64 -g 1234 -L /usr/aarch64-linux-gnu ./binary_arm64

# In another terminal, connect GDB
gdb-multiarch ./binary_arm64
(gdb) target remote localhost:1234
(gdb) break main
(gdb) continue
```

### Strace / Syscall Tracing

```bash
# Trace syscalls
qemu-aarch64 -strace ./binary_arm64

# Trace specific syscall
qemu-aarch64 -strace ./binary_arm64 2>&1 | grep open
```

### User-mode with Docker (qemu-user-static)

```bash
# Register binfmt_misc handlers
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes

# Run ARM64 container on x86 host
docker run --rm -it arm64v8/ubuntu:22.04 bash

# Run ARM32 container
docker run --rm -it arm32v7/debian:bullseye bash
```

## System-Mode Emulation

Emulate complete systems with full OS.

### ARM64 (AArch64) System

```bash
# Boot ARM64 Linux
qemu-system-aarch64 \
    -M virt \
    -cpu cortex-a72 \
    -m 2G \
    -smp 4 \
    -kernel Image \
    -initrd initrd.img \
    -append "root=/dev/vda2 console=ttyAMA0" \
    -drive file=disk.qcow2,format=qcow2,if=virtio \
    -netdev user,id=net0,hostfwd=tcp::2222-:22 \
    -device virtio-net-pci,netdev=net0 \
    -nographic
```

### ARM32 System

```bash
qemu-system-arm \
    -M vexpress-a9 \
    -cpu cortex-a9 \
    -m 1G \
    -kernel zImage \
    -dtb vexpress-v2p-ca9.dtb \
    -initrd initrd.img \
    -append "root=/dev/mmcblk0 console=ttyAMA0" \
    -sd rootfs.ext4 \
    -nographic
```

### x86_64 System

```bash
qemu-system-x86_64 \
    -m 4G \
    -smp 4 \
    -enable-kvm \
    -cpu host \
    -drive file=disk.qcow2,format=qcow2 \
    -netdev user,id=net0,hostfwd=tcp::2222-:22 \
    -device virtio-net-pci,netdev=net0 \
    -nographic
```

### MIPS System

```bash
qemu-system-mips \
    -M malta \
    -cpu 24Kf \
    -m 256M \
    -kernel vmlinux \
    -append "root=/dev/sda1 console=ttyS0" \
    -drive file=disk.qcow2,format=qcow2 \
    -nographic
```

### RISC-V System

```bash
qemu-system-riscv64 \
    -M virt \
    -cpu rv64 \
    -m 2G \
    -smp 4 \
    -kernel Image \
    -append "root=/dev/vda console=ttyS0" \
    -drive file=rootfs.ext4,format=raw,if=virtio \
    -nographic
```

## Common Patterns

### Pattern 1: Cross-Architecture Binary Testing

```bash
#!/bin/bash
# Test a binary compiled for multiple architectures

BINARY_NAME="my_program"
ROOTFS_BASE="/usr/cross"

for arch in aarch64 arm mips mipsel riscv64; do
    echo "=== Testing $arch ==="
    qemu-$arch -L "$ROOTFS_BASE/$arch-linux-gnu" ./${BINARY_NAME}_${arch} 2>&1
    echo "Exit code: $?"
done
```

### Pattern 2: Firmware Emulation

```bash
# Extract and emulate IoT firmware
# 1. Extract filesystem
binwalk -e firmware.bin
cd _firmware.bin.extracted

# 2. Find rootfs
ls squashfs-root/

# 3. Emulate with QEMU user-mode (chroot style)
sudo cp /usr/bin/qemu-arm-static squashfs-root/usr/bin/
sudo chroot squashfs-root /usr/bin/qemu-arm-static /bin/sh

# 4. Or emulate specific binaries
qemu-arm -L squashfs-root squashfs-root/usr/bin/target_binary
```

### Pattern 3: Kernel Debugging with GDB

```bash
# Start QEMU with GDB server
qemu-system-aarch64 \
    -M virt \
    -cpu cortex-a72 \
    -m 2G \
    -kernel Image \
    -initrd initrd.img \
    -append "root=/dev/vda2 console=ttyAMA0 nokaslr" \
    -nographic \
    -s -S  # -s = GDB on port 1234, -S = freeze at startup

# Connect GDB
gdb-multiarch vmlinux
(gdb) target remote localhost:1234
(gdb) break start_kernel
(gdb) continue
```

### Pattern 4: Snapshot-based Analysis

```bash
# Create disk image
qemu-img create -f qcow2 analysis.qcow2 10G

# Create snapshot
qemu-img snapshot -c clean_state analysis.qcow2

# List snapshots
qemu-img snapshot -l analysis.qcow2

# Revert to snapshot
qemu-img snapshot -a clean_state analysis.qcow2

# From QEMU monitor (Ctrl+A, C):
# (qemu) savevm my_snapshot
# (qemu) loadvm my_snapshot
```

### Pattern 5: Network Forensics / Traffic Analysis

```bash
# Dump network traffic to pcap
qemu-system-x86_64 \
    -m 2G \
    -drive file=malware_env.qcow2,format=qcow2 \
    -netdev user,id=net0,hostfwd=tcp::2222-:22 \
    -device virtio-net-pci,netdev=net0 \
    -object filter-dump,id=dump0,netdev=net0,file=traffic.pcap \
    -nographic
```

### Pattern 6: QEMU Monitor Commands

```bash
# Access monitor: Ctrl+A, C (in -nographic mode)

# Common monitor commands:
# info registers     - Dump CPU registers
# info mem           - Show memory mappings
# info cpus          - Show CPU state
# xp /16xw 0x1000   - Examine memory (16 words at 0x1000)
# gdbserver 1234     - Start GDB server
# savevm name        - Save VM snapshot
# loadvm name        - Load VM snapshot
# stop               - Pause execution
# cont               - Resume execution
# quit               - Exit QEMU
```

### Pattern 7: QEMU with Python (via QMP)

```python
import socket
import json

class QMPClient:
    """QEMU Machine Protocol client for programmatic control."""

    def __init__(self, socket_path="/tmp/qemu-qmp.sock"):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(socket_path)
        # Read greeting
        self._recv()
        # Negotiate capabilities
        self._send({"execute": "qmp_capabilities"})
        self._recv()

    def _send(self, cmd):
        self.sock.sendall(json.dumps(cmd).encode() + b"\n")

    def _recv(self):
        data = b""
        while True:
            chunk = self.sock.recv(4096)
            data += chunk
            if b"\n" in chunk:
                break
        return json.loads(data.decode())

    def execute(self, command, **kwargs):
        cmd = {"execute": command}
        if kwargs:
            cmd["arguments"] = kwargs
        self._send(cmd)
        return self._recv()

    def save_snapshot(self, name):
        return self.execute("human-monitor-command",
                          command_line=f"savevm {name}")

    def load_snapshot(self, name):
        return self.execute("human-monitor-command",
                          command_line=f"loadvm {name}")

    def query_status(self):
        return self.execute("query-status")

    def stop(self):
        return self.execute("stop")

    def cont(self):
        return self.execute("cont")

# Usage:
# Start QEMU with: -qmp unix:/tmp/qemu-qmp.sock,server,nowait
# qmp = QMPClient("/tmp/qemu-qmp.sock")
# qmp.save_snapshot("before_exploit")
# qmp.load_snapshot("before_exploit")
```

## Disk Image Management

```bash
# Create disk image
qemu-img create -f qcow2 disk.qcow2 20G

# Create with backing file (copy-on-write)
qemu-img create -f qcow2 -b base.qcow2 -F qcow2 overlay.qcow2

# Convert between formats
qemu-img convert -f raw -O qcow2 disk.raw disk.qcow2

# Resize
qemu-img resize disk.qcow2 +10G

# Info
qemu-img info disk.qcow2

# Mount qcow2 (read contents on host)
sudo modprobe nbd max_part=8
sudo qemu-nbd --connect=/dev/nbd0 disk.qcow2
sudo mount /dev/nbd0p1 /mnt
# ... access files ...
sudo umount /mnt
sudo qemu-nbd --disconnect /dev/nbd0
```

## Architecture Reference

| Architecture | User-mode Binary | System Binary | Machine Type |
|-------------|-----------------|---------------|-------------|
| ARM64 | `qemu-aarch64` | `qemu-system-aarch64` | `virt` |
| ARM32 | `qemu-arm` | `qemu-system-arm` | `vexpress-a9`, `virt` |
| x86 | `qemu-i386` | `qemu-system-i386` | `pc`, `q35` |
| x86-64 | `qemu-x86_64` | `qemu-system-x86_64` | `pc`, `q35` |
| MIPS | `qemu-mips` | `qemu-system-mips` | `malta` |
| MIPS64 | `qemu-mips64` | `qemu-system-mips64` | `malta` |
| RISC-V 64 | `qemu-riscv64` | `qemu-system-riscv64` | `virt` |
| PowerPC | `qemu-ppc` | `qemu-system-ppc` | `mac99` |
| S390x | `qemu-s390x` | `qemu-system-s390x` | `s390-ccw-virtio` |

## Comparison: QEMU vs Unicorn vs Qiling

| Feature | QEMU | Unicorn | Qiling |
|---------|------|---------|--------|
| Emulation Level | Full system / User-mode | CPU only | OS-level (on Unicorn) |
| Real OS Boot | Yes | No | No |
| Peripherals | Full device emulation | No | No |
| Performance | Fast (TCG/KVM) | Moderate | Moderate |
| Snapshots | Full VM snapshots | Register state | Process state |
| GDB Support | Built-in | No | Built-in |
| Networking | Full stack | No | No |
| Best For | Full system, firmware, kernel | Lightweight code emu | Binary analysis, DFA |
| Language | C (CLI tool) | C/Python | Python |

## Tips

1. **Use `-nographic`** for headless operation, `Ctrl+A, X` to quit
2. **Enable KVM** (`-enable-kvm`) on Linux for near-native speed when host matches guest arch
3. **Use qcow2** format for copy-on-write and snapshot support
4. **Port forwarding** via `-netdev user,hostfwd=tcp::HOST-:GUEST` for SSH/HTTP access
5. **Snapshot before experiments** - always save state before risky operations
6. **Use `-strace`** in user-mode for quick syscall debugging
7. **GDB with `nokaslr`** in kernel command line for stable breakpoints
8. **Static binaries** avoid library dependency issues in user-mode
9. **Monitor console** (`Ctrl+A, C`) for runtime inspection and control
10. **QMP protocol** for scripted/automated control from Python

## Dependencies

```bash
# Core
brew install qemu  # macOS
# or: apt install qemu-user qemu-system  # Linux

# For cross-compilation rootfs
apt install gcc-aarch64-linux-gnu  # ARM64 cross-compiler
apt install gcc-arm-linux-gnueabihf  # ARM32 cross-compiler

# For debugging
apt install gdb-multiarch

# For firmware extraction
pip install binwalk
```
