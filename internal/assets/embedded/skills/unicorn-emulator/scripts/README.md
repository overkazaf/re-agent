# Unicorn Emulator Scripts

基于Unicorn Engine的CPU模拟和逆向工程脚本集合。

## 脚本列表

| 脚本 | 描述 | 架构支持 |
|------|------|----------|
| `arm_emulator.py` | ARM32模拟器（支持ARM/Thumb模式） | ARM32 |
| `arm64_emulator.py` | ARM64 (AArch64) 模拟器 | ARM64 |
| `x86_emulator.py` | x86/x64模拟器 | x86, x64 |
| `android_so_emulator.py` | Android SO库模拟执行 | ARM32, ARM64 |
| `algorithm_extractor.py` | 加密算法提取和分析工具 | ARM32, ARM64 |
| `utils.py` | 通用工具函数库 | 全平台 |

## 安装依赖

```bash
pip install unicorn capstone keystone-engine lief
```

## 快速开始

### 1. ARM32模拟

```python
from arm_emulator import ARM32Emulator
from unicorn.arm_const import UC_MODE_ARM

# 创建模拟器
emu = ARM32Emulator(UC_MODE_ARM)

# 加载代码
code = bytes([0x01, 0x00, 0x80, 0xE0, 0x1E, 0xFF, 0x2F, 0xE1])
emu.load_binary(code)

# 启用追踪
emu.enable_trace(True)

# 调用函数
result = emu.call(emu.CODE_BASE, 100, 200)
print(f"100 + 200 = {result}")
```

### 2. ARM64模拟

```python
from arm64_emulator import ARM64Emulator

emu = ARM64Emulator()
emu.load_file("libexample.so")
emu.enable_trace(True)

# 调用函数
result = emu.call(emu.CODE_BASE + 0x1234, arg1, arg2)
```

### 3. x86/x64模拟

```python
from x86_emulator import X86Emulator, X64Emulator

# 32位
emu32 = X86Emulator()
emu32.load_binary(code)
result = emu32.call(address, arg1, arg2)

# 64位
emu64 = X64Emulator()
emu64.load_binary(code)
result = emu64.call(address, arg1, arg2, arg3)  # System V ABI
```

### 4. Android SO模拟

```python
from android_so_emulator import AndroidSOEmulator

# 加载SO文件
emu = AndroidSOEmulator("libsign.so", is_64bit=False)

# 查看符号
emu.list_symbols("sign")

# 调用函数
result = emu.call_function("Java_com_example_Sign_sign", data_ptr, data_len)

# 调用JNI函数
result = emu.call_jni_function("Java_com_example_Crypto_encrypt", 0, data_ptr, data_len)
```

### 5. 算法提取

```python
from algorithm_extractor import AlgorithmExtractor

ext = AlgorithmExtractor()
ext.load_file("libcrypto.so")
ext.enable_trace(True)

# 执行加密函数
output = ext.call_encrypt(func_addr, input_data, key)

# 分析算法特征
ext.analyze_algorithm()

# 与已知算法比较
ext.compare_with_known(input_data, output)
```

## 命令行使用

### ARM模拟

```bash
# ARM模式
python arm_emulator.py libexample.so 0x1234 0xdeadbeef 16

# Thumb模式（地址末位为1）
python arm_emulator.py libexample.so 0x1235 0xdeadbeef 16
```

### ARM64模拟

```bash
python arm64_emulator.py libexample.so 0x1234 0xdeadbeef 16
```

### x86/x64模拟

```bash
# x86
python x86_emulator.py binary.bin 0x0 arg1 arg2

# x64
python x86_emulator.py --x64 binary.bin 0x0 arg1 arg2 arg3
```

### Android SO模拟

```bash
# ARM32 SO
python android_so_emulator.py libsign.so sign 0xdeadbeef 16

# ARM64 SO
python android_so_emulator.py --64 libsign.so sign 0xdeadbeef 16
```

