// DagLayer — 证据 DAG：H-NN 塔顶悬浮棱镜 + ev_NNN 螺旋多面体 + 分类光束边。
// 每次（节流后）渲染把节点世界坐标（含 session offset）写入模块级 nodePositionIndex，
// 供 CameraRig 的 node 运镜查询。ev 超过 200 硬截断只渲染最近 200（HUD 提示）。
//
// 交互：单击节点 setFocus(node)；双击 hyp 节点 openWizard({stage:'experiment'})。
// 边：support 绿色加性光束 / contradict 红色逐帧微扰 / derive、audit 暗紫。
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { zoneOf, type EvNode, type HypNode, type SessionScene } from './contract'
import { sceneActions } from '../store/scene'
import { makeWireMaterial, type TheaterMaterials } from './ThemeMaterials'

/** nodeId（'H-001' / 'ev_001'）→ 世界坐标（含 session offset）。DagLayer 写，CameraRig 读。 */
export const nodePositionIndex = new Map<string, [number, number, number]>()

/** ev 渲染硬截断上限（>200 只渲染最近 200）。 */
export const EV_RENDER_CAP = 200

// 模块级共享几何（页内常驻，单实例；dispose 交给页面卸载）。
const EV_GEO = new THREE.IcosahedronGeometry(0.6, 0)
const EV_EDGES = new THREE.EdgesGeometry(EV_GEO)
const HIT_GEO = new THREE.SphereGeometry(1, 8, 8)

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

