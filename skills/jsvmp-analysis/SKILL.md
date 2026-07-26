---
name: jsvmp-analysis
description: Analyze and reverse engineer JavaScript Virtual Machine Protection (JSVMP). Identify opcode handlers, reconstruct control flow, extract original logic from virtualized code. Use for security research on protected web applications.
---

# JavaScript VMP Analysis

A skill for analyzing JavaScript Virtual Machine Protection (JSVMP), a code protection technique that converts JavaScript into custom bytecode executed by an interpreter.

## Workflow Overview

### Step 1: Identify JSVMP Patterns

**Common JSVMP Signatures:**

| Pattern | Description | Example |
|---------|-------------|---------|
| **Dispatcher Loop** | while/switch structure | `while(1){switch(op){...}}` |
| **Opcode Array** | Encoded instruction array | `[12,45,78,...]` |
| **Stack Operations** | Push/pop operations | `stack.push()`, `stack.pop()` |
| **Register Array** | Virtual registers | `regs[0]`, `regs[1]` |
| **PC Counter** | Program counter | `pc++`, `ip+=2` |
| **Handler Table** | Opcode handlers | `handlers[opcode]()` |

**Detection Script:**

```javascript
// Detect JSVMP patterns in code
(function detectJSVMP() {
    const indicators = {
        dispatcherLoop: false,
        opcodeArray: false,
        stackOps: false,
        handlers: false
    };

    const source = document.body.innerHTML;

    // Check for dispatcher patterns
    indicators.dispatcherLoop = /while\s*\(\s*(true|1|!0)\s*\)\s*\{\s*switch/.test(source);

    // Check for opcode arrays (long number arrays)
    indicators.opcodeArray = /\[\s*\d+\s*(,\s*\d+\s*){50,}\]/.test(source);

    // Check for stack operations
    indicators.stackOps = /\.(push|pop)\s*\(/.test(source) &&
                         /stack|stk|_s/.test(source);

    // Check for handler patterns
    indicators.handlers = /case\s+\d+\s*:/.test(source) &&
                         (source.match(/case\s+\d+\s*:/g)?.length > 20);

    const isJSVMP = Object.values(indicators).filter(Boolean).length >= 3;

    console.log('JSVMP Detection:', { isJSVMP, indicators });
    return { isJSVMP, indicators };
})();
```

### Step 2: JSVMP Architecture Analysis

#### 2.1 Typical JSVMP Structure

```javascript
// Simplified JSVMP structure
function VM(bytecode) {
    const stack = [];           // Operand stack
    const regs = [];            // Virtual registers
    const memory = {};          // Virtual memory
    let pc = 0;                 // Program counter
    const code = bytecode;      // Bytecode array

    // Dispatcher loop
    while (pc < code.length) {
        const opcode = code[pc++];

        switch (opcode) {
            case 0x01:  // PUSH_CONST
                stack.push(code[pc++]);
                break;

            case 0x02:  // PUSH_REG
                stack.push(regs[code[pc++]]);
                break;

            case 0x03:  // POP_REG
                regs[code[pc++]] = stack.pop();
                break;

            case 0x04:  // ADD
                const b = stack.pop();
                const a = stack.pop();
                stack.push(a + b);
                break;

            case 0x05:  // SUB
                // ... similar operations
                break;

            case 0x10:  // CALL
                const funcIdx = code[pc++];
                const argCount = code[pc++];
                // Handle function call
                break;

            case 0xFF:  // HALT
                return stack.pop();
        }
    }
}
```

#### 2.2 Common Opcode Categories

| Category | Opcodes | Purpose |
|----------|---------|---------|
| **Stack** | PUSH, POP, DUP, SWAP | Stack manipulation |
| **Arithmetic** | ADD, SUB, MUL, DIV, MOD | Math operations |
| **Bitwise** | AND, OR, XOR, NOT, SHL, SHR | Bit operations |
| **Comparison** | EQ, NE, LT, GT, LE, GE | Comparisons |
| **Control** | JMP, JZ, JNZ, CALL, RET | Control flow |
| **Memory** | LOAD, STORE, GET, SET | Memory access |
| **Object** | GET_PROP, SET_PROP, NEW | Object operations |
| **Special** | TYPEOF, INSTANCEOF, IN | Special ops |

### Step 3: Opcode Handler Extraction

