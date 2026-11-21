// Scene store — 3D 剧场的派生状态 + 向导/聚焦 UI 状态。
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

const EMPTY_SCENE: SceneState = { sessions: [], empty: true }
const NO_SUGGESTION: Suggestion = { text: '', action: { kind: 'none' } }

export interface SceneSnapshot {
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
export const sceneActions: SceneStoreApi = {
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
}
