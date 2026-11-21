// Track B 派生层单测 —— 用例清单来自 docs/plans/2026-11-21-3d-forensic-theater.md Track B 节（7 组全覆盖）。
// 纯函数部分（1-6 组）不依赖 React；第 7 组直接驱动 sceneActions.reconcile 断言接线行为。
import { describe, expect, it } from 'vitest'
import type {
  EvidenceRecord,
  FlowDTO,
  HudDTO,
  Hypothesis,
  LedgerDTO,
  ReDTO,
  TickDTO,
} from '../lib/types'
import { RAIL_SPACING, zoneOf } from '../three/contract'
import { deriveEdges, deriveScene, placeEv, placeHyp, suggestNext } from './derive'
import { sceneActions } from './scene'

const DEG = Math.PI / 180
const HYP_BASE = zoneOf('HYP').center // [26, 0, 30]，与 RAIL_SPACING 一样来自冻结契约

// 与 internal/workflow/phase.go 的 9 相位一一对应（ReDTO.phase 的真实取值）
const PHASES = [
  'triage', 'static', 'dynamic', 'evidence', 'interface', 'hypothesis', 'verify', 'audit', 'writeup',
] as const

// ---------- fixtures ----------

function flow(): FlowDTO {
  return {
    stage: 'idle',
    turn: 0,
    provider: 'p',
    model: 'm',
    endpoint: 'e',
    messages: 0,
    sentTokens: 0,
    usage: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    pendingCalls: 0,
    activeTool: '',
    toolStartedAt: 0,
    toolMs: 0,
    toolsOk: 0,
    toolsFailed: 0,
    toolRuns: [],
    replyChars: 0,
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
}

function hud(): HudDTO {
  return {
    phase: 'triage',
    frame: '',
    elapsedMs: 0,
    stats: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    spark: [],
    route: null,
    queueCount: 0,
    planDisplay: 'auto',
    thinkDisplay: 'auto',
  }
}

function re(phaseIndex: number, extra: Partial<ReDTO> = {}): ReDTO {
  return {
    sampleType: 'binary',
    phase: PHASES[phaseIndex] ?? 'triage',
    phaseIndex,
    phaseCount: 9,
    hypotheses: 0,
    evidence: 0,
    ...extra,
  }
}

function tick(opts: { re?: ReDTO | null; ledger?: LedgerDTO | null } = {}): TickDTO {
  return { flow: flow(), hud: hud(), re: opts.re ?? null, plan: null, ledger: opts.ledger ?? null }
}

function hyp(id: string, extra: Partial<Hypothesis> = {}): Hypothesis {
  return { id, claim: `claim ${id}`, confidence: 0.5, status: 'active', createdAt: 1, updatedAt: 1, ...extra }
}

function ev(id: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { id, source: 'strings', excerpt: `excerpt ${id}`, bytes: 10, createdAt: 1, ...extra }
}

/** 点到 base 中轴（x/z 平面）的水平距离 */
function horizontalDistance(p: [number, number, number], base: [number, number, number]): number {
  return Math.hypot(p[0] - base[0], p[2] - base[2])
}

/** 点绕 base 中轴的极角（度，归一化到 [0, 360)） */
function polarAngle(p: [number, number, number], base: [number, number, number]): number {
  const a = Math.atan2(p[2] - base[2], p[0] - base[0]) / DEG
  return ((a % 360) + 360) % 360
}

// ---------- 组 1+2：deriveScene ----------

describe('deriveScene', () => {
  it('空输入 → 空场景', () => {
    expect(deriveScene([])).toEqual({ sessions: [], empty: true })
  })

  it('单 session（2 hyp、3 ev）→ 节点数、rail、empty 正确', () => {
    const ledger: LedgerDTO = {
      hypotheses: [
        hyp('H-001', {
          confidence: 0.7,
          supporting: ['ev_001'],
          experiments: [
            { id: 'exp-1', title: 'strings probe', command: 'strings', status: 'passed', evidenceId: 'ev_002' },
          ],
        }),
        hyp('H-002', { status: 'rejected' }),
      ],
      evidence: [
        ev('ev_001', { kind: 'tool_observation', summary: 'MZ header', verification: { build: true, passed: 3, total: 3 } }),
        ev('ev_002', { artifact: '/tmp/out.bin' }),
        ev('ev_003', { kind: 'verification_result', isError: true, verification: { build: true, passed: 1, total: 2 } }),
      ],
    }
    const state = deriveScene([{ sessionId: 's1', slot: 0, tick: tick({ re: re(6), ledger }) }])

    expect(state.empty).toBe(false)
    expect(state.sessions).toHaveLength(1)
    const session = state.sessions[0]!
    expect(session.sessionId).toBe('s1')
    expect(session.offset).toEqual([0, 0, 0])
    expect(session.rail).toEqual({ activeIndex: 6, total: 9, archived: false })
    expect(session.hyps).toHaveLength(2)
    expect(session.evs).toHaveLength(3)

    const h0 = session.hyps[0]!
    expect(h0.id).toBe('H-001')
    expect(h0.claim).toBe('claim H-001')
    expect(h0.confidence).toBe(0.7)
    expect(h0.status).toBe('active')
    expect(h0.experiments).toEqual([
      { id: 'exp-1', title: 'strings probe', status: 'passed', evidenceId: 'ev_002' },
    ])
    // 位置是有限的三元组（几何细节在 placeHyp/placeEv 组里断言）
    for (const node of [...session.hyps, ...session.evs]) {
      expect(node.position).toHaveLength(3)
      for (const c of node.position) expect(Number.isFinite(c)).toBe(true)
    }

    const e0 = session.evs[0]!
    expect(e0.id).toBe('ev_001')
    expect(e0.kind).toBe('tool_observation')
    expect(e0.summary).toBe('MZ header')
    expect(e0.verified).toBe(true)
    expect(e0.isError).toBe(false)
    expect(session.evs[1]!.verified).toBe(false) // 无 verification
    expect(session.evs[2]!.isError).toBe(true)
    expect(session.evs[2]!.verified).toBe(false) // 1/2 未全过
    // summary 缺省回退 excerpt
    expect(session.evs[1]!.summary).toBe('excerpt ev_002')
    // kind 缺省回退 source
    expect(session.evs[1]!.kind).toBe('strings')
  })

  it('tick 为 null → session 保留但无内容、rail.activeIndex 为 -1', () => {
    const state = deriveScene([{ sessionId: 's1', slot: 0, tick: null }])
    expect(state.empty).toBe(false)
    const session = state.sessions[0]!
    expect(session.rail).toEqual({ activeIndex: -1, total: 9, archived: false })
    expect(session.hyps).toEqual([])
    expect(session.evs).toEqual([])
    expect(session.edges).toEqual([])
  })

  it('slot 决定平行主线偏移，节点随之平移', () => {
    const ledger: LedgerDTO = { hypotheses: [hyp('H-001')], evidence: [ev('ev_001')] }
    const state = deriveScene([
      { sessionId: 's1', slot: 0, tick: tick({ re: re(2), ledger }) },
      { sessionId: 's2', slot: 1, tick: tick({ re: re(2), ledger }) },
    ])
    expect(state.sessions[0]!.offset).toEqual([0, 0, 0])
    expect(state.sessions[1]!.offset).toEqual([RAIL_SPACING, 0, 0])
    expect(state.sessions[1]!.hyps[0]!.position[0]).toBeCloseTo(
      state.sessions[0]!.hyps[0]!.position[0] + RAIL_SPACING,
      8,
    )
    expect(state.sessions[1]!.evs[0]!.position[0]).toBeCloseTo(
      state.sessions[0]!.evs[0]!.position[0] + RAIL_SPACING,
      8,
    )
  })

  it('phase 走到 writeup → rail.archived 金色定格', () => {
    const state = deriveScene([{ sessionId: 's1', slot: 0, tick: tick({ re: re(8) }) }])
    expect(state.sessions[0]!.rail.archived).toBe(true)
    expect(state.sessions[0]!.rail.activeIndex).toBe(8)
    const notArchived = deriveScene([{ sessionId: 's1', slot: 0, tick: tick({ re: re(7) }) }])
    expect(notArchived.sessions[0]!.rail.archived).toBe(false)
  })
})

// ---------- 组 3：placeHyp ----------

describe('placeHyp', () => {
  it('绕 HYP 塔 base 环形排布：半径 8，高度 10 + index*4', () => {
    for (let i = 0; i < 5; i++) {
      const p = placeHyp(hyp(`H-00${i + 1}`), i, HYP_BASE)
      expect(horizontalDistance(p, HYP_BASE)).toBeCloseTo(8, 6)
      expect(p[1]).toBe(HYP_BASE[1] + 10 + i * 4)
    }
    // 不同 index 位置互不相同（塔身向上错开排布）
    expect(placeHyp(hyp('H-001'), 0, HYP_BASE)).not.toEqual(placeHyp(hyp('H-002'), 1, HYP_BASE))
  })

  it('id → 坐标稳定：同输入重算坐标不变', () => {
    const a = placeHyp(hyp('H-001'), 2, HYP_BASE)
    const b = placeHyp(hyp('H-001'), 2, HYP_BASE)
    expect(a).toEqual(b)

    const ledger: LedgerDTO = { hypotheses: [hyp('H-001'), hyp('H-002')], evidence: [] }
    const input = { sessionId: 's1', slot: 0, tick: tick({ re: re(5), ledger }) }
    const first = deriveScene([input])
    const again = deriveScene([input])
    expect(again.sessions[0]!.hyps.map((h) => h.position)).toEqual(
      first.sessions[0]!.hyps.map((h) => h.position),
    )
  })
})

// ---------- 组 4：placeEv ----------

describe('placeEv', () => {
  it('黄金角螺旋：极角 = index * 137.5°', () => {
    for (const i of [0, 1, 2, 7]) {
      const p = placeEv(ev(`ev_${i}`), i, HYP_BASE)
      expect(polarAngle(p, HYP_BASE)).toBeCloseTo((i * 137.5) % 360, 6)
    }
  })

  it('半径 = 6 + (index % 4)', () => {
    for (const i of [0, 3, 5, 9]) {
      const p = placeEv(ev(`ev_${i}`), i, HYP_BASE)
      expect(horizontalDistance(p, HYP_BASE)).toBeCloseTo(6 + (i % 4), 6)
    }
  })

  it('高度 = 12 + index*2.2', () => {
    expect(placeEv(ev('ev_0'), 0, HYP_BASE)[1]).toBe(HYP_BASE[1] + 12)
    expect(placeEv(ev('ev_4'), 4, HYP_BASE)[1]).toBeCloseTo(HYP_BASE[1] + 12 + 4 * 2.2, 8)
  })

  it('isError 的证据沉降到 -1.5，螺旋半径/极角不变', () => {
    const normal = placeEv(ev('ev_2'), 2, HYP_BASE)
    const errored = placeEv(ev('ev_2', { isError: true }), 2, HYP_BASE)
    expect(errored[1]).toBe(HYP_BASE[1] - 1.5)
    expect(horizontalDistance(errored, HYP_BASE)).toBeCloseTo(horizontalDistance(normal, HYP_BASE), 6)
    expect(polarAngle(errored, HYP_BASE)).toBeCloseTo(polarAngle(normal, HYP_BASE), 6)
  })

  it('同输入重算坐标稳定（deriveScene 层面）', () => {
    const ledger: LedgerDTO = { hypotheses: [], evidence: [ev('ev_001'), ev('ev_002', { isError: true })] }
    const input = { sessionId: 's1', slot: 0, tick: tick({ re: re(2), ledger }) }
    const first = deriveScene([input])
    const again = deriveScene([input])
    expect(again.sessions[0]!.evs.map((e) => e.position)).toEqual(
      first.sessions[0]!.evs.map((e) => e.position),
    )
  })
})

// ---------- 组 5：deriveEdges ----------

describe('deriveEdges', () => {
  it('supporting/contradicting/derived/audit 四类边齐全，非 audit 证据不出边', () => {
    const ledger: LedgerDTO = {
      hypotheses: [
        hyp('H-001', { supporting: ['ev_1'], contradicting: ['ev_2'], derived: ['H-002'] }),
        hyp('H-002'),
      ],
      evidence: [
        ev('ev_1'),
        ev('ev_2'),
        ev('ev_a', { kind: 'audit', supports: ['H-001'] }),
        ev('ev_n', { kind: 'tool_observation', supports: ['H-002'] }), // 非 audit：不出边
      ],
    }
    expect(deriveEdges(ledger)).toEqual([
      { from: 'ev_1', to: 'H-001', kind: 'support' },
      { from: 'ev_2', to: 'H-001', kind: 'contradict' },
      { from: 'H-001', to: 'H-002', kind: 'derive' },
      { from: 'ev_a', to: 'H-001', kind: 'audit' },
    ])
  })

  it('多值列表逐条出边（一对多）', () => {
    const ledger: LedgerDTO = {
      hypotheses: [hyp('H-001', { supporting: ['ev_1', 'ev_2'] })],
      evidence: [],
    }
    expect(deriveEdges(ledger)).toEqual([
      { from: 'ev_1', to: 'H-001', kind: 'support' },
      { from: 'ev_2', to: 'H-001', kind: 'support' },
    ])
  })

  it('空列表字段与 null/undefined ledger → 无边', () => {
    expect(deriveEdges({ hypotheses: [hyp('H-001')], evidence: [] })).toEqual([])
    expect(deriveEdges(null)).toEqual([])
    expect(deriveEdges(undefined)).toEqual([])
  })

  it('audit 证据的 contradicts 不参与 audit 边（规格只取 supports）', () => {
    const ledger: LedgerDTO = {
      hypotheses: [hyp('H-001')],
      evidence: [ev('ev_a', { kind: 'audit', contradicts: ['H-001'] })],
    }
    expect(deriveEdges(ledger)).toEqual([])
  })
})

// ---------- 组 6：suggestNext ----------

describe('suggestNext', () => {
  it('tick 为 null 或 re 为 null → none', () => {
    expect(suggestNext(null).action.kind).toBe('none')
    expect(suggestNext(tick()).action.kind).toBe('none')
  })

  it('无 hyp 且阶段在 SCR/HYP 区 → new-hypothesis；其他区不触发', () => {
    const emptyLedger: LedgerDTO = { hypotheses: [], evidence: [] }
    // SCR/HYP 区 = PHASE_ZONE 按索引映射（契约冻结事实）：索引 1、2
    for (const idx of [1, 2]) {
      const s = suggestNext(tick({ re: re(idx), ledger: emptyLedger }))
      expect(s.action).toEqual({ kind: 'new-hypothesis' })
      expect(s.text.length).toBeGreaterThan(0)
    }
    // 非 SCR/HYP 区（索引 6 → AUD）不触发
    expect(suggestNext(tick({ re: re(6), ledger: emptyLedger })).action.kind).toBe('none')
  })

  it('active hyp 无实验或全 planned → configure-experiment', () => {
    const noExp: LedgerDTO = { hypotheses: [hyp('H-001')], evidence: [] }
    expect(suggestNext(tick({ re: re(6), ledger: noExp })).action).toEqual({
      kind: 'configure-experiment',
      hypId: 'H-001',
    })

    const allPlanned: LedgerDTO = {
      hypotheses: [
        hyp('H-001', {
          experiments: [
            { id: 'exp-1', title: 'probe', command: 'strings', status: 'planned' },
            { id: 'exp-2', title: 'trace', command: 'strace', status: 'planned' },
          ],
        }),
      ],
      evidence: [],
    }
    expect(suggestNext(tick({ re: re(6), ledger: allPlanned })).action).toEqual({
      kind: 'configure-experiment',
      hypId: 'H-001',
    })
  })

  it('passed 实验的证据未验证 → run-verification（artifact 取 evidence.artifact）；已验证则不再触发', () => {
    const unverified: LedgerDTO = {
      hypotheses: [
        hyp('H-001', {
          experiments: [
            { id: 'exp-1', title: 'patch', command: 'cp', status: 'passed', evidenceId: 'ev_p' },
          ],
        }),
      ],
      evidence: [ev('ev_p', { kind: 'runtime_trace', artifact: '/tmp/a.out' })],
    }
    const s = suggestNext(tick({ re: re(6), ledger: unverified }))
    expect(s.action).toEqual({ kind: 'run-verification', hypId: 'H-001', artifact: '/tmp/a.out' })
    expect(s.text.length).toBeGreaterThan(0)

    const verified: LedgerDTO = {
      ...unverified,
      evidence: [ev('ev_p', { kind: 'runtime_trace', artifact: '/tmp/a.out', verification: { build: true, passed: 2, total: 2 } })],
    }
    expect(suggestNext(tick({ re: re(6), ledger: verified })).action.kind).toBe('none')

    // passed 实验没有 evidenceId → 无法定位证据，不触发
    const noEvId: LedgerDTO = {
      hypotheses: [
        hyp('H-001', { experiments: [{ id: 'exp-1', title: 'x', command: 'x', status: 'passed' }] }),
      ],
      evidence: [],
    }
    expect(suggestNext(tick({ re: re(6), ledger: noEvId })).action.kind).toBe('none')
  })

  it('audit/writeup 阶段存在 finding → submit-review', () => {
    const findings = [{ rule: 'r1', hypothesisId: 'H-001', applied: false, message: 'mismatch' }]
    expect(suggestNext(tick({ re: re(7), ledger: { hypotheses: [], evidence: [], findings } })).action).toEqual({
      kind: 'submit-review',
      hypId: 'H-001',
    })
    expect(suggestNext(tick({ re: re(8), ledger: { hypotheses: [], evidence: [], findings } })).action.kind).toBe('submit-review')

    // finding 无关联 hyp → hypId 缺省
    const anonymous = [{ rule: 'r2', hypothesisId: '', applied: false, message: 'm' }]
    expect(suggestNext(tick({ re: re(7), ledger: { hypotheses: [], evidence: [], findings: anonymous } })).action).toEqual({
      kind: 'submit-review',
    })

    // 非 audit/writeup 阶段或无 finding → 不触发（前面规则也不命中：实验已通过且已验证）
    const quiet: LedgerDTO = {
      hypotheses: [
        hyp('H-001', {
          experiments: [{ id: 'exp-1', title: 'x', command: 'x', status: 'passed', evidenceId: 'ev_q' }],
        }),
      ],
      evidence: [ev('ev_q', { verification: { build: true, passed: 1, total: 1 } })],
    }
    expect(suggestNext(tick({ re: re(6), ledger: { ...quiet, findings } })).action.kind).toBe('none')
    expect(suggestNext(tick({ re: re(7), ledger: { ...quiet, findings: [] } })).action.kind).toBe('none')
  })

  it('优先级：configure-experiment 先于 run-verification', () => {
    const ledger: LedgerDTO = {
      hypotheses: [
        hyp('H-001', {
          experiments: [{ id: 'exp-1', title: 'probe', command: 'strings', status: 'planned' }],
        }),
        hyp('H-002', {
          experiments: [{ id: 'exp-2', title: 'patch', command: 'cp', status: 'passed', evidenceId: 'ev_p' }],
        }),
      ],
      evidence: [ev('ev_p', { kind: 'runtime_trace', artifact: '/tmp/a.out' })],
    }
    expect(suggestNext(tick({ re: re(6), ledger })).action).toEqual({
      kind: 'configure-experiment',
      hypId: 'H-001',
    })
  })

  it('rejected hyp 的 planned 实验不触发 configure-experiment', () => {
    const ledger: LedgerDTO = {
      hypotheses: [
        hyp('H-001', {
          status: 'rejected',
          experiments: [{ id: 'exp-1', title: 'probe', command: 'strings', status: 'planned' }],
        }),
      ],
      evidence: [],
    }
    expect(suggestNext(tick({ re: re(6), ledger })).action.kind).toBe('none')
  })
})

// ---------- 组 7：scene.ts reconcile 接线 ----------
// 直接调 sceneActions.reconcile 并断言 sceneActions 的 getter 快照
// （useSyncExternalStore 依赖 getSnapshot 引用更换触发重渲染，getter 读的是同一份 snap）。
// 注意：组内用例有顺序依赖（共享模块级 store），勿单独重排。

describe('scene store reconcile wiring', () => {
  it('两次 tick（ev 1→2）→ 快照场景更新且引用更换，suggestion 同步派生', () => {
    const before = sceneActions.scene
    sceneActions.reconcile(
      ['s1'],
      new Map([['s1', tick({ re: re(2), ledger: { hypotheses: [], evidence: [ev('ev_001')] } })]]),
    )
    const first = sceneActions.scene
    expect(first).not.toBe(before)
    expect(first.sessions[0]!.evs).toHaveLength(1)
    expect(sceneActions.suggestion.action.kind).toBe('new-hypothesis')

    sceneActions.reconcile(
      ['s1'],
      new Map([['s1', tick({ re: re(2), ledger: { hypotheses: [], evidence: [ev('ev_001'), ev('ev_002')] } })]]),
    )
    const second = sceneActions.scene
    expect(second).not.toBe(first)
    expect(second.sessions[0]!.evs).toHaveLength(2)
  })

  it('dismiss 后建议条不再更新，但场景照常派生', () => {
    sceneActions.dismissSuggestion()
    const dismissed = sceneActions.suggestion
    sceneActions.reconcile(
      ['s1'],
      new Map([['s1', tick({ re: re(6), ledger: { hypotheses: [hyp('H-009')], evidence: [] } })]]),
    )
    expect(sceneActions.suggestion).toBe(dismissed) // 保持被 dismiss 时的建议引用
    expect(sceneActions.scene.sessions[0]!.hyps).toHaveLength(1)
  })

  it('空 activeIds → 空场景', () => {
    sceneActions.reconcile([], new Map())
    expect(sceneActions.scene.empty).toBe(true)
    expect(sceneActions.scene.sessions).toEqual([])
  })
})
