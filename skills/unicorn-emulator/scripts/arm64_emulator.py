#!/usr/bin/env python3
"""
ARM64 (AArch64) Unicorn Emulator Template
用于模拟执行ARM64代码

使用方法:
    python arm64_emulator.py <binary_file> <function_offset> [args...]

示例:
    python arm64_emulator.py libexample.so 0x1234 0xdeadbeef 16
"""

from unicorn import *
from unicorn.arm64_const import *
from capstone import *
from keystone import *
import struct
import sys
import os


class ARM64Emulator:
    """ARM64 CPU模拟器"""

    # 内存布局
    CODE_BASE = 0x100000000
    CODE_SIZE = 0x1000000   # 16MB
    STACK_BASE = 0x800000000000
    STACK_SIZE = 0x100000   # 1MB
    HEAP_BASE = 0x900000000000
    HEAP_SIZE = 0x1000000   # 16MB
    DATA_BASE = 0xA00000000000
    DATA_SIZE = 0x1000000   # 16MB

    def __init__(self):
        """初始化模拟器"""
        self.mu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        self.cs = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
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

        # 初始化栈指针（16字节对齐）
        self.mu.reg_write(UC_ARM64_REG_SP, self.STACK_BASE - 0x100)

    def _setup_hooks(self):
        """设置Hook"""
        self.mu.hook_add(UC_HOOK_MEM_UNMAPPED, self._hook_unmapped)
        self.code_hook = None
        self.mem_hook = None

    def _hook_unmapped(self, mu, access, address, size, value, user_data):
        """处理未映射内存访问"""
        access_type = "READ" if access == UC_MEM_READ else "WRITE" if access == UC_MEM_WRITE else "FETCH"
        print(f"[!] Unmapped {access_type} at 0x{address:016x}, size={size}")

        # 自动映射
        page_start = address & ~0xFFF
        try:
            self.mu.mem_map(page_start, 0x1000, UC_PROT_ALL)
            print(f"[*] Auto-mapped page at 0x{page_start:016x}")
            return True
        except Exception as e:
            print(f"[-] Failed to map: {e}")
            return False

    def _hook_code(self, mu, address, size, user_data):
        """指令追踪Hook"""
        self.instruction_count += 1
        code = mu.mem_read(address, size)

        for insn in self.cs.disasm(bytes(code), address):
            x0 = mu.reg_read(UC_ARM64_REG_X0)
            x1 = mu.reg_read(UC_ARM64_REG_X1)
            print(f"0x{address:016x}: {insn.mnemonic:8s} {insn.op_str:40s} | "
                  f"X0=0x{x0:016x} X1=0x{x1:016x}")

    def _hook_mem_access(self, mu, access, address, size, value, user_data):
        """内存访问Hook"""
        if access == UC_MEM_WRITE:
            print(f"[MEM] WRITE 0x{address:016x} = 0x{value:x} (size={size})")
        elif access == UC_MEM_READ:
            data = mu.mem_read(address, size)
            val = int.from_bytes(data, 'little')
            print(f"[MEM] READ  0x{address:016x} = 0x{val:x} (size={size})")

    def enable_trace(self, enabled=True):
        """启用/禁用指令追踪"""
        self.trace_enabled = enabled
        if enabled and self.code_hook is None:
            self.code_hook = self.mu.hook_add(UC_HOOK_CODE, self._hook_code)
        elif not enabled and self.code_hook is not None:
            self.mu.hook_del(self.code_hook)
            self.code_hook = None

    def enable_mem_trace(self, enabled=True):
        """启用/禁用内存追踪"""
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
        """加载二进制代码"""
        if base is None:
            base = self.CODE_BASE
        self.mu.mem_write(base, data)
        print(f"[*] Loaded {len(data)} bytes at 0x{base:016x}")

    def load_file(self, filepath, base=None):
        """从文件加载"""
        with open(filepath, 'rb') as f:
            data = f.read()
        self.load_binary(data, base)
        return data

    def malloc(self, size):
        """模拟内存分配"""
        size = (size + 15) & ~15  # 16字节对齐
        addr = self.heap_ptr
        self.heap_ptr += size
        print(f"[*] malloc({size}) = 0x{addr:016x}")
        return addr

    def write_string(self, address, string, encoding='utf-8'):
        """写入字符串"""
        data = string.encode(encoding) + b'\x00'
        self.mu.mem_write(address, data)
        return len(data)

    def read_string(self, address, max_len=256):
        """读取字符串"""
        result = b''
        for i in range(max_len):
            byte = self.mu.mem_read(address + i, 1)
            if byte == b'\x00':
                break
            result += byte
        return result.decode('utf-8', errors='replace')

    def write_bytes(self, address, data):
        """写入字节"""
        self.mu.mem_write(address, data)

    def read_bytes(self, address, size):
        """读取字节"""
        return bytes(self.mu.mem_read(address, size))

    def _get_registers(self):
        """获取所有寄存器"""
        regs = {}
        for i in range(31):
            regs[f'x{i}'] = self.mu.reg_read(UC_ARM64_REG_X0 + i)
        regs['sp'] = self.mu.reg_read(UC_ARM64_REG_SP)
        regs['pc'] = self.mu.reg_read(UC_ARM64_REG_PC)
        regs['nzcv'] = self.mu.reg_read(UC_ARM64_REG_NZCV)
        return regs

    def set_args(self, *args):
        """
        设置函数参数 (ARM64 AAPCS64调用约定)
        前8个参数通过X0-X7传递
        """
        regs = [
            UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3,
            UC_ARM64_REG_X4, UC_ARM64_REG_X5, UC_ARM64_REG_X6, UC_ARM64_REG_X7
        ]

        for i, arg in enumerate(args):
            if i < 8:
                self.mu.reg_write(regs[i], arg)
            else:
                # 栈传递
                sp = self.mu.reg_read(UC_ARM64_REG_SP)
                offset = (i - 8) * 8
                self.mu.mem_write(sp + offset, struct.pack('<Q', arg))

    def call(self, address, *args, timeout=0, count=0):
        """
        调用函数

        Args:
            address: 函数地址
            args: 函数参数
            timeout: 超时时间
            count: 最大指令数

        Returns:
            X0寄存器的值
        """
        self.set_args(*args)
        self.mu.reg_write(UC_ARM64_REG_LR, 0)

        print(f"[*] Calling function at 0x{address:016x}")
        print(f"[*] Arguments: {[hex(a) for a in args]}")

        try:
            self.instruction_count = 0
            self.mu.emu_start(address, 0, timeout=timeout, count=count)
        except UcError as e:
            if e.errno == UC_ERR_FETCH_UNMAPPED and self.mu.reg_read(UC_ARM64_REG_PC) == 0:
                pass
            else:
                print(f"[-] Emulation error: {e}")
                self.dump_state()
                raise

        result = self.mu.reg_read(UC_ARM64_REG_X0)
        print(f"[*] Executed {self.instruction_count} instructions")
        print(f"[*] Return value: 0x{result:016x} ({result})")

        return result

    def dump_state(self):
        """打印CPU状态"""
        regs = self._get_registers()
        print("\n" + "=" * 80)
        print("CPU State (ARM64):")
        print("=" * 80)

        for i in range(0, 32, 4):
            line = ""
            for j in range(4):
                idx = i + j
                if idx < 31:
                    line += f"  X{idx:<2d} = 0x{regs[f'x{idx}']:016x}"
            print(line)

        print(f"  SP  = 0x{regs['sp']:016x}    PC  = 0x{regs['pc']:016x}")
        print(f"  NZCV= 0x{regs['nzcv']:016x}")
        print("=" * 80)

    def hexdump(self, address, size):
        """十六进制转储"""
        data = self.read_bytes(address, size)
        print(f"\nHexdump at 0x{address:016x}:")
        for i in range(0, len(data), 16):
            hex_str = ' '.join(f'{b:02x}' for b in data[i:i+16])
            ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in data[i:i+16])
            print(f"  0x{address+i:016x}: {hex_str:48s} {ascii_str}")


