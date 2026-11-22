import { describe, expect, it } from 'vitest'
import type { EvidenceRecord, FindingDTO, FlowDTO, HudDTO, Hypothesis, TickDTO } from '../../lib/types'
import {
  buildHypothesisArcs,
  buildReplayFrames,
  generateWriteupMarkdown,
  synthesizeProcessSummary,
  synthesizeProofStory,
} from './cognitiveSynthesis'

function makeBaseTick(overrides: Partial<TickDTO> = {}): TickDTO {
  const flow: FlowDTO = {
    stage: 'done',
    turn: 3,
    provider: 'codex-sol',
    model: 'codex sol',
    endpoint: 'demo://sandbox',
    messages: 8,
    sentTokens: 3200,
    usage: { input: 2400, output: 800, thinking: 400, cacheRead: 1000, cacheWrite: 0, costUsd: 0.03 },
    pendingCalls: 0,
    activeTool: '',
    toolStartedAt: 0,
    toolMs: 0,
    toolsOk: 5,
    toolsFailed: 1,
    toolRuns: [],
    replyChars: 420,
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
    elapsedMs: 4200,
    stats: flow.usage,
    spark: [10, 20, 30],
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

describe('synthesizeProofStory & buildHypothesisArcs', () => {
  it('handles empty / null session cleanly without inventing facts', () => {
    const storyNull = synthesizeProofStory(null)
    expect(storyNull.isEmpty).toBe(true)
    expect(storyNull.chapters).toHaveLength(0)
    expect(storyNull.hypothesisArcs).toHaveLength(0)

    const emptyTick = makeBaseTick()
    const storyEmpty = synthesizeProofStory(emptyTick)
    expect(storyEmpty.isEmpty).toBe(true)
    expect(storyEmpty.chapters).toHaveLength(0)
    expect(storyEmpty.leadSummary).toContain('初步勘察')
  })

  it('builds a clean contiguous linear proof for a single confirmed hypothesis without false pivot chapters', () => {
    const evs: EvidenceRecord[] = [
      {
        id: 'ev_001',
        source: 'read_file',
        kind: 'tool_observation',
        view: 'static',
        summary: 'chall.js: XOR key=0x2a, encoded[17]',
        excerpt: 'const key = 0x2a;',
        bytes: 436,
        createdAt: 1,
      },
      {
        id: 'ev_002',
        source: 'ctf_decode',
        kind: 'tool_observation',
        view: 'static',
        summary: 'XOR 0x2a decoded -> 0xaf{warmup_deck}',
        excerpt: 'output="0xaf{warmup_deck}"',
        bytes: 17,
        createdAt: 2,
      },
      {
        id: 'ev_003',
        source: 'verify_artifact',
        kind: 'verification_result',
        view: 'dynamic',
        summary: "node chall.js '0xaf{warmup_deck}' -> accepted; negative -> rejected",
        excerpt: '2/2 passed',
        verification: { build: false, passed: 2, total: 2 },
        supports: ['H-001'],
        bytes: 94,
        createdAt: 3,
      },
      {
        id: 'ev_004',
        source: 'audit:glm-5.3',
        kind: 'audit_finding',
        view: 'static',
        summary: 'GLM-5.3 adversarial audit PASS',
        excerpt: 'AUDIT H-001 SUPPORT ev_003',
        supports: ['H-001'],
        bytes: 60,
        createdAt: 4,
      },
    ]
    const hyps: Hypothesis[] = [
      {
        id: 'H-001',
        claim: 'chall.js 使用单字节 XOR（key=0x2a）编码目标令牌 0xaf{warmup_deck}',
        confidence: 0.98,
        status: 'active',
        supporting: ['ev_001', 'ev_002', 'ev_003'],
        experiments: [
          {
            id: 'exp_01',
            title: '本地运行校验正反例',
            command: "node chall.js '0xaf{warmup_deck}'",
            expected: 'accepted',
            status: 'passed',
            evidenceId: 'ev_003',
            actual: 'accepted',
          },
        ],
        createdAt: 1,
        updatedAt: 4,
      },
    ]

    const tick = makeBaseTick({
      re: { sampleType: 'elf', phase: 'writeup', phaseIndex: 8, phaseCount: 9, hypotheses: 1, evidence: 4 },
      ledger: {
        evidence: evs,
        hypotheses: hyps,
        findings: [],
        goal: {
          primary: '还原 chall.js 校验令牌并完成重放验证',
          targetFile: 'chall.js',
          accepted: true,
          criteria: [{ label: 'verify_artifact ≥ 1', pass: true }],
        },
      },
    })

    const story = synthesizeProofStory(tick)
    expect(story.isEmpty).toBe(false)
    // Contiguous step numbers (1, 2, 3, 4) with no falsification/pivot chapter
    expect(story.chapters.map((c) => c.stepNo)).toEqual([1, 2, 3, 4])
    expect(story.chapters.some((c) => c.id === 'ch-falsify-pivot')).toBe(false)
    expect(story.chapters[0].transitionFromPrev).toBeNull()
    expect(story.chapters[1].transitionFromPrev).toBeTruthy()
    expect(story.chapters[2].transitionFromPrev).toBeTruthy()
    expect(story.chapters[3].transitionFromPrev).toBeTruthy()

    expect(story.hypothesisArcs).toHaveLength(1)
    const arc = story.hypothesisArcs[0]
    expect(arc.id).toBe('H-001')
    expect(arc.statusLabel).toContain('审计通过')
    expect(arc.contrast).toBeNull()
    expect(arc.triggerClues).toContain('[ev_001]')
    expect(arc.claimAndCriterion).toContain('accepted')
    expect(arc.testAndObservation).toContain('[ev_003]')
    expect(arc.deductionVerdict).toContain('98%')
  })

  it('constructs full falsification, dependency cascade, logical pivot, and audit story (Case 2 shape)', () => {
    const evs: EvidenceRecord[] = [
      { id: 'ev_001', source: 'ctf_triage', kind: 'tool_observation', view: 'static', summary: '121B · ASCII prefix + %PDF-1.7@0x21 + PK_0x5f@0x5f', excerpt: 'triage', bytes: 121, createdAt: 1 },
      { id: 'ev_002', source: 'carve_artifacts', kind: 'tool_observation', view: 'static', summary: 'carved 2 signatures: PDF stub (60B), ZIP local header PK_0x5f (26B)', excerpt: 'carved', bytes: 86, createdAt: 2 },
      { id: 'ev_003', source: 'find_bytes', kind: 'tool_observation', view: 'static', summary: 'matches at 0x21 and 0x5f', excerpt: 'matches', bytes: 40, createdAt: 3 },
      { id: 'ev_004', source: 'entropy_scan', kind: 'tool_observation', view: 'static', summary: 'overall=4.12 bits/byte', excerpt: 'entropy', bytes: 32, createdAt: 4 },
      { id: 'ev_005', source: 'sandbox:run_command', kind: 'tool_observation', view: 'dynamic', isError: true, summary: 'run_command(curl) → capability "network" denied by task sandbox', excerpt: 'denied', bytes: 50, createdAt: 5 },
      { id: 'ev_006', source: 'run_command', kind: 'runtime_trace', view: 'dynamic', isError: true, summary: 'run_command(unzip -t carrier.bin) → PK_0x5f: End-of-central-directory signature not found (truncated decoy)', excerpt: 'no EOCD', contradicts: ['H-002'], bytes: 88, createdAt: 6 },
      { id: 'ev_007', source: 'read_file', kind: 'tool_observation', view: 'static', summary: 'read_file(artifact.txt) → base64 candidate: ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9', excerpt: 'ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9', bytes: 36, createdAt: 7 },
      { id: 'ev_008', source: 'ctf_decode', kind: 'tool_observation', view: 'static', summary: 'ctf_decode(base64) → flag{demo_reverse_lab_flag}', excerpt: 'flag{demo_reverse_lab_flag}', bytes: 27, createdAt: 8 },
      { id: 'ev_009', source: 'verify_artifact', kind: 'verification_result', view: 'dynamic', summary: 'verify_artifact → 2/2 assertions passed → flag{demo_reverse_lab_flag}', excerpt: '2/2 passed', verification: { build: false, passed: 2, total: 2 }, supports: ['H-004'], bytes: 64, createdAt: 9 },
      { id: 'ev_010', source: 'audit:glm-5.3', kind: 'audit_finding', view: 'static', summary: 'GLM-5.3 隔离对抗审计 PASS', excerpt: 'AUDIT H-004 SUPPORT\nAUDIT H-003 CHALLENGE ev_006', supports: ['H-001', 'H-004'], bytes: 80, createdAt: 10 },
      { id: 'ev_011', source: 'write_file', kind: 'artifact', view: 'static', artifact: 'notes/writeup.md', summary: 'wrote notes/writeup.md', excerpt: '# report', bytes: 1200, createdAt: 11 },
    ]
    const hyps: Hypothesis[] = [
      { id: 'H-001', claim: '偏移 0x21 的 %PDF-1.7 是极简空壳', confidence: 0.92, status: 'active', supporting: ['ev_001', 'ev_002'], createdAt: 1, updatedAt: 2 },
      {
        id: 'H-002',
        claim: '偏移 0x5f 的 PK_0x5f ZIP 局部头内嵌了压缩加密的真实 Flag 数据流',
        confidence: 0.21,
        status: 'rejected',
        supporting: ['ev_002', 'ev_003'],
        contradicting: ['ev_006'],
        experiments: [
          { id: 'exp_01', title: '解压测试', command: 'unzip -t carrier.bin', expected: 'No errors detected', status: 'falsified', evidenceId: 'ev_006', actual: 'End-of-central-directory signature not found' },
        ],
        note: '被动态运行证据 ev_006 证伪（缺少 EOCD 中央目录），置信度折半淘汰',
        createdAt: 1,
        updatedAt: 6,
      },
      {
        id: 'H-003',
        claim: '用偏移 0x00 明文前缀派生密钥即可解密 H-002 中的 PK_0x5f 载荷流',
        confidence: 0.19,
        status: 'rejected',
        supporting: ['ev_003', 'ev_004'],
        contradicting: ['ev_006'],
        dependsOn: ['H-002'],
        note: '经独立审计席 glm-5.3 CHALLENGE 复核淘汰（父假设已证伪）',
        createdAt: 1,
        updatedAt: 10,
      },
      {
        id: 'H-004',
        claim: 'carrier.bin 中 PK_0x5f 为诱饵头，真实 Flag 位于伴生文件 artifact.txt Base64 载荷 flag{demo_reverse_lab_flag}',
        confidence: 0.96,
        status: 'active',
        supporting: ['ev_007', 'ev_008', 'ev_009'],
        experiments: [
          { id: 'exp_01', title: 'Base64 解码与重放', command: 'verify_artifact base64', expected: 'flag{demo_reverse_lab_flag}', status: 'passed', evidenceId: 'ev_009', actual: '2/2 assertions passed' },
        ],
        note: '兼具静态解码 (ev_008) 与动态重放 (ev_009, 2/2 passed) 双视角交叉验证支撑',
        createdAt: 9,
        updatedAt: 10,
      },
    ]
    const findings: FindingDTO[] = [
      { rule: 'single-view', hypothesisId: 'H-002', evidenceId: 'ev_002', applied: false, action: 'challenge', message: '单视角告警' },
      { rule: 'runtime-contradiction', hypothesisId: 'H-002', evidenceId: 'ev_006', applied: true, action: 'challenge', message: '动态运行反证' },
      { rule: 'dependency-cascade', hypothesisId: 'H-003', evidenceId: 'ev_006', applied: true, action: 'challenge', message: '父假设淘汰级联重审' },
      { rule: 'adversarial-audit', hypothesisId: 'H-003', evidenceId: 'ev_006', applied: true, action: 'challenge', message: '审计淘汰' },
      { rule: 'adversarial-audit', hypothesisId: 'H-004', evidenceId: 'ev_009', applied: true, action: 'support', message: '审计通过' },
    ]

    const tick = makeBaseTick({
      re: { sampleType: 'firmware', phase: 'writeup', phaseIndex: 8, phaseCount: 9, hypotheses: 2, evidence: 11 },
      ledger: {
        evidence: evs,
        hypotheses: hyps,
        findings,
        auditorProvider: 'glm-5.3',
        goal: {
          primary: '完成 carrier.bin 静态/动态交叉取证、重放验证与独立对抗审计',
          targetFile: 'carrier.bin',
          accepted: true,
          criteria: [
            { label: '账本有效证据 ≥ 4', pass: true },
            { label: '动态重放 verify_artifact ≥ 1', pass: true },
            { label: '独立对抗审计 audit_finding ≥ 1', pass: true },
          ],
        },
        sandbox: { active: true, granted: [], grantedCount: 8, deniedCount: 1, recentActions: [] },
      },
    })

    const story = synthesizeProofStory(tick)
    expect(story.isEmpty).toBe(false)
    // All 6 chapters present with sequential numbering 1..6
    expect(story.chapters.map((c) => c.stepNo)).toEqual([1, 2, 3, 4, 5, 6])
    expect(story.chapters.map((c) => c.id)).toEqual([
      'ch-triage',
      'ch-hypothesize',
      'ch-experiment',
      'ch-falsify-pivot',
      'ch-verify',
      'ch-audit',
    ])

    // Every chapter after chapter 1 carries an explicit causal connector
    for (let i = 1; i < story.chapters.length; i += 1) {
      expect(story.chapters[i].transitionFromPrev).toBeTruthy()
    }

    // Chapter 4 (falsification & pivot) explains H-002 refutation, H-003 cascade, and natural pivot to H-004
    const pivotChapter = story.chapters[3]
    expect(pivotChapter.body).toContain('H-002')
    expect(pivotChapter.body).toContain('H-003')
    expect(pivotChapter.body).toContain('H-004')
    expect(pivotChapter.body).toContain('[ev_007]')
    expect(pivotChapter.contrasts.length).toBeGreaterThanOrEqual(1)
    expect(pivotChapter.contrasts[0].hypothesisId).toBe('H-002')
    expect(pivotChapter.contrasts[0].expected).toContain('No errors detected')
    expect(pivotChapter.contrasts[0].observed).toContain('ev_006')

    // Per-hypothesis arcs capture full 5-beat causal threads
    const arcs = buildHypothesisArcs(evs, hyps, findings, 'glm-5.3')
    expect(arcs).toHaveLength(4)
    const arcH2 = arcs.find((a) => a.id === 'H-002')!
    const arcH3 = arcs.find((a) => a.id === 'H-003')!
    const arcH4 = arcs.find((a) => a.id === 'H-004')!
    expect(arcH2.contrast).not.toBeNull()
    expect(arcH2.dependents).toContain('H-003')
    expect(arcH2.nextMove).toContain('H-004')
    expect(arcH3.dependsOn).toContain('H-002')
    expect(arcH3.deductionVerdict).toContain('H-002')
    expect(arcH4.triggerClues).toContain('[ev_007]')
    expect(arcH4.deductionVerdict).toContain('96%')

    // ProcessSummary narrative reads naturally with cohesive connectors (no terse semicolon soup)
    const summary = synthesizeProcessSummary(tick)
    expect(summary.narrative).toContain('首先')
    expect(summary.narrative).toContain('然而')
    expect(summary.narrative).toContain('转向')
    expect(summary.narrative).toContain('最终')
    expect(summary.narrative).toContain('H-004')

    // Replay frames carry explicit causal transitions & preserve E2E anchors
    const frames = buildReplayFrames(tick)
    expect(frames.length).toBeGreaterThanOrEqual(6)
    for (const f of frames) {
      expect(f.transitionFromPrev).toBeTruthy()
      expect(f.takeaway).toBeTruthy()
    }
    const contraFrame = frames.find((f) => f.id === 'f-arbitrate-cascade')
    expect(contraFrame?.stageTag).toMatch(/反证折半与级/)
    expect(contraFrame?.thought).toContain('Commits to a story')
    expect(contraFrame?.stateDelta).toContain('H-002 折半淘汰 [REJECTED]')
    expect(contraFrame?.stateDelta).toContain('H-003 级联降级 [REEVALUATE]')
    // Ensure post-audit meta evidence (evidence_review) does not leak into Step 4 pivot clues
    expect(pivotChapter.body).not.toContain('evidence_review')
    expect(pivotChapter.body).toContain('flag{demo_reverse_lab_flag}')

    // Markdown writeup contains the complete deductive proof narrative section across all 3 templates
    const mdStd = generateWriteupMarkdown(tick, 'article-standard', '/demo/reverse-lab')
    expect(mdStd).toContain('# 逆向分析与证据溯源报告：carrier.bin')
    expect(mdStd).toContain('推理与证明全过程（从假设提出到证据闭环）')
    expect(mdStd).toContain('逐条假设的因果证明链路')
    expect(mdStd).toContain('反证对照 `[H-002]`')
    expect(mdStd).toContain('承接逻辑')

    const mdCtf = generateWriteupMarkdown(tick, 'ctf-writeup', '/demo/reverse-lab')
    expect(mdCtf).toContain('推理与证明全过程（从假设提出到证据闭环）')
    expect(mdCtf).toContain('flag{demo_reverse_lab_flag}')

    const mdAlgo = generateWriteupMarkdown(tick, 'algo-report', '/demo/reverse-lab')
    expect(mdAlgo).toContain('推理与证明全过程（从假设提出到证据闭环）')
  })
})
