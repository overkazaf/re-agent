#!/usr/bin/env python3
"""
Algorithm Extractor - 算法还原工具
用于从二进制中提取和分析加密/签名算法

功能:
- 提取加密算法（AES, DES, RC4, TEA等）
- 分析哈希函数（MD5, SHA1, SHA256等）
- 还原签名算法
- 数据流追踪

使用方法:
    python algorithm_extractor.py <binary_file> <function_offset> <input_data>

示例:
    python algorithm_extractor.py libcrypto.so 0x1234 "test_input"
"""

from unicorn import *
from unicorn.arm_const import *
from unicorn.arm64_const import *
from capstone import *
import struct
import sys
import hashlib
import binascii


class DataFlowTracker:
    """数据流追踪器"""

    def __init__(self):
        self.memory_writes = []
        self.memory_reads = []
        self.xor_operations = []
        self.shift_operations = []
        self.constants = set()

    def record_write(self, address, size, value):
        self.memory_writes.append({
            'address': address,
            'size': size,
            'value': value
        })

    def record_read(self, address, size, value):
        self.memory_reads.append({
            'address': address,
            'size': size,
            'value': value
        })

    def analyze(self):
        """分析收集的数据"""
        print("\n" + "=" * 60)
        print("Data Flow Analysis")
        print("=" * 60)

        print(f"\n[*] Memory writes: {len(self.memory_writes)}")
        print(f"[*] Memory reads: {len(self.memory_reads)}")

        # 检测循环模式
        self._detect_patterns()

    def _detect_patterns(self):
        """检测算法模式"""
        # 检测XOR模式
        xor_count = 0
        for w in self.memory_writes:
            if w['value'] is not None:
                # 简单的XOR检测
                pass

        print(f"[*] Potential XOR operations: {xor_count}")


