# 3D 取证剧场（3D Forensic Theater）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 GUI 升级为「3D 为主 + 经典回退」的取证作战室：全面 3D 场景（three.js/R3F）+ 引导式假设→实验→验证→审计主线。

**Architecture:** DOM HUD 层（向导卡/审批/输入）不动，WebGL 场景层负责空间/节点/运镜/粒子，`store/scene.ts` 作为唯一派生层消费现有 `store/sessions` 的 tick，向导动作直接调现有 `lib/api`。不发明第二套数据路径。

**Tech Stack:** React 18 + Vite + three + @react-three/fiber@8 + @react-three/drei@9 + vitest（仅派生层单测）。

**并行策略（用户已确认多并发）:**
- Task 0（串行，集成者执行）: 依赖安装 + 冻结契约 + scene store 骨架 + vitest 配置 → 提交
- Track A / B / C 三个并行子代理，各自 `isolation: worktree`（独立分支，文件不相交）
- Task D（串行，集成者）: 合并三分支 + App.tsx 集成 + 降级链
- Task E（串行）: e2e；Task F: 文档

**文件所有权（防冲突）:**

| 轨道 | 独占文件 | 只读依赖 |
| --- | --- | --- |
| Task 0（我） | `package.json`, `vite.config.ts`, `three/contract.ts`, `store/scene.ts` | — |
| Track A（场景） | `three/*.tsx` `three/*.ts`（除 contract.ts） | contract, store/scene, theme/ThemeContext |
| Track B（派生） | `store/derive.ts`, `store/derive.test.ts`, `store/scene.ts` 的 reconcile 接线 | contract, lib/types |
| Track C（向导） | `components/wizard/*` | contract, store/scene, store/sessions actions, lib/api, lib/escStack |
| Task D（我） | `App.tsx`, `components/shell/TopBar.tsx`, `styles/*` | 全部 |

---

## Task 0: 冻结契约 + 依赖 + store 骨架（串行，集成者）

**Files:**
- Modify: `gui/frontend/package.json`（安装依赖）
- Create: `gui/frontend/src/three/contract.ts`
- Create: `gui/frontend/src/store/scene.ts`
- Modify: `gui/frontend/vite.config.ts`（vitest 配置）

**Step 1: 安装依赖**

```bash
cd gui/frontend
npm install three@^0.170.0 @react-three/fiber@^8.17.0 @react-three/drei@^9.114.0
npm install -D vitest@^2.1.0 @types/three@^0.170.0
```

`package.json` scripts 增加: `"test:unit": "vitest run"`。

**Step 2: 写 `src/three/contract.ts`（完整代码，双轨道共享的冻结契约）**

```typescript
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
  archived: boolean // phase === 'writeup' 完成后金色定格（用 re.phase 判断）
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
  readonly focusNonce: number // 自增，重复点同一目标也重新运镜
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
```

**Step 3: 写 `src/store/scene.ts` 骨架（useSyncExternalStore 模式，照抄 sessions.ts 的形态）**

```typescript
// Scene store — 3D 剧场的派生状态 + 向导/聚焦 UI 状态。
// Task 0 只交付骨架（reconcile 直通一个空场景 + 最小建议逻辑），
// Track B 在 store/derive.ts 实现 deriveScene/suggestNext 并接线。
import { useSyncExternalStore } from 'react'
import type { TickDTO } from '../lib/types'
import type {
  FocusTarget,
  SceneState,
  SceneStoreApi,
  Suggestion,
  WizardContext,
} from '../three/contract'

const EMPTY_SCENE: SceneState = { sessions: [], empty: true }
const NO_SUGGESTION: Suggestion = { text: '', action: { kind: 'none' } }

interface SceneSnapshot {
  scene: SceneState
  focus: FocusTarget
  focusNonce: number
  wizard: WizardContext | null
  suggestion: Suggestion
  suggestionDismissed: boolean
}

let snap: SceneSnapshot = {
  scene: EMPTY_SCENE,
  focus: { kind: 'global' },
  focusNonce: 0,
  wizard: null,
  suggestion: NO_SUGGESTION,
  suggestionDismissed: false,
}

const listeners = new Set<() => void>()
function emit() {
  snap = { ...snap }
  listeners.forEach((l) => l())
}

export function useSceneStore(): SceneStoreApi {
  return useSyncExternalStore(subscribe, getSnapshot) as SceneStoreApi
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function getSnapshot(): SceneSnapshot {
  return snap
}

// —— Track B 会把 deriveScene / suggestNext 抽到 store/derive.ts 并在此接线 ——
export const sceneActions: SceneStoreApi = {
  get scene() { return snap.scene },
  get focus() { return snap.focus },
  get focusNonce() { return snap.focusNonce },
  get wizard() { return snap.wizard },
  get suggestion() { return snap.suggestion },
  get suggestionDismissed() { return snap.suggestionDismissed },
  reconcile(_activeIds, _ticks) {
    /* Task 0: no-op；Track B 接线 */
  },
  setFocus(target) {
    snap.focus = target
    snap.focusNonce += 1
    emit()
  },
  openWizard(ctx) {
    snap.wizard = ctx
    emit()
  },
  advanceWizard(patch) {
    if (snap.wizard) snap.wizard = { ...snap.wizard, ...patch }
    emit()
  },
  closeWizard() {
    snap.wizard = null
    emit()
  },
  dismissSuggestion() {
    snap.suggestionDismissed = true
    emit()
  },
}
```

