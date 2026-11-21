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
  SceneEdge,
  SceneState,
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

export function deriveScene(inputs: DeriveInput[]): SceneState {
  void inputs
  throw new Error('not implemented')
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

export function deriveEdges(ledger: LedgerDTO | null | undefined): SceneEdge[] {
  void ledger
  throw new Error('not implemented')
}

export function suggestNext(tick: TickDTO | null): Suggestion {
  void tick
  throw new Error('not implemented')
}

// 布局常量唯一来源仍是 three/contract.ts；此处仅消费。
void PHASE_ZONE
void zoneOf
