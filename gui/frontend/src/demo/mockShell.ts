// Interactive simulated PTY shell for Demo Sandbox mode.
// Speaks the exact gui:shell base64 byte protocol so the real xterm.js
// ShellView renders ANSI colors, line editing, history, tab completion, and
// genuine execution of `node chall.js <token>` / `base64 -d` / `ls` / `cat`.
import type { ShellInfo } from '../lib/types'
import { emitDemoShellEvent } from '../lib/events'
import { emitDemoSignal } from './signals'

// ---------- virtual demo filesystem ----------

const CHALL_JS = `#!/usr/bin/env node

const key = 0x2a;
const encoded = [26, 82, 75, 76, 81, 93, 75, 88, 71, 95, 90, 117, 78, 79, 73, 65, 87];
const expected = encoded.map(value => String.fromCharCode(value ^ key)).join("");

const provided = process.argv[2] ?? "";

if (!provided) {
  console.log("usage: node chall.js <token>");
  process.exit(2);
}

if (provided === expected) {
  console.log("accepted");
  process.exit(0);
}

console.log("rejected");
process.exit(1);`

const SESSION_LOG = `[2026-11-20 14:02:11] boot target=welcome-checker
[2026-11-20 14:02:12] probe input="test" -> rejected (exit=1)
[2026-11-20 14:02:15] hint: single-byte XOR table lives directly in chall.js`

const OPERATOR_NOTES = `# Operator Notes
- Suspect constant key in chall.js (0x2a = 42)
- Expected flag format: 0xaf{...}
- Verify locally with: node chall.js '<token>'`

const ARTIFACT_TXT = `CTF demo artifact

Hints:
- base64 candidate: ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9
- suspicious endpoint: https://ctf.example.invalid/api/sign
- crypto words: AES CBC HMAC SHA256 token secret
- pwn words: system /bin/sh printf strcpy

The useful answer is encoded, not hidden by network access.`

const CARRIER_HEX = `00000000: 6361 7272 6965 722d 7072 6566 6978 0a6e  carrier-prefix.n
00000010: 6f69 7365 206e 6f69 7365 206e 6f69 7365  oise noise noise
00000020: 0a25 5044 462d 312e 370a 3120 3020 6f62  .%PDF-1.7.1 0 ob
00000030: 6a20 3c3c 202f 5479 7065 202f 4361 7461  j << /Type /Cata
00000040: 6c6f 6720 3e3e 2065 6e64 6f62 6a0a 2525  log >> endobj.%%
00000050: 454f 460a 6d6f 7265 2d6e 6f69 7365 0a50  EOF.more-noise.P
00000060: 4b03 0464 656d 6f20 7a69 7020 6d61 726b  K..demo zip mark
00000070: 6572 0a66 696e 616c 0a                   er.final.`

interface VFile {
  name: string
  size: number
  mode: string
  content: string
  fileType: string
  binary?: boolean
}