class ARM64EmulatorWithSVC(ARM64Emulator):
    """带系统调用模拟的ARM64模拟器"""

    def __init__(self):
        super().__init__()
        self._setup_svc_hook()
        self.svc_handlers = {}
        self._register_default_svc()

    def _setup_svc_hook(self):
        """设置SVC中断Hook"""
        self.mu.hook_add(UC_HOOK_INTR, self._hook_svc)

    def _hook_svc(self, mu, intno, user_data):
        """处理SVC调用"""
        if intno == 2:  # ARM64 SVC
            svc_num = mu.reg_read(UC_ARM64_REG_X8)
            if svc_num in self.svc_handlers:
                self.svc_handlers[svc_num](mu)
            else:
                print(f"[!] Unhandled SVC: {svc_num}")

    def _register_default_svc(self):
        """注册默认的系统调用处理器"""
        # brk (45)
        self.svc_handlers[214] = self._svc_brk

        # mmap (222)
        self.svc_handlers[222] = self._svc_mmap

        # write (64)
        self.svc_handlers[64] = self._svc_write

    def _svc_brk(self, mu):
        """模拟brk系统调用"""
        addr = mu.reg_read(UC_ARM64_REG_X0)
        if addr == 0:
            mu.reg_write(UC_ARM64_REG_X0, self.heap_ptr)
        else:
            self.heap_ptr = addr
            mu.reg_write(UC_ARM64_REG_X0, addr)

    def _svc_mmap(self, mu):
        """模拟mmap系统调用"""
        addr = mu.reg_read(UC_ARM64_REG_X0)
        size = mu.reg_read(UC_ARM64_REG_X1)

        if addr == 0:
            addr = self.malloc(size)

        mu.reg_write(UC_ARM64_REG_X0, addr)

    def _svc_write(self, mu):
        """模拟write系统调用"""
        fd = mu.reg_read(UC_ARM64_REG_X0)
        buf = mu.reg_read(UC_ARM64_REG_X1)
        count = mu.reg_read(UC_ARM64_REG_X2)

        data = mu.mem_read(buf, count)
        if fd == 1:  # stdout
            print(f"[STDOUT] {data.decode('utf-8', errors='replace')}", end='')
        elif fd == 2:  # stderr
            print(f"[STDERR] {data.decode('utf-8', errors='replace')}", end='')

        mu.reg_write(UC_ARM64_REG_X0, count)