### 算法提取

```bash
python algorithm_extractor.py libcrypto.so 0x1234 "test_input"
```

## 内存布局

### 通用布局

| 区域 | 地址范围 | 用途 |
|------|----------|------|
| CODE | 0x10000 - 0x110000 | 代码段 |
| STACK | 0x7FF00000 - 0x80000000 | 栈 |
| HEAP | 0xB0000000 - 0xC0000000 | 堆 |
| DATA | 0xA0000000 - 0xB0000000 | 数据段 |

### Android SO布局

| 区域 | 地址 | 用途 |
|------|------|------|
| SO_BASE | 0x10000000 | SO加载基址 |
| JNI_ENV | 0xC0000000 | JNI环境 |
| LIBC | 0xD0000000 | libc函数模拟 |

## Hook类型

| Hook | 用途 |
|------|------|
| `UC_HOOK_CODE` | 指令执行追踪 |
| `UC_HOOK_BLOCK` | 基本块执行 |
| `UC_HOOK_MEM_READ` | 内存读取 |
| `UC_HOOK_MEM_WRITE` | 内存写入 |
| `UC_HOOK_MEM_UNMAPPED` | 未映射内存访问 |
| `UC_HOOK_INTR` | 中断/系统调用 |

## 调用约定

### ARM32 (AAPCS)
- R0-R3: 前4个参数
- R0: 返回值
- SP: 栈指针
- LR: 返回地址

### ARM64 (AAPCS64)
- X0-X7: 前8个参数
- X0: 返回值
- SP: 栈指针
- LR (X30): 返回地址

### x86 (cdecl)
- 参数从右到左压栈
- EAX: 返回值
- 调用者清理栈

### x64 System V (Linux)
- RDI, RSI, RDX, RCX, R8, R9: 前6个参数
- RAX: 返回值

### x64 Windows
- RCX, RDX, R8, R9: 前4个参数
- RAX: 返回值
- Shadow space: 32字节

## 使用技巧

### 1. 处理未映射内存

```python
def hook_unmapped(mu, access, address, size, value, user_data):
    page_start = address & ~0xFFF
    mu.mem_map(page_start, 0x1000, UC_PROT_ALL)
    return True  # 继续执行

mu.hook_add(UC_HOOK_MEM_UNMAPPED, hook_unmapped)
```

### 2. 模拟libc函数

```python
def hook_malloc(mu):
    size = mu.reg_read(UC_ARM_REG_R0)
    addr = allocate_memory(size)
    mu.reg_write(UC_ARM_REG_R0, addr)
    # 跳过函数，返回调用者
    lr = mu.reg_read(UC_ARM_REG_LR)
    mu.reg_write(UC_ARM_REG_PC, lr)
```

### 3. 数据流追踪

```python
writes = []

def hook_mem_write(mu, access, address, size, value, user_data):
    writes.append((address, size, value))

mu.hook_add(UC_HOOK_MEM_WRITE, hook_mem_write)
```

### 4. 设置断点

```python
breakpoints = {0x1234, 0x5678}

def hook_code(mu, address, size, user_data):
    if address in breakpoints:
        print(f"Breakpoint hit at 0x{address:x}")
        # 检查状态
        dump_registers(mu)
```

## 常见问题

### Q: 模拟卡住或无限循环
A: 设置指令计数限制或超时
```python
mu.emu_start(start, end, timeout=10000000, count=100000)
```

### Q: 内存访问错误
A: 确保所有需要的内存区域都已映射，或使用自动映射hook

### Q: 函数调用失败
A: 检查调用约定，确保参数正确设置

### Q: SO加载失败
A: 确认SO架构匹配，检查是否需要lief库

## 参考资料

- [Unicorn Engine](https://www.unicorn-engine.org/)
- [Capstone Disassembler](https://www.capstone-engine.org/)
- [Keystone Assembler](https://www.keystone-engine.org/)
- [LIEF](https://lief-project.github.io/)
