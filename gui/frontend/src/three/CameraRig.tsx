// CameraRig — 默认斜 45° 俯瞰全局 + focus 运镜（global / zone / session）。
// 平滑过渡交给 camera-controls 自带 damping（smoothTime≈0.35s，直观约 600ms），
// 不手写补间。session 偏移查询走节流快照（useThrottledScene）。
import { useEffect, useRef } from 'react'
import { CameraControls } from '@react-three/drei'
import type CameraControlsImpl from 'camera-controls'
import * as THREE from 'three'
import { zoneOf } from './contract'
import { nodePositionIndex } from './DagLayer'
import { useSceneStore } from '../store/scene'
import { useThrottledScene } from './useThrottledScene'

// 全局取景：视点前移（target z=+4）让房间在 2:1 横向画布居中，
// TRI（z=+60）与 AUD（z=-60）两端各留约 3° 视锥余量，无底部裁切。
export const HOME_POS: readonly [number, number, number] = [0, 64, 106]
export const HOME_TARGET: readonly [number, number, number] = [0, 0, 4]

/** 全局视角的观察方向（target→pos），聚焦时保持同一角度推近。 */
const VIEW_DIR = new THREE.Vector3(...HOME_POS).sub(new THREE.Vector3(...HOME_TARGET)).normalize()

export function CameraRig() {
  const controls = useRef<CameraControlsImpl | null>(null)
  const { focus, focusNonce } = useSceneStore()
  const scene = useThrottledScene(250)
  // 同一目标不因 scene 刷新而重拍；未渲染出的 node 目标挂起等下一次快照重试。
  const appliedNonce = useRef(-1)
  const pendingNode = useRef<string | null>(null)

  // 默认位姿：挂载即摆到位（不动画）。
  useEffect(() => {
    controls.current?.setLookAt(...HOME_POS, ...HOME_TARGET, false)
  }, [])

  useEffect(() => {
    const c = controls.current
    if (!c) return
    const fly = (center: THREE.Vector3, dist: number) => {
      const pos = center.clone().addScaledVector(VIEW_DIR, dist)
      void c.setLookAt(pos.x, pos.y, pos.z, center.x, center.y, center.z, true)
    }
    if (focus.kind === 'node') {
      if (appliedNonce.current === focusNonce && pendingNode.current === null) return
      const p = nodePositionIndex.get(focus.nodeId)
      if (!p) {
        // 节点尚未渲染（截断/还没挂载）：挂起，等下一次节流快照重试。
        pendingNode.current = focus.nodeId
        return
      }
      pendingNode.current = null
      appliedNonce.current = focusNonce
      fly(new THREE.Vector3(p[0], p[1], p[2]), 9)
      return
    }
    pendingNode.current = null
    if (appliedNonce.current === focusNonce) return
    appliedNonce.current = focusNonce
    if (focus.kind === 'global') {
      void c.setLookAt(...HOME_POS, ...HOME_TARGET, true)
    } else if (focus.kind === 'zone') {
      const spec = zoneOf(focus.zone)
      fly(new THREE.Vector3(...spec.center), spec.radius * 3.2)
    } else {
      const s = scene.sessions.find((x) => x.sessionId === focus.sessionId)
      if (!s) return
      void c.setLookAt(
        HOME_POS[0] + s.offset[0], HOME_POS[1], HOME_POS[2],
        HOME_TARGET[0] + s.offset[0], HOME_TARGET[1], HOME_TARGET[2],
        true,
      )
    }
  }, [focus, focusNonce, scene])

  return <CameraControls ref={controls} makeDefault smoothTime={0.35} />
}
