import { describe, expect, it } from 'vitest'
import { getDemoTerrain } from '../../demo/terrain'
import type { EvidenceRecord, FindingDTO, FlowDTO, HudDTO, Hypothesis, TickDTO, ToolRunSnapshot } from '../../lib/types'
import {
  buildForensicJsonBundle,
  buildProvenanceChain,
  classifyEntropy,
  classifyToolCall,
  computeLatencyStats,
  evaluateMitigationPosture,
  evaluatePhaseGates,
  formatEvidenceCitation,
  formatHypothesisCitation,
  resolveOffsetMapping,
} from './forensics'

function makeTick(overrides: Partial<TickDTO> = {}): TickDTO {
  const flow: FlowDTO = {
    stage: 'done',
    turn: 3,
    provider: 'codex-sol',
    model: 'codex-1',
    endpoint: 'local',
    messages: 10,
    sentTokens: 4200,
    usage: { input: 3000, output: 1200, thinking: 800, cacheRead: 1000, cacheWrite: 0, costUsd: 0.042 },
    pendingCalls: 0,
    activeTool: '',
    toolStartedAt: 0,
    toolMs: 0,
    toolsOk: 4,
    toolsFailed: 1,
    toolRuns: [],
    replyChars: 640,
    compactedDrop: 0,
    compactedElide: 0,
    hasCompacted: false,
    plan: null,
    planKind: '',
    error: '',
    frame: 0,
    packets: [],
    since: 0,
  }
  const hud: HudDTO = {
    phase: 'idle',
    frame: '',
    elapsedMs: 12000,
    stats: flow.usage,
    spark: [10, 40, 25],
    route: { planner: 'codex-sol', executor: 'ds', auditor: 'glm-5.3', active: 'codex-sol' },
    queueCount: 0,
    planDisplay: 'auto',
    thinkDisplay: 'auto',
  }
  return {
    flow,
    hud,
    re: {
      sampleType: 'firmware',
      phase: 'verify',
      phaseIndex: 6,
      phaseCount: 9,
      hypotheses: 2,
      evidence: 4,
    },
    plan: null,
    ledger: { hypotheses: [], evidence: [], findings: [] },
    ...overrides,
  }
}

describe('evaluateMitigationPosture & classifyEntropy', () => {
  it('flags RWX/high-entropy packed ELF as PACKED/RWX with alert pills', () => {
    const chall = getDemoTerrain('chall.elf')
    const posture = evaluateMitigationPosture(chall)
    expect(posture.grade).toBe('PACKED/RWX')
    expect(posture.tone).toBe('err')
    expect(posture.rwxCount).toBe(1)
    expect(posture.ctorCount).toBe(1)
    expect(posture.entropyVerdict).toBe('PACKED/ENCRYPTED')
    expect(posture.pills.some((p) => p.key === 'RWX' && p.status === 'alert')).toBe(true)
    expect(posture.pills.some((p) => p.key === 'RELRO' && p.value === 'PARTIAL' && p.status === 'partial')).toBe(true)
  })

  it('scores hardened binary without RWX or high entropy as HARDENED', () => {
    const so = getDemoTerrain('libnative-sign.so')
    const clean = { ...so, maxEntropy: 6.1, overallEntropy: 5.5 }
    const posture = evaluateMitigationPosture(clean)
    expect(posture.grade).toBe('HARDENED')
    expect(posture.tone).toBe('ok')
    expect(posture.score).toBeGreaterThanOrEqual(78)
    expect(posture.pills.some((p) => p.key === 'RELRO' && p.value === 'FULL' && p.status === 'secure')).toBe(true)
    expect(posture.pills.some((p) => p.key === 'stripped' && p.value === 'STRIPPED')).toBe(true)
  })

  it('classifies entropy bands accurately', () => {
    expect(classifyEntropy(7.85).verdict).toBe('PACKED/ENCRYPTED')
    expect(classifyEntropy(6.7).verdict).toBe('HIGH/COMPRESSED')
    expect(classifyEntropy(4.8).verdict).toBe('CODE/STRUCTURED')
    expect(classifyEntropy(1.2).verdict).toBe('SPARSE')
  })
})