注意：`useSceneStore()` 返回 getter 对象；React 组件里用 `useSceneStore().scene` 等属性（快照不可变引用保证重渲染正确）。组件调用动作用 `sceneActions.setXxx(...)`（与 sessions.ts 的 `actions` 模式一致）。

**Step 4: vitest 配置** — `vite.config.ts` 增加 `/// <reference types="vitest/config" />` 与 `test: { environment: 'node', include: ['src/**/*.test.ts'] }`。

**Step 5: 验证 + 提交**

```bash
cd gui/frontend && npx tsc --noEmit && npm run test:unit
# 期望: tsc 0 错误；vitest "no test files found" 退出码 0（passWithNoTests 配置或先留空测试）
git add -A && git commit -m "feat(gui-3d): freeze theater contract, scene store skeleton, add three/R3F/vitest deps"
```

---

## Track A: 3D 场景骨架（并行子代理 · worktree 分支 `track-a-scene`）

**Files（全部新建，除 contract.ts）:**
- Create: `gui/frontend/src/three/ForensicTheater.tsx` — 主组件（唯一对外的入口）
- Create: `gui/frontend/src/three/ThemeMaterials.ts`
- Create: `gui/frontend/src/three/CameraRig.tsx`
- Create: `gui/frontend/src/three/ZoneMarker.tsx`
- Create: `gui/frontend/src/three/PhaseRailMesh.tsx`
- Create: `gui/frontend/src/three/DagLayer.tsx`
- Create: `gui/frontend/src/three/HoloPanels.tsx`
- Create: `gui/frontend/src/three/useThrottledScene.ts`
- Create: `gui/frontend/src/three/index.ts`

**必须遵守:** 只 import `three/contract.ts`、`store/scene.ts`、`theme/ThemeContext`、`lib/types`、three/R3F/drei。不碰 DOM 组件、不碰 App.tsx。视觉组件无单测（派生层已覆盖逻辑），验收 = `npx tsc --noEmit` + 我在 Task D 合并后跑 e2e。

**行为规格:**

1. `ForensicTheater.tsx`:
   - `<Canvas dpr={[1, 2]} gl={{ antialias: true }}>` + `<color attach="background">` 用主题背景 + `<fog>`（近主题色）
   - 灯光：环境光 0.4 + 两盏点光（cyan 主光在 EXP 上方、violet 补光在 AUD）
   - 空态（`scene.empty`）: 只渲染 TRI ZoneMarker 的呼吸光（`useFrame` 里 sin 缩放 emissiveIntensity），其余不挂载
   - 多 session：按 `scene.sessions[i].offset` 平移各 rail 组
   - **点击空白回全局**: Canvas `onPointerMissed={() => sceneActions.setFocus({ kind: 'global' })}`

2. `ThemeMaterials.ts`:
   - `readThemeMaterials(): { bg, accent, ok, err, violet, amber, faint, glowStrength }` — 从 `getComputedStyle(document.documentElement)` 读 `--bg`, `--accent`, `--ok`, `--err`, `--violet`, `--amber` CSS 变量转 THREE.Color
   - `<ThemeSync />` 组件：用 `useTheme()` 订阅，主题变化时更新一个模块级缓存对象并触发材质重建（`useMemo` 依赖 theme 名）
   - 全部材质 `transparent + emissive`，线框优先（CRT 质感）

