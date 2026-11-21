// FROZEN CONTRACT — 3D scene ↔ derivation store ↔ wizard HUD 的共享类型。
// 跟 lib/api.ts 同样的纪律：改动需过集成者评审。
// 各轨道只依赖本文件 + store/scene.ts 的公开 API，不得互 import。

import type {
  EvidenceRecord,
  Hypothesis,
  HypothesisStatus,
  LedgerDTO,
  TickDTO,
} from '../lib/types'

// ---------- 空间布局 ----------

export type ZoneKey = 'TRI' | 'SCR' | 'HYP' | 'EXP' | 'VER' | 'AUD' | 'DEL'

export interface ZoneSpec {
  key: ZoneKey
  label: string // 三角洲/勘查屏/假设塔/实验平台/验证台/审计拱门/交付坞
  center: [number, number, number]
  radius: number // 点击命中半径
}

/** 作战室骨架。TRI 在 +Z（近景），AUD 在 -Z 深处。布局常量唯一来源。 */
export const ZONES: readonly ZoneSpec[] = [
  { key: 'TRI', label: '三角洲', center: [0, 0, 60], radius: 14 },
  { key: 'SCR', label: '勘查屏', center: [-26, 0, 30], radius: 10 },
  { key: 'HYP', label: '假设塔', center: [26, 0, 30], radius: 10 },
  { key: 'EXP', label: '实验平台', center: [0, 0, 0], radius: 12 },
  { key: 'VER', label: '验证台', center: [-24, 0, -30], radius: 10 },
  { key: 'AUD', label: '审计拱门', center: [0, 6, -60], radius: 14 },
  { key: 'DEL', label: '交付坞', center: [24, 0, -30], radius: 10 },
]

/** 多 session 平行主线在 x 轴的排布间距 */
export const RAIL_SPACING = 46

export function zoneOf(key: ZoneKey): ZoneSpec {
  return ZONES.find((z) => z.key === key)!
}

/**
 * 9 阶段 RE 工作流 → 7 区的映射（PhaseRailMesh / ZoneMarker 共用）。
 * 按索引对应 internal/workflow/phase.go 的 Phases（1:1）：
 *   0 triage→TRI  1 static→SCR  2 dynamic→EXP  3 evidence→HYP
 *   4 interface→SCR  5 hypothesis→HYP  6 verify→VER  7 audit→AUD
 *   8 writeup→DEL
 * evidence 入账使 DAG（假设塔周围）生长故映射 HYP；interface 重建
 * 属勘查分析故映射 SCR。suggestNext 以「区 ∈ {SCR,HYP}」触发
 * new-hypothesis 建议，即 static/evidence/interface/hypothesis 相位。
 */
export const PHASE_ZONE: readonly ZoneKey[] = [
  'TRI', // 0 triage
  'SCR', // 1 static
  'EXP', // 2 dynamic
  'HYP', // 3 evidence
  'SCR', // 4 interface
  'HYP', // 5 hypothesis
  'VER', // 6 verify
  'AUD', // 7 audit
  'DEL', // 8 writeup
]

// ---------- 派生场景状态（store/derive.ts 计算，three/ 渲染） ----------

export interface ExpMark {
  id: string
  title: string
  status: 'planned' | 'passed' | 'falsified' | 'error'
  evidenceId?: string
}

export interface HypNode {
  id: string // 'H-001'
  claim: string
  confidence: number // 0..1
  status: HypothesisStatus
  position: [number, number, number]
  experiments: ExpMark[]
}

export interface EvNode {
  id: string // 'ev_001'
  kind: string
  summary: string
  isError: boolean
  verified: boolean
  position: [number, number, number]
}

export type EdgeKind = 'support' | 'contradict' | 'derive' | 'audit'

export interface SceneEdge {
  from: string
  to: string
  kind: EdgeKind
}

export interface PhaseRail {
  activeIndex: number // 0..8；re 为 null 时 -1
  total: number // 9
  archived: boolean // phase 走完 writeup/deliver 后金色定格
}

export interface SessionScene {
  sessionId: string
  offset: [number, number, number] // 平行主线 x 偏移
  rail: PhaseRail
  hyps: HypNode[]
  evs: EvNode[]
  edges: SceneEdge[]
}

export interface SceneState {
  sessions: SessionScene[]
  empty: boolean
}

// ---------- HUD 建议条 ----------

export type SuggestionAction =
  | { kind: 'new-hypothesis' }
  | { kind: 'configure-experiment'; hypId: string }
  | { kind: 'run-verification'; hypId: string; artifact?: string }
  | { kind: 'submit-review'; hypId?: string }
  | { kind: 'none' }

export interface Suggestion {
  text: string
  action: SuggestionAction
}

// ---------- 向导流 ----------

export type WizardStage = 'hypothesis' | 'experiment' | 'verification' | 'review' | 'revise'

export interface WizardContext {
  sessionId: string
  stage: WizardStage
  hypId?: string
  experimentId?: string
  /** revise 变体：失败的证据链回填 */
  failureEvidenceId?: string
  artifact?: string
}

// ---------- 摄像机聚焦目标 ----------

export type FocusTarget =
  | { kind: 'global' }
  | { kind: 'zone'; zone: ZoneKey }
  | { kind: 'node'; nodeId: string }
  | { kind: 'session'; sessionId: string }

// ---------- scene store 公开 API（store/scene.ts 实现，A/C 消费） ----------

export interface SceneStoreApi {
  /** 派生场景（Track B 接线 reconcile 后由 tick 事件驱动） */
  readonly scene: SceneState
  /** 当前摄像机聚焦目标；组件用它触发运镜 */
  readonly focus: FocusTarget
  /** 自增，重复点同一目标也重新运镜 */
  readonly focusNonce: number
  readonly wizard: WizardContext | null
  readonly suggestion: Suggestion
  readonly suggestionDismissed: boolean
  /** 集成者（Task D）在 App 层调用：tick 到达时重算派生状态 */
  reconcile(activeIds: string[], ticks: Map<string, TickDTO | null>): void
  setFocus(target: FocusTarget): void
  openWizard(ctx: WizardContext): void
  advanceWizard(patch: Partial<WizardContext>): void
  closeWizard(): void
  dismissSuggestion(): void
}

// ---------- e2e 调试钩子约定 ----------
// Track A 在 demo/DEV 下挂 window.__theaterDebug = {
//   zoneScreenPos(zone: ZoneKey): {x: number, y: number} | null
// }，e2e 用它拿 canvas 内点击坐标（Task E 用例 1）。

// ---------- 防未使用 import 报错（类型仅供 derive.ts/轨道使用） ----------
export type { EvidenceRecord, Hypothesis, HypothesisStatus, LedgerDTO, TickDTO }
