// CameraRig — Tactical camera pilot with 4 calibrated presets, focus framing,
// gentle auto-orbit turntable (pauses immediately on user drag), and zero-rerender
// live azimuth/elevation/distance telemetry written directly to a DOM ref.
import { useEffect, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import type CameraControlsImpl from 'camera-controls'
import * as THREE from 'three'
import { zoneOf } from './contract'
import { nodePositionIndex } from './DagLayer'
import { sceneActions, useSceneStore, type CameraPresetKey } from '../store/scene'
import { useThrottledScene } from './useThrottledScene'

export interface CameraPresetSpec {
  key: CameraPresetKey
  shortcut: '1' | '2' | '3' | '4'
  label: string
  title: string
  hint: string
  position: readonly [number, number, number]
  target: readonly [number, number, number]
}

export const CAMERA_PRESETS: Record<CameraPresetKey, CameraPresetSpec> = {
  overview: {
    key: 'overview',
    shortcut: '1',
    label: '俯瞰',
    title: '俯瞰全局',
    hint: '切至平衡全局俯瞰视角',
    position: [0, 72, 124],
    target: [0, 3, -6],
  },
  tactical: {
    key: 'tactical',
    shortcut: '2',
    label: '战术',
    title: '低角战术',
    hint: '切至低角度戏剧性战术主视角',
    position: [68, 38, 86],
    target: [0, 6, -12],
  },
  hyp: {
    key: 'hyp',
    shortcut: '3',
    label: '假设',
    title: '假设塔特写',
    hint: '拉近环绕假设塔与证据 DAG 螺旋',
    position: [52, 28, 60],
    target: [26, 14, 30],
  },
  radar: {
    key: 'radar',
    shortcut: '4',
    label: '雷达',
    title: '顶视雷达',
    hint: '切至近似正交顶视雷达态势图',
    position: [0, 148, 22],
    target: [0, 0, -8],
  },
}

export const CAMERA_PRESET_LIST: readonly CameraPresetSpec[] = [
  CAMERA_PRESETS.overview,
  CAMERA_PRESETS.tactical,
  CAMERA_PRESETS.hyp,
  CAMERA_PRESETS.radar,
]

// Framed global view (preserved exports for callers/tests).
export const HOME_POS: readonly [number, number, number] = CAMERA_PRESETS.overview.position
export const HOME_TARGET: readonly [number, number, number] = CAMERA_PRESETS.overview.target

/** 全局视角的观察方向（target→pos），聚焦时保持同一角度推近。 */
const VIEW_DIR = new THREE.Vector3(...HOME_POS).sub(new THREE.Vector3(...HOME_TARGET)).normalize()

/** Gentle cinematic turntable speed (~9 deg/sec). */
const AUTO_ORBIT_RAD_PER_SEC = 0.16

export interface CameraTelemetry {
  azimuthDeg: number
  elevationDeg: number
  distance: number
}

/** Pure spherical telemetry from camera position & lookAt target. */
export function computeCameraTelemetry(
  pos: readonly [number, number, number],
  target: readonly [number, number, number],
): CameraTelemetry {
  const dx = pos[0] - target[0]
  const dy = pos[1] - target[1]
  const dz = pos[2] - target[2]
  const distance = Math.hypot(dx, dy, dz)
  if (!Number.isFinite(distance) || distance < 1e-6) {
    return { azimuthDeg: 0, elevationDeg: 0, distance: 0 }
  }
  const horiz = Math.hypot(dx, dz)
  const rawAz = (Math.atan2(dx, dz) * 180) / Math.PI
  const azimuthDeg = ((rawAz % 360) + 360) % 360
  const elevationDeg = Math.max(-90, Math.min(90, (Math.atan2(dy, horiz) * 180) / Math.PI))
  return { azimuthDeg, elevationDeg, distance }
}

/** Crisp tabular-nums telemetry readout: `AZ 038° · EL 31° · D 142`. */
export function formatCameraTelemetry(t: CameraTelemetry): string {
  const azNum = ((Math.round(Number.isFinite(t.azimuthDeg) ? t.azimuthDeg : 0) % 360) + 360) % 360
  const elRaw = Math.max(-90, Math.min(90, Math.round(Number.isFinite(t.elevationDeg) ? t.elevationDeg : 0)))
  const distNum = Math.max(0, Math.round(Number.isFinite(t.distance) ? t.distance : 0))
  const az = String(azNum).padStart(3, '0')
  const el = elRaw < 0 ? `-${String(Math.abs(elRaw)).padStart(2, '0')}` : String(elRaw).padStart(2, '0')
  return `AZ ${az}° · EL ${el}° · D ${distNum}`
}

// ---------- Single-key shortcut guards & resolver (pure, unit-tested) ----------

export type TheaterKeyAction =
  | { kind: 'preset'; preset: CameraPresetKey }
  | { kind: 'reset' }
  | { kind: 'toggle-orbit' }
  | { kind: 'clear-focus' }
  | null

interface EditableTargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/** True when keyboard focus is inside an input, textarea, select, or contenteditable field. */
export function isEditableEventTarget(target: EventTarget | EditableTargetLike | null): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as EditableTargetLike
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  if (typeof el.closest === 'function') {
    if (el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') != null) {
      return true
    }
  }
  return false
}

/** True when a modal dialog is open in the DOM. */
export function hasOpenModalDialog(doc?: Pick<Document, 'querySelector'> | null): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false
  return doc.querySelector('[role="dialog"][aria-modal="true"], [aria-modal="true"], dialog[open]') != null
}

export interface TheaterShortcutEventLike {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  defaultPrevented?: boolean
}

