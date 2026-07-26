#!/usr/bin/env python3
"""
Android SO Unicorn Emulator
用于模拟执行Android .so库中的函数

特性:
- 自动解析ELF文件
- JNI环境模拟
- 常用libc函数模拟
- 支持ARM和ARM64

使用方法:
    python android_so_emulator.py <so_file> <function_name> [args...]

示例:
    python android_so_emulator.py libsign.so sign "test_data" 9
"""

from unicorn import *
from unicorn.arm_const import *
from unicorn.arm64_const import *
from capstone import *
import struct
import sys
import os

try:
    import lief
    HAS_LIEF = True
except ImportError:
    HAS_LIEF = False
    print("[!] lief not installed. Install with: pip install lief")


class JNIEnv:
    """模拟JNI环境"""

    def __init__(self, emulator):
        self.emu = emulator
        self.strings = {}  # 字符串引用表
        self.string_counter = 0x1000
        self.objects = {}  # 对象引用表
        self.object_counter = 0x2000

        # JNI函数表
        self.jni_functions = {
            # 版本相关
            0: self._GetVersion,
            # 类操作
            6: self._FindClass,
            # 方法操作
            33: self._GetMethodID,
            36: self._CallObjectMethod,
            49: self._CallVoidMethod,
            # 字段操作
            94: self._GetFieldID,
            95: self._GetObjectField,
            # 字符串操作
            167: self._NewStringUTF,
            169: self._GetStringUTFLength,
            170: self._GetStringUTFChars,
            172: self._ReleaseStringUTFChars,
            # 数组操作
            171: self._GetArrayLength,
            184: self._GetByteArrayElements,
            185: self._GetCharArrayElements,
            192: self._ReleaseByteArrayElements,
            # 其他
            214: self._GetJavaVM,
        }

    def handle_jni_call(self, func_index):
        """处理JNI调用"""
        if func_index in self.jni_functions:
            return self.jni_functions[func_index]()
        else:
            print(f"[JNI] Unimplemented function index: {func_index}")
            return 0

    def _GetVersion(self):
        print("[JNI] GetVersion()")
        return 0x00010006  # JNI_VERSION_1_6

    def _FindClass(self):
        # 从寄存器获取类名
        print("[JNI] FindClass()")
        return self.object_counter  # 返回一个假的类引用

    def _GetMethodID(self):
        print("[JNI] GetMethodID()")
        return 0x12345678

    def _CallObjectMethod(self):
        print("[JNI] CallObjectMethod()")
        return 0

    def _CallVoidMethod(self):
        print("[JNI] CallVoidMethod()")
        return 0

    def _GetFieldID(self):
        print("[JNI] GetFieldID()")
        return 0x87654321

    def _GetObjectField(self):
        print("[JNI] GetObjectField()")
        return 0

    def _NewStringUTF(self):
        print("[JNI] NewStringUTF()")
        self.string_counter += 1
        return self.string_counter

    def _GetStringUTFLength(self):
        print("[JNI] GetStringUTFLength()")
        return 0

    def _GetStringUTFChars(self):
        print("[JNI] GetStringUTFChars()")
        return 0

    def _ReleaseStringUTFChars(self):
        print("[JNI] ReleaseStringUTFChars()")
        return 0

    def _GetArrayLength(self):
        print("[JNI] GetArrayLength()")
        return 0

    def _GetByteArrayElements(self):
        print("[JNI] GetByteArrayElements()")
        return 0

    def _GetCharArrayElements(self):
        print("[JNI] GetCharArrayElements()")
        return 0

    def _ReleaseByteArrayElements(self):
        print("[JNI] ReleaseByteArrayElements()")
        return 0

    def _GetJavaVM(self):
        print("[JNI] GetJavaVM()")
        return 0


