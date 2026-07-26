#!/usr/bin/env python3
"""
x86/x64 Unicorn Emulator Template
用于模拟执行x86和x86-64代码

使用方法:
    python x86_emulator.py <binary_file> <function_offset> [args...]
    python x86_emulator.py --x64 <binary_file> <function_offset> [args...]

示例:
    python x86_emulator.py shellcode.bin 0x0 0xdeadbeef
    python x86_emulator.py --x64 lib.so 0x1234 0xdeadbeef 16
"""

from unicorn import *
from unicorn.x86_const import *
from capstone import *
from keystone import *
import struct
import sys
import os


class X86Emulator:
    """x86 (32位) CPU模拟器"""

    # 内存布局
    CODE_BASE = 0x400000
    CODE_SIZE = 0x100000    # 1MB
    STACK_BASE = 0x7FFE0000
    STACK_SIZE = 0x100000   # 1MB
    HEAP_BASE = 0x10000000
    HEAP_SIZE = 0x1000000   # 16MB
    DATA_BASE = 0x20000000
    DATA_SIZE = 0x1000000   # 16MB

    def __init__(self):
        """初始化x86模拟器"""
        self.mu = Uc(UC_ARCH_X86, UC_MODE_32)
        self.cs = Cs(CS_ARCH_X86, CS_MODE_32)
        self.cs.detail = True

        self.heap_ptr = self.HEAP_BASE
        self.trace_enabled = False
        self.instruction_count = 0

        self._setup_memory()
        self._setup_hooks()

    def _setup_memory(self):
        """初始化内存"""
        self.mu.mem_map(self.CODE_BASE, self.CODE_SIZE, UC_PROT_READ | UC_PROT_EXEC)
        self.mu.mem_map(self.STACK_BASE - self.STACK_SIZE, self.STACK_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.HEAP_BASE, self.HEAP_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.DATA_BASE, self.DATA_SIZE, UC_PROT_READ | UC_PROT_WRITE)

        # 初始化栈
        self.mu.reg_write(UC_X86_REG_ESP, self.STACK_BASE - 0x1000)
        self.mu.reg_write(UC_X86_REG_EBP, self.STACK_BASE - 0x1000)

    def _setup_hooks(self):
        """设置Hook"""
        self.mu.hook_add(UC_HOOK_MEM_UNMAPPED, self._hook_unmapped)
        self.code_hook = None
        self.mem_hook = None

    def _hook_unmapped(self, mu, access, address, size, value, user_data):
        """未映射内存处理"""
        access_type = {UC_MEM_READ: "READ", UC_MEM_WRITE: "WRITE", UC_MEM_FETCH: "FETCH"}.get(access, "UNKNOWN")
        print(f"[!] Unmapped {access_type} at 0x{address:08x}, size={size}")

        page_start = address & ~0xFFF
        try:
            self.mu.mem_map(page_start, 0x1000, UC_PROT_ALL)
            print(f"[*] Auto-mapped page at 0x{page_start:08x}")
            return True
        except:
            return False

    def _hook_code(self, mu, address, size, user_data):
        """指令追踪"""
        self.instruction_count += 1
        code = mu.mem_read(address, size)

        for insn in self.cs.disasm(bytes(code), address):
            eax = mu.reg_read(UC_X86_REG_EAX)
            ebx = mu.reg_read(UC_X86_REG_EBX)
            ecx = mu.reg_read(UC_X86_REG_ECX)
            edx = mu.reg_read(UC_X86_REG_EDX)
            esp = mu.reg_read(UC_X86_REG_ESP)

            print(f"0x{address:08x}: {insn.mnemonic:8s} {insn.op_str:30s} | "
                  f"EAX=0x{eax:08x} EBX=0x{ebx:08x} ECX=0x{ecx:08x} EDX=0x{edx:08x} ESP=0x{esp:08x}")

    def enable_trace(self, enabled=True):
        """启用追踪"""
        self.trace_enabled = enabled
        if enabled and self.code_hook is None:
            self.code_hook = self.mu.hook_add(UC_HOOK_CODE, self._hook_code)
        elif not enabled and self.code_hook:
            self.mu.hook_del(self.code_hook)
            self.code_hook = None

    def load_binary(self, data, base=None):
        """加载二进制"""
        if base is None:
            base = self.CODE_BASE
        self.mu.mem_write(base, data)
        print(f"[*] Loaded {len(data)} bytes at 0x{base:08x}")

    def load_file(self, filepath, base=None):
        """加载文件"""
        with open(filepath, 'rb') as f:
            data = f.read()
        self.load_binary(data, base)
        return data

    def malloc(self, size):
        """内存分配"""
        size = (size + 7) & ~7
        addr = self.heap_ptr
        self.heap_ptr += size
        return addr

    def write_string(self, address, string):
        """写入字符串"""
        data = string.encode('utf-8') + b'\x00'
        self.mu.mem_write(address, data)

    def read_string(self, address, max_len=256):
        """读取字符串"""
        result = b''
        for i in range(max_len):
            byte = self.mu.mem_read(address + i, 1)
            if byte == b'\x00':
                break
            result += byte
        return result.decode('utf-8', errors='replace')

    def push(self, value):
        """压栈"""
        esp = self.mu.reg_read(UC_X86_REG_ESP) - 4
        self.mu.reg_write(UC_X86_REG_ESP, esp)
        self.mu.mem_write(esp, struct.pack('<I', value))

    def pop(self):
        """出栈"""
        esp = self.mu.reg_read(UC_X86_REG_ESP)
        value = struct.unpack('<I', self.mu.mem_read(esp, 4))[0]
        self.mu.reg_write(UC_X86_REG_ESP, esp + 4)
        return value

    def call(self, address, *args, timeout=0, count=0):
        """
        调用函数 (cdecl调用约定)
        参数从右到左压栈
        """
        # 参数压栈（从右到左）
        for arg in reversed(args):
            self.push(arg)

        # 压入返回地址
        self.push(0)

        print(f"[*] Calling function at 0x{address:08x}")
        print(f"[*] Arguments: {[hex(a) for a in args]}")

        try:
            self.instruction_count = 0
            self.mu.emu_start(address, 0, timeout=timeout, count=count)
        except UcError as e:
            if e.errno == UC_ERR_FETCH_UNMAPPED and self.mu.reg_read(UC_X86_REG_EIP) == 0:
                pass
            else:
                print(f"[-] Error: {e}")
                self.dump_state()
                raise

        result = self.mu.reg_read(UC_X86_REG_EAX)
        print(f"[*] Executed {self.instruction_count} instructions")
        print(f"[*] Return: 0x{result:08x} ({result})")

        return result

    def call_stdcall(self, address, *args, timeout=0, count=0):
        """stdcall调用约定（被调函数清理栈）"""
        return self.call(address, *args, timeout=timeout, count=count)

    def _get_registers(self):
        """获取寄存器"""
        return {
            'eax': self.mu.reg_read(UC_X86_REG_EAX),
            'ebx': self.mu.reg_read(UC_X86_REG_EBX),
            'ecx': self.mu.reg_read(UC_X86_REG_ECX),
            'edx': self.mu.reg_read(UC_X86_REG_EDX),
            'esi': self.mu.reg_read(UC_X86_REG_ESI),
            'edi': self.mu.reg_read(UC_X86_REG_EDI),
            'esp': self.mu.reg_read(UC_X86_REG_ESP),
            'ebp': self.mu.reg_read(UC_X86_REG_EBP),
            'eip': self.mu.reg_read(UC_X86_REG_EIP),
            'eflags': self.mu.reg_read(UC_X86_REG_EFLAGS),
        }

    def dump_state(self):
        """打印状态"""
        regs = self._get_registers()
        print("\n" + "=" * 60)
        print("CPU State (x86):")
        print("=" * 60)
        print(f"  EAX = 0x{regs['eax']:08x}    EBX = 0x{regs['ebx']:08x}")
        print(f"  ECX = 0x{regs['ecx']:08x}    EDX = 0x{regs['edx']:08x}")
        print(f"  ESI = 0x{regs['esi']:08x}    EDI = 0x{regs['edi']:08x}")
        print(f"  ESP = 0x{regs['esp']:08x}    EBP = 0x{regs['ebp']:08x}")
        print(f"  EIP = 0x{regs['eip']:08x}    EFLAGS = 0x{regs['eflags']:08x}")
        print("=" * 60)