3. `CameraRig.tsx`:
   - drei `<CameraControls makeDefault />`；默认位姿：`pos(0, 55, 95)` 看向 `(0, 0, -10)`（斜 45° 俯瞰全局）
   - 订阅 `useSceneStore()` 的 `focus` + `focusNonce`：`global` → 复位；`zone` → 对准 `zoneOf(key).center` 距离 = radius×3.2；`node` → 在 DagLayer 暴露的 `nodePositionIndex`（模块级 Map<string, [number,number,number]>，DagLayer 每次渲染写入）查坐标对准；`session` → x 对准 `offset`
   - 运镜：`cameraControls.setLookAt(...)`（drei 自带 damping 即平滑；约 600ms 的直观感受即可，不手写补间）
   - **节流**: 消费 scene 用 `useThrottledScene(250)`

4. `ZoneMarker.tsx`: 每区一个 `ZoneMarker` — 底座圆环（RingGeometry 线框）+ 中心 glyph（简单几何: TRI=四面体/SCR=平面屏/HYP=塔柱/EXP=六边形台/VER=立方台/AUD=拱门=两柱一梁/DEL=船坞=U 形）+ 文字用 drei `<Text>`（font 用系统 monospace fallback，`fontSize` 2.2，颜色 accent）；`onPointerOver` 高亮 + cursor pointer，`onClick` `setFocus({kind:'zone',...})`。当前相位所在区（rail.activeIndex 映射 9 阶段→7 区：TRI,SCR,HYP,EXP,EXP,VER,AUD,AUD,DEL）脉冲最亮。

5. `PhaseRailMesh.tsx`: TRI→AUD 走 EXP 的折线管道（CatmullRomCurve3 + TubeGeometry 线框材质）。分段着色：`i < activeIndex` 实心 emissive、`i === activeIndex` 脉冲（useFrame sin）、`> activeIndex` 半透明虚化（opacity 0.25）。`archived` 时整条转金色（`--amber`）且停止脉冲。

6. `DagLayer.tsx`:
   - `H-NN`: 塔顶上方悬浮棱镜（OctahedronGeometry，边长随 confidence 0.8→1.6）；`rejected` 半透明(0.3)+y 降 2；`active` 呼吸
   - `ev_NNN`: 绕塔螺旋上升的多面体（IcosahedronGeometry 0.6）；`verified` 加绿描边、`isError` 红、`contradicted`（有 contradict 边指向它）锯齿闪烁（emissiveIntensity 方波）
   - 边：`support` 绿色光束（Line + additive）、`contradict` 红色抖动（顶点每帧微扰）、`derive`/`audit` 暗紫
   - 节点/边总数上限保护：>200 ev 时只渲染最近 200 并在 HUD 提示（YAGNI: 先做硬截断）
   - 渲染同时把坐标写进 `nodePositionIndex`
   - 点击节点 `setFocus({kind:'node', nodeId})`；双击 hyp 节点 `openWizard({stage:'experiment', hypId})`（contract 里 wizard 是 DOM 层渲染，这里只发指令）

7. `HoloPanels.tsx`: 中低空三件套——TRANSCRIPT 摘要柱（最近 3 条 thinkLines 做成发光文本条，点击回经典视图由 Task D 接）、TELE 遥测条（token 数值）、QUEUE 计数环。全部低频（用 throttled scene + tick.hud 数据从 props 传入，不订阅 90ms 事件）。

8. `useThrottledScene.ts`: `useThrottledScene(ms=250)` — 内部 `useRef` 存上次快照时间，`useSceneStore()` 的 scene 引用变更时若间隔不足则返回旧引用（防止每 tick 重渲染整棵场景树）。

9. `index.ts`: 只导出 `ForensicTheater`。

**Step 验收:** `cd gui/frontend && npx tsc --noEmit` 0 错误；`npm run build` 成功（体积检查 three chunk 预期 < 700KB raw）。分 3 次提交：骨架+摄像机、Zone+Rail、DAG+Holo。

---