describe('resolveOffsetMapping', () => {
  it('maps file offset inside ELF section to exact VA, RVA, section delta, and forensic citation', () => {
    const chall = getDemoTerrain('chall.elf')
    const mapped = resolveOffsetMapping(chall, 0x9020)
    expect(mapped.fileOffsetHex).toBe('0x009020')
    expect(mapped.section?.name).toBe('.packed_stub')
    expect(mapped.vaddrHex).toBe('0x409020')
    expect(mapped.rvaHex).toBe('+0x9020')
    expect(mapped.sectionDeltaHex).toBe('+0x20')
    expect(mapped.citation).toContain('chall.elf!0x409020')
    expect(mapped.citation).toContain('.packed_stub')
  })

  it('handles raw binary offsets without virtual addresses cleanly', () => {
    const carrier = getDemoTerrain('carrier.bin')
    const mapped = resolveOffsetMapping(carrier, 0x0c00)
    expect(mapped.fileOffsetHex).toBe('0x000c00')
    expect(mapped.vaddrHex).toBeNull()
    expect(mapped.section?.name).toBe('embedded_pdf')
    expect(mapped.citation).toBe('carrier.bin@0x000c00 (embedded_pdf)')
  })
})

describe('buildProvenanceChain & citation formatters', () => {
  const evStatic: EvidenceRecord = {
    id: 'ev_001',
    source: 'binary_inspect',
    kind: 'tool_observation',
    view: 'static',
    excerpt: 'ELF section .packed_stub RWX',
    sha256: 'abcdef0123456789abcdef0123456789',
    bytes: 120,
    createdAt: 1,
  }
  const evDyn: EvidenceRecord = {
    id: 'ev_002',
    source: 'run_command',
    kind: 'runtime_trace',
    view: 'dynamic',
    excerpt: 'decoded flag{ok}',
    bytes: 40,
    createdAt: 2,
  }
  const evVer: EvidenceRecord = {
    id: 'ev_003',
    source: 'verify_artifact',
    kind: 'verification_result',
    view: 'dynamic',
    excerpt: '2/2 cases passed',
    verification: { build: true, passed: 2, total: 2 },
    bytes: 60,
    createdAt: 3,
  }
  const evErr: EvidenceRecord = {
    id: 'ev_004',
    source: 'run_command',
    kind: 'runtime_trace',
    view: 'dynamic',
    excerpt: 'unzip error: invalid central directory',
    isError: true,
    bytes: 50,
    createdAt: 4,
  }
  const evAud: EvidenceRecord = {
    id: 'ev_005',
    source: 'glm-5.3',
    kind: 'audit_finding',
    view: 'dynamic',
    excerpt: 'AUDIT H-001 SUPPORT ev_003',
    supports: ['H-001'],
    bytes: 40,
    createdAt: 5,
  }

  it('marks dual-view verified + audited hypothesis as VERIFIED and CALIBRATED', () => {
    const h: Hypothesis = {
      id: 'H-001',
      claim: 'Base64 payload decodes to flag',
      confidence: 0.94,
      status: 'active',
      supporting: ['ev_001', 'ev_002', 'ev_003'],
      experiments: [{ id: 'exp_01', title: 'decode', command: 'base64 -d artifact.txt', expected: 'flag{ok}', status: 'passed', evidenceId: 'ev_002' }],
      createdAt: 1,
      updatedAt: 5,
    }
    const chain = buildProvenanceChain(h, [evStatic, evDyn, evVer, evAud])
    expect(chain.verdict).toBe('VERIFIED')
    expect(chain.calibration.status).toBe('CALIBRATED')
    expect(chain.auditEvs).toHaveLength(1)
    expect(chain.falsificationCriteria).toContain('base64 -d artifact.txt')
    expect(formatHypothesisCitation(h)).toContain('[H-001 | ACTIVE 94% | sup:ev_001,ev_002,ev_003]')
    expect(formatEvidenceCitation(evStatic)).toBe('[ev_001 | static | tool_observation | binary_inspect | sha256:abcdef012345]')
  })

  it('flags static-only >=80% hypothesis as OVERCONFIDENT and ANTI_ANALYSIS when touching anti-debug/packer', () => {
    const h: Hypothesis = {
      id: 'H-002',
      claim: 'ptrace check in .packed_stub prevents debugging',
      confidence: 0.88,
      status: 'active',
      supporting: ['ev_001'],
      createdAt: 1,
      updatedAt: 1,
    }
    const chain = buildProvenanceChain(h, [evStatic])
    expect(chain.verdict).toBe('ANTI_ANALYSIS')
    expect(chain.calibration.status).toBe('OVERCONFIDENT')
    expect(chain.calibration.tone).toBe('warn')
  })

  it('marks contradicted hypothesis as DIVERGED and UNRECONCILED if confidence stays high', () => {
    const h: Hypothesis = {
      id: 'H-003',
      claim: 'Embedded ZIP archive holds flag',
      confidence: 0.65,
      status: 'reevaluate',
      supporting: ['ev_001'],
      contradicting: ['ev_004'],
      createdAt: 1,
      updatedAt: 4,
    }
    const findings: FindingDTO[] = [
      { rule: 'runtime-contradiction', hypothesisId: 'H-003', evidenceId: 'ev_004', action: 'challenge', applied: true, message: 'zip corrupted' },
    ]
    const chain = buildProvenanceChain(h, [evStatic, evErr], findings)
    expect(chain.verdict).toBe('DIVERGED')
    expect(chain.calibration.status).toBe('UNRECONCILED')
    expect(chain.calibration.tone).toBe('err')

    const falsifiedChain = buildProvenanceChain({ ...h, status: 'rejected', confidence: 0.21 }, [evStatic, evErr], findings)
    expect(falsifiedChain.verdict).toBe('DIVERGED')
    expect(falsifiedChain.calibration.status).toBe('FALSIFIED')
  })
})