const WORKSPACE_FILES: Record<string, Record<string, VFile>> = {
  '/demo/welcome': {
    'chall.js': {
      name: 'chall.js',
      size: CHALL_JS.length,
      mode: '-rwxr-xr-x',
      content: CHALL_JS,
      fileType: 'Node.js script, ASCII text executable',
    },
    'README.md': {
      name: 'README.md',
      size: 412,
      mode: '-rw-r--r--',
      content: '# Welcome Demo Workspace\n\nTry:\n  node chall.js test\n  node chall.js 0xaf{warmup_deck}\n',
      fileType: 'UTF-8 Unicode text',
    },
    'artifacts/session.log': {
      name: 'artifacts/session.log',
      size: SESSION_LOG.length,
      mode: '-rw-r--r--',
      content: SESSION_LOG,
      fileType: 'ASCII text',
    },
    'artifacts/operator-notes.txt': {
      name: 'artifacts/operator-notes.txt',
      size: OPERATOR_NOTES.length,
      mode: '-rw-r--r--',
      content: OPERATOR_NOTES,
      fileType: 'ASCII text',
    },
  },
  '/demo/reverse-lab': {
    'carrier.bin': {
      name: 'carrier.bin',
      size: 121,
      mode: '-rw-r--r--',
      content: CARRIER_HEX,
      fileType: 'data (contains %PDF-1.7 at 0x21, PK\\x03\\x04 at 0x5f)',
      binary: true,
    },
    'artifact.txt': {
      name: 'artifact.txt',
      size: ARTIFACT_TXT.length,
      mode: '-rw-r--r--',
      content: ARTIFACT_TXT,
      fileType: 'ASCII text',
    },
    'README.md': {
      name: 'README.md',
      size: 298,
      mode: '-rw-r--r--',
      content: '# Reverse Lab Demo\n\nFixtures: carrier.bin (121B), artifact.txt\n',
      fileType: 'ASCII text',
    },
  },
  '/demo/android-sign': {
    'app-release.apk': {
      name: 'app-release.apk',
      size: 4812944,
      mode: '-rw-r--r--',
      content: '[binary APK archive — use `file` or `strings`]',
      fileType: 'Zip archive data (Android APK, minSdk=24, targetSdk=34)',
      binary: true,
    },
    'libnative-sign.so': {
      name: 'libnative-sign.so',
      size: 294912,
      mode: '-rwxr-xr-x',
      content: '[ELF 64-bit LSB shared object, ARM aarch64]',
      fileType: 'ELF 64-bit LSB shared object, ARM aarch64, stripped',
      binary: true,
    },
    'notes.md': {
      name: 'notes.md',
      size: 218,
      mode: '-rw-r--r--',
      content: '# JNI Sign Notes\n- Java entry: com.example.auth.Signer.signPayload(String)\n- Native symbol: JNI_OnLoad -> sub_8f4c\n',
      fileType: 'ASCII text',
    },
  },
  '/demo/elf-packer': {
    'crackme_x64': {
      name: 'crackme_x64',
      size: 65536,
      mode: '-rwxr-xr-x',
      content: '[ELF 64-bit LSB pie executable, x86-64, UPX packed]',
      fileType: 'ELF 64-bit LSB pie executable, x86-64, statically linked, UPX! packed',
      binary: true,
    },
    'strings.txt': {
      name: 'strings.txt',
      size: 184,
      mode: '-rw-r--r--',
      content: 'UPX!\nptrace\n/proc/self/status\nTracerPid:\nEnter license key:\n',
      fileType: 'ASCII text',
    },
  },
}

// ---------- UTF-8 safe base64 ----------

const encoder = new TextEncoder()

function utf8ToBase64(text: string): string {
  const bytes = encoder.encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i])
  }
  return btoa(bin)
}

function sendData(shellId: string, text: string): void {
  emitDemoShellEvent({ shellId, kind: 'data', b64: utf8ToBase64(text), code: 0 })
}

// ---------- shell instance ----------

interface DemoShellState {
  info: ShellInfo
  line: string
  history: string[]
  histIdx: number
  closed: boolean
  timers: Set<ReturnType<typeof setTimeout>>
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  violet: '\x1b[35m',
}

function promptOf(cwd: string): string {
  const short = cwd.split('/').filter(Boolean).pop() || 'demo'
  return `${ANSI.cyan}0xaf${ANSI.reset}:${ANSI.violet}${short}${ANSI.reset}$ `
}

function filesFor(cwd: string): Record<string, VFile> {
  return WORKSPACE_FILES[cwd] ?? WORKSPACE_FILES['/demo/welcome']
}

function stripQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1)
  }
  return s
}

function decodeBase64Safe(s: string): string {
  try {
    return atob(s.trim())
  } catch {
    return '(invalid base64 input)'
  }
}

export class DemoShellManager {
  private shells = new Map<string, DemoShellState>()
  private seq = 0