export function DagLayer({ session, materials }: { session: SessionScene; materials: TheaterMaterials }) {
  const [ox, oy, oz] = session.offset
  const evs = session.evs.length > EV_RENDER_CAP ? session.evs.slice(-EV_RENDER_CAP) : session.evs
  const truncated = session.evs.length - evs.length

  // 节点局部坐标表（会话组内坐标 == contract position）。
  const localPos = useMemo(() => {
    const m = new Map<string, [number, number, number]>()
    for (const h of session.hyps) m.set(h.id, h.position)
    for (const e of evs) m.set(e.id, e.position)
    return m
  }, [session.hyps, evs])

  // 渲染即写入世界坐标索引（CameraRig 运镜用）。
  useEffect(() => {
    for (const [id, p] of localPos) nodePositionIndex.set(id, [p[0] + ox, p[1] + oy, p[2] + oz])
  }, [localPos, ox, oy, oz])

  const contradictedIds = useMemo(() => {
    const s = new Set<string>()
    for (const e of session.edges) {
      if (e.kind === 'contradict') s.add(e.to)
    }
    return s
  }, [session.edges])

  const edgeData = useMemo(() => {
    const support: number[] = []
    const contradict: number[] = []
    const dim: number[] = []
    for (const edge of session.edges) {
      const a = localPos.get(edge.from)
      const b = localPos.get(edge.to)
      if (!a || !b) continue // 截断后消失的端点：边直接不画
      const push = (t: number[]) => {
        t.push(a[0], a[1], a[2], b[0], b[1], b[2])
      }
      if (edge.kind === 'support') push(support)
      else if (edge.kind === 'contradict') push(contradict)
      else push(dim)
    }
    const geom = (arr: number[]) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3))
      return g
    }
    return {
      support: geom(support),
      contradict: geom(contradict),
      dim: geom(dim),
      contradictBase: Float32Array.from(contradict),
    }
  }, [session.edges, localPos])

  useEffect(
    () => () => {
      edgeData.support.dispose()
      edgeData.contradict.dispose()
      edgeData.dim.dispose()
    },
    [edgeData],
  )

  const lineMats = useMemo(
    () => ({
      support: new THREE.LineBasicMaterial({
        color: materials.ok,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      contradict: new THREE.LineBasicMaterial({ color: materials.err, transparent: true, opacity: 0.9, depthWrite: false }),
      dim: new THREE.LineBasicMaterial({ color: materials.violet, transparent: true, opacity: 0.3, depthWrite: false }),
    }),
    [materials],
  )
  useEffect(
    () => () => {
      lineMats.support.dispose()
      lineMats.contradict.dispose()
      lineMats.dim.dispose()
    },
    [lineMats],
  )

  // contradict 边逐帧顶点微扰（红色抖动）。
  const contradictRef = useRef<THREE.LineSegments>(null)
  useFrame(({ clock }) => {
    const seg = contradictRef.current
    const base = edgeData.contradictBase
    if (!seg || base.length === 0) return
    const attr = seg.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const t = clock.elapsedTime
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = base[i] + Math.sin(t * 21 + i * 1.3) * 0.4
      arr[i + 1] = base[i + 1] + Math.cos(t * 17 + i * 0.7) * 0.4
      arr[i + 2] = base[i + 2] + Math.sin(t * 19 + i * 1.9) * 0.4
    }
    attr.needsUpdate = true
  })

  const hypCenter = zoneOf('HYP').center

  return (
    <group>
      {session.hyps.map((h, i) => (
        <HypPrism key={h.id} hyp={h} index={i} sessionId={session.sessionId} materials={materials} />
      ))}
      {evs.map((e) => (
        <EvPoly key={e.id} ev={e} contradicted={contradictedIds.has(e.id)} materials={materials} />
      ))}
      <lineSegments geometry={edgeData.support} material={lineMats.support} />
      <lineSegments ref={contradictRef} geometry={edgeData.contradict} material={lineMats.contradict} />
      <lineSegments geometry={edgeData.dim} material={lineMats.dim} />
      {truncated > 0 && (
        <Html position={[hypCenter[0], 30, hypCenter[2]]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
          <div className="glow-muted" style={{ fontSize: 10, letterSpacing: '0.12em', whiteSpace: 'nowrap' }}>
            ▲ 证据流截断 · 显示最近 {EV_RENDER_CAP} / {session.evs.length}
          </div>
        </Html>
      )}
    </group>
  )
}

/** H-NN 假设棱镜：边长随 confidence 0.8→1.6；rejected 半透明 + 沉降 2；active 呼吸。 */
function HypPrism({
  hyp,
  index,
  sessionId,
  materials,
}: {
  hyp: HypNode
  index: number
  sessionId: string
  materials: TheaterMaterials
}) {
  const [hovered, setHovered] = useState(false)
  const rejected = hyp.status === 'rejected'
  const size = 0.8 + clamp01(hyp.confidence) * 0.8
  const y = hyp.position[1] + (rejected ? -2 : 0)

  const mat = useMemo(() => makeWireMaterial(materials.accent, rejected ? 0.3 : 0.7, 0.9), [materials, rejected])
  useEffect(() => () => mat.dispose(), [mat])

  useFrame(({ clock }) => {
    const base = rejected ? 0.25 : 0.9
    if (hyp.status === 'active') mat.emissiveIntensity = base + 0.55 + Math.sin(clock.elapsedTime * 2.4) * 0.35
    else if (hovered) mat.emissiveIntensity = base + 0.8
    else mat.emissiveIntensity = base
  })

  const focusNode = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    sceneActions.setFocus({ kind: 'node', nodeId: hyp.id })
  }
  const openExperimentWizard = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    sceneActions.openWizard({ sessionId, stage: 'experiment', hypId: hyp.id })
  }
  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    setHovered(true)
    document.body.style.cursor = 'pointer'
  }
  const onOut = () => {
    setHovered(false)
    document.body.style.cursor = ''
  }

  return (
    <group position={[hyp.position[0], y, hyp.position[2]]}>
      <mesh material={mat}>
        <octahedronGeometry args={[size, 0]} />
      </mesh>
      {/* 命中球：棱镜偏小，放大点击热区 */}
      <mesh
        geometry={HIT_GEO}
        scale={size + 1}
        onClick={focusNode}
        onDoubleClick={openExperimentWizard}
        onPointerOver={onOver}
        onPointerOut={onOut}
      >
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html
        position={[0, size + 1.1 + (index % 2) * 1.7, 0]}
        center
        zIndexRange={[40, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div
          className="glow-accent"
          style={{ fontSize: 10, whiteSpace: 'nowrap', opacity: rejected ? 0.4 : 0.95 }}
        >
          {hyp.id} · {Math.round(clamp01(hyp.confidence) * 100)}%
        </div>
      </Html>
    </group>
  )
}

/** ev_NNN 证据多面体：verified 绿描边、isError 红、被 contradict 指向方波闪烁。 */
function EvPoly({
  ev,
  contradicted,
  materials,
}: {
  ev: EvNode
  contradicted: boolean
  materials: TheaterMaterials
}) {
  const [hovered, setHovered] = useState(false)
  const color = ev.isError ? materials.err : materials.faint

  const mat = useMemo(() => makeWireMaterial(color, ev.isError ? 0.8 : 0.6, 0.8), [color, ev.isError])
  useEffect(() => () => mat.dispose(), [mat])
  const edgeMat = useMemo(
    () => new THREE.LineBasicMaterial({ color: materials.ok, transparent: true, opacity: 0.9, depthWrite: false }),
    [materials],
  )
  useEffect(() => () => edgeMat.dispose(), [edgeMat])

  useFrame(({ clock }) => {
    if (contradicted) mat.emissiveIntensity = Math.sin(clock.elapsedTime * 9) > 0 ? 1.9 : 0.15 // 方波锯齿闪烁
    else if (hovered) mat.emissiveIntensity = 1.5
    else mat.emissiveIntensity = 0.8
  })

  const focusNode = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    sceneActions.setFocus({ kind: 'node', nodeId: ev.id })
  }
  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    setHovered(true)
    document.body.style.cursor = 'pointer'
  }
  const onOut = () => {
    setHovered(false)
    document.body.style.cursor = ''
  }

  return (
    <group position={ev.position}>
      <mesh geometry={EV_GEO} material={mat} />
      {ev.verified && <lineSegments geometry={EV_EDGES} material={edgeMat} />}
      <mesh geometry={HIT_GEO} scale={1.6} onClick={focusNode} onPointerOver={onOver} onPointerOut={onOut}>
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}