```javascript
// Extract opcode handlers from JSVMP code
(function extractHandlers() {
    const handlers = {};

    // Find the main switch statement
    const switchMatch = source.match(
        /switch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\}/
    );

    if (switchMatch) {
        const switchBody = switchMatch[2];
        const opcodeVar = switchMatch[1];

        // Extract each case
        const caseRegex = /case\s+(\d+)\s*:\s*([\s\S]*?)(?=case\s+\d+|default|$)/g;
        let match;

        while ((match = caseRegex.exec(switchBody)) !== null) {
            const opcode = parseInt(match[1]);
            const handlerCode = match[2].trim();

            handlers[opcode] = {
                code: handlerCode,
                operations: analyzeHandler(handlerCode)
            };
        }
    }

    function analyzeHandler(code) {
        const ops = [];
        if (/\.push\s*\(/.test(code)) ops.push('PUSH');
        if (/\.pop\s*\(/.test(code)) ops.push('POP');
        if (/\+[^+]/.test(code)) ops.push('ADD');
        if (/-[^-]/.test(code)) ops.push('SUB');
        if (/\*/.test(code)) ops.push('MUL');
        if (/\//.test(code)) ops.push('DIV');
        if (/===?/.test(code)) ops.push('EQ');
        if (/\[\s*\w+\s*\]/.test(code)) ops.push('INDEX');
        return ops;
    }

    console.log('Extracted handlers:', handlers);
    return handlers;
})();
```

### Step 4: Bytecode Disassembly

```javascript
// JSVMP Bytecode Disassembler
class JSVMPDisassembler {
    constructor(bytecode, opcodeMap) {
        this.bytecode = bytecode;
        this.opcodeMap = opcodeMap;  // opcode -> name mapping
        this.pc = 0;
    }

    disassemble() {
        const instructions = [];

        while (this.pc < this.bytecode.length) {
            const addr = this.pc;
            const opcode = this.bytecode[this.pc++];
            const info = this.opcodeMap[opcode] || { name: 'UNKNOWN', args: 0 };

            const args = [];
            for (let i = 0; i < (info.args || 0); i++) {
                args.push(this.bytecode[this.pc++]);
            }

            instructions.push({
                address: addr,
                opcode: opcode,
                name: info.name,
                args: args,
                raw: `${addr.toString(16).padStart(4, '0')}: ${info.name} ${args.join(', ')}`
            });
        }

        return instructions;
    }

    // Analyze control flow
    analyzeControlFlow(instructions) {
        const blocks = [];
        let currentBlock = { start: 0, instructions: [], exits: [] };

        instructions.forEach((inst, idx) => {
            currentBlock.instructions.push(inst);

            // Check for control flow changes
            if (['JMP', 'JZ', 'JNZ', 'RET', 'CALL'].includes(inst.name)) {
                if (inst.args[0]) {
                    currentBlock.exits.push(inst.args[0]);
                }
                blocks.push(currentBlock);
                currentBlock = { start: idx + 1, instructions: [], exits: [] };
            }
        });

        if (currentBlock.instructions.length > 0) {
            blocks.push(currentBlock);
        }

        return blocks;
    }
}

// Example opcode map (customize per target)
const opcodeMap = {
    0x01: { name: 'PUSH_CONST', args: 1 },
    0x02: { name: 'PUSH_REG', args: 1 },
    0x03: { name: 'POP_REG', args: 1 },
    0x04: { name: 'ADD', args: 0 },
    0x05: { name: 'SUB', args: 0 },
    0x06: { name: 'MUL', args: 0 },
    0x07: { name: 'DIV', args: 0 },
    0x10: { name: 'JMP', args: 1 },
    0x11: { name: 'JZ', args: 1 },
    0x12: { name: 'JNZ', args: 1 },
    0x20: { name: 'CALL', args: 2 },
    0x21: { name: 'RET', args: 0 },
    0xFF: { name: 'HALT', args: 0 }
};
```

### Step 5: Dynamic Analysis Techniques

#### 5.1 Hook Dispatcher

