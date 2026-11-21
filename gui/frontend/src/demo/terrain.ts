// Authentic reverse-engineering sample terrain datasets for the standalone
// browser Demo Sandbox (zero backend required; mirrors internal/tools/terrain.go).
import type { BinaryTerrainDTO, TerrainBucketDTO, WorkspaceFileDTO } from '../lib/types'

export const DEMO_WORKSPACE_FILES: WorkspaceFileDTO[] = [
  { path: 'chall.elf', size: 65536, format: 'ELF', isBinary: true },
  { path: 'chall_patched.elf', size: 65536, format: 'ELF', isBinary: true },
  { path: 'libnative-sign.so', size: 131072, format: 'ELF', isBinary: true },
  { path: 'carrier.bin', size: 16384, format: 'Raw Binary', isBinary: true },
  { path: 'chall.js', size: 412, format: 'Text', isBinary: false },
]

function makeBuckets(
  totalSize: number,
  count: number,
  profile: (ratio: number, offset: number) => { entropy: number; printable: number; hex: string; ascii: string },
): TerrainBucketDTO[] {
  const out: TerrainBucketDTO[] = []
  for (let i = 0; i < count; i++) {
    const offset = Math.floor((i * totalSize) / count)
    const next = Math.floor(((i + 1) * totalSize) / count)
    const ratio = i / Math.max(1, count - 1)
    const p = profile(ratio, offset)
    out.push({
      offset,
      size: Math.max(1, next - offset),
      entropy: Math.round(p.entropy * 1000) / 1000,
      printable: Math.round(p.printable * 1000) / 1000,
      hexPreview: p.hex,
      asciiPreview: p.ascii,
    })
  }
  return out
}

const CHALL_ELF: BinaryTerrainDTO = {
  path: 'chall.elf',
  format: 'ELF',
  arch: 'EM_X86_64',
  size: 65536,
  sampled: 65536,
  sha256: 'c5c74a9e8eff5d3e75d63dcb96ef95f4ef79b1dc0bc1c8b39c2e0f6fde1f2a45',
  overallEntropy: 6.184,
  maxEntropy: 7.912,
  entryPoint: '0x401060',
  mitigations: {
    PIE: 'yes (PIE executable)',
    NX: 'yes',
    canary: 'yes',
    RELRO: 'partial',
    stripped: 'no',
    RWX: 'yes (RWX PT_LOAD)',
  },
  sections: [
    { name: '.init_array', offset: 0x0800, size: 0x0400, vaddr: '0x400800', flags: 'AW', entropy: 2.41, isConstructor: true },
    { name: '.text', offset: 0x1000, size: 0x5400, vaddr: '0x401000', flags: 'AX', entropy: 6.18 },
    { name: '.rodata', offset: 0x6800, size: 0x2400, vaddr: '0x406800', flags: 'A', entropy: 4.82 },
    { name: '.packed_stub', offset: 0x9000, size: 0x4800, vaddr: '0x409000', flags: 'AWX', entropy: 7.89, rwx: true },
    { name: '.data', offset: 0xdc00, size: 0x1800, vaddr: '0x40dc00', flags: 'AW', entropy: 3.15 },
  ],
  entropy: makeBuckets(65536, 96, (r, off) => {
    if (off < 0x1000) return { entropy: 2.2 + r * 6, printable: 0.18, hex: '7f454c46020101000000000000000000', ascii: '.ELF............' }
    if (off >= 0x1000 && off < 0x6400) {
      const wave = 5.85 + Math.sin(off * 0.004) * 0.45
      return { entropy: wave, printable: 0.12, hex: '554889e54883ec20488b05c90a000048', ascii: 'UH..H.. H......H' }
    }
    if (off >= 0x6800 && off < 0x8c00) {
      return { entropy: 4.75 + Math.cos(off * 0.005) * 0.35, printable: 0.78, hex: '2f70726f632f73656c662f7374617475', ascii: '/proc/self/statu' }
    }
    if (off >= 0x9000 && off < 0xd800) {
      const spike = 7.62 + Math.abs(Math.sin(off * 0.007)) * 0.29
      return { entropy: spike, printable: 0.04, hex: '9f3c7e1a44d8b205e16a8f93c02b5d77', ascii: '.<~.D....j....]w' }
    }
    return { entropy: 2.6 + Math.abs(Math.sin(off * 0.003)) * 1.1, printable: 0.22, hex: '000000002a0000001a524b4c515d4b58', ascii: '....*....RKLQ]KX' }
  }),
  carves: [
    { offset: 0x9020, kind: 'GZIP', signature: '1f 8b 08 (compressed unpacker payload)' },
    { offset: 0xd980, kind: 'ZIP', signature: 'PK\\x03\\x04 (embedded license resource)' },
  ],
  anti: [
    {
      category: 'anti_debug',
      confidence: 'high',
      description: 'ptrace reference (PTRACE_TRACEME self-trace check)',
      detail: 'ptrace',
      offset: 0x1184,
      bypass: 'ptrace: NOP PTRACE_TRACEME or hook ptrace() to return 0 on first call.',
    },
    {
      category: 'anti_debug',
      confidence: 'high',
      description: 'TracerPid check via /proc/self/status',
      detail: '/proc/self/status',
      offset: 0x6940,
      bypass: 'TracerPid: rewrite /proc/self/status read buffer so TracerPid reports 0.',
    },
    {
      category: 'packer_obfuscation',
      confidence: 'high',
      description: 'RWX PT_LOAD & encrypted executable section .packed_stub (entropy 7.89)',
      detail: 'addr=0x409000 size=0x4800',
      offset: 0x9000,
      bypass: 'Packed/RWX stub: break after .init_array / mprotect transition and dump unpacked memory.',
    },
  ],
  diffs: [],
}