## Track B: 派生层 TDD（并行子代理 · worktree 分支 `track-b-derive`）

**Files:**
- Create: `gui/frontend/src/store/derive.ts`
- Create: `gui/frontend/src/store/derive.test.ts`
- Modify: `gui/frontend/src/store/scene.ts`（仅 reconcile 接线，~15 行）

**必须遵守:** 纯函数、零 React/three import；只用 `lib/types` 与 `three/contract`。严格 TDD：先写测试看它红，再实现转绿，小步提交。

**测试用例清单（derive.test.ts，先写全再实现）:**

1. `deriveScene`: 空 → `{sessions:[], empty:true}`
2. 单 session 有 ledger（2 hyp、3 ev）→ 节点数正确、`empty:false`、rail.activeIndex 来自 `re.phaseIndex`
3. `placeHyp`: 第 i 个假设绕 HYP 塔 center 的环形排布，半径 8，高度 10+i*4；id 稳定（同 id 重算坐标不变）
4. `placeEv`: 螺旋——第 i 个 ev 的极角 = i * 137.5°（黄金角），半径 6+((i%4))，高度 = 12 + i*2.2，围绕所属假设塔；`isError` 的 ev 高度 -1.5（沉降）
5. `deriveEdges`: hyp.supporting=['ev_1'] → edge(ev_1→H-xx, support)；contradicting → contradict；hyp.derived → derive；kind==='audit' 的 evidence.supports → audit
6. `suggestNext`:
   - `re=null` → none
   - 有 SCR/HYP 阶段且 hyps 为空 → `new-hypothesis`
   - 存在 active hyp 且其 experiments 全 planned（或无）→ `configure-experiment`
   - hyp 有 passed 实验且其 evidenceId 的 ev `.verification` 为空 → `run-verification`（artifact 取 evidence.artifact）
   - re.phase 为 audit/writeup 且存在未 review 的 finding → `submit-review`
   - 优先级从上到下第一个命中即返回
7. `reconcile` 接线后：模拟两次 tick（ev 数 1→2），store 快照的 scene.evs.length 相应变化且引用更换（触发重渲染）

**实现要点:**

```typescript
// store/derive.ts 完整签名
export interface DeriveInput {
  sessionId: string
  slot: number // 第几个 session，决定 offset.x = slot * RAIL_SPACING
  tick: TickDTO | null
}
export function deriveScene(inputs: DeriveInput[]): SceneState
export function placeHyp(hyp: Hypothesis, index: number, base: [number, number, number]): [number, number, number]
export function placeEv(ev: EvidenceRecord, index: number, base: [number, number, number]): [number, number, number]
export function deriveEdges(ledger: LedgerDTO | null | undefined): SceneEdge[]
export function suggestNext(tick: TickDTO | null): Suggestion
```

`scene.ts` 接线（Track B 唯一改动处）:

```typescript
import { deriveScene, suggestNext } from './derive'
// reconcile 实现:
reconcile(activeIds, ticks) {
  const inputs = activeIds.map((id, i) => ({ sessionId: id, slot: i, tick: ticks.get(id) ?? null }))
  const scene = deriveScene(inputs)
  const primary = ticks.get(activeIds[0] ?? '') ?? null
  const suggestion = suggestNext(primary)
  const changed = scene !== snap.scene || suggestion.text !== snap.suggestion.text
  if (!changed) return
  snap.scene = scene
  if (!snap.suggestionDismissed) snap.suggestion = suggestion
  emit()
},
```

**Step 验收:** `npm run test:unit` 全绿；`npx tsc --noEmit` 0 错误。每转绿一组用例提交一次（预计 4-5 个 commit）。

---

## Track C: 向导 DOM 组件（并行子代理 · worktree 分支 `track-c-wizard`）

**Files（全部新建）:**
- Create: `gui/frontend/src/components/wizard/WizardCard.tsx`
- Create: `gui/frontend/src/components/wizard/HypothesisWizard.tsx`
- Create: `gui/frontend/src/components/wizard/ExperimentWizard.tsx`
- Create: `gui/frontend/src/components/wizard/VerificationWizard.tsx`
- Create: `gui/frontend/src/components/wizard/ReviewWizard.tsx`
- Create: `gui/frontend/src/components/wizard/SuggestionBar.tsx`
- Create: `gui/frontend/src/components/wizard/index.ts`

