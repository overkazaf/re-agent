#!/usr/bin/env python3
"""
ARM32 Unicorn Emulator Template
用于模拟执行ARM32代码（支持ARM和Thumb模式）

使用方法:
    python arm_emulator.py <binary_file> <function_offset> [args...]

示例:
    python arm_emulator.py libexample.so 0x1234 0xdeadbeef 16
"""

from unicorn import *
from unicorn.arm_const import *
from capstone import *
from keystone import *
import struct
import sys
import os


class ARM32Emulator:
    """ARM32 CPU模拟器"""

    # 内存布局
    CODE_BASE = 0x10000
    CODE_SIZE = 0x100000  # 1MB
    STACK_BASE = 0x80000000
    STACK_SIZE = 0x100000  # 1MB
    HEAP_BASE = 0x90000000
    HEAP_SIZE = 0x100000  # 1MB
    DATA_BASE = 0xA0000000
    DATA_SIZE = 0x100000  # 1MB

    def __init__(self, mode=UC_MODE_ARM):
        """
        初始化模拟器

        Args:
            mode: UC_MODE_ARM 或 UC_MODE_THUMB
        """
        self.mode = mode
        self.mu = Uc(UC_ARCH_ARM, mode)
        self.cs = Cs(CS_ARCH_ARM, CS_MODE_ARM if mode == UC_MODE_ARM else CS_MODE_THUMB)
        self.cs.detail = True

        self.heap_ptr = self.HEAP_BASE
        self.trace_enabled = False
        self.mem_trace_enabled = False
        self.instruction_count = 0

        self._setup_memory()
        self._setup_hooks()

    def _setup_memory(self):
        """初始化内存布局"""
        # 代码段
        self.mu.mem_map(self.CODE_BASE, self.CODE_SIZE,
                        UC_PROT_READ | UC_PROT_EXEC)
        # 栈
        self.mu.mem_map(self.STACK_BASE - self.STACK_SIZE, self.STACK_SIZE,
                        UC_PROT_READ | UC_PROT_WRITE)
        # 堆
        self.mu.mem_map(self.HEAP_BASE, self.HEAP_SIZE,
                        UC_PROT_READ | UC_PROT_WRITE)
        # 数据段
        self.mu.mem_map(self.DATA_BASE, self.DATA_SIZE,
                        UC_PROT_READ | UC_PROT_WRITE)

        # 初始化栈指针
        self.mu.reg_write(UC_ARM_REG_SP, self.STACK_BASE - 0x100)

    def _setup_hooks(self):
        """设置各种Hook"""
        # 未映射内存访问Hook
        self.mu.hook_add(UC_HOOK_MEM_UNMAPPED, self._hook_unmapped)

        # 指令执行Hook（可选开启）
        self.code_hook = None

        # 内存访问Hook（可选开启）
        self.mem_hook = None

    def _hook_unmapped(self, mu, access, address, size, value, user_data):
        """处理未映射内存访问"""
        access_type = "READ" if access == UC_MEM_READ else "WRITE" if access == UC_MEM_WRITE else "FETCH"
        print(f"[!] Unmapped {access_type} at 0x{address:08x}, size={size}")

        # 自动映射内存页
        page_start = address & ~0xFFF
        try:
            self.mu.mem_map(page_start, 0x1000, UC_PROT_ALL)
            print(f"[*] Auto-mapped page at 0x{page_start:08x}")
            return True
        except Exception as e:
            print(f"[-] Failed to map: {e}")
            return False

    def _hook_code(self, mu, address, size, user_data):
        """指令执行追踪Hook"""
        self.instruction_count += 1
        code = mu.mem_read(address, size)
        for insn in self.cs.disasm(bytes(code), address):
            regs = self._get_registers()
            print(f"0x{address:08x}: {insn.mnemonic:8s} {insn.op_str:30s} | "
                  f"R0=0x{regs['r0']:08x} R1=0x{regs['r1']:08x} "
                  f"R2=0x{regs['r2']:08x} R3=0x{regs['r3']:08x}")

    def _hook_mem_access(self, mu, access, address, size, value, user_data):
        """内存访问追踪Hook"""
        if access == UC_MEM_WRITE:
            print(f"[MEM] WRITE 0x{address:08x} = 0x{value:x} (size={size})")
        elif access == UC_MEM_READ:
            data = mu.mem_read(address, size)
            val = int.from_bytes(data, 'little')
            print(f"[MEM] READ  0x{address:08x} = 0x{val:x} (size={size})")

    def enable_trace(self, enabled=True):
        """启用/禁用指令追踪"""
        self.trace_enabled = enabled
        if enabled and self.code_hook is None:
            self.code_hook = self.mu.hook_add(UC_HOOK_CODE, self._hook_code)
        elif not enabled and self.code_hook is not None:
            self.mu.hook_del(self.code_hook)
            self.code_hook = None

    def enable_mem_trace(self, enabled=True):
        """启用/禁用内存访问追踪"""
        self.mem_trace_enabled = enabled
        if enabled and self.mem_hook is None:
            self.mem_hook = self.mu.hook_add(
                UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE,
                self._hook_mem_access
            )
        elif not enabled and self.mem_hook is not None:
            self.mu.hook_del(self.mem_hook)
            self.mem_hook = None

    def load_binary(self, data, base=None):
        """
        加载二进制代码

        Args:
            data: 二进制数据 (bytes)
            base: 加载基址，默认为CODE_BASE
        """
        if base is None:
            base = self.CODE_BASE

        self.mu.mem_write(base, data)
        print(f"[*] Loaded {len(data)} bytes at 0x{base:08x}")

    def load_file(self, filepath, base=None):
        """从文件加载二进制代码"""
        with open(filepath, 'rb') as f:
            data = f.read()
        self.load_binary(data, base)
        return data

    def malloc(self, size):
        """
        模拟堆内存分配

        Args:
            size: 分配大小

        Returns:
            分配的地址
        """
        # 对齐到8字节
        size = (size + 7) & ~7
        addr = self.heap_ptr
        self.heap_ptr += size
        print(f"[*] malloc({size}) = 0x{addr:08x}")
        return addr

    def write_string(self, address, string, encoding='utf-8'):
        """写入字符串到指定地址"""
        data = string.encode(encoding) + b'\x00'
        self.mu.mem_write(address, data)
        return len(data)

    def read_string(self, address, max_len=256):
        """从指定地址读取字符串"""
        result = b''
        for i in range(max_len):
            byte = self.mu.mem_read(address + i, 1)
            if byte == b'\x00':
                break
            result += byte
        return result.decode('utf-8', errors='replace')

    def write_bytes(self, address, data):
        """写入字节数据"""
        self.mu.mem_write(address, data)

    def read_bytes(self, address, size):
        """读取字节数据"""
        return bytes(self.mu.mem_read(address, size))

    def _get_registers(self):
        """获取所有通用寄存器"""
        return {
            'r0': self.mu.reg_read(UC_ARM_REG_R0),
            'r1': self.mu.reg_read(UC_ARM_REG_R1),
            'r2': self.mu.reg_read(UC_ARM_REG_R2),
            'r3': self.mu.reg_read(UC_ARM_REG_R3),
            'r4': self.mu.reg_read(UC_ARM_REG_R4),
            'r5': self.mu.reg_read(UC_ARM_REG_R5),
            'r6': self.mu.reg_read(UC_ARM_REG_R6),
            'r7': self.mu.reg_read(UC_ARM_REG_R7),
            'r8': self.mu.reg_read(UC_ARM_REG_R8),
            'r9': self.mu.reg_read(UC_ARM_REG_R9),
            'r10': self.mu.reg_read(UC_ARM_REG_R10),
            'r11': self.mu.reg_read(UC_ARM_REG_R11),
            'r12': self.mu.reg_read(UC_ARM_REG_R12),
            'sp': self.mu.reg_read(UC_ARM_REG_SP),
            'lr': self.mu.reg_read(UC_ARM_REG_LR),
            'pc': self.mu.reg_read(UC_ARM_REG_PC),
            'cpsr': self.mu.reg_read(UC_ARM_REG_CPSR),
        }

    def set_args(self, *args):
        """
        设置函数参数 (ARM AAPCS调用约定)

        Args:
            args: 参数列表，前4个通过R0-R3传递，其余通过栈传递
        """
        regs = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3]

        for i, arg in enumerate(args):
            if i < 4:
                self.mu.reg_write(regs[i], arg)
            else:
                # 栈传递
                sp = self.mu.reg_read(UC_ARM_REG_SP)
                offset = (i - 4) * 4
                self.mu.mem_write(sp + offset, struct.pack('<I', arg))

    def call(self, address, *args, timeout=0, count=0):
        """
        调用函数

        Args:
            address: 函数地址
            args: 函数参数
            timeout: 超时时间（微秒），0表示无限制
            count: 最大执行指令数，0表示无限制

        Returns:
            R0寄存器的值（函数返回值）
        """
        # 设置参数
        self.set_args(*args)

        # 设置返回地址（返回到地址0时停止）
        self.mu.reg_write(UC_ARM_REG_LR, 0)

        # 计算实际执行地址（Thumb模式需要+1）
        exec_addr = address
        if self.mode == UC_MODE_THUMB:
            exec_addr |= 1

        print(f"[*] Calling function at 0x{address:08x}")
        print(f"[*] Arguments: {[hex(a) for a in args]}")

        try:
            self.instruction_count = 0
            self.mu.emu_start(exec_addr, 0, timeout=timeout, count=count)
        except UcError as e:
            if e.errno == UC_ERR_FETCH_UNMAPPED and self.mu.reg_read(UC_ARM_REG_PC) == 0:
                # 正常返回（跳转到地址0）
                pass
            else:
                print(f"[-] Emulation error: {e}")
                self.dump_state()
                raise

        result = self.mu.reg_read(UC_ARM_REG_R0)
        print(f"[*] Executed {self.instruction_count} instructions")
        print(f"[*] Return value: 0x{result:08x} ({result})")

        return result

    def dump_state(self):
        """打印当前CPU状态"""
        regs = self._get_registers()
        print("\n" + "=" * 60)
        print("CPU State:")
        print("=" * 60)
        print(f"  R0  = 0x{regs['r0']:08x}    R1  = 0x{regs['r1']:08x}")
        print(f"  R2  = 0x{regs['r2']:08x}    R3  = 0x{regs['r3']:08x}")
        print(f"  R4  = 0x{regs['r4']:08x}    R5  = 0x{regs['r5']:08x}")
        print(f"  R6  = 0x{regs['r6']:08x}    R7  = 0x{regs['r7']:08x}")
        print(f"  R8  = 0x{regs['r8']:08x}    R9  = 0x{regs['r9']:08x}")
        print(f"  R10 = 0x{regs['r10']:08x}    R11 = 0x{regs['r11']:08x}")
        print(f"  R12 = 0x{regs['r12']:08x}")
        print(f"  SP  = 0x{regs['sp']:08x}    LR  = 0x{regs['lr']:08x}")
        print(f"  PC  = 0x{regs['pc']:08x}    CPSR= 0x{regs['cpsr']:08x}")
        print("=" * 60)

    def hexdump(self, address, size):
        """打印内存的十六进制转储"""
        data = self.read_bytes(address, size)
        print(f"\nHexdump at 0x{address:08x}:")
        for i in range(0, len(data), 16):
            hex_str = ' '.join(f'{b:02x}' for b in data[i:i+16])
            ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in data[i:i+16])
            print(f"  0x{address+i:08x}: {hex_str:48s} {ascii_str}")


