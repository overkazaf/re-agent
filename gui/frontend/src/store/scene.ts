// Scene store — 3D 剧场的派生状态 + 向导/聚焦 UI 状态 + 战术镜头/图层控制。
// 形态照抄 sessions.ts：useSyncExternalStore 单一快照 + actions 对象，
// 每次变更换快照引用，React 精确重渲染。
// Track B 已接线：reconcile 在 tick 到达时调用 store/derive.ts 的
// deriveScene/suggestNext 重算派生状态（App 层的 CommandCenter 喂 activeIds + ticks）。
import { useSyncExternalStore } from 'react'
import type { TickDTO } from '../lib/types'
import type {
  FocusTarget,
  SceneState,
  SceneStoreApi,
  Suggestion,
  WizardContext,
} from '../three/contract'
import { deriveScene, suggestNext } from './derive'

export type CameraPresetKey = 'overview' | 'tactical' | 'hyp' | 'radar'

const EMPTY_SCENE: SceneState = { sessions: [], empty: true }
const NO_SUGGESTION: Suggestion = { text: '', action: { kind: 'none' } }

export interface SceneSnapshot {
  scene: SceneState
  focus: FocusTarget
  focusNonce: number
  wizard: WizardContext | null
  suggestion: Suggestion
  suggestionDismissed: boolean
  /** Active camera preset key */
  cameraPreset: CameraPresetKey
  /** Increments on every preset selection / reset so re-clicking flies back */
  cameraPresetNonce: number
  /** Gentle cinematic turntable orbit around current camera target */
  autoOrbit: boolean
  /** Stage floor radar grid visibility */
  showGrid: boolean
  /** Floating 3D HoloPanels visibility */
  showHoloPanels: boolean
  /** DAG 3D floating label visibility (wired to DagLayer after merge) */
  showLabels: boolean
}

export interface SceneDeckActions {
  readonly cameraPreset: CameraPresetKey
  readonly cameraPresetNonce: number
  readonly autoOrbit: boolean
  readonly showGrid: boolean
  readonly showHoloPanels: boolean
  readonly showLabels: boolean
  setCameraPreset(preset: CameraPresetKey): void
  setAutoOrbit(enabled: boolean): void
  toggleAutoOrbit(): void
  toggleGrid(): void
  toggleHoloPanels(): void
  toggleLabels(): void
  resetCamera(): void
}

let snap: SceneSnapshot = {
  scene: EMPTY_SCENE,
  focus: { kind: 'global' },
  focusNonce: 0,
  wizard: null,
  suggestion: NO_SUGGESTION,
  suggestionDismissed: false,
  cameraPreset: 'overview',
  cameraPresetNonce: 0,
  autoOrbit: false,
  showGrid: true,
  showHoloPanels: true,
  showLabels: true,
}

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function getSnapshot(): SceneSnapshot {
  return snap
}

/** 组件渲染订阅：const { scene, wizard } = useSceneStore() */
export function useSceneStore(): SceneSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 动作入口：sceneActions.setFocus(...) / openWizard(...)（与 sessions.ts 的 actions 模式一致） */
export const sceneActions: SceneStoreApi & SceneDeckActions = {
  get scene() {
    return snap.scene
  },
  get focus() {
    return snap.focus
  },
  get focusNonce() {
    return snap.focusNonce
  },
  get wizard() {
    return snap.wizard
  },
  get suggestion() {
    return snap.suggestion
  },
  get suggestionDismissed() {
    return snap.suggestionDismissed
  },
  get cameraPreset() {
    return snap.cameraPreset
  },
  get cameraPresetNonce() {
    return snap.cameraPresetNonce
  },
  get autoOrbit() {
    return snap.autoOrbit
  },
  get showGrid() {
    return snap.showGrid
  },
  get showHoloPanels() {
    return snap.showHoloPanels
  },
  get showLabels() {
    return snap.showLabels
  },
  reconcile(activeIds: string[], ticks: Map<string, TickDTO | null>) {
    // Track B 接线：tick 到达时重算派生场景 + 主 session 建议（照计划 Track B 节）。
    const inputs = activeIds.map((id, i) => ({ sessionId: id, slot: i, tick: ticks.get(id) ?? null }))
    const scene = deriveScene(inputs)
    const primary = ticks.get(activeIds[0] ?? '') ?? null
    const suggestion = suggestNext(primary)
    if (scene === snap.scene && suggestion.text === snap.suggestion.text) return
    snap = {
      ...snap,
      scene,
      // 建议条被 dismiss 后不再更新，直到下次会话状态重启
      suggestion: snap.suggestionDismissed ? snap.suggestion : suggestion,
    }
    emit()
  },
  setFocus(target: FocusTarget) {
    snap = { ...snap, focus: target, focusNonce: snap.focusNonce + 1 }
    emit()
  },
  openWizard(ctx: WizardContext) {
    snap = { ...snap, wizard: ctx }
    emit()
  },
  advanceWizard(patch: Partial<WizardContext>) {
    if (snap.wizard) snap = { ...snap, wizard: { ...snap.wizard, ...patch } }
    emit()
  },
  closeWizard() {
    snap = { ...snap, wizard: null }
    emit()
  },
  dismissSuggestion() {
    snap = { ...snap, suggestionDismissed: true }
    emit()
  },
  setCameraPreset(preset: CameraPresetKey) {
    snap = {
      ...snap,
      cameraPreset: preset,
      cameraPresetNonce: snap.cameraPresetNonce + 1,
    }
    emit()
  },
  setAutoOrbit(enabled: boolean) {
    if (snap.autoOrbit === enabled) return
    snap = { ...snap, autoOrbit: enabled }
    emit()
  },
  toggleAutoOrbit() {
    snap = { ...snap, autoOrbit: !snap.autoOrbit }
    emit()
  },
  toggleGrid() {
    snap = { ...snap, showGrid: !snap.showGrid }
    emit()
  },
  toggleHoloPanels() {
    snap = { ...snap, showHoloPanels: !snap.showHoloPanels }
    emit()
  },
  toggleLabels() {
    snap = { ...snap, showLabels: !snap.showLabels }
    emit()
  },
  resetCamera() {
    snap = {
      ...snap,
      cameraPreset: 'overview',
      cameraPresetNonce: snap.cameraPresetNonce + 1,
      focus: { kind: 'global' },
      focusNonce: snap.focusNonce + 1,
      autoOrbit: false,
    }
    emit()
  },
}