**必须遵守:** 只 import contract、`store/scene`（sceneActions/useSceneStore）、`store/sessions`（actions/useSessionStore 取 runtime）、`lib/api`、`lib/escStack`、`components/crt`（PanelBox/GlowText）、`lib/types`。**不碰 App.tsx / three/ / store 文件**。样式用内联 CSSProperties + CSS 变量（照抄 session/Dialog.tsx 的形态，先 `Read` 它和 `re/HypothesisWorkbenchDialog.tsx` 学习既有表单/校验/提交模式）。

**行为规格:**

1. `WizardCard.tsx`: 共享外壳——fixed 居中卡片（`background: var(--bg-panel)`、`border: 1px solid var(--accent-dim)`、`boxShadow` 辉光）、标题栏（阶段图标+名称+步骤指示 ①-⑤）、`pushEsc(onClose)` 集成、右上 `✕`。props: `{ title, step, children, onClose }`。**审批门优先**: 挂载时若 `useSessionStore()` 的 active runtime 有 `pendingApproval`，本卡片降为背景（`pointerEvents: none; opacity: .6`）——审批 DOM 在 z-index 50 之上自然覆盖，但要把 Esc 让位（有 pendingApproval 时不注册 esc）。

2. `HypothesisWizard.tsx`（stage: hypothesis | revise）:
   - 字段: claim（textarea 必填）、可证伪预测（textarea 必填，占位符提示「写下能被实验推翻的预测，例：解密后前 4 字节应为 magic 'MZPK'」）、挂靠证据（从 runtime.latestTick.ledger.evidence 列出最近 12 条 ev，多选 chip）
   - `revise` 变体: 标题变「修正假设」，预填原 claim（从 ledger.hypotheses 找 hypId），顶部红色条显示失败实验的证据摘要（failureEvidenceId 查 ledger.evidence）
   - 提交: `api.MutateHypothesis(sessionId, { action: 'create' | 'revise', claim, confidence: 0.5, supporting: 选中的 ev })`；成功 → `sceneActions.openWizard({ stage: 'experiment', hypId: 新id })` + `setFocus({kind:'zone', zone:'EXP'})`；失败 → toast（`actions` 的模式）+ 停留本步
   - 跳过按钮: `[稍后再配实验]` → closeWizard

3. `ExperimentWizard.tsx`（stage: experiment）:
   - 实验类型三卡: static_probe（模板 `strings -a {artifact} | head -50`）/ sandbox_trace（`objdump -d {artifact} --start-address=...`）/ artifact_replay（`verify_artifact` 模板）；选中后命令框预填模板可编辑、expected 输入框
   - **引导配置（核心）**: 读 `tick.ledger.sandbox`（SandboxDTO）与 `ledger.goal`——把可写路径渲染成绿色 chip、网络开关状态、只读路径灰色；实验命令引用不可写路径时输入框下红字警告「该路径不在沙箱 scope 内」
   - 提交: `api.RunHypothesisExperiment(sessionId, { hypothesisId, command, expected, title })`；进行中按钮 spinner；返回 evidence `status: 'passed'|'falsified'|'error'`（从 Hypothesis.experiments 比对）→ passed → `openWizard({stage:'verification', hypId, artifact: evidence.artifact})` + setFocus VER；falsified → `openWizard({stage:'revise', hypId, failureEvidenceId})` + setFocus HYP
   - 每步 `[上一步]` 可回 hypothesis 步（advanceWizard）

4. `VerificationWizard.tsx`（stage: verification）: artifact 路径输入（预填 ctx.artifact）、build 命令可选、cases 列表（name/command/expected 三列，+/- 行）；提交 `api.RunVerification`；成功显示 VerificationStats（passed/total 绿红条）并 `openWizard({stage:'review', hypId})` + setFocus AUD。

5. `ReviewWizard.tsx`（stage: review）: mode 单选（arbitrate/operator_audit/model_audit）、verdict（support/challenge/reject）、citedEvidence 多选（从 ledger）、summary；提交 `api.SubmitReview`；结果 findings 列表展示，`[完成归档]` → closeWizard + setFocus global。