class X64Emulator:
    """x86-64 (64位) CPU模拟器"""

    # 内存布局
    CODE_BASE = 0x400000
    CODE_SIZE = 0x1000000    # 16MB
    STACK_BASE = 0x7FFFFFFFE000
    STACK_SIZE = 0x100000    # 1MB
    HEAP_BASE = 0x10000000000
    HEAP_SIZE = 0x10000000   # 256MB
    DATA_BASE = 0x20000000000
    DATA_SIZE = 0x10000000   # 256MB

    def __init__(self):
        """初始化x64模拟器"""
        self.mu = Uc(UC_ARCH_X86, UC_MODE_64)
        self.cs = Cs(CS_ARCH_X86, CS_MODE_64)
        self.cs.detail = True

        self.heap_ptr = self.HEAP_BASE
        self.trace_enabled = False
        self.instruction_count = 0

        self._setup_memory()
        self._setup_hooks()

    def _setup_memory(self):
        """初始化内存"""
        self.mu.mem_map(self.CODE_BASE, self.CODE_SIZE, UC_PROT_READ | UC_PROT_EXEC)
        self.mu.mem_map(self.STACK_BASE - self.STACK_SIZE, self.STACK_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.HEAP_BASE, self.HEAP_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.DATA_BASE, self.DATA_SIZE, UC_PROT_READ | UC_PROT_WRITE)

        # 初始化栈（16字节对齐）
        self.mu.reg_write(UC_X86_REG_RSP, self.STACK_BASE - 0x1000)
        self.mu.reg_write(UC_X86_REG_RBP, self.STACK_BASE - 0x1000)

    def _setup_hooks(self):
        """设置Hook"""
        self.mu.hook_add(UC_HOOK_MEM_UNMAPPED, self._hook_unmapped)
        self.code_hook = None

    def _hook_unmapped(self, mu, access, address, size, value, user_data):
        """未映射内存处理"""
        print(f"[!] Unmapped access at 0x{address:016x}")
        page_start = address & ~0xFFF
        try:
            self.mu.mem_map(page_start, 0x1000, UC_PROT_ALL)
            return True
        except:
            return False

    def _hook_code(self, mu, address, size, user_data):
        """指令追踪"""
        self.instruction_count += 1
        code = mu.mem_read(address, size)

        for insn in self.cs.disasm(bytes(code), address):
            rax = mu.reg_read(UC_X86_REG_RAX)
            rdi = mu.reg_read(UC_X86_REG_RDI)
            rsi = mu.reg_read(UC_X86_REG_RSI)

            print(f"0x{address:016x}: {insn.mnemonic:8s} {insn.op_str:40s} | "
                  f"RAX=0x{rax:016x} RDI=0x{rdi:016x} RSI=0x{rsi:016x}")

    def enable_trace(self, enabled=True):
        """启用追踪"""
        self.trace_enabled = enabled
        if enabled and self.code_hook is None:
            self.code_hook = self.mu.hook_add(UC_HOOK_CODE, self._hook_code)
        elif not enabled and self.code_hook:
            self.mu.hook_del(self.code_hook)
            self.code_hook = None

    def load_binary(self, data, base=None):
        """加载二进制"""
        if base is None:
            base = self.CODE_BASE
        self.mu.mem_write(base, data)
        print(f"[*] Loaded {len(data)} bytes at 0x{base:016x}")

    def load_file(self, filepath, base=None):
        """加载文件"""
        with open(filepath, 'rb') as f:
            data = f.read()
        self.load_binary(data, base)
        return data

    def malloc(self, size):
        """内存分配"""
        size = (size + 15) & ~15
        addr = self.heap_ptr
        self.heap_ptr += size
        return addr

    def write_string(self, address, string):
        """写入字符串"""
        data = string.encode('utf-8') + b'\x00'
        self.mu.mem_write(address, data)

    def read_string(self, address, max_len=256):
        """读取字符串"""
        result = b''
        for i in range(max_len):
            byte = self.mu.mem_read(address + i, 1)
            if byte == b'\x00':
                break
            result += byte
        return result.decode('utf-8', errors='replace')

    def push(self, value):
        """压栈"""
        rsp = self.mu.reg_read(UC_X86_REG_RSP) - 8
        self.mu.reg_write(UC_X86_REG_RSP, rsp)
        self.mu.mem_write(rsp, struct.pack('<Q', value))

    def pop(self):
        """出栈"""
        rsp = self.mu.reg_read(UC_X86_REG_RSP)
        value = struct.unpack('<Q', self.mu.mem_read(rsp, 8))[0]
        self.mu.reg_write(UC_X86_REG_RSP, rsp + 8)
        return value

    def call(self, address, *args, timeout=0, count=0):
        """
        调用函数 (System V AMD64 ABI)
        前6个参数: RDI, RSI, RDX, RCX, R8, R9
        其余通过栈传递
        """
        # 参数寄存器
        arg_regs = [
            UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX,
            UC_X86_REG_RCX, UC_X86_REG_R8, UC_X86_REG_R9
        ]

        for i, arg in enumerate(args):
            if i < 6:
                self.mu.reg_write(arg_regs[i], arg)
            else:
                self.push(arg)

        # 压入返回地址
        self.push(0)

        print(f"[*] Calling function at 0x{address:016x}")
        print(f"[*] Arguments: {[hex(a) for a in args]}")

        try:
            self.instruction_count = 0
            self.mu.emu_start(address, 0, timeout=timeout, count=count)
        except UcError as e:
            if e.errno == UC_ERR_FETCH_UNMAPPED and self.mu.reg_read(UC_X86_REG_RIP) == 0:
                pass
            else:
                print(f"[-] Error: {e}")
                self.dump_state()
                raise

        result = self.mu.reg_read(UC_X86_REG_RAX)
        print(f"[*] Executed {self.instruction_count} instructions")
        print(f"[*] Return: 0x{result:016x} ({result})")

        return result

    def call_windows(self, address, *args, timeout=0, count=0):
        """
        Windows x64调用约定
        前4个参数: RCX, RDX, R8, R9
        """
        arg_regs = [UC_X86_REG_RCX, UC_X86_REG_RDX, UC_X86_REG_R8, UC_X86_REG_R9]

        # Shadow space
        rsp = self.mu.reg_read(UC_X86_REG_RSP)
        self.mu.reg_write(UC_X86_REG_RSP, rsp - 32)

        for i, arg in enumerate(args):
            if i < 4:
                self.mu.reg_write(arg_regs[i], arg)
            else:
                self.push(arg)

        self.push(0)

        try:
            self.mu.emu_start(address, 0, timeout=timeout, count=count)
        except UcError as e:
            if not (e.errno == UC_ERR_FETCH_UNMAPPED and self.mu.reg_read(UC_X86_REG_RIP) == 0):
                raise

        return self.mu.reg_read(UC_X86_REG_RAX)

    def _get_registers(self):
        """获取寄存器"""
        return {
            'rax': self.mu.reg_read(UC_X86_REG_RAX),
            'rbx': self.mu.reg_read(UC_X86_REG_RBX),
            'rcx': self.mu.reg_read(UC_X86_REG_RCX),
            'rdx': self.mu.reg_read(UC_X86_REG_RDX),
            'rsi': self.mu.reg_read(UC_X86_REG_RSI),
            'rdi': self.mu.reg_read(UC_X86_REG_RDI),
            'rsp': self.mu.reg_read(UC_X86_REG_RSP),
            'rbp': self.mu.reg_read(UC_X86_REG_RBP),
            'r8': self.mu.reg_read(UC_X86_REG_R8),
            'r9': self.mu.reg_read(UC_X86_REG_R9),
            'r10': self.mu.reg_read(UC_X86_REG_R10),
            'r11': self.mu.reg_read(UC_X86_REG_R11),
            'r12': self.mu.reg_read(UC_X86_REG_R12),
            'r13': self.mu.reg_read(UC_X86_REG_R13),
            'r14': self.mu.reg_read(UC_X86_REG_R14),
            'r15': self.mu.reg_read(UC_X86_REG_R15),
            'rip': self.mu.reg_read(UC_X86_REG_RIP),
            'rflags': self.mu.reg_read(UC_X86_REG_EFLAGS),
        }

    def dump_state(self):
        """打印状态"""
        regs = self._get_registers()
        print("\n" + "=" * 80)
        print("CPU State (x86-64):")
        print("=" * 80)
        print(f"  RAX = 0x{regs['rax']:016x}    RBX = 0x{regs['rbx']:016x}")
        print(f"  RCX = 0x{regs['rcx']:016x}    RDX = 0x{regs['rdx']:016x}")
        print(f"  RSI = 0x{regs['rsi']:016x}    RDI = 0x{regs['rdi']:016x}")
        print(f"  RSP = 0x{regs['rsp']:016x}    RBP = 0x{regs['rbp']:016x}")
        print(f"  R8  = 0x{regs['r8']:016x}    R9  = 0x{regs['r9']:016x}")
        print(f"  R10 = 0x{regs['r10']:016x}    R11 = 0x{regs['r11']:016x}")
        print(f"  R12 = 0x{regs['r12']:016x}    R13 = 0x{regs['r13']:016x}")
        print(f"  R14 = 0x{regs['r14']:016x}    R15 = 0x{regs['r15']:016x}")
        print(f"  RIP = 0x{regs['rip']:016x}    RFLAGS = 0x{regs['rflags']:016x}")
        print("=" * 80)


