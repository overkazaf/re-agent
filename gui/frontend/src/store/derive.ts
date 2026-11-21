// Track B —— 3D 剧场派生层（纯函数，零 React/three 依赖）。
// 输入：CommandCenter 喂进来的各 session 最新 tick（DeriveInput）；
// 输出：three/contract.ts 冻结契约里的 SceneState / Suggestion。
// 行为规格：docs/plans/2026-11-21-3d-forensic-theater.md Track B 节。
import type {
  EvidenceRecord,
  Hypothesis,
  LedgerDTO,
  TickDTO,
} from '../lib/types'
import { PHASE_ZONE, RAIL_SPACING, zoneOf } from '../three/contract'
import type {
  EvNode,
  ExpMark,
  HypNode,
  SceneEdge,
  SceneState,
  SessionScene,
  Suggestion,
} from '../three/contract'

export interface DeriveInput {
  sessionId: string
  slot: number
  tick: TickDTO | null
}

// ---------- 布局常量（规格：Track B 节） ----------

const DEG = Math.PI / 180
/** 黄金角（°）——假设环与证据螺旋共用的角步进 */
const GOLDEN_ANGLE_DEG = 137.5
const HYP_RING_RADIUS = 8
const HYP_BASE_HEIGHT = 10
const HYP_LEVEL_HEIGHT = 4
const EV_RING_BASE = 6
const EV_RING_MOD = 4 // 半径 = 6 + (index % 4)
const EV_BASE_HEIGHT = 12
const EV_LEVEL_HEIGHT = 2.2
const EV_ERROR_Y = -1.5 // isError 证据沉降

/** 证据视为已验证：跑过 verification 且全部用例通过。 */
function isVerified(ev: EvidenceRecord): boolean {
  const v = ev.verification
  return v != null && v.total > 0 && v.passed >= v.total
}

/** tick → 单条 session 主线：假设塔节点 + 证据螺旋 + 边 + 相位轨道。 */
function deriveSession(input: DeriveInput): SessionScene {
  const offset: [number, number, number] = [input.slot * RAIL_SPACING, 0, 0]
  const zone = zoneOf('HYP').center
  const base: [number, number, number] = [zone[0] + offset[0], zone[1] + offset[1], zone[2] + offset[2]]

  const ledger = input.tick?.ledger ?? null
  const re = input.tick?.re ?? null

  const hyps: HypNode[] = (ledger?.hypotheses ?? []).map((hyp, i) => ({
    id: hyp.id,
    claim: hyp.claim,
    confidence: hyp.confidence,
    status: hyp.status,
    position: placeHyp(hyp, i, base),
    experiments: (hyp.experiments ?? []).map(
      (exp): ExpMark => ({
        id: exp.id,
        title: exp.title,
        status: exp.status,
        evidenceId: exp.evidenceId,
      }),
    ),
  }))

  const evs: EvNode[] = (ledger?.evidence ?? []).map((ev, i) => ({
    id: ev.id,
    kind: ev.kind ?? ev.source,
    summary: ev.summary ?? ev.excerpt,
    isError: !!ev.isError,
    verified: isVerified(ev),
    position: placeEv(ev, i, base),
  }))

  return {
    sessionId: input.sessionId,
    offset,
    rail: {
      activeIndex: re ? re.phaseIndex : -1,
      total: PHASE_ZONE.length, // 9
      archived: re?.phase === 'writeup',
    },
    hyps,
    evs,
    edges: deriveEdges(ledger),
  }
}

/** 多 session 派生：inputs 为空（或不含任何 session）时输出空场景。 */
export function deriveScene(inputs: DeriveInput[]): SceneState {
  const sessions = inputs.map(deriveSession)
  return { sessions, empty: sessions.length === 0 }
}

/** 假设节点：绕 HYP 塔 base 环形上升，半径 8、高度 10 + index*4；只依赖 index/base，同 id 重算坐标不变。 */
export function placeHyp(
  _hyp: Hypothesis,
  index: number,
  base: [number, number, number],
): [number, number, number] {
  const a = index * GOLDEN_ANGLE_DEG * DEG
  return [
    base[0] + HYP_RING_RADIUS * Math.cos(a),
    base[1] + HYP_BASE_HEIGHT + index * HYP_LEVEL_HEIGHT,
    base[2] + HYP_RING_RADIUS * Math.sin(a),
  ]
}

/** 证据节点：黄金角螺旋（极角 i*137.5°，半径 6+(i%4)，高度 12+i*2.2）绕所属假设塔；isError 沉降到 -1.5。 */
export function placeEv(
  ev: EvidenceRecord,
  index: number,
  base: [number, number, number],
): [number, number, number] {
  const a = index * GOLDEN_ANGLE_DEG * DEG
  const r = EV_RING_BASE + (index % EV_RING_MOD)
  const y = ev.isError ? base[1] + EV_ERROR_Y : base[1] + EV_BASE_HEIGHT + index * EV_LEVEL_HEIGHT
  return [base[0] + r * Math.cos(a), y, base[2] + r * Math.sin(a)]
}

/**
 * 从台账派生场景边：
 * - hyp.supporting → support 边（ev → hyp）
 * - hyp.contradicting → contradict 边（ev → hyp）
 * - hyp.derived → derive 边（父 hyp → 子 hyp）
 * - kind === 'audit' 的 evidence.supports → audit 边（ev → hyp）
 */
export function deriveEdges(ledger: LedgerDTO | null | undefined): SceneEdge[] {
  if (!ledger) return []
  const edges: SceneEdge[] = []
  for (const hyp of ledger.hypotheses) {
    for (const evId of hyp.supporting ?? []) {
      edges.push({ from: evId, to: hyp.id, kind: 'support' })
    }
    for (const evId of hyp.contradicting ?? []) {
      edges.push({ from: evId, to: hyp.id, kind: 'contradict' })
    }
    for (const childId of hyp.derived ?? []) {
      edges.push({ from: hyp.id, to: childId, kind: 'derive' })
    }
  }
  for (const ev of ledger.evidence) {
    if (ev.kind !== 'audit') continue
    for (const hypId of ev.supports ?? []) {
      edges.push({ from: ev.id, to: hypId, kind: 'audit' })
    }
  }
  return edges
}

export function suggestNext(tick: TickDTO | null): Suggestion {
  void tick
  throw new Error('not implemented')
}