export function resolveTheaterShortcut(
  e: TheaterShortcutEventLike,
  opts: { editable: boolean; modalOpen: boolean; hasFocus: boolean },
): TheaterKeyAction {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null
  if (opts.editable || opts.modalOpen) return null

  switch (e.key) {
    case '1':
      return { kind: 'preset', preset: 'overview' }
    case '2':
      return { kind: 'preset', preset: 'tactical' }
    case '3':
      return { kind: 'preset', preset: 'hyp' }
    case '4':
      return { kind: 'preset', preset: 'radar' }
    case 'r':
    case 'R':
      return { kind: 'reset' }
    case ' ':
      return e.repeat ? null : { kind: 'toggle-orbit' }
    case 'Escape':
      return opts.hasFocus ? { kind: 'clear-focus' } : null
    default:
      if (e.code === 'Space') return e.repeat ? null : { kind: 'toggle-orbit' }
      return null
  }
}

export interface CameraRigProps {
  /** Direct DOM target for live AZ/EL/D telemetry (zero React re-renders per frame). */
  telemetryRef?: RefObject<HTMLSpanElement | null>
}

export function CameraRig({ telemetryRef }: CameraRigProps) {
  const controls = useRef<CameraControlsImpl | null>(null)
  const { focus, focusNonce, cameraPreset, cameraPresetNonce, autoOrbit } = useSceneStore()
  const scene = useThrottledScene(250)

  const appliedFocusNonce = useRef(focusNonce)
  const appliedPresetNonce = useRef(cameraPresetNonce)
  const pendingNode = useRef<string | null>(null)
  const autoOrbitRef = useRef(autoOrbit)
  autoOrbitRef.current = autoOrbit

  // Scratch vectors & last rendered telemetry string (zero per-frame allocations/re-renders).
  const posVec = useRef(new THREE.Vector3())
  const targetVec = useRef(new THREE.Vector3())
  const lastTelemetry = useRef('')

  // Initial pose: snap immediately on mount without animation.
  useEffect(() => {
    const spec = CAMERA_PRESETS[cameraPreset] ?? CAMERA_PRESETS.overview
    controls.current?.setLookAt(...spec.position, ...spec.target, false)
    appliedPresetNonce.current = cameraPresetNonce
    appliedFocusNonce.current = focusNonce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Preset transitions (1-4 buttons / shortcuts / R reset).
  useEffect(() => {
    const c = controls.current
    if (!c) return
    if (appliedPresetNonce.current === cameraPresetNonce) return
    appliedPresetNonce.current = cameraPresetNonce
    pendingNode.current = null
    if (focus.kind === 'global') {
      appliedFocusNonce.current = focusNonce
    }
    const spec = CAMERA_PRESETS[cameraPreset] ?? CAMERA_PRESETS.overview
    void c.setLookAt(...spec.position, ...spec.target, true)
  }, [cameraPreset, cameraPresetNonce, focus.kind, focusNonce])

  // Focus transitions (zone / node / session / void-reset).
  useEffect(() => {
    const c = controls.current
    if (!c) return
    const fly = (center: THREE.Vector3, dist: number) => {
      const pos = center.clone().addScaledVector(VIEW_DIR, dist)
      void c.setLookAt(pos.x, pos.y, pos.z, center.x, center.y, center.z, true)
    }
    if (focus.kind === 'node') {
      if (appliedFocusNonce.current === focusNonce && pendingNode.current === null) return
      const p = nodePositionIndex.get(focus.nodeId)
      if (!p) {
        // 节点尚未渲染（截断/还没挂载）：挂起，等下一次节流快照重试。
        pendingNode.current = focus.nodeId
        return
      }
      pendingNode.current = null
      appliedFocusNonce.current = focusNonce
      fly(new THREE.Vector3(p[0], p[1], p[2]), 11)
      return
    }
    pendingNode.current = null
    if (appliedFocusNonce.current === focusNonce) return
    appliedFocusNonce.current = focusNonce
    if (focus.kind === 'global') {
      void c.setLookAt(...HOME_POS, ...HOME_TARGET, true)
    } else if (focus.kind === 'zone') {
      const spec = zoneOf(focus.zone)
      fly(new THREE.Vector3(...spec.center), spec.radius * 3.2)
    } else {
      const s = scene.sessions.find((x) => x.sessionId === focus.sessionId)
      if (!s) return
      void c.setLookAt(
        HOME_POS[0] + s.offset[0],
        HOME_POS[1],
        HOME_POS[2],
        HOME_TARGET[0] + s.offset[0],
        HOME_TARGET[1],
        HOME_TARGET[2],
        true,
      )
    }
  }, [focus, focusNonce, scene])

  // Per-frame auto-orbit turntable + direct DOM telemetry update (zero React setState).
  useFrame((_, delta) => {
    const c = controls.current
    if (!c) return
    if (autoOrbitRef.current) {
      c.rotate(Math.min(delta, 0.05) * AUTO_ORBIT_RAD_PER_SEC, 0, false)
    }
    const el = telemetryRef?.current
    if (!el) return
    c.getPosition(posVec.current)
    c.getTarget(targetVec.current)
    const text = formatCameraTelemetry(
      computeCameraTelemetry(
        [posVec.current.x, posVec.current.y, posVec.current.z],
        [targetVec.current.x, targetVec.current.y, targetVec.current.z],
      ),
    )
    if (text !== lastTelemetry.current) {
      lastTelemetry.current = text
      el.textContent = text
    }
  })

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.35}
      minDistance={10}
      maxDistance={280}
      maxPolarAngle={Math.PI * 0.485}
      onStart={() => {
        // Pause cinematic turntable immediately when the operator grabs the viewport.
        if (autoOrbitRef.current) {
          sceneActions.setAutoOrbit(false)
        }
      }}
    />
  )
}