class LibcEmulator:
    """模拟常用libc函数"""

    def __init__(self, emulator):
        self.emu = emulator
        self.heap_ptr = 0xB0000000

        # 函数映射
        self.functions = {
            'malloc': self._malloc,
            'free': self._free,
            'calloc': self._calloc,
            'realloc': self._realloc,
            'memcpy': self._memcpy,
            'memset': self._memset,
            'memmove': self._memmove,
            'memcmp': self._memcmp,
            'strlen': self._strlen,
            'strcpy': self._strcpy,
            'strncpy': self._strncpy,
            'strcmp': self._strcmp,
            'strncmp': self._strncmp,
            'strcat': self._strcat,
            'sprintf': self._sprintf,
            'snprintf': self._snprintf,
            'printf': self._printf,
            'puts': self._puts,
            '__android_log_print': self._android_log_print,
            'time': self._time,
            'rand': self._rand,
            'srand': self._srand,
        }

    def handle_call(self, func_name):
        """处理libc调用"""
        if func_name in self.functions:
            return self.functions[func_name]()
        else:
            print(f"[libc] Unimplemented: {func_name}")
            return 0

    def _malloc(self):
        size = self.emu.get_arg(0)
        addr = self.heap_ptr
        self.heap_ptr += (size + 15) & ~15
        print(f"[libc] malloc({size}) = 0x{addr:x}")
        return addr

    def _free(self):
        ptr = self.emu.get_arg(0)
        print(f"[libc] free(0x{ptr:x})")
        return 0

    def _calloc(self):
        nmemb = self.emu.get_arg(0)
        size = self.emu.get_arg(1)
        total = nmemb * size
        addr = self.heap_ptr
        self.heap_ptr += (total + 15) & ~15
        # 清零
        self.emu.mu.mem_write(addr, b'\x00' * total)
        print(f"[libc] calloc({nmemb}, {size}) = 0x{addr:x}")
        return addr

    def _realloc(self):
        ptr = self.emu.get_arg(0)
        size = self.emu.get_arg(1)
        addr = self.heap_ptr
        self.heap_ptr += (size + 15) & ~15
        print(f"[libc] realloc(0x{ptr:x}, {size}) = 0x{addr:x}")
        return addr

    def _memcpy(self):
        dst = self.emu.get_arg(0)
        src = self.emu.get_arg(1)
        n = self.emu.get_arg(2)
        data = self.emu.mu.mem_read(src, n)
        self.emu.mu.mem_write(dst, bytes(data))
        print(f"[libc] memcpy(0x{dst:x}, 0x{src:x}, {n})")
        return dst

    def _memset(self):
        s = self.emu.get_arg(0)
        c = self.emu.get_arg(1) & 0xFF
        n = self.emu.get_arg(2)
        self.emu.mu.mem_write(s, bytes([c]) * n)
        print(f"[libc] memset(0x{s:x}, 0x{c:02x}, {n})")
        return s

    def _memmove(self):
        return self._memcpy()

    def _memcmp(self):
        s1 = self.emu.get_arg(0)
        s2 = self.emu.get_arg(1)
        n = self.emu.get_arg(2)
        data1 = bytes(self.emu.mu.mem_read(s1, n))
        data2 = bytes(self.emu.mu.mem_read(s2, n))
        if data1 < data2:
            return -1
        elif data1 > data2:
            return 1
        return 0

    def _strlen(self):
        s = self.emu.get_arg(0)
        length = 0
        while True:
            byte = self.emu.mu.mem_read(s + length, 1)
            if byte == b'\x00':
                break
            length += 1
        print(f"[libc] strlen(0x{s:x}) = {length}")
        return length

    def _strcpy(self):
        dst = self.emu.get_arg(0)
        src = self.emu.get_arg(1)
        # 读取源字符串
        s = b''
        offset = 0
        while True:
            byte = self.emu.mu.mem_read(src + offset, 1)
            s += byte
            if byte == b'\x00':
                break
            offset += 1
        self.emu.mu.mem_write(dst, s)
        print(f"[libc] strcpy(0x{dst:x}, 0x{src:x})")
        return dst

    def _strncpy(self):
        dst = self.emu.get_arg(0)
        src = self.emu.get_arg(1)
        n = self.emu.get_arg(2)
        data = bytes(self.emu.mu.mem_read(src, n))
        self.emu.mu.mem_write(dst, data)
        return dst

    def _strcmp(self):
        s1 = self.emu.get_arg(0)
        s2 = self.emu.get_arg(1)
        str1 = self.emu.read_string(s1)
        str2 = self.emu.read_string(s2)
        if str1 < str2:
            return -1
        elif str1 > str2:
            return 1
        return 0

    def _strncmp(self):
        s1 = self.emu.get_arg(0)
        s2 = self.emu.get_arg(1)
        n = self.emu.get_arg(2)
        str1 = self.emu.read_string(s1)[:n]
        str2 = self.emu.read_string(s2)[:n]
        if str1 < str2:
            return -1
        elif str1 > str2:
            return 1
        return 0

    def _strcat(self):
        dst = self.emu.get_arg(0)
        src = self.emu.get_arg(1)
        print(f"[libc] strcat(0x{dst:x}, 0x{src:x})")
        return dst

    def _sprintf(self):
        print("[libc] sprintf(...)")
        return 0

    def _snprintf(self):
        print("[libc] snprintf(...)")
        return 0

    def _printf(self):
        fmt_addr = self.emu.get_arg(0)
        fmt = self.emu.read_string(fmt_addr)
        print(f"[printf] {fmt}")
        return 0

    def _puts(self):
        s = self.emu.get_arg(0)
        string = self.emu.read_string(s)
        print(f"[puts] {string}")
        return 0

    def _android_log_print(self):
        prio = self.emu.get_arg(0)
        tag_addr = self.emu.get_arg(1)
        fmt_addr = self.emu.get_arg(2)
        tag = self.emu.read_string(tag_addr)
        fmt = self.emu.read_string(fmt_addr)
        print(f"[LOG:{prio}] {tag}: {fmt}")
        return 0

    def _time(self):
        import time
        return int(time.time())

    def _rand(self):
        import random
        return random.randint(0, 0x7FFFFFFF)

    def _srand(self):
        return 0