  start(cwd: string): ShellInfo {
    this.seq += 1
    const norm = cwd && WORKSPACE_FILES[cwd] ? cwd : cwd || '/demo/welcome'
    const info: ShellInfo = {
      id: `demo-sh-${this.seq}`,
      cwd: norm,
      pid: 4100 + this.seq * 17,
    }
    const state: DemoShellState = {
      info,
      line: '',
      history: [],
      histIdx: 0,
      closed: false,
      timers: new Set(),
    }
    this.shells.set(info.id, state)

    // Give ShellView a moment to mount xterm and register its sink before banner lands.
    const t = setTimeout(() => {
      state.timers.delete(t)
      if (state.closed) return
      const banner = [
        `${ANSI.dim}── 0xAF·RE demo PTY (${info.cwd}) · 输入 help 查看可用命令 ──${ANSI.reset}`,
        `${ANSI.dim}提示: 试试 ls -la · cat chall.js · node chall.js '0xaf{warmup_deck}'${ANSI.reset}`,
        '',
        promptOf(info.cwd),
      ].join('\r\n')
      sendData(info.id, banner)
    }, 90)
    state.timers.add(t)

    emitDemoSignal({ type: 'shell_opened', shellId: info.id, cwd: info.cwd })
    return info
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map((s) => s.info)
  }

  stop(id: string): void {
    const s = this.shells.get(id)
    if (!s) return
    s.closed = true
    for (const t of s.timers) clearTimeout(t)
    s.timers.clear()
    this.shells.delete(id)
    emitDemoShellEvent({ shellId: id, kind: 'exit', b64: '', code: 0 })
  }

  stopAll(): void {
    for (const id of [...this.shells.keys()]) {
      this.stop(id)
    }
  }

  /** Programmatically type a command into the shell (used by Coach Bar auto-play). */
  typeCommand(id: string, cmd: string): void {
    const s = this.shells.get(id)
    if (!s || s.closed) return
    // Clear any partial input first
    if (s.line.length > 0) {
      sendData(id, '\b \b'.repeat(s.line.length))
      s.line = ''
    }
    let idx = 0
    const step = () => {
      if (s.closed) return
      if (idx < cmd.length) {
        const ch = cmd[idx++]
        this.write(id, ch)
        const t = setTimeout(() => {
          s.timers.delete(t)
          step()
        }, 18)
        s.timers.add(t)
      } else {
        const t = setTimeout(() => {
          s.timers.delete(t)
          this.write(id, '\r')
        }, 90)
        s.timers.add(t)
      }
    }
    step()
  }

  write(id: string, data: string): void {
    const s = this.shells.get(id)
    if (!s || s.closed) return

    // Handle arrow keys (history navigation)
    if (data === '\x1b[A') {
      if (s.history.length > 0 && s.histIdx > 0) {
        s.histIdx -= 1
        this.replaceLine(s, s.history[s.histIdx])
      }
      return
    }
    if (data === '\x1b[B') {
      if (s.histIdx < s.history.length - 1) {
        s.histIdx += 1
        this.replaceLine(s, s.history[s.histIdx])
      } else if (s.histIdx === s.history.length - 1) {
        s.histIdx = s.history.length
        this.replaceLine(s, '')
      }
      return
    }
    // Ignore other escape sequences
    if (data.startsWith('\x1b')) return

    for (let i = 0; i < data.length; i++) {
      const ch = data[i]
      if (ch === '\r' || ch === '\n') {
        const cmd = s.line.trim()
        sendData(id, '\r\n')
        s.line = ''
        if (cmd) {
          s.history.push(cmd)
          s.histIdx = s.history.length
          const shouldContinue = this.exec(s, cmd)
          if (!shouldContinue) return
        }
        sendData(id, promptOf(s.info.cwd))
      } else if (ch === '\x7f' || ch === '\b') {
        if (s.line.length > 0) {
          s.line = s.line.slice(0, -1)
          sendData(id, '\b \b')
        }
      } else if (ch === '\x03') {
        // Ctrl+C
        s.line = ''
        sendData(id, `^C\r\n${promptOf(s.info.cwd)}`)
      } else if (ch === '\x0c') {
        // Ctrl+L
        sendData(id, `\x1b[2J\x1b[H${promptOf(s.info.cwd)}${s.line}`)
      } else if (ch === '\t') {
        this.autocomplete(s)
      } else if (ch >= ' ') {
        s.line += ch
        sendData(id, ch)
      }
    }
  }

