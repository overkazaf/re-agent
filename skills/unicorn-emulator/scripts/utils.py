#!/usr/bin/env python3
"""
Unicorn Emulator Utilities
通用工具函数库

包含:
- ELF解析工具
- 反汇编工具
- 内存分析工具
- 数据转换工具
"""

from unicorn import *
from capstone import *
from keystone import *
import struct
import binascii
import os

try:
    import lief
    HAS_LIEF = True
except ImportError:
    HAS_LIEF = False


# ==========================================
# 数据转换工具
# ==========================================

def hex_to_bytes(hex_str):
    """十六进制字符串转字节"""
    hex_str = hex_str.replace(' ', '').replace('\n', '')
    if hex_str.startswith('0x'):
        hex_str = hex_str[2:]
    return binascii.unhexlify(hex_str)


def bytes_to_hex(data, sep=' '):
    """字节转十六进制字符串"""
    return sep.join(f'{b:02x}' for b in data)


def int_to_bytes(value, size, byteorder='little'):
    """整数转字节"""
    return value.to_bytes(size, byteorder=byteorder)


def bytes_to_int(data, byteorder='little'):
    """字节转整数"""
    return int.from_bytes(data, byteorder=byteorder)


def pack32(value):
    """打包32位小端整数"""
    return struct.pack('<I', value)


def pack64(value):
    """打包64位小端整数"""
    return struct.pack('<Q', value)


def unpack32(data):
    """解包32位小端整数"""
    return struct.unpack('<I', data)[0]


def unpack64(data):
    """解包64位小端整数"""
    return struct.unpack('<Q', data)[0]


# ==========================================
# 十六进制转储
# ==========================================

def hexdump(data, base_addr=0, width=16):
    """
    格式化的十六进制转储

    Args:
        data: 字节数据
        base_addr: 起始地址
        width: 每行字节数
    """
    lines = []
    for i in range(0, len(data), width):
        chunk = data[i:i+width]

        # 地址
        addr = f'{base_addr + i:08x}'

        # 十六进制
        hex_part = ' '.join(f'{b:02x}' for b in chunk)
        hex_part = hex_part.ljust(width * 3 - 1)

        # ASCII
        ascii_part = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)

        lines.append(f'{addr}  {hex_part}  |{ascii_part}|')

    return '\n'.join(lines)


def print_hexdump(data, base_addr=0, width=16):
    """打印十六进制转储"""
    print(hexdump(data, base_addr, width))


# ==========================================
# 反汇编工具
# ==========================================

class Disassembler:
    """反汇编器"""

    ARCHS = {
        'arm': (CS_ARCH_ARM, CS_MODE_ARM),
        'arm_thumb': (CS_ARCH_ARM, CS_MODE_THUMB),
        'arm64': (CS_ARCH_ARM64, CS_MODE_ARM),
        'x86': (CS_ARCH_X86, CS_MODE_32),
        'x64': (CS_ARCH_X86, CS_MODE_64),
        'mips': (CS_ARCH_MIPS, CS_MODE_MIPS32),
        'mips64': (CS_ARCH_MIPS, CS_MODE_MIPS64),
    }

    def __init__(self, arch='arm'):
        """初始化反汇编器"""
        if arch not in self.ARCHS:
            raise ValueError(f"Unsupported arch: {arch}. Available: {list(self.ARCHS.keys())}")

        cs_arch, cs_mode = self.ARCHS[arch]
        self.cs = Cs(cs_arch, cs_mode)
        self.cs.detail = True
        self.arch = arch

    def disasm(self, code, address=0, count=0):
        """反汇编代码"""
        instructions = list(self.cs.disasm(code, address, count))
        return instructions

    def disasm_one(self, code, address=0):
        """反汇编单条指令"""
        for insn in self.cs.disasm(code, address, 1):
            return insn
        return None

    def print_disasm(self, code, address=0, count=0):
        """打印反汇编结果"""
        for insn in self.disasm(code, address, count):
            print(f'0x{insn.address:08x}:  {insn.mnemonic:8s} {insn.op_str}')


# ==========================================
# 汇编工具
# ==========================================

class Assembler:
    """汇编器"""

    ARCHS = {
        'arm': (KS_ARCH_ARM, KS_MODE_ARM),
        'arm_thumb': (KS_ARCH_ARM, KS_MODE_THUMB),
        'arm64': (KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN),
        'x86': (KS_ARCH_X86, KS_MODE_32),
        'x64': (KS_ARCH_X86, KS_MODE_64),
    }

    def __init__(self, arch='arm'):
        """初始化汇编器"""
        if arch not in self.ARCHS:
            raise ValueError(f"Unsupported arch: {arch}")

        ks_arch, ks_mode = self.ARCHS[arch]
        self.ks = Ks(ks_arch, ks_mode)
        self.arch = arch

    def asm(self, code, address=0):
        """汇编代码"""
        try:
            encoding, count = self.ks.asm(code, address)
            return bytes(encoding)
        except KsError as e:
            print(f"Assembler error: {e}")
            return None

    def asm_lines(self, lines, address=0):
        """汇编多行代码"""
        result = b''
        current_addr = address

        for line in lines:
            line = line.strip()
            if not line or line.startswith(';') or line.startswith('#'):
                continue

            encoded = self.asm(line, current_addr)
            if encoded:
                result += encoded
                current_addr += len(encoded)

        return result