6. `SuggestionBar.tsx`: 常驻细条（TopBar 下沿，由 Task D 摆放）——`useSceneStore().suggestion`；action.kind==='none' 或 dismissed 时不渲染；否则 `▸ {text} [去处理 →]` 按钮，点击按 action kind 映射 openWizard + setFocus；右侧 `✕` dismissSuggestion。

**Step 验收:** `npx tsc --noEmit` 0 错误。按组件分 4 次提交。

---

## Task D: 集成 + 降级链（串行，集成者）

**Files:**
- Modify: `gui/frontend/src/App.tsx`
- Modify: `gui/frontend/src/components/shell/TopBar.tsx`
- Create: `gui/frontend/src/three/useTheaterFallback.ts`

**Steps:**

1. **合并三轨道分支**（文件不相交，预期无冲突）:
   ```bash
   git merge track-a-scene && git merge track-b-derive && git merge track-c-wizard
   ```
2. `App.tsx`: `viewMode: 'classic' | 'theater'` state（默认 theater，localStorage 记忆）；theater 时 dashboard 槽渲染 `<ForensicTheater/>`（替换/叠加 Dashboard 都不行——是**替换**，AppShell 布局不动）；TopBar 加切换钮（◈ 3D 剧场 / ▣ 经典视图，复用 graphBtn 样式）；`SuggestionBar` 挂在 banner 槽（AppShell 已有 banner prop，DemoCoachBar 同位，二选一优先 demo）
3. **reconcile 接线**: 在 CommandCenter 的 useEffect 里订阅 sessions 变化，把 `[...sessions.keys()]` + 各 runtime.latestTick 喂给 `sceneActions.reconcile`（这一处是 3D 与现有 store 的唯一桥）
4. **wizard 渲染**: `sceneStore.wizard` 非空时按 stage 挂对应 Wizard 组件（在现有 workbenchModal 同层）；保留原 HypothesisWorkbenchDialog（经典视图入口不删）
5. `useTheaterFallback.ts`: ① `hasWebGL()`（try 创建 canvas.getContext('webgl2'||'webgl')）；② `prefers-reduced-motion` matchMedia；③ 帧率哨兵——ForensicTheater 挂载后 rAF 采样，<30fps 持续 5s → 回调；任一触发 → toast 提示 + setViewMode('classic')。TopBar 的 theater 钮在被自动降级后仍可手动再进（哨兵 30s 冷却）
6. **E2E 自检**: `make gui-demo` 打开，手动走：进 3D → 建假设 → 跑 demo 实验 → 验证 → 审计；切 4 主题看材质即时变化
7. 提交: `feat(gui-3d): integrate theater mode with classic fallback`

---

## Task E: e2e 补齐（串行）

**Files:**
- Modify: `gui/frontend/scripts/e2e-runtime.mjs` / `e2e-demo.mjs`（照现有用例形态追加）

**Steps:**

1. 用例 1（demo 路径）: `?demo=1` → 断言 3D canvas 存在 → 点 SuggestionBar 或 HYP 塔（用 DOM 上的 wizard 卡片断言，canvas 内部交互用 `page.mouse.click(canvas 中心偏 HYP 塔屏幕坐标)`——坐标从 `window.__theaterDebug.zoneScreenPos('HYP')` 拿（Track A 在 DEV/demo 下挂的调试钩子，约定写入 contract 注释）→ 断言 HypothesisWizard DOM 出现 → 填 claim/预测 → 提交 → 断言 ExperimentWizard 出现 → 选 static_probe → 跑 → 断言 demo 后端 mock 实验通过后 VerificationWizard 出现
2. 用例 2: 切经典视图 → 断言现有五维仪表 DOM 在；切回 3D
3. 用例 3: `?demo=1&reduced-motion=1`（demo store 支持 query 强制）→ 断言自动落在经典视图
4. `npm run test:e2e && npm run test:e2e-demo` 全绿 + `go test ./gui/ -run TestE2E -v`
5. 提交: `test(gui-3d): theater-mode e2e coverage`

---

## Task F: 文档 + 截图（串行）

1. README Desktop GUI 节：加 3D 剧场段落（布局图、向导流、降级行为）、新截图（每主题 3D 空站/中线/终局 3 帧，沿用现有 docs/shots/ 命名 `gui-3d-*.png`）
2. README.zh-CN.md 同步
3. 提交: `docs: 3D forensic theater — README + screenshots`
