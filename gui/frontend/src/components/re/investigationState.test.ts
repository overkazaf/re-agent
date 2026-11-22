import { describe, expect, it } from 'vitest'
import type { EvidenceRecord, FindingDTO, FlowDTO, HudDTO, Hypothesis, TickDTO } from '../../lib/types'
import { buildInvestigationState, type CalibratedHypothesis, type CalibratedLedger } from './investigationState'

function makeTick(overrides: Partial<TickDTO> = {}): TickDTO {
  const flow: FlowDTO = {
    stage: 'done',
    turn: 6,
    provider: 'codex-sol',
    model: 'codex sol',
    endpoint: 'demo://sandbox',
    messages: 14,
    sentTokens: 6400,
    usage: { input: 4200, output: 1800, thinking: 400, cacheRead: 1200, cacheWrite: 0, costUsd: 0.045 },
    pendingCalls: 0,
    activeTool: '',
    toolStartedAt: 0,
    toolMs: 0,
    toolsOk: 8,
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
    elapsedMs: 9200,
    stats: flow.usage,
    spark: [10, 20, 40],
    route: { planner: 'codex-sol', executor: 'ds', auditor: 'glm-5.3', active: 'codex-sol' },
    queueCount: 0,
    planDisplay: 'auto',
    thinkDisplay: 'auto',
  }
  return {
    flow,
    hud,
    re: null,
    plan: null,
    ledger: { hypotheses: [], evidence: [], findings: [] },
    ...overrides,
  }
}