const LIBNATIVE_SO: BinaryTerrainDTO = {
  path: 'libnative-sign.so',
  format: 'ELF',
  arch: 'EM_AARCH64',
  size: 131072,
  sampled: 131072,
  sha256: '8b4e2f109ac3d77f1204c9a12b7c3e4f991a0e84d51f23c8824c1b7042a9d103',
  overallEntropy: 6.54,
  maxEntropy: 7.86,
  entryPoint: '0x18240',
  mitigations: {
    PIE: 'dso (position-independent shared library)',
    NX: 'yes',
    canary: 'yes',
    RELRO: 'full',
    stripped: 'yes',
  },
  sections: [
    { name: '.init_array', offset: 0x1400, size: 0x0c00, vaddr: '0x1400', flags: 'AW', entropy: 3.12, isConstructor: true },
    { name: '.text', offset: 0x4000, size: 0x12000, vaddr: '0x4000', flags: 'AX', entropy: 6.74 },
    { name: '.rodata', offset: 0x16800, size: 0x4200, vaddr: '0x16800', flags: 'A', entropy: 5.42 },
    { name: '.wb_tables', offset: 0x1b000, size: 0x4400, vaddr: '0x1b000', flags: 'A', entropy: 7.84 },
  ],
  entropy: makeBuckets(131072, 96, (_r, off) => {
    if (off >= 0x1b000 && off < 0x1f400) {
      return { entropy: 7.72 + Math.abs(Math.sin(off * 0.002)) * 0.14, printable: 0.03, hex: 'a4c7128e5b9104d37f2a6c81e0449b12', ascii: '......[....l....' }
    }
    if (off >= 0x4000 && off < 0x16000) {
      return { entropy: 6.45 + Math.sin(off * 0.001) * 0.4, printable: 0.09, hex: '010000d4fd7bbfa9fd030091e0031faa', ascii: '.....{..........' }
    }
    return { entropy: 4.1 + Math.abs(Math.cos(off * 0.002)) * 1.4, printable: 0.46, hex: '4a4e495f4f6e4c6f6164006672696461', ascii: 'JNI_OnLoad.frida' }
  }),
  carves: [],
  anti: [
    {
      category: 'anti_frida',
      confidence: 'high',
      description: 'Direct ARM64 `svc #0` instructions in .text (14 hits) — bypasses libc PLT/Frida hooks',
      detail: 'first at VA 0x74a0',
      offset: 0x74a0,
      bypass: 'Direct ARM64 SVC: libc hooks will miss these; use Stalker or Unicorn/unidbg syscall hooks.',
    },
    {
      category: 'anti_frida',
      confidence: 'high',
      description: 'frida-agent library/maps scan + port 27042 check',
      detail: 'frida-agent',
      offset: 0x17220,
      bypass: 'Frida detection: rename frida-server, run on custom port, or emulate offline with unidbg.',
    },
    {
      category: 'packer_obfuscation',
      confidence: 'medium',
      description: 'White-box lookup table / high-entropy constant table (.wb_tables, 7.84 b/B)',
      detail: 'addr=0x1b000 size=0x4400',
      offset: 0x1b000,
      bypass: 'White-box AES/SM4: check `whitebox-dfa` skill to fault round 8-9 state in Unicorn/unidbg.',
    },
  ],
  diffs: [],
}