def demo_x86():
    """x86演示"""
    print("=" * 60)
    print("x86 Emulator Demo")
    print("=" * 60)

    emu = X86Emulator()

    # ADD EAX, EBX; RET
    code = bytes([
        0x01, 0xD8,  # ADD EAX, EBX
        0xC3,        # RET
    ])

    emu.load_binary(code)
    emu.mu.reg_write(UC_X86_REG_EAX, 100)
    emu.mu.reg_write(UC_X86_REG_EBX, 200)

    emu.enable_trace(True)

    # 直接执行，不通过call
    emu.push(0)  # 返回地址
    try:
        emu.mu.emu_start(emu.CODE_BASE, 0)
    except:
        pass

    result = emu.mu.reg_read(UC_X86_REG_EAX)
    print(f"\n100 + 200 = {result}")


def demo_x64():
    """x64演示"""
    print("\n" + "=" * 60)
    print("x86-64 Emulator Demo")
    print("=" * 60)

    emu = X64Emulator()

    # 示例：计算两数之和
    # MOV RAX, RDI
    # ADD RAX, RSI
    # RET
    code = bytes([
        0x48, 0x89, 0xF8,        # MOV RAX, RDI
        0x48, 0x01, 0xF0,        # ADD RAX, RSI
        0xC3,                     # RET
    ])

    emu.load_binary(code)
    emu.enable_trace(True)

    result = emu.call(emu.CODE_BASE, 1000, 2000)
    print(f"\n1000 + 2000 = {result}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python x86_emulator.py [--x64] <binary_file> <function_offset> [args...]")
        print("\nRunning demo...")
        demo_x86()
        demo_x64()
    else:
        is_64bit = False
        args_start = 1

        if sys.argv[1] == '--x64':
            is_64bit = True
            args_start = 2

        binary_file = sys.argv[args_start]
        func_offset = int(sys.argv[args_start + 1], 0)
        call_args = [int(a, 0) for a in sys.argv[args_start + 2:]]

        if is_64bit:
            emu = X64Emulator()
        else:
            emu = X86Emulator()

        emu.load_file(binary_file)
        emu.enable_trace(True)

        result = emu.call(emu.CODE_BASE + func_offset, *call_args)
        print(f"\nResult: 0x{result:x} ({result})")