# ==========================================
# ELF解析工具
# ==========================================

class ELFParser:
    """ELF文件解析器"""

    def __init__(self, filepath):
        """初始化"""
        if not HAS_LIEF:
            raise ImportError("lief library required: pip install lief")

        self.filepath = filepath
        self.binary = lief.parse(filepath)

        if self.binary is None:
            raise Exception(f"Failed to parse: {filepath}")

    @property
    def is_64bit(self):
        """是否为64位"""
        return self.binary.header.identity_class == lief.ELF.ELF_CLASS.CLASS64

    @property
    def arch(self):
        """获取架构"""
        arch_map = {
            lief.ELF.ARCH.ARM: 'arm',
            lief.ELF.ARCH.AARCH64: 'arm64',
            lief.ELF.ARCH.i386: 'x86',
            lief.ELF.ARCH.x86_64: 'x64',
            lief.ELF.ARCH.MIPS: 'mips',
        }
        return arch_map.get(self.binary.header.machine_type, 'unknown')

    @property
    def entry_point(self):
        """入口点"""
        return self.binary.entrypoint

    def get_symbols(self):
        """获取所有符号"""
        symbols = {}
        for sym in self.binary.symbols:
            if sym.value != 0:
                symbols[sym.name] = sym.value
        return symbols

    def get_symbol(self, name):
        """获取指定符号的地址"""
        for sym in self.binary.symbols:
            if sym.name == name and sym.value != 0:
                return sym.value
        return None

    def get_functions(self):
        """获取所有函数"""
        functions = {}
        for sym in self.binary.symbols:
            if sym.type == lief.ELF.SYMBOL_TYPES.FUNC and sym.value != 0:
                functions[sym.name] = {
                    'address': sym.value,
                    'size': sym.size
                }
        return functions

    def get_sections(self):
        """获取所有段"""
        sections = []
        for section in self.binary.sections:
            sections.append({
                'name': section.name,
                'address': section.virtual_address,
                'size': section.size,
                'type': str(section.type)
            })
        return sections

    def get_segment_data(self, index=0):
        """获取指定段的数据"""
        segments = list(self.binary.segments)
        if index < len(segments):
            return bytes(segments[index].content)
        return None

    def read_code(self):
        """读取代码段"""
        for segment in self.binary.segments:
            if segment.type == lief.ELF.SEGMENT_TYPES.LOAD:
                if segment.flags & lief.ELF.SEGMENT_FLAGS.X:
                    return bytes(segment.content), segment.virtual_address
        return None, 0

    def print_info(self):
        """打印ELF信息"""
        print(f"File: {self.filepath}")
        print(f"Architecture: {self.arch}")
        print(f"64-bit: {self.is_64bit}")
        print(f"Entry point: 0x{self.entry_point:x}")
        print(f"\nSections:")
        for sec in self.get_sections():
            print(f"  {sec['name']:20s} 0x{sec['address']:08x} ({sec['size']} bytes)")


# ==========================================
# 内存管理工具
# ==========================================

class MemoryManager:
    """内存管理器"""

    def __init__(self, mu):
        """初始化"""
        self.mu = mu
        self.allocations = {}
        self.next_addr = 0xB0000000

    def alloc(self, size, prot=UC_PROT_ALL):
        """分配内存"""
        # 对齐到页边界
        aligned_size = (size + 0xFFF) & ~0xFFF
        addr = self.next_addr

        try:
            self.mu.mem_map(addr, aligned_size, prot)
            self.allocations[addr] = {
                'size': size,
                'aligned_size': aligned_size
            }
            self.next_addr += aligned_size
            return addr
        except UcError as e:
            print(f"Memory allocation failed: {e}")
            return 0

    def free(self, addr):
        """释放内存"""
        if addr in self.allocations:
            info = self.allocations[addr]
            try:
                self.mu.mem_unmap(addr, info['aligned_size'])
                del self.allocations[addr]
                return True
            except:
                pass
        return False

    def write(self, addr, data):
        """写入数据"""
        self.mu.mem_write(addr, data)

    def read(self, addr, size):
        """读取数据"""
        return bytes(self.mu.mem_read(addr, size))

    def write_string(self, addr, string, encoding='utf-8'):
        """写入字符串"""
        data = string.encode(encoding) + b'\x00'
        self.write(addr, data)
        return len(data)

    def read_string(self, addr, max_len=1024):
        """读取字符串"""
        result = b''
        for i in range(max_len):
            byte = self.read(addr + i, 1)
            if byte == b'\x00':
                break
            result += byte
        return result.decode('utf-8', errors='replace')