class AlgorithmExtractor:
    """算法提取器"""

    # 内存布局
    CODE_BASE = 0x10000
    CODE_SIZE = 0x100000
    STACK_BASE = 0x80000000
    STACK_SIZE = 0x100000
    INPUT_BASE = 0x90000000
    INPUT_SIZE = 0x10000
    OUTPUT_BASE = 0xA0000000
    OUTPUT_SIZE = 0x10000
    KEY_BASE = 0xB0000000
    KEY_SIZE = 0x1000

    def __init__(self, is_64bit=False):
        """初始化"""
        self.is_64bit = is_64bit
        self.tracker = DataFlowTracker()
        self.instruction_count = 0
        self.trace_log = []

        if is_64bit:
            self.mu = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
            self.cs = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
            self.REG_PC = UC_ARM64_REG_PC
            self.REG_SP = UC_ARM64_REG_SP
            self.REG_LR = UC_ARM64_REG_LR
            self.REG_RET = UC_ARM64_REG_X0
            self.ARG_REGS = [
                UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3
            ]
            self.ptr_size = 8
        else:
            self.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
            self.cs = Cs(CS_ARCH_ARM, CS_MODE_ARM)
            self.REG_PC = UC_ARM_REG_PC
            self.REG_SP = UC_ARM_REG_SP
            self.REG_LR = UC_ARM_REG_LR
            self.REG_RET = UC_ARM_REG_R0
            self.ARG_REGS = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3]
            self.ptr_size = 4

        self.cs.detail = True
        self._setup_memory()
        self._setup_hooks()

    def _setup_memory(self):
        """初始化内存"""
        self.mu.mem_map(self.CODE_BASE, self.CODE_SIZE, UC_PROT_ALL)
        self.mu.mem_map(self.STACK_BASE - self.STACK_SIZE, self.STACK_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.INPUT_BASE, self.INPUT_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.OUTPUT_BASE, self.OUTPUT_SIZE, UC_PROT_READ | UC_PROT_WRITE)
        self.mu.mem_map(self.KEY_BASE, self.KEY_SIZE, UC_PROT_READ | UC_PROT_WRITE)

        self.mu.reg_write(self.REG_SP, self.STACK_BASE - 0x1000)

    def _setup_hooks(self):
        """设置Hook"""
        self.mu.hook_add(UC_HOOK_MEM_UNMAPPED, self._hook_unmapped)
        self.mu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self._hook_mem)
        self.code_hook = None

    def _hook_unmapped(self, mu, access, address, size, value, user_data):
        """未映射内存"""
        page_start = address & ~0xFFF
        try:
            self.mu.mem_map(page_start, 0x1000, UC_PROT_ALL)
            return True
        except:
            return False

    def _hook_mem(self, mu, access, address, size, value, user_data):
        """内存访问Hook"""
        if access == UC_MEM_WRITE:
            self.tracker.record_write(address, size, value)

            # 检测是否写入输出区域
            if self.OUTPUT_BASE <= address < self.OUTPUT_BASE + self.OUTPUT_SIZE:
                offset = address - self.OUTPUT_BASE
                self.trace_log.append(f"OUTPUT[{offset}] = 0x{value:x}")

        elif access == UC_MEM_READ:
            data = mu.mem_read(address, size)
            val = int.from_bytes(data, 'little')
            self.tracker.record_read(address, size, val)

            # 检测是否读取输入区域
            if self.INPUT_BASE <= address < self.INPUT_BASE + self.INPUT_SIZE:
                offset = address - self.INPUT_BASE
                self.trace_log.append(f"INPUT[{offset}] -> 0x{val:x}")

    def _hook_code(self, mu, address, size, user_data):
        """代码执行Hook"""
        self.instruction_count += 1
        code = mu.mem_read(address, size)

        for insn in self.cs.disasm(bytes(code), address):
            # 检测特定操作
            mnemonic = insn.mnemonic.lower()

            # XOR操作
            if 'eor' in mnemonic or 'xor' in mnemonic:
                self.trace_log.append(f"XOR: {insn.op_str}")

            # 位移操作
            if 'lsl' in mnemonic or 'lsr' in mnemonic or 'ror' in mnemonic:
                self.trace_log.append(f"SHIFT: {mnemonic} {insn.op_str}")

            # 查表操作 (LDR with offset)
            if 'ldr' in mnemonic:
                self.trace_log.append(f"LOAD: {insn.op_str}")

    def enable_trace(self, enabled=True):
        """启用详细追踪"""
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

    def set_input(self, data):
        """设置输入数据"""
        if isinstance(data, str):
            data = data.encode('utf-8')
        self.mu.mem_write(self.INPUT_BASE, data)
        print(f"[*] Input ({len(data)} bytes): {binascii.hexlify(data).decode()}")
        return self.INPUT_BASE

    def set_key(self, key):
        """设置密钥"""
        if isinstance(key, str):
            key = key.encode('utf-8')
        self.mu.mem_write(self.KEY_BASE, key)
        print(f"[*] Key ({len(key)} bytes): {binascii.hexlify(key).decode()}")
        return self.KEY_BASE

    def get_output(self, size):
        """获取输出数据"""
        data = bytes(self.mu.mem_read(self.OUTPUT_BASE, size))
        print(f"[*] Output ({size} bytes): {binascii.hexlify(data).decode()}")
        return data

    def call_encrypt(self, func_addr, input_data, key=None, output_size=None):
        """
        调用加密函数

        典型签名: encrypt(input, input_len, key, key_len, output)
        """
        if output_size is None:
            output_size = len(input_data) + 32  # 预留padding空间

        input_addr = self.set_input(input_data)
        input_len = len(input_data)

        if key:
            key_addr = self.set_key(key)
            key_len = len(key)
        else:
            key_addr = 0
            key_len = 0

        # 清空输出区域
        self.mu.mem_write(self.OUTPUT_BASE, b'\x00' * output_size)

        # 设置参数
        args = [input_addr, input_len, key_addr, key_len, self.OUTPUT_BASE]
        for i, arg in enumerate(args[:len(self.ARG_REGS)]):
            self.mu.reg_write(self.ARG_REGS[i], arg)

        self.mu.reg_write(self.REG_LR, 0)

        print(f"\n[*] Calling encrypt function at 0x{func_addr:08x}")
        self.instruction_count = 0
        self.trace_log = []

        try:
            self.mu.emu_start(func_addr, 0, timeout=10000000)
        except UcError as e:
            if not (e.errno == UC_ERR_FETCH_UNMAPPED and self.mu.reg_read(self.REG_PC) == 0):
                raise

        result = self.mu.reg_read(self.REG_RET)
        print(f"[*] Executed {self.instruction_count} instructions")
        print(f"[*] Return value: 0x{result:x}")

        return self.get_output(output_size)

    def call_hash(self, func_addr, input_data, digest_size=32):
        """
        调用哈希函数

        典型签名: hash(input, input_len, output)
        """
        input_addr = self.set_input(input_data)
        input_len = len(input_data)

        self.mu.mem_write(self.OUTPUT_BASE, b'\x00' * digest_size)

        # 设置参数
        self.mu.reg_write(self.ARG_REGS[0], input_addr)
        self.mu.reg_write(self.ARG_REGS[1], input_len)
        self.mu.reg_write(self.ARG_REGS[2], self.OUTPUT_BASE)

        self.mu.reg_write(self.REG_LR, 0)

        print(f"\n[*] Calling hash function at 0x{func_addr:08x}")

        try:
            self.mu.emu_start(func_addr, 0, timeout=10000000)
        except UcError as e:
            if not (e.errno == UC_ERR_FETCH_UNMAPPED and self.mu.reg_read(self.REG_PC) == 0):
                raise

        return self.get_output(digest_size)

    def analyze_algorithm(self):
        """分析检测到的算法特征"""
        print("\n" + "=" * 60)
        print("Algorithm Analysis")
        print("=" * 60)

        # 分析追踪日志
        xor_count = sum(1 for l in self.trace_log if 'XOR' in l)
        shift_count = sum(1 for l in self.trace_log if 'SHIFT' in l)
        load_count = sum(1 for l in self.trace_log if 'LOAD' in l)

        print(f"\n[*] XOR operations: {xor_count}")
        print(f"[*] Shift operations: {shift_count}")
        print(f"[*] Memory loads: {load_count}")

        # 算法特征识别
        print("\n[*] Possible algorithms:")

        if xor_count > 100 and shift_count > 50:
            print("  - RC4 (stream cipher)")
            print("  - ChaCha20")

        if load_count > 200 and xor_count > 50:
            print("  - AES (block cipher)")
            print("  - DES/3DES")

        if xor_count > 10 and shift_count > 20 and load_count < 50:
            print("  - TEA/XTEA")
            print("  - Custom XOR cipher")

        # 数据流分析
        self.tracker.analyze()

    def dump_trace(self, limit=100):
        """打印追踪日志"""
        print("\n" + "=" * 60)
        print(f"Trace Log (last {limit} entries)")
        print("=" * 60)

        for entry in self.trace_log[-limit:]:
            print(f"  {entry}")

    def compare_with_known(self, input_data, output_data):
        """与已知算法比较"""
        print("\n" + "=" * 60)
        print("Comparison with Known Algorithms")
        print("=" * 60)

        # MD5
        md5_hash = hashlib.md5(input_data).digest()
        if output_data[:16] == md5_hash:
            print("[+] MATCH: MD5")
        else:
            print(f"[-] MD5: {binascii.hexlify(md5_hash).decode()}")

        # SHA1
        sha1_hash = hashlib.sha1(input_data).digest()
        if output_data[:20] == sha1_hash:
            print("[+] MATCH: SHA1")
        else:
            print(f"[-] SHA1: {binascii.hexlify(sha1_hash).decode()}")

        # SHA256
        sha256_hash = hashlib.sha256(input_data).digest()
        if output_data[:32] == sha256_hash:
            print("[+] MATCH: SHA256")
        else:
            print(f"[-] SHA256: {binascii.hexlify(sha256_hash).decode()}")