class AndroidSOEmulator:
    """Android SO模拟器"""

    # 内存布局
    SO_BASE = 0x10000000
    SO_SIZE = 0x10000000    # 256MB
    STACK_BASE = 0x80000000
    STACK_SIZE = 0x100000   # 1MB
    HEAP_BASE = 0xB0000000
    HEAP_SIZE = 0x10000000  # 256MB
    JNI_ENV_BASE = 0xC0000000
    LIBC_BASE = 0xD0000000

    def __init__(self, so_path, is_64bit=False):
        """
        初始化

        Args:
            so_path: SO文件路径
            is_64bit: 是否为64位
        """
        self.so_path = so_path
        self.is_64bit = is_64bit
        self.symbols = {}
        self.plt_symbols = {}
        self.instruction_count = 0

        if is_64bit:
            self.mu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
            self.cs = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
            self.ptr_size = 8
            self.REG_PC = UC_ARM64_REG_PC
            self.REG_SP = UC_ARM64_REG_SP
            self.REG_LR = UC_ARM64_REG_LR
            self.REG_RET = UC_ARM64_REG_X0
            self.ARG_REGS = [
                UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3,
                UC_ARM64_REG_X4, UC_ARM64_REG_X5, UC_ARM64_REG_X6, UC_ARM64_REG_X7
            ]
        else:
            self.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
            self.cs = Cs(CS_ARCH_ARM, CS_MODE_ARM)
            self.ptr_size = 4
            self.REG_PC = UC_ARM_REG_PC
            self.REG_SP = UC_ARM_REG_SP
            self.REG_LR = UC_ARM_REG_LR
            self.REG_RET = UC_ARM_REG_R0
            self.ARG_REGS = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3]

        self.cs.detail = True

        # 初始化组件
        self.jni = JNIEnv(self)
        self.libc = LibcEmulator(self)

        self._setup_memory()
        self._setup_hooks()
        self._load_so()

    def _setup_memory(self):
        """初始化内存"""
        self.mu.mem_map(self.SO_BASE, self.SO_SIZE, UC_PROT_ALL)
        self.mu.mem_map(self.STACK_BASE - self.STACK_SIZE, self.STACK_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.HEAP_BASE, self.HEAP_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.JNI_ENV_BASE, 0x10000, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.LIBC_BASE, 0x10000, UC_PROT_READ | UC_PROT_EXEC)

        # 初始化栈
        self.mu.reg_write(self.REG_SP, self.STACK_BASE - 0x1000)

        # 初始化JNI环境
        self._setup_jni_env()

    def _setup_jni_env(self):
        """设置JNI环境结构"""
        # 创建JNI函数表
        jni_func_table = self.JNI_ENV_BASE + 0x1000

        # 写入函数指针（每个指向libc区域的不同位置）
        for i in range(256):
            func_addr = self.LIBC_BASE + 0x1000 + i * 4
            if self.is_64bit:
                self.mu.mem_write(jni_func_table + i * 8, struct.pack('<Q', func_addr))
            else:
                self.mu.mem_write(jni_func_table + i * 4, struct.pack('<I', func_addr))

        # JNIEnv* 指向函数表指针
        if self.is_64bit:
            self.mu.mem_write(self.JNI_ENV_BASE, struct.pack('<Q', jni_func_table))
        else:
            self.mu.mem_write(self.JNI_ENV_BASE, struct.pack('<I', jni_func_table))

    def _setup_hooks(self):
        """设置Hook"""
        self.mu.hook_add(UC_HOOK_MEM_UNMAPPED, self._hook_unmapped)
        self.mu.hook_add(UC_HOOK_CODE, self._hook_code, begin=self.LIBC_BASE, end=self.LIBC_BASE + 0x10000)
        self.code_trace_hook = None

    def _hook_unmapped(self, mu, access, address, size, value, user_data):
        """未映射内存处理"""
        access_type = {UC_MEM_READ: "READ", UC_MEM_WRITE: "WRITE", UC_MEM_FETCH: "FETCH"}.get(access, "?")
        print(f"[!] Unmapped {access_type} at 0x{address:08x}")

        page_start = address & ~0xFFF
        try:
            self.mu.mem_map(page_start, 0x1000, UC_PROT_ALL)
            return True
        except:
            return False

    def _hook_code(self, mu, address, size, user_data):
        """LIBC区域的代码执行Hook（用于模拟libc函数）"""
        # 检查是否是libc函数调用
        offset = address - self.LIBC_BASE - 0x1000
        if 0 <= offset < 256 * 4:
            func_index = offset // 4
            if address in self.plt_symbols:
                func_name = self.plt_symbols[address]
                result = self.libc.handle_call(func_name)
            else:
                # 可能是JNI调用
                result = self.jni.handle_jni_call(func_index)

            # 设置返回值并返回
            self.mu.reg_write(self.REG_RET, result & (0xFFFFFFFFFFFFFFFF if self.is_64bit else 0xFFFFFFFF))

            # 返回到调用者
            lr = self.mu.reg_read(self.REG_LR)
            self.mu.reg_write(self.REG_PC, lr)

    def _hook_code_trace(self, mu, address, size, user_data):
        """指令追踪Hook"""
        self.instruction_count += 1
        code = mu.mem_read(address, size)

        for insn in self.cs.disasm(bytes(code), address):
            print(f"0x{address:08x}: {insn.mnemonic:8s} {insn.op_str}")

    def _load_so(self):
        """加载SO文件"""
        if not HAS_LIEF:
            print("[!] Loading raw binary (lief not available)")
            with open(self.so_path, 'rb') as f:
                data = f.read()
            self.mu.mem_write(self.SO_BASE, data)
            return

        print(f"[*] Loading SO: {self.so_path}")
        binary = lief.parse(self.so_path)

        if binary is None:
            raise Exception(f"Failed to parse: {self.so_path}")

        # 检测架构
        if binary.header.machine_type == lief.ELF.ARCH.AARCH64:
            if not self.is_64bit:
                print("[!] Warning: SO is ARM64 but emulator is 32-bit")
        elif binary.header.machine_type == lief.ELF.ARCH.ARM:
            if self.is_64bit:
                print("[!] Warning: SO is ARM32 but emulator is 64-bit")

        # 加载段
        for segment in binary.segments:
            if segment.type == lief.ELF.SEGMENT_TYPES.LOAD:
                addr = self.SO_BASE + segment.virtual_address
                data = bytes(segment.content)
                if len(data) > 0:
                    self.mu.mem_write(addr, data)
                    print(f"[*] Loaded segment at 0x{addr:08x}, size={len(data)}")

        # 解析符号
        for sym in binary.symbols:
            if sym.value != 0:
                addr = self.SO_BASE + sym.value
                self.symbols[sym.name] = addr
                # print(f"[*] Symbol: {sym.name} @ 0x{addr:08x}")

        # 解析PLT（用于外部函数调用）
        for reloc in binary.relocations:
            if reloc.symbol and reloc.symbol.name:
                # 为每个导入函数创建跳转stub
                stub_addr = self.LIBC_BASE + 0x1000 + len(self.plt_symbols) * 4
                self.plt_symbols[stub_addr] = reloc.symbol.name

                # 在重定位地址写入stub地址
                addr = self.SO_BASE + reloc.address
                if self.is_64bit:
                    self.mu.mem_write(addr, struct.pack('<Q', stub_addr))
                else:
                    self.mu.mem_write(addr, struct.pack('<I', stub_addr))

        print(f"[*] Loaded {len(self.symbols)} symbols, {len(self.plt_symbols)} PLT entries")

    def get_symbol_address(self, name):
        """获取符号地址"""
        if name in self.symbols:
            return self.symbols[name]

        # 尝试模糊匹配
        for sym_name, addr in self.symbols.items():
            if name in sym_name:
                print(f"[*] Matched: {name} -> {sym_name} @ 0x{addr:08x}")
                return addr

        return None

    def get_arg(self, index):
        """获取函数参数"""
        if index < len(self.ARG_REGS):
            return self.mu.reg_read(self.ARG_REGS[index])
        else:
            # 从栈获取
            sp = self.mu.reg_read(self.REG_SP)
            offset = (index - len(self.ARG_REGS)) * self.ptr_size
            data = self.mu.mem_read(sp + offset, self.ptr_size)
            if self.is_64bit:
                return struct.unpack('<Q', data)[0]
            else:
                return struct.unpack('<I', data)[0]

    def set_arg(self, index, value):
        """设置函数参数"""
        if index < len(self.ARG_REGS):
            self.mu.reg_write(self.ARG_REGS[index], value)
        else:
            sp = self.mu.reg_read(self.REG_SP)
            offset = (index - len(self.ARG_REGS)) * self.ptr_size
            if self.is_64bit:
                self.mu.mem_write(sp + offset, struct.pack('<Q', value))
            else:
                self.mu.mem_write(sp + offset, struct.pack('<I', value))

    def read_string(self, address, max_len=1024):
        """读取字符串"""
        result = b''
        for i in range(max_len):
            byte = self.mu.mem_read(address + i, 1)
            if byte == b'\x00':
                break
            result += byte
        return result.decode('utf-8', errors='replace')

    def write_string(self, address, string):
        """写入字符串"""
        data = string.encode('utf-8') + b'\x00'
        self.mu.mem_write(address, data)
        return len(data)

    def malloc(self, size):
        """分配内存"""
        addr = self.libc.heap_ptr
        self.libc.heap_ptr += (size + 15) & ~15
        return addr

    def enable_trace(self, enabled=True):
        """启用指令追踪"""
        if enabled and self.code_trace_hook is None:
            self.code_trace_hook = self.mu.hook_add(
                UC_HOOK_CODE, self._hook_code_trace,
                begin=self.SO_BASE, end=self.SO_BASE + self.SO_SIZE
            )
        elif not enabled and self.code_trace_hook:
            self.mu.hook_del(self.code_trace_hook)
            self.code_trace_hook = None

    def call_function(self, func_name_or_addr, *args, timeout=10000000):
        """
        调用SO中的函数

        Args:
            func_name_or_addr: 函数名或地址
            args: 参数列表
            timeout: 超时时间（微秒）

        Returns:
            函数返回值
        """
        # 获取函数地址
        if isinstance(func_name_or_addr, str):
            func_addr = self.get_symbol_address(func_name_or_addr)
            if func_addr is None:
                raise Exception(f"Symbol not found: {func_name_or_addr}")
            print(f"[*] Function: {func_name_or_addr} @ 0x{func_addr:08x}")
        else:
            func_addr = func_name_or_addr

        # 设置参数
        for i, arg in enumerate(args):
            self.set_arg(i, arg)
            print(f"[*] Arg{i}: 0x{arg:x}")

        # 设置返回地址
        self.mu.reg_write(self.REG_LR, 0)

        print(f"[*] Starting emulation...")
        self.instruction_count = 0

        try:
            self.mu.emu_start(func_addr, 0, timeout=timeout)
        except UcError as e:
            pc = self.mu.reg_read(self.REG_PC)
            if e.errno == UC_ERR_FETCH_UNMAPPED and pc == 0:
                pass  # 正常返回
            else:
                print(f"[-] Emulation error at PC=0x{pc:08x}: {e}")
                raise

        result = self.mu.reg_read(self.REG_RET)
        print(f"[*] Executed {self.instruction_count} instructions")
        print(f"[*] Result: 0x{result:x} ({result})")

        return result

    def call_jni_function(self, func_name, jclass, *args):
        """
        调用JNI函数

        Args:
            func_name: 函数名
            jclass: jclass参数（通常为0）
            args: 其他参数
        """
        # JNI函数的前两个参数是JNIEnv*和jclass/jobject
        return self.call_function(
            func_name,
            self.JNI_ENV_BASE,  # JNIEnv*
            jclass,             # jclass
            *args
        )

    def dump_memory(self, address, size):
        """打印内存"""
        data = bytes(self.mu.mem_read(address, size))
        print(f"\nMemory at 0x{address:08x}:")
        for i in range(0, len(data), 16):
            hex_str = ' '.join(f'{b:02x}' for b in data[i:i+16])
            ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in data[i:i+16])
            print(f"  0x{address+i:08x}: {hex_str:48s} {ascii_str}")

    def list_symbols(self, pattern=None):
        """列出符号"""
        print("\n[*] Symbols:")
        for name, addr in sorted(self.symbols.items(), key=lambda x: x[1]):
            if pattern is None or pattern.lower() in name.lower():
                print(f"  0x{addr:08x}: {name}")