describe('buildInvestigationState (canonical 7-state re-agent synthesizer)', () => {
  it('handles null / empty session safely with needs_more_evidence verdict', () => {
    const state = buildInvestigationState(null, '/demo/empty')
    expect(state.isEmpty).toBe(true)
    expect(state.states.target.status).toBe('pending')
    expect(state.states.objective.status).toBe('pending')
    expect(state.states.verification.status).toBe('unverified')
    expect(state.states.audit.verdict).toBe('needs_more_evidence')
    expect(state.defenses).toHaveLength(5)
    expect(state.states.audit.checklist).toHaveLength(5)
    expect(state.completionCriteria).toHaveLength(7)
    expect(state.completionScore.passed).toBeLessThan(7)
  })

  it('strictly separates Target State from Objective State and computes all 7 states, 5 defenses, 5 metrics & 7 gates on a full audited run', () => {
    const evs: EvidenceRecord[] = [
      { id: 'ev_001', source: 'ctf_triage', kind: 'tool_observation', view: 'static', sha256: 'abc1234567890001', untrustedInput: true, summary: 'carrier.bin 121B firmware blob', excerpt: 'triage', bytes: 121, createdAt: 1 },
      { id: 'ev_002', source: 'carve_artifacts', kind: 'tool_observation', view: 'static', sha256: 'abc1234567890002', untrustedInput: true, summary: 'carved PK_0x5f header', excerpt: 'carved', bytes: 86, createdAt: 2 },
      { id: 'ev_003', source: 'sandbox:run_command', kind: 'tool_observation', view: 'dynamic', isError: true, summary: 'run_command(curl) → capability "network" denied by task sandbox', excerpt: 'denied', bytes: 50, createdAt: 3 },
      { id: 'ev_004', source: 'run_command', kind: 'runtime_trace', view: 'dynamic', isError: true, summary: 'unzip -t carrier.bin -> no EOCD', excerpt: 'no EOCD', contradicts: ['H-002'], bytes: 88, createdAt: 4 },
      { id: 'ev_005', source: 'read_file', kind: 'tool_observation', view: 'static', sha256: 'abc1234567890005', untrustedInput: true, summary: 'artifact.txt base64 payload', excerpt: 'ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9', bytes: 36, createdAt: 5 },
      { id: 'ev_006', source: 'verify_artifact', kind: 'verification_result', view: 'dynamic', sha256: 'abc1234567890006', summary: '2/2 assertions passed (positive + negative boundary)', excerpt: '2/2 passed', verification: { build: true, passed: 2, total: 2 }, supports: ['H-003'], bytes: 64, createdAt: 6 },
      { id: 'ev_007', source: 'audit:glm-5.3', kind: 'audit_finding', view: 'static', sha256: 'abc1234567890007', summary: 'GLM-5.3 isolated audit PASS', excerpt: 'AUDIT H-003 SUPPORT', supports: ['H-001', 'H-003'], bytes: 80, createdAt: 7 },
    ]

    const hyps: CalibratedHypothesis[] = [
      {
        id: 'H-001',
        claim: '偏移 0x21 的 %PDF-1.7 是极简空壳',
        scope: 'carrier.bin @ 0x21..0x5e',
        falsifiers: ['若解析出非空 PDF 对象流则推翻'],
        nextTest: '确认无嵌套 JS 或嵌入文件流',
        confidence: 0.92,
        status: 'active',
        supporting: ['ev_001', 'ev_002'],
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 'H-002',
        claim: '偏移 0x5f 的 PK_0x5f 内嵌真实压缩 Flag',
        scope: 'carrier.bin @ 0x5f',
        falsifiers: ['unzip -t 缺少 EOCD 或解压报错即证伪'],
        nextTest: '运行 unzip -t carrier.bin 验证完整性',
        confidence: 0.21,
        status: 'rejected',
        supporting: ['ev_002'],
        contradicting: ['ev_004'],
        createdAt: 2,
        updatedAt: 4,
      },
      {
        id: 'H-003',
        claim: '真实 Flag 位于伴生文件 artifact.txt Base64 载荷',
        scope: 'workspace/artifact.txt',
        falsifiers: ['正反例重放任一失败则降权'],
        nextTest: '执行 verify_artifact 正反例重放',
        confidence: 0.96,
        status: 'active',
        supporting: ['ev_005', 'ev_006'],
        createdAt: 5,
        updatedAt: 7,
      },
    ]

    const findings: FindingDTO[] = [
      { rule: 'runtime-contradiction', hypothesisId: 'H-002', evidenceId: 'ev_004', applied: true, action: 'challenge', message: '动态反证淘汰' },
      { rule: 'adversarial-audit', hypothesisId: 'H-003', evidenceId: 'ev_006', applied: true, action: 'support', message: '审计通过' },
    ]

    const calibratedLedger: CalibratedLedger = {
      evidence: evs,
      hypotheses: hyps,
      findings,
      auditorProvider: 'glm-5.3',
      goal: {
        primary: '恢复 carrier.bin 载荷逻辑并完成双视角重放与独立审计',
        intent: 'recover_payload_and_verify',
        targetFile: 'carrier.bin',
        targetSha256: 'deadbeef00112233445566778899aabbccddeeff',
        targetArch: 'embedded / blob',
        targetFormat: 'Firmware Blob',
        deliverables: ['candidate_decoder', 'replay_verification', 'audited_writeup'],
        stopConditions: ['单样本命中不放行', '禁止外联探测'],
        accepted: true,
        constraints: { network: 'deny', filesystem: 'sample-workspace-only', device: 'none' },
        criteria: [
          { label: '账本有效证据 ≥ 4', pass: true },
          { label: 'verify_artifact ≥ 1', pass: true },
          { label: 'audit_finding ≥ 1', pass: true },
        ],
      },
      sandbox: {
        active: true,
        granted: ['fs:read(workspace)'],
        grantedCount: 6,
        deniedCount: 1,
        recentActions: [
          { at: 3, tool: 'run_command', capability: 'network', subject: 'curl http://decoy', sha256: '112233', decision: 'denied' },
          { at: 4, tool: 'run_command', capability: 'exec', subject: 'unzip -t carrier.bin', sha256: '445566', decision: 'granted', hypothesisId: 'H-002' },
          { at: 6, tool: 'verify_artifact', capability: 'exec', subject: 'replay base64', sha256: '778899', decision: 'granted', hypothesisId: 'H-003' },
        ],
      },
    }

    const tick = makeTick({
      re: { sampleType: 'firmware', phase: 'writeup', phaseIndex: 8, phaseCount: 9, hypotheses: 2, evidence: evs.length },
      ledger: calibratedLedger as unknown as TickDTO['ledger'],
    })

    const state = buildInvestigationState(tick, '/demo/reverse-lab')

    // Target vs Objective strictly separated
    expect(state.states.target.file).toBe('carrier.bin')
    expect(state.states.target.format).toBe('Firmware Blob')
    expect(state.states.objective.primary).toContain('双视角重放')
    expect(state.states.objective.deliverables).toContain('replay_verification')
    expect(state.states.target.separationNote).toContain('分离')

    // Evidence untrusted input isolation & hash coverage
    expect(state.states.evidence.untrustedIsolatedCount).toBe(3)
    expect(state.states.evidence.hashedCount).toBe(5)

    // Hypothesis structured fields & computed confidence
    const h2 = state.states.hypothesis.items.find((h) => h.id === 'H-002')!
    expect(h2.scope).toBe('carrier.bin @ 0x5f')
    expect(h2.falsifiers[0]).toContain('EOCD')
    expect(h2.computedConfidencePct).toBeLessThanOrEqual(25)

    // Action hypothesis-bound tracking
    expect(state.states.action.sandboxActive).toBe(true)
    expect(state.states.action.deniedCount).toBe(1)
    expect(state.states.action.hypothesisBoundCount).toBeGreaterThanOrEqual(2)

    // Verification promoted to verified (2/2 passed)
    expect(state.states.verification.status).toBe('verified')
    expect(state.states.verification.singleSampleHitWarning).toBe(false)
    expect(state.states.verification.replayPassRatePct).toBe(100)

    // Audit 5-item checklist & 3-state verdict = accepted
    expect(state.states.audit.verdict).toBe('accepted')
    expect(state.states.audit.passedChecksCount).toBe(5)

    // 5 Trust Metrics (§7.5)
    expect(state.metrics.evidenceCoverage.valuePct).toBe(100)
    expect(state.metrics.replayPassRate.valuePct).toBe(100)
    expect(state.metrics.wrongHypLifetime.avgRounds).toBe(2) // ev_004 (idx 3) - ev_002 (idx 1) = 2
    expect(state.metrics.overreachCount.count).toBe(1)
    expect(state.metrics.overreachCount.blockedBySandbox).toBe(true)
    expect(state.metrics.costPerAcceptedFinding.usd).toBeCloseTo(0.0225, 4)

    // 7/7 completion criteria & 3 handover questions
    expect(state.completionScore).toEqual({ passed: 7, total: 7 })
    expect(state.handover.whichRun.answer).toContain('carrier.bin')
    expect(state.handover.reproducibleAcrossModels.status).toBe('reproducible')
    expect(state.handover.errorAttribution.breakdown.model).toContain('H-002')
  })

  it('enforces §8.5 / §8.6 single-sample-hit guard: keeps verification as candidate and downgrades audit to needs_more_evidence', () => {
    const evs: EvidenceRecord[] = [
      { id: 'ev_001', source: 'read_file', kind: 'tool_observation', view: 'static', summary: 'read decoder', excerpt: 'code', bytes: 100, createdAt: 1 },
      { id: 'ev_002', source: 'verify_artifact', kind: 'verification_result', view: 'dynamic', summary: '1/1 single example matched', excerpt: '1/1 passed', verification: { build: true, passed: 1, total: 1 }, supports: ['H-001'], bytes: 40, createdAt: 2 },
      { id: 'ev_003', source: 'audit:glm-5.3', kind: 'audit_finding', view: 'static', summary: 'audit review', excerpt: 'AUDIT H-001', supports: ['H-001'], bytes: 40, createdAt: 3 },
    ]
    const hyps: Hypothesis[] = [
      { id: 'H-001', claim: '单样本命中的候选解码逻辑', confidence: 0.9, status: 'active', supporting: ['ev_001', 'ev_002'], createdAt: 1, updatedAt: 2 },
    ]
    const tick = makeTick({
      ledger: {
        evidence: evs,
        hypotheses: hyps,
        findings: [],
        goal: { primary: '还原签名算法', targetFile: 'libshield.so', accepted: false, criteria: [] },
        sandbox: { active: true, granted: ['fs:read'], grantedCount: 2, deniedCount: 0, recentActions: [] },
      },
    })

    const state = buildInvestigationState(tick, '/demo/shield')
    expect(state.states.verification.status).toBe('candidate')
    expect(state.states.verification.singleSampleHitWarning).toBe(true)
    expect(state.states.audit.verdict).toBe('needs_more_evidence')
    const boundaryCheck = state.states.audit.checklist.find((c) => c.key === 'boundary_failure')!
    expect(boundaryCheck.pass).toBe(false)
    expect(boundaryCheck.detail).toContain('单样本命中')
  })

  it('marks audit verdict as rejected when all hypotheses are falsified with no replacement', () => {
    const evs: EvidenceRecord[] = [
      { id: 'ev_001', source: 'ctf_triage', kind: 'tool_observation', view: 'static', summary: 'triage', excerpt: 'triage', bytes: 50, createdAt: 1 },
      { id: 'ev_002', source: 'run_command', kind: 'runtime_trace', view: 'dynamic', isError: true, summary: 'failed', excerpt: 'err', contradicts: ['H-001'], bytes: 40, createdAt: 2 },
    ]
    const hyps: Hypothesis[] = [
      { id: 'H-001', claim: '错误假设', confidence: 0.15, status: 'rejected', supporting: ['ev_001'], contradicting: ['ev_002'], createdAt: 1, updatedAt: 2 },
    ]
    const tick = makeTick({
      ledger: { evidence: evs, hypotheses: hyps, findings: [] },
    })
    const state = buildInvestigationState(tick)
    expect(state.states.audit.verdict).toBe('rejected')
  })
})