const CARRIER_BIN: BinaryTerrainDTO = {
  path: 'carrier.bin',
  format: 'Raw Binary',
  size: 16384,
  sampled: 16384,
  sha256: '3b926e1a779e76bbbe658c5e5d79f5a091b3657570d99b9f4a39db0c8ec99ba1',
  overallEntropy: 5.92,
  maxEntropy: 7.78,
  mitigations: {},
  sections: [
    { name: 'header_prefix', offset: 0x0000, size: 0x0800, flags: 'R', entropy: 3.4 },
    { name: 'embedded_pdf', offset: 0x0c00, size: 0x1200, flags: 'R', entropy: 4.9 },
    { name: 'encrypted_blob', offset: 0x2200, size: 0x1600, flags: 'R', entropy: 7.76 },
    { name: 'zip_trailer', offset: 0x3a00, size: 0x0600, flags: 'R', entropy: 5.1 },
  ],
  entropy: makeBuckets(16384, 96, (_r, off) => {
    if (off >= 0x2200 && off < 0x3800) {
      return { entropy: 7.65 + Math.abs(Math.sin(off * 0.01)) * 0.13, printable: 0.04, hex: 'd41d8cd98f00b204e9800998ecf8427e', ascii: '..............B~' }
    }
    if (off >= 0x0c00 && off < 0x1e00) {
      return { entropy: 4.85, printable: 0.85, hex: '255044462d312e370a312030206f626a', ascii: '%PDF-1.7.1 0 obj' }
    }
    return { entropy: 3.8 + Math.abs(Math.cos(off * 0.008)) * 0.9, printable: 0.65, hex: '504b030414000000080064656d6f5f7a', ascii: 'PK........demo_z' }
  }),
  carves: [
    { offset: 0x0c00, kind: 'PDF', signature: '%PDF-1.7 (1-object catalog stub)' },
    { offset: 0x3a00, kind: 'ZIP', signature: 'PK\\x03\\x04 (incomplete central directory marker)' },
  ],
  anti: [],
  diffs: [],
}

const CHALL_DIFFS = [
  {
    offset: 0x1184,
    length: 5,
    bytesA: 'e877feffff',
    bytesB: '9090909090',
    classification: ['x86 NOP sled patch (bypass ptrace check)'],
  },
  {
    offset: 0x2420,
    length: 6,
    bytesA: '554889e54883',
    bytesB: 'b801000000c3',
    classification: ['x86/x64 `mov eax, 1; ret` (force verify_serial true)'],
  },
]

export function getDemoTerrain(path: string, comparePath = ''): BinaryTerrainDTO {
  let base: BinaryTerrainDTO
  if (path === 'libnative-sign.so') base = LIBNATIVE_SO
  else if (path === 'carrier.bin') base = CARRIER_BIN
  else base = { ...CHALL_ELF, path: path || 'chall.elf' }

  const cloned: BinaryTerrainDTO = {
    ...base,
    sections: [...base.sections],
    entropy: [...base.entropy],
    carves: [...base.carves],
    anti: [...base.anti],
    diffs: [],
  }
  if (
    comparePath &&
    comparePath !== cloned.path &&
    ((cloned.path === 'chall.elf' && comparePath === 'chall_patched.elf') ||
      (cloned.path === 'chall_patched.elf' && comparePath === 'chall.elf'))
  ) {
    cloned.comparePath = comparePath
    cloned.diffs = CHALL_DIFFS
  } else if (comparePath && comparePath !== cloned.path) {
    cloned.comparePath = comparePath
    cloned.diffs = [
      {
        offset: 0x0c00,
        length: 8,
        bytesA: '255044462d312e37',
        bytesB: '7f454c4602010100',
        classification: ['header container mismatch'],
      },
    ]
  }
  return cloned
}