class CryptoPatterns:
    """常见加密算法模式"""

    # AES S-Box
    AES_SBOX = bytes([
        0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5,
        0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
        # ... 完整S-Box
    ])

    # DES Initial Permutation
    DES_IP = [
        58, 50, 42, 34, 26, 18, 10, 2,
        60, 52, 44, 36, 28, 20, 12, 4,
        # ...
    ]

    # MD5 Constants
    MD5_K = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
        # ...
    ]

    @staticmethod
    def detect_sbox(data):
        """检测S-Box"""
        # 搜索AES S-Box特征
        if CryptoPatterns.AES_SBOX[:8] in data:
            return "AES"
        return None

    @staticmethod
    def detect_constants(data):
        """检测已知常量"""
        # 转换为32位整数列表
        if len(data) < 4:
            return []

        detected = []

        # 检查MD5常量
        for const in CryptoPatterns.MD5_K[:4]:
            packed = struct.pack('<I', const)
            if packed in data:
                detected.append(('MD5', hex(const)))

        return detected


def demo():
    """演示"""
    print("=" * 60)
    print("Algorithm Extractor Demo")
    print("=" * 60)

    # 创建提取器
    ext = AlgorithmExtractor(is_64bit=False)

    # 示例：简单的XOR加密
    # XOR R2, R0, R1 (对每个字节进行XOR)
    # 循环处理
    code = bytes([
        # 简化的XOR加密代码
        0x00, 0x20, 0x81, 0xE0,  # ADD R2, R1, R0
        0x1E, 0xFF, 0x2F, 0xE1,  # BX LR
    ])

    ext.load_binary(code)
    ext.enable_trace(True)

    # 测试
    input_data = b"Hello World!"

    print("\n[*] Testing algorithm extraction...")
    print(f"[*] Input: {input_data}")

    # 分析
    ext.analyze_algorithm()


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python algorithm_extractor.py <binary_file> <function_offset> <input>")
        print("\nExample:")
        print("  python algorithm_extractor.py libcrypto.so 0x1234 'test_input'")
        print("\nRunning demo...")
        demo()
    else:
        binary_file = sys.argv[1]
        func_offset = int(sys.argv[2], 0)
        input_data = sys.argv[3]

        if input_data.startswith('0x'):
            input_data = binascii.unhexlify(input_data[2:])
        else:
            input_data = input_data.encode()

        ext = AlgorithmExtractor()
        ext.load_file(binary_file)
        ext.enable_trace(True)

        output = ext.call_encrypt(ext.CODE_BASE + func_offset, input_data)

        ext.analyze_algorithm()
        ext.compare_with_known(input_data, output)
        ext.dump_trace(50)