```javascript
// Hook the VM dispatcher to trace execution
(function traceVM() {
    const trace = [];

    // Find and hook the dispatcher
    // This requires identifying the switch variable
    const originalSwitch = /* locate switch handler */;

    // Example: Proxy-based tracing
    const vmState = new Proxy({
        stack: [],
        regs: [],
        pc: 0
    }, {
        set(target, prop, value) {
            trace.push({
                time: performance.now(),
                op: 'SET',
                prop: prop,
                value: JSON.stringify(value).substring(0, 100)
            });
            target[prop] = value;
            return true;
        },
        get(target, prop) {
            trace.push({
                time: performance.now(),
                op: 'GET',
                prop: prop,
                value: JSON.stringify(target[prop]).substring(0, 100)
            });
            return target[prop];
        }
    });

    window.__vmTrace = trace;
    console.log('VM tracing enabled. Access via window.__vmTrace');
})();
```

#### 5.2 Opcode Frequency Analysis

```javascript
// Analyze opcode execution frequency
(function analyzeOpcodeFrequency() {
    const frequency = {};
    const sequences = [];
    let lastOpcodes = [];

    // Hook opcode execution
    function recordOpcode(opcode) {
        frequency[opcode] = (frequency[opcode] || 0) + 1;

        // Track sequences
        lastOpcodes.push(opcode);
        if (lastOpcodes.length > 5) {
            lastOpcodes.shift();
        }

        // Record common sequences
        if (lastOpcodes.length === 5) {
            const seq = lastOpcodes.join(',');
            sequences.push(seq);
        }
    }

    // Find common patterns
    function getPatterns() {
        const seqCount = {};
        sequences.forEach(seq => {
            seqCount[seq] = (seqCount[seq] || 0) + 1;
        });

        return Object.entries(seqCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
    }

    window.recordOpcode = recordOpcode;
    window.getOpcodeStats = () => ({ frequency, patterns: getPatterns() });
})();
```

### Step 6: Decompilation Strategies

#### 6.1 Stack-Based to Expression Conversion

```javascript
// Convert stack-based bytecode to expressions
class StackToExpression {
    constructor() {
        this.stack = [];
        this.expressions = [];
    }

    process(instruction) {
        switch (instruction.name) {
            case 'PUSH_CONST':
                this.stack.push({ type: 'const', value: instruction.args[0] });
                break;

            case 'PUSH_REG':
                this.stack.push({ type: 'var', name: `r${instruction.args[0]}` });
                break;

            case 'ADD': {
                const b = this.stack.pop();
                const a = this.stack.pop();
                this.stack.push({
                    type: 'binop',
                    op: '+',
                    left: a,
                    right: b
                });
                break;
            }

            case 'POP_REG': {
                const value = this.stack.pop();
                this.expressions.push({
                    type: 'assign',
                    target: `r${instruction.args[0]}`,
                    value: value
                });
                break;
            }

            // ... more handlers
        }
    }

    toCode(expr) {
        if (!expr) return '';

        switch (expr.type) {
            case 'const':
                return String(expr.value);
            case 'var':
                return expr.name;
            case 'binop':
                return `(${this.toCode(expr.left)} ${expr.op} ${this.toCode(expr.right)})`;
            case 'assign':
                return `${expr.target} = ${this.toCode(expr.value)}`;
            default:
                return JSON.stringify(expr);
        }
    }

    getDecompiledCode() {
        return this.expressions.map(e => this.toCode(e)).join(';\n');
    }
}
```

#### 6.2 Control Flow Reconstruction

```javascript
// Reconstruct if/while/for from bytecode
class ControlFlowReconstructor {
    constructor(blocks) {
        this.blocks = blocks;
        this.visited = new Set();
    }

    reconstruct() {
        const ast = [];

        for (const block of this.blocks) {
            if (this.visited.has(block.start)) continue;

            const node = this.processBlock(block);
            if (node) ast.push(node);
        }

        return ast;
    }

    processBlock(block) {
        this.visited.add(block.start);

        // Check for loop pattern (back edge)
        if (block.exits.some(e => e <= block.start)) {
            return {
                type: 'while',
                condition: this.extractCondition(block),
                body: this.extractBody(block)
            };
        }

        // Check for if pattern (forward conditional jump)
        const lastInst = block.instructions[block.instructions.length - 1];
        if (['JZ', 'JNZ'].includes(lastInst?.name)) {
            return {
                type: 'if',
                condition: this.extractCondition(block),
                then: this.processBlock(this.getBlock(lastInst.args[0])),
                else: this.processBlock(this.getBlock(block.start + block.instructions.length))
            };
        }

        return {
            type: 'sequence',
            instructions: block.instructions
        };
    }

    getBlock(address) {
        return this.blocks.find(b => b.start === address);
    }

    extractCondition(block) {
        // Extract comparison from block
        return '/* condition */';
    }

    extractBody(block) {
        return '/* body */';
    }
}
```