  private replaceLine(s: DemoShellState, next: string): void {
    if (s.line.length > 0) {
      sendData(s.info.id, '\b \b'.repeat(s.line.length))
    }
    s.line = next
    if (next) sendData(s.info.id, next)
  }

  private autocomplete(s: DemoShellState): void {
    const parts = s.line.split(/\s+/)
    const last = parts[parts.length - 1] ?? ''
    if (!last) return
    const files = Object.keys(filesFor(s.info.cwd))
    const hit = files.find((f) => f.startsWith(last))
    if (hit) {
      const rest = hit.slice(last.length)
      s.line += rest
      sendData(s.info.id, rest)
    }
  }

  private exec(s: DemoShellState, rawCmd: string): boolean {
    const id = s.info.id
    const files = filesFor(s.info.cwd)
    const pipeMatch = rawCmd.match(/^echo\s+(.+?)\s*\|\s*base64\s+(-d|--decode)$/)
    if (pipeMatch) {
      const decoded = decodeBase64Safe(stripQuotes(pipeMatch[1].trim()))
      sendData(id, `${ANSI.green}${decoded}${ANSI.reset}\r\n`)
      emitDemoSignal({ type: 'shell_command', shellId: id, command: rawCmd, output: decoded })
      return true
    }

    const tokens = rawCmd.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
    const cmd = tokens[0] ?? ''
    const args = tokens.slice(1).map(stripQuotes)

    let out = ''
    switch (cmd) {
      case 'help':
        out = [
          `${ANSI.cyan}Demo Shell 可用命令:${ANSI.reset}`,
          `  ls [-la]                  列出当前演示目录文件`,
          `  cat <file>                查看文本文件内容（如 cat chall.js）`,
          `  node chall.js <token>     真实运行令牌校验脚本（试试 '0xaf{warmup_deck}'）`,
          `  file <file>               识别文件类型`,
          `  strings <file>            提取可读字符串`,
          `  xxd <file>                十六进制转储`,
          `  echo <b64> | base64 -d    Base64 解码`,
          `  cd <dir>                  切换演示目录（/demo/welcome · /demo/reverse-lab）`,
          `  pwd / clear / exit        常用基础命令`,
        ].join('\r\n')
        break

      case 'clear':
        sendData(id, '\x1b[2J\x1b[H')
        emitDemoSignal({ type: 'shell_command', shellId: id, command: rawCmd, output: '' })
        return true

      case 'exit':
        sendData(id, `${ANSI.dim}logout${ANSI.reset}\r\n`)
        this.stop(id)
        return false

      case 'pwd':
        out = s.info.cwd
        break

      case 'whoami':
        out = '0xaf-operator'
        break

      case 'uname':
        out = 'Darwin 0xaf-demo-lab 24.1.0 arm64'
        break

      case 'cd': {
        const target = args[0] || '/demo/welcome'
        const resolved = WORKSPACE_FILES[target]
          ? target
          : WORKSPACE_FILES[`/demo/${target}`]
            ? `/demo/${target}`
            : null
        if (!resolved) {
          out = `${ANSI.red}cd: no such demo directory: ${target}${ANSI.reset} (try /demo/welcome or /demo/reverse-lab)`
        } else {
          s.info = { ...s.info, cwd: resolved }
        }
        break
      }

      case 'ls':
      case 'll': {
        const long = cmd === 'll' || args.some((a) => a.includes('l'))
        const list = Object.values(files)
        if (long) {
          out = [
            `total ${list.length * 8}`,
            ...list.map(
              (f) =>
                `${ANSI.dim}${f.mode}${ANSI.reset}  1 operator  staff  ${String(f.size).padStart(7)}  Nov 20 14:00  ${f.binary ? ANSI.violet : ANSI.cyan}${f.name}${ANSI.reset}`,
            ),
          ].join('\r\n')
        } else {
          out = list.map((f) => `${f.binary ? ANSI.violet : ANSI.cyan}${f.name}${ANSI.reset}`).join('   ')
        }
        break
      }

      case 'cat':
      case 'head': {
        const target = args[0]?.replace(/^\.\//, '')
        const f = target ? files[target] : undefined
        if (!target) {
          out = `${ANSI.yellow}usage: ${cmd} <file>${ANSI.reset}`
        } else if (!f) {
          out = `${ANSI.red}${cmd}: ${target}: No such file or directory${ANSI.reset}`
        } else {
          out = f.content.replace(/\n/g, '\r\n')
        }
        break
      }

      case 'file': {
        const target = args[0]?.replace(/^\.\//, '')
        const f = target ? files[target] : undefined
        out = f
          ? `${target}: ${ANSI.cyan}${f.fileType}${ANSI.reset}`
          : `${ANSI.red}file: ${target || ''}: cannot open${ANSI.reset}`
        break
      }

      case 'strings': {
        const target = args[0]?.replace(/^\.\//, '')
        if (target === 'carrier.bin') {
          out = ['carrier-prefix', 'noise noise noise', '%PDF-1.7', '1 0 obj << /Type /Catalog >> endobj', '%%EOF', 'more-noise', 'demo zip marker', 'final'].join('\r\n')
        } else if (target === 'libnative-sign.so') {
          out = ['JNI_OnLoad', 'Java_com_example_auth_Signer_signPayload', 'HMAC-SHA256', '/proc/self/maps', 'frida-agent'].join('\r\n')
        } else if (target === 'crackme_x64') {
          out = ['UPX!', 'UPX0', 'UPX1', 'ptrace', 'TracerPid:', 'Enter license key:'].join('\r\n')
        } else if (target && files[target]) {
          out = files[target].content.split('\n').slice(0, 12).join('\r\n')
        } else {
          out = `${ANSI.red}strings: ${target || ''}: No such file${ANSI.reset}`
        }
        break
      }

      case 'xxd':
      case 'hexdump': {
        const target = args[0]?.replace(/^\.\//, '')
        if (target === 'carrier.bin') {
          out = CARRIER_HEX.replace(/\n/g, '\r\n')
        } else if (target && files[target]) {
          const sample = files[target].content.slice(0, 48)
          const hex = Array.from(sample)
            .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
            .join(' ')
          out = `00000000: ${hex}`
        } else {
          out = `${ANSI.red}${cmd}: ${target || ''}: No such file${ANSI.reset}`
        }
        break
      }

      case 'node': {
        const script = args[0]?.replace(/^\.\//, '')
        if (script !== 'chall.js' && script !== 'demos/welcome/chall.js') {
          out = `${ANSI.red}node: cannot find module '${args[0] || ''}'${ANSI.reset}`
          break
        }
        const provided = args[1] ?? ''
        const expected = [26, 82, 75, 76, 81, 93, 75, 88, 71, 95, 90, 117, 78, 79, 73, 65, 87]
          .map((v) => String.fromCharCode(v ^ 0x2a))
          .join('')
        if (!provided) {
          out = `${ANSI.yellow}usage: node chall.js <token>${ANSI.reset}`
        } else if (provided === expected) {
          out = `${ANSI.green}${ANSI.bold}accepted${ANSI.reset}`
        } else {
          out = `${ANSI.red}rejected${ANSI.reset} ${ANSI.dim}(hint: 试试 '0xaf{warmup_deck}')${ANSI.reset}`
        }
        break
      }

      case 'echo':
        out = args.join(' ')
        break

      case 'sha256sum': {
        const target = args[0]?.replace(/^\.\//, '')
        out =
          target && files[target]
            ? `9e4a7c2b1f08d6e35c14a8b7d201f93e41c7b8a2f6e5d4c3b2a10987654321ab  ${target}`
            : `${ANSI.red}sha256sum: ${target || ''}: No such file${ANSI.reset}`
        break
      }

      default:
        out = `${ANSI.yellow}demo-sh: command not found: ${cmd}${ANSI.reset} ${ANSI.dim}(输入 help 查看演示命令)${ANSI.reset}`
        break
    }

    if (out) sendData(id, `${out}\r\n`)
    emitDemoSignal({ type: 'shell_command', shellId: id, command: rawCmd, output: out })
    return true
  }
}
