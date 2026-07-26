---
name: re-planner
description: Reverse engineering workflow planner. Analyzes RE problems/scenarios and creates step-by-step action plans using available skills. Identifies skill gaps and recommends areas to develop. Use when facing complex RE challenges.
---

# Reverse Engineering Workflow Planner

智能规划逆向工程工作流程，根据问题场景匹配现有技能，生成分步操作方案，并识别技能缺口。

## 使用场景

当你遇到以下情况时使用此技能：
- 面对复杂的逆向工程任务，不知从何下手
- 需要制定系统性的分析方案
- 想了解现有技能如何组合使用
- 需要识别知识/技能盲区

## 工作流程

### Step 1: 问题分析

收集以下信息：
1. **目标类型**: Web/Android/iOS/Windows/Linux/其他
2. **保护类型**: 混淆/加壳/VMP/加密/反调试/其他
3. **分析目标**: 算法还原/协议分析/漏洞挖掘/去保护/其他
4. **已有信息**: 样本/流量/文档/其他

### Step 2: 技能库匹配

#### 现有逆向技能库

**Web逆向技能**
| 技能 | 适用场景 | 前置条件 |
|------|---------|---------|
| `js-unpacker` | JS打包/混淆代码解包 | 获取到混淆JS代码 |
| `webpack-analyzer` | Webpack打包分析 | 识别为Webpack打包 |
| `wasm-reverser` | WebAssembly逆向 | 存在WASM模块 |
| `web-crypto-analyzer` | Web加密分析 | 存在加密逻辑 |
| `api-signature-crack` | API签名逆向 | 需要破解API签名 |
| `anti-debug-bypass` | JS反调试绑定 | 遇到反调试保护 |
| `browser-hook` | 浏览器运行时Hook | 需要动态分析 |
| `web-scraping-defense` | 反爬虫分析 | 遇到反爬保护 |
| `jsvmp-analysis` | JS虚拟机保护分析 | 存在JSVMP保护 |
| `deobfuscate` | 代码去混淆 | 代码被混淆 |
| `fingerprints-analysis` | 浏览器指纹分析 | 分析指纹采集 |

**Android逆向技能**
| 技能 | 适用场景 | 前置条件 |
|------|---------|---------|
| `jadx` | APK反编译分析 | 获取到APK |
| `frida-hook-workflow` | Frida Hook工作流 | 需要动态Hook |
| `frida-setup` | Frida环境配置 | 准备Frida环境 |
| `frida-pull-apk` | 从设备提取APK | 需要提取APK |
| `frida-log-analyzer` | Frida日志分析 | 有Hook日志 |
| `frida-codeshare` | Frida脚本搜索 | 查找现成脚本 |
| `gen-frida-hook` | 生成Hook脚本 | 需要编写Hook |
| `analyze-apk` | APK初步分析 | 获取到APK |
| `analyze-so` | SO文件分析 | 需要分析SO |
| `apk-so-analyzer` | APK中SO分析 | 需要分析Native层 |
| `ollvm-deobfuscation` | OLLVM反混淆 | SO使用OLLVM |
| `vmp-restore` | VMP还原 | 存在VMP保护 |
| `svc-bypass` | SVC对抗 | 存在SVC保护 |
| `android-emu-restore` | 模拟执行还原 | 需要模拟执行 |
| `android-rootfs-restore` | Rootfs执行还原 | 需要真实环境 |
| `mitmproxy` | 流量抓包分析 | 需要抓包 |
| `unidbg` | unidbg模拟器 | 需要模拟SO |

**通用逆向技能**
| 技能 | 适用场景 | 前置条件 |
|------|---------|---------|
| `curl-to-python` | cURL转Python | 有cURL命令 |
| `js-to-python` | JS转Python | 需要转换代码 |
| `js-to-java` | JS转Java | 需要转换代码 |
| `re-writeup` | 逆向报告编写 | 完成分析 |
| `frida-analysis-writeup` | Frida分析报告 | 完成Frida分析 |
| `unicorn-emulator` | Unicorn模拟器 | 需要指令模拟 |