def demo():
    """演示示例"""
    print("=" * 60)
    print("ARM32 Emulator Demo")
    print("=" * 60)

    # 创建模拟器（ARM模式）
    emu = ARM32Emulator(UC_MODE_ARM)

    # 示例代码：计算两个数的和
    # ADD R0, R0, R1
    # BX LR
    code = bytes([
        0x01, 0x00, 0x80, 0xE0,  # ADD R0, R0, R1
        0x1E, 0xFF, 0x2F, 0xE1,  # BX LR
    ])

    # 加载代码
    emu.load_binary(code)

    # 启用追踪
    emu.enable_trace(True)

    # 调用函数：计算 100 + 200
    result = emu.call(emu.CODE_BASE, 100, 200)
    print(f"\n100 + 200 = {result}")


def demo_thumb():
    """Thumb模式演示"""
    print("\n" + "=" * 60)
    print("ARM32 Thumb Mode Demo")
    print("=" * 60)

    # 创建Thumb模式模拟器
    emu = ARM32Emulator(UC_MODE_THUMB)

    # Thumb代码：计算两个数的和
    # ADDS R0, R0, R1
    # BX LR
    code = bytes([
        0x08, 0x44,  # ADD R0, R1
        0x70, 0x47,  # BX LR
    ])

    emu.load_binary(code)
    emu.enable_trace(True)

    result = emu.call(emu.CODE_BASE, 50, 30)
    print(f"\n50 + 30 = {result}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python arm_emulator.py <binary_file> <function_offset> [args...]")
        print("\nRunning demo instead...")
        demo()
        demo_thumb()
    else:
        binary_file = sys.argv[1]
        func_offset = int(sys.argv[2], 0)
        args = [int(a, 0) for a in sys.argv[3:]]

        # 检测是否为Thumb模式（通过最低位判断）
        mode = UC_MODE_THUMB if func_offset & 1 else UC_MODE_ARM
        func_offset = func_offset & ~1  # 清除Thumb标志位

        emu = ARM32Emulator(mode)
        emu.load_file(binary_file)
        emu.enable_trace(True)

        result = emu.call(emu.CODE_BASE + func_offset, *args)
        print(f"\nResult: 0x{result:08x} ({result})")