def main():
    if len(sys.argv) < 3:
        print("Usage: python android_so_emulator.py [--64] <so_file> <function_name> [args...]")
        print("\nExample:")
        print("  python android_so_emulator.py libsign.so sign 0xdeadbeef 16")
        print("  python android_so_emulator.py --64 libcrypto.so encrypt 0x12345678")
        sys.exit(1)

    is_64bit = False
    args_start = 1

    if sys.argv[1] == '--64':
        is_64bit = True
        args_start = 2

    so_file = sys.argv[args_start]
    func_name = sys.argv[args_start + 1]

    # 解析参数（支持十六进制和字符串）
    call_args = []
    for arg in sys.argv[args_start + 2:]:
        try:
            call_args.append(int(arg, 0))
        except ValueError:
            # 字符串参数 - 需要分配内存并写入
            print(f"[*] String argument: {arg}")
            # 暂时作为0处理，后续需要在调用前分配
            call_args.append(0)

    # 创建模拟器
    emu = AndroidSOEmulator(so_file, is_64bit)

    # 列出可用符号
    emu.list_symbols(func_name)

    # 启用追踪
    emu.enable_trace(True)

    # 调用函数
    try:
        result = emu.call_function(func_name, *call_args)
        print(f"\n[+] Function returned: 0x{result:x}")
    except Exception as e:
        print(f"\n[-] Error: {e}")


if __name__ == '__main__':
    main()