# ==========================================
# 调试工具
# ==========================================

class Debugger:
    """简易调试器"""

    def __init__(self, mu, cs):
        """初始化"""
        self.mu = mu
        self.cs = cs
        self.breakpoints = set()
        self.watchpoints = {}
        self.step_mode = False

    def add_breakpoint(self, address):
        """添加断点"""
        self.breakpoints.add(address)
        print(f"[BP] Breakpoint set at 0x{address:08x}")

    def remove_breakpoint(self, address):
        """移除断点"""
        self.breakpoints.discard(address)
        print(f"[BP] Breakpoint removed at 0x{address:08x}")

    def add_watchpoint(self, address, size, access='rw'):
        """添加内存监视点"""
        self.watchpoints[address] = {'size': size, 'access': access}
        print(f"[WP] Watchpoint set at 0x{address:08x} ({size} bytes, {access})")

    def check_breakpoint(self, address):
        """检查是否命中断点"""
        return address in self.breakpoints

    def check_watchpoint(self, address, size, is_write):
        """检查是否命中监视点"""
        for wp_addr, wp_info in self.watchpoints.items():
            if address >= wp_addr and address < wp_addr + wp_info['size']:
                if is_write and 'w' in wp_info['access']:
                    return True
                if not is_write and 'r' in wp_info['access']:
                    return True
        return False


# ==========================================
# 常用Shell Code
# ==========================================

class ShellCode:
    """常用Shell Code模板"""

    @staticmethod
    def arm_nop():
        """ARM NOP"""
        return bytes([0x00, 0xF0, 0x20, 0xE3])  # NOP

    @staticmethod
    def arm_thumb_nop():
        """ARM Thumb NOP"""
        return bytes([0x00, 0xBF])  # NOP

    @staticmethod
    def arm_ret():
        """ARM RET (BX LR)"""
        return bytes([0x1E, 0xFF, 0x2F, 0xE1])

    @staticmethod
    def arm64_nop():
        """ARM64 NOP"""
        return bytes([0x1F, 0x20, 0x03, 0xD5])

    @staticmethod
    def arm64_ret():
        """ARM64 RET"""
        return bytes([0xC0, 0x03, 0x5F, 0xD6])

    @staticmethod
    def x86_nop():
        """x86 NOP"""
        return bytes([0x90])

    @staticmethod
    def x86_ret():
        """x86 RET"""
        return bytes([0xC3])

    @staticmethod
    def x64_nop():
        """x64 NOP"""
        return bytes([0x90])

    @staticmethod
    def x64_ret():
        """x64 RET"""
        return bytes([0xC3])


# ==========================================
# 签名常量检测
# ==========================================

class CryptoDetector:
    """加密算法常量检测"""

    # AES S-Box (前16字节)
    AES_SBOX = bytes([
        0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5,
        0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76
    ])

    # MD5初始常量
    MD5_INIT = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]

    # SHA1初始常量
    SHA1_INIT = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]

    # SHA256初始常量
    SHA256_INIT = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]

    @classmethod
    def detect(cls, data):
        """检测数据中的加密常量"""
        detected = []

        # 检测AES S-Box
        if cls.AES_SBOX in data:
            detected.append('AES (S-Box found)')

        # 检测MD5
        for const in cls.MD5_INIT:
            if pack32(const) in data:
                detected.append(f'MD5 (constant 0x{const:08x})')
                break

        # 检测SHA1
        for const in cls.SHA1_INIT:
            if pack32(const) in data:
                detected.append(f'SHA1 (constant 0x{const:08x})')
                break

        # 检测SHA256
        for const in cls.SHA256_INIT:
            if pack32(const) in data:
                detected.append(f'SHA256 (constant 0x{const:08x})')
                break

        return detected


# ==========================================
# 测试
# ==========================================

if __name__ == '__main__':
    print("Unicorn Emulator Utilities")
    print("=" * 40)

    # 测试十六进制转换
    print("\n[Test] Hex conversion:")
    data = b"Hello"
    print(f"  bytes_to_hex: {bytes_to_hex(data)}")
    print(f"  hex_to_bytes: {hex_to_bytes('48 65 6c 6c 6f')}")

    # 测试反汇编
    print("\n[Test] Disassembly (ARM):")
    disasm = Disassembler('arm')
    code = bytes([0x01, 0x00, 0x80, 0xE0])  # ADD R0, R0, R1
    disasm.print_disasm(code)

    # 测试汇编
    print("\n[Test] Assembly (ARM):")
    asm = Assembler('arm')
    result = asm.asm("ADD R0, R0, R1")
    if result:
        print(f"  Assembled: {bytes_to_hex(result)}")

    # 测试hexdump
    print("\n[Test] Hexdump:")
    print_hexdump(b"Hello World! This is a test message.", 0x1000)

    # 测试加密检测
    print("\n[Test] Crypto detection:")
    test_data = bytes([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5,
                       0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76])
    detected = CryptoDetector.detect(test_data)
    for d in detected:
        print(f"  {d}")