describe('classifyToolCall & computeLatencyStats', () => {
  const runs: ToolRunSnapshot[] = [
    { id: 1, name: 'binary_inspect', argsText: 'chall.elf --sections', preview: 'ELF64', status: 'done', startedAt: 0, finishedAt: 120, ms: 120, ok: true },
    { id: 2, name: 'run_command', argsText: 'gdb -batch -ex "x/16i 0x401060" chall.elf', preview: 'ok', status: 'done', startedAt: 0, finishedAt: 450, ms: 450, ok: true },
    { id: 3, name: 'verify_artifact', argsText: 'artifact.txt', preview: '2/2', status: 'done', startedAt: 0, finishedAt: 280, ms: 280, ok: true },
    { id: 4, name: 'decode_base64', argsText: 'ZmxhZw==', preview: 'flag', status: 'failed', startedAt: 0, finishedAt: 90, ms: 90, ok: false },
  ]

  it('categorizes RE tools, extracts target artifacts, and labels exit states', () => {
    const c0 = classifyToolCall(runs[0])
    expect(c0.category).toBe('STATIC')
    expect(c0.targetArtifact).toBe('chall.elf')
    expect(c0.exitLabel).toBe('EXIT 0')

    const c1 = classifyToolCall(runs[1])
    expect(c1.category).toBe('DYNAMIC')
    expect(c1.toolFamily).toBe('gdb')
    expect(c1.targetArtifact).toBe('chall.elf')

    const c2 = classifyToolCall(runs[2])
    expect(c2.category).toBe('VERIFY')
    expect(c2.targetArtifact).toBe('artifact.txt')

    const c3 = classifyToolCall(runs[3])
    expect(c3.category).toBe('CRYPTO')
    expect(c3.exitState).toBe('fail')
    expect(c3.exitLabel).toBe('ERR')
  })

  it('computes average, p95, max latency and success rate', () => {
    const stats = computeLatencyStats(runs)
    expect(stats.avgMs).toBe(235)
    expect(stats.maxMs).toBe(450)
    expect(stats.p95Ms).toBe(450)
    expect(stats.successRate).toBe(75)
  })
})

describe('evaluatePhaseGates & buildForensicJsonBundle', () => {
  it('evaluates 9 phase gates and builds schema-versioned forensic JSON bundle', () => {
    const tick = makeTick({
      re: { sampleType: 'firmware', phase: 'audit', phaseIndex: 7, phaseCount: 9, hypotheses: 1, evidence: 3 },
      ledger: {
        hypotheses: [
          {
            id: 'H-001',
            claim: 'Base64 artifact yields flag',
            confidence: 0.92,
            status: 'active',
            supporting: ['ev_001', 'ev_002'],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        evidence: [
          { id: 'ev_001', source: 'scan', kind: 'tool_observation', view: 'static', excerpt: 'carrier.bin header', bytes: 32, createdAt: 1 },
          { id: 'ev_002', source: 'verify_artifact', kind: 'verification_result', view: 'dynamic', excerpt: 'flag{demo_reverse_lab_flag}', verification: { build: true, passed: 2, total: 2 }, bytes: 48, createdAt: 2 },
        ],
        findings: [],
        goal: {
          primary: 'Recover flag from carrier.bin',
          targetFile: 'carrier.bin',
          accepted: true,
          criteria: [{ label: 'verify_artifact pass', pass: true }],
        },
      },
    })

    const gates = evaluatePhaseGates(tick)
    expect(gates).toHaveLength(9)
    expect(gates[7].code).toBe('AUD')
    expect(gates[7].ready).toBe('current')
    expect(gates[8].code).toBe('WRI')
    expect(gates[8].ready).toBe('blocked') // audit_finding not minted yet

    const bundle = buildForensicJsonBundle(tick, 'article-standard', '/demo/reverse-lab')
    expect(bundle.schema).toBe('0xaf-re/forensic-bundle/v1')
    expect(bundle.hypotheses[0].alignmentVerdict).toBe('VERIFIED')
    expect(bundle.markdownWriteup).toContain('# 逆向分析与证据溯源报告：carrier.bin')
    expect(bundle.phaseGates).toHaveLength(9)
  })
})