### Step 3: 生成执行方案

根据问题类型匹配技能并生成分步方案。

## 问题类型模板

### 模板A: Web API签名逆向

**典型问题**: "某网站请求带有签名参数sign，需要破解签名算法"

**推荐流程**:
```
1. 信息收集
   └─ /fingerprints-analysis - 分析请求指纹

2. 流量分析
   └─ 抓包获取完整请求（浏览器DevTools/mitmproxy）

3. JS定位
   └─ /browser-hook - Hook网络请求找到签名生成位置
   └─ 搜索关键词: sign, signature, encrypt

4. 代码分析
   ├─ /webpack-analyzer - 如果是Webpack打包
   ├─ /js-unpacker - 如果代码被打包/混淆
   └─ /deobfuscate - 如果代码被混淆

5. 算法分析
   ├─ /web-crypto-analyzer - 识别加密算法
   └─ /jsvmp-analysis - 如果存在VMP保护

6. 签名还原
   └─ /api-signature-crack - 还原签名算法

7. 代码转换
   └─ /js-to-python 或 /js-to-java

8. 文档输出
   └─ /re-writeup - 生成分析报告
```

### 模板B: Android SO算法还原

**典型问题**: "某APP的加密算法在Native层，需要还原算法"

**推荐流程**:
```
1. 样本获取
   └─ /frida-pull-apk - 从设备提取APK

2. 静态分析
   ├─ /analyze-apk - APK初步分析
   ├─ /jadx - 反编译分析Java层
   └─ /apk-so-analyzer - 定位目标SO和函数

3. SO分析
   ├─ /analyze-so - SO静态分析
   └─ IDA/Ghidra 打开SO文件

4. 保护识别
   ├─ /ollvm-deobfuscation - 如果存在OLLVM
   ├─ /vmp-restore - 如果存在VMP
   └─ /svc-bypass - 如果存在SVC保护

5. 动态分析
   ├─ /frida-setup - 配置Frida环境
   ├─ /frida-codeshare - 搜索现成脚本
   ├─ /gen-frida-hook - 生成Hook脚本
   └─ /frida-hook-workflow - 执行Hook分析

6. 算法模拟
   ├─ /unidbg - 使用unidbg模拟
   ├─ /android-emu-restore - 模拟执行还原
   └─ /unicorn-emulator - Unicorn模拟

7. 日志分析
   └─ /frida-log-analyzer - 分析Hook日志

8. 文档输出
   └─ /frida-analysis-writeup - 生成分析报告
```

### 模板C: Web反爬绕过

**典型问题**: "某网站有反爬保护，需要分析绕过方案"

**推荐流程**:
```
1. 保护识别
   └─ /web-scraping-defense - 识别保护类型
      - Cloudflare/Akamai/PerimeterX等

2. 指纹分析
   └─ /fingerprints-analysis - 分析采集的指纹

3. JS分析
   ├─ /anti-debug-bypass - 绕过反调试
   ├─ /browser-hook - Hook关键函数
   └─ /js-unpacker - 解包混淆代码

4. 算法分析
   ├─ /jsvmp-analysis - 如果存在VMP
   └─ /web-crypto-analyzer - 分析加密

5. 挑战分析
   └─ 分析Challenge流程和参数生成

6. 方案实现
   └─ /curl-to-python - 实现请求
```

### 模板D: JSVMP保护分析

**典型问题**: "某网站JS被VMP保护，需要还原原始逻辑"

