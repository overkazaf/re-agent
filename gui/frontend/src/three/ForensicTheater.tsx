// ForensicTheater — 3D 取证剧场主组件（three/ 唯一对外入口，见 index.ts）。
// DOM HUD 层（向导卡/审批/输入）不在此渲染；这里只有 WebGL 空间：
// 灯光、雾、摄像机运镜、区块标记、相位主线、证据 DAG 与全息面板。
//
// 数据：store/scene（useSceneStore 快照 + sceneActions 动作），经 useThrottledScene
// 节流消费；点画布空白回全局视角。多 session = 按 offset 平移的平行主线组。
// HUD 摘要（think/token/queue）由集成层低频组装经 props 喂入，不订阅 90ms 事件。
//
// e2e 调试钩子：DEV / demo 下挂 window.__theaterDebug.zoneScreenPos(zone)（contract 尾注约定）。
import { useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { PHASE_ZONE, ZONES, zoneOf, type SceneState, type ZoneKey } from './contract'
import { sceneActions } from '../store/scene'
import { ThemeSync, useTheaterMaterials, type TheaterMaterials } from './ThemeMaterials'
import { useThrottledScene } from './useThrottledScene'
import { CameraRig } from './CameraRig'
import { ZoneMarker } from './ZoneMarker'
import { PhaseRailMesh } from './PhaseRailMesh'
import { DagLayer } from './DagLayer'
import { HoloPanels, type HoloHudData } from './HoloPanels'

declare global {
  interface Window {
    __DEMO__?: boolean
    /** Track A 挂的 e2e 调试钩子（DEV / demo 才有；见 contract.ts 尾注） */
    __theaterDebug?: {
      zoneScreenPos: (zone: ZoneKey) => { x: number; y: number } | null
    }
  }
}

export interface ForensicTheaterProps {
  /** HUD 摘要（TRANSCRIPT/TELE/QUEUE），集成层低频喂入；缺省显示占位 */
  hud?: HoloHudData | null
  /** 点击 TRANSCRIPT 摘要条 → 回经典视图（集成层接线） */
  onExitToClassic?: () => void
}

/** 最近一次 pointerdown 的页面坐标：onPointerMissed 用它区分「点击」与「拖拽视角」。 */
const lastPointerDown = { x: Number.NaN, y: Number.NaN }

export function ForensicTheater({ hud = null, onExitToClassic }: ForensicTheaterProps) {
  const materials = useTheaterMaterials()
  const scene = useThrottledScene(250)
  return (
    <>
      <ThemeSync />
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true }}
        camera={{ position: [0, 55, 95], fov: 50, near: 0.5, far: 600 }}
        onPointerMissed={(e) => {
          const dx = e.clientX - lastPointerDown.x
          const dy = e.clientY - lastPointerDown.y
          if (dx * dx + dy * dy > 36) return // 环绕/平移的拖拽不算空白点击
          sceneActions.setFocus({ kind: 'global' })
        }}
      >
        <SceneRoot materials={materials} scene={scene} hud={hud} onExitToClassic={onExitToClassic} />
      </Canvas>
    </>
  )
}

function SceneRoot({
  materials,
  scene,
  hud,
  onExitToClassic,
}: {
  materials: TheaterMaterials
  scene: SceneState
  hud: HoloHudData | null
  onExitToClassic?: () => void
}) {
  const primary = scene.sessions[0] ?? null
  let activeZone: ZoneKey | null = null
  if (primary && !primary.rail.archived) {
    const i = primary.rail.activeIndex
    if (i >= 0 && i < PHASE_ZONE.length) activeZone = PHASE_ZONE[i]
  }
  return (
    <>
      <color attach="background" args={[materials.bg.getHex()]} />
      <fog attach="fog" args={[materials.bg.getHex(), 130, 300]} />
      <ambientLight intensity={0.4} />
      {/* EXP 上方 cyan 主光 + AUD 上方 violet 补光 */}
      <pointLight position={[0, 34, 0]} color={materials.accent} intensity={1.1} decay={0} />
      <pointLight position={[0, 34, -60]} color={materials.violet} intensity={0.9} decay={0} />
      <CameraRig />
      <PointerDownProbe />
      <TheaterDebugBridge />
      {scene.empty ? (
        // 空态：只挂 TRI 入口呼吸光（呼应 ░ NO SIGNAL ░）
        <ZoneMarker zone={zoneOf('TRI')} materials={materials} breathing />
      ) : (
        <>
          {ZONES.map((z) => (
            <ZoneMarker key={z.key} zone={z} materials={materials} active={activeZone === z.key} />
          ))}
          {scene.sessions.map((s) => (
            <group key={s.sessionId} position={s.offset}>
              <PhaseRailMesh rail={s.rail} materials={materials} />
              <DagLayer session={s} materials={materials} />
            </group>
          ))}
          <HoloPanels materials={materials} hud={hud} onExitToClassic={onExitToClassic} />
        </>
      )}
    </>
  )
}

/** 记录 pointerdown 坐标（供 onPointerMissed 判定拖拽距离）。 */
function PointerDownProbe(): null {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const el = gl.domElement
    const onDown = (e: PointerEvent) => {
      lastPointerDown.x = e.clientX
      lastPointerDown.y = e.clientY
    }
    el.addEventListener('pointerdown', onDown)
    return () => el.removeEventListener('pointerdown', onDown)
  }, [gl])
  return null
}

/** e2e 调试钩子：把区中心用 camera.project 投到页面像素坐标（点击 canvas 内目标用）。 */
function TheaterDebugBridge(): null {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
    if (!env?.DEV && !window.__DEMO__) return
    const v = new THREE.Vector3()
    window.__theaterDebug = {
      zoneScreenPos(zone) {
        const spec = ZONES.find((z) => z.key === zone)
        if (!spec) return null
        v.set(spec.center[0], spec.center[1], spec.center[2]).project(camera)
        const rect = gl.domElement.getBoundingClientRect()
        return {
          x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
          y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
        }
      },
    }
    return () => {
      delete window.__theaterDebug
    }
  }, [camera, gl])
  return null
}