def demo():
    """演示示例"""
    print("=" * 80)
    print("ARM64 Emulator Demo")
    print("=" * 80)

    emu = ARM64Emulator()

    # 示例代码：计算两数之和
    # ADD X0, X0, X1
    # RET
    code = bytes([
        0x00, 0x00, 0x01, 0x8B,  # ADD X0, X0, X1
        0xC0, 0x03, 0x5F, 0xD6,  # RET
    ])

    emu.load_binary(code)
    emu.enable_trace(True)

    result = emu.call(emu.CODE_BASE, 1000, 2000)
    print(f"\n1000 + 2000 = {result}")


def demo_string():
    """字符串处理演示"""
    print("\n" + "=" * 80)
    print("ARM64 String Processing Demo")
    print("=" * 80)

    emu = ARM64Emulator()

    # 简单的字符串长度计算代码
    # strlen:
    #   MOV X2, X0           ; 保存起始地址
    # loop:
    #   LDRB W1, [X0], #1    ; 加载字节并递增指针
    #   CBNZ W1, loop        ; 如果不为0则继续
    #   SUB X0, X0, X2       ; 计算长度
    #   SUB X0, X0, #1       ; 减去结尾的0
    #   RET
    code = bytes([
        0xE2, 0x03, 0x00, 0xAA,  # MOV X2, X0
        0x01, 0x14, 0x40, 0x38,  # LDRB W1, [X0], #1
        0xE1, 0xFF, 0xFF, 0x35,  # CBNZ W1, -4
        0x40, 0x00, 0x02, 0xCB,  # SUB X0, X0, X2
        0x00, 0x04, 0x00, 0xD1,  # SUB X0, X0, #1
        0xC0, 0x03, 0x5F, 0xD6,  # RET
    ])

    emu.load_binary(code)

    # 准备测试字符串
    test_str = "Hello, ARM64 Unicorn!"
    str_addr = emu.malloc(len(test_str) + 1)
    emu.write_string(str_addr, test_str)

    emu.enable_trace(True)
    length = emu.call(emu.CODE_BASE, str_addr)

    print(f"\nstrlen(\"{test_str}\") = {length}")
    print(f"Expected: {len(test_str)}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python arm64_emulator.py <binary_file> <function_offset> [args...]")
        print("\nRunning demo instead...")
        demo()
        demo_string()
    else:
        binary_file = sys.argv[1]
        func_offset = int(sys.argv[2], 0)
        args = [int(a, 0) for a in sys.argv[3:]]

        emu = ARM64Emulator()
        emu.load_file(binary_file)
        emu.enable_trace(True)

        result = emu.call(emu.CODE_BASE + func_offset, *args)
        print(f"\nResult: 0x{result:016x} ({result})")