### Step 7: Common JSVMP Implementations

#### 7.1 某数 (MouShu) / 瑞数

```javascript
// 特征识别
const mouShuPatterns = {
    // 典型的数组混淆
    arrayShift: /\['push'\]\(\w+\['shift'\]\(\)\)/,
    // 自执行函数嵌套
    iife: /\(function\(\w+,\w+\)\{.*?\}\(\w+,0x/,
    // 环境检测
    envCheck: /navigator\['userAgent'\]|document\['cookie'\]/
};

// 分析流程
// 1. 找到主入口函数
// 2. 定位字符串解密函数
// 3. 解密所有字符串
// 4. 分析VM dispatcher
// 5. 提取opcode语义
```

#### 7.2 极验 (GeeTest)

```javascript
// 极验JSVMP特征
const geetestPatterns = {
    // W参数生成
    wParam: /\$_\w+\s*=\s*function/,
    // 滑块轨迹处理
    track: /passtime|track|distance/,
    // 加密相关
    crypto: /aes|rsa|md5|sha/i
};

// 分析重点
// 1. W参数的生成逻辑
// 2. 轨迹数据的加密方式
// 3. 时间戳和随机数的处理
```

## Output Format

```markdown
## JSVMP Analysis Report

### Overview
- **Protection Type**: {{JSVMP_VARIANT}}
- **Complexity**: {{LOW/MEDIUM/HIGH/EXTREME}}
- **Estimated Opcodes**: {{COUNT}}
- **Dispatcher Type**: {{SWITCH/TABLE/THREADED}}

### Architecture

#### VM Components
| Component | Location | Description |
|-----------|----------|-------------|
| Dispatcher | {{LOCATION}} | {{DESC}} |
| Stack | {{VAR_NAME}} | {{DESC}} |
| Registers | {{VAR_NAME}} | {{DESC}} |
| Bytecode | {{VAR_NAME}} | {{DESC}} |

#### Opcode Map
| Opcode | Hex | Name | Args | Description |
|--------|-----|------|------|-------------|
| {{OP}} | {{HEX}} | {{NAME}} | {{ARGS}} | {{DESC}} |

### Disassembly

```
0000: PUSH_CONST 10
0002: PUSH_CONST 20
0004: ADD
0005: POP_REG 0
...
```

### Decompiled Code

```javascript
// Reconstructed logic
{{DECOMPILED_CODE}}
```

### Key Findings

#### Entry Points
- {{ENTRY_1}}
- {{ENTRY_2}}

#### Critical Functions
| Function | Purpose | Location |
|----------|---------|----------|
| {{FUNC}} | {{PURPOSE}} | {{LOC}} |

#### Anti-Analysis Techniques
- {{TECHNIQUE_1}}
- {{TECHNIQUE_2}}

### Recommendations
1. {{REC_1}}
2. {{REC_2}}
```

## Tools Reference

| Tool | Purpose |
|------|---------|
| **AST Explorer** | JavaScript AST analysis |
| **Babel** | Code transformation |
| **escodegen** | AST to code |
| **esprima** | JS parser |
| **Chrome DevTools** | Dynamic analysis |
| **Frida** | Runtime instrumentation |

## Best Practices

1. **Start with static analysis** - Understand the VM structure before running
2. **Map opcodes incrementally** - Don't try to understand all at once
3. **Use frequency analysis** - Common opcodes are usually basic operations
4. **Look for patterns** - PUSH-PUSH-OP-POP is typical
5. **Trace critical paths** - Focus on important functionality
6. **Document as you go** - Build opcode reference progressively
7. **Automate where possible** - Write helper scripts for repetitive tasks

## Usage

```
/jsvmp-analysis

[Paste JSVMP-protected JavaScript code]
```

This will:
1. Identify JSVMP variant and structure
2. Extract opcode handlers
3. Generate disassembly
4. Attempt decompilation
5. Document analysis findings