**推荐流程**:
```
1. 代码定位
   ├─ /browser-hook - Hook定位VMP入口
   └─ /webpack-analyzer - 分析打包结构

2. 反调试绕过
   └─ /anti-debug-bypass - 绑定反调试

3. VMP分析
   └─ /jsvmp-analysis - VMP结构分析
      - 识别Dispatcher
      - 提取Handler
      - 分析Opcode

4. 动态跟踪
   └─ 利用Hook跟踪执行流

5. 代码还原
   └─ 根据Handler语义重建代码

6. 验证测试
   └─ /api-signature-crack - 验证还原结果
```

## 技能缺口识别

### 当前技能库覆盖范围
- ✅ Web前端逆向
- ✅ JavaScript混淆/VMP
- ✅ Android Java层分析
- ✅ Android Native层分析
- ✅ OLLVM/VMP保护
- ✅ Frida动态分析
- ✅ API签名分析
- ✅ 流量抓包分析

### 可能的技能缺口
如果你的问题涉及以下领域，建议补充相应技能：

| 领域 | 缺失技能建议 | 说明 |
|------|-------------|------|
| iOS逆向 | ios-frida, ios-jailbreak | iOS动态分析 |
| Windows逆向 | pe-analysis, windbg | PE分析调试 |
| 游戏安全 | game-memory, game-protocol | 游戏内存/协议 |
| 协议分析 | protocol-reverser | 自定义协议 |
| 机器学习对抗 | ml-adversarial | 验证码/风控 |
| 区块链 | smart-contract-audit | 智能合约 |
| 固件分析 | firmware-analysis | IoT固件 |
| 内核分析 | kernel-debug | 内核调试 |

## 输出格式

```markdown
## 逆向工程执行方案

### 问题概述
- **目标**: {{TARGET_DESCRIPTION}}
- **类型**: {{WEB/ANDROID/NATIVE/OTHER}}
- **保护**: {{PROTECTION_TYPE}}
- **目标**: {{ANALYSIS_GOAL}}

### 推荐执行流程

#### 阶段1: {{PHASE_NAME}}
| 步骤 | 技能 | 操作 | 预期输出 |
|------|------|------|---------|
| 1.1 | /{{skill}} | {{ACTION}} | {{OUTPUT}} |

#### 阶段2: {{PHASE_NAME}}
| 步骤 | 技能 | 操作 | 预期输出 |
|------|------|------|---------|
| 2.1 | /{{skill}} | {{ACTION}} | {{OUTPUT}} |

### 技能匹配度
- **完全覆盖**: {{SKILLS}}
- **部分覆盖**: {{SKILLS}}
- **需要补充**: {{GAPS}}

### 技能缺口提醒
⚠️ 以下方面可能需要补充技能或知识：
1. {{GAP_1}}
2. {{GAP_2}}

### 预估难度
- **技术难度**: {{LOW/MEDIUM/HIGH/EXPERT}}
- **时间估计**: {{TIME_RANGE}}
- **关键挑战**: {{CHALLENGES}}

### 参考资源
- {{RESOURCE_1}}
- {{RESOURCE_2}}
```

## 使用方法

```
/re-planner

描述你的逆向问题：
- 目标是什么？（网站/APP/文件）
- 遇到什么保护？
- 想要达成什么目标？
- 已有哪些信息？
```

## 示例

**输入**:
```
我在分析某电商APP，请求中有sign参数，
通过jadx发现sign在native层生成，
SO文件用了OLLVM混淆，
我想还原sign的生成算法。
```

**输出方案**:
```
阶段1: 静态分析
├─ /analyze-so → 分析SO导出函数
├─ /ollvm-deobfuscation → 识别OLLVM类型
└─ IDA/Ghidra → 反编译分析

阶段2: 去混淆
├─ 使用D-810/deflat处理CFF
└─ 简化指令替换

阶段3: 动态分析
├─ /frida-setup → 配置环境
├─ /gen-frida-hook → 生成Hook脚本
└─ /frida-hook-workflow → 执行Hook

阶段4: 算法模拟
├─ /unidbg → 模拟SO执行
└─ 提取算法实现

技能匹配度: 高
缺口提醒: 无明显缺口
```
