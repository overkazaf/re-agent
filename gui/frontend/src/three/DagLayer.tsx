// DagLayer — Evidence & Hypothesis 3D Provenance DAG:
// Status-colored translucent crystal HypPrisms with crisp EdgesGeometry cages,
// faceted EvPoly artifacts, balanced causal beams, and frosted HTML pills.
//
// Preserves nodePositionIndex, EV_RENDER_CAP, single-click focus, and
// double-click experiment wizard routing.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { zoneOf, type EvNode, type HypNode, type SessionScene } from './contract'
import { sceneActions } from '../store/scene'
import {
  makeEdgeLineMaterial,
  makeGlassCoreMaterial,
  type TheaterMaterials,
} from './ThemeMaterials'

/** nodeId ('H-001' / 'ev_001') -> world position (including session offset). */
export const nodePositionIndex = new Map<string, [number, number, number]>()

/** Hard render cap for evidence nodes (most recent 200). */
export const EV_RENDER_CAP = 200

// Shared static geometries (singleton per page lifetime).
const EV_GEO = new THREE.IcosahedronGeometry(0.62, 0)
const EV_EDGES = new THREE.EdgesGeometry(EV_GEO)
const HYP_UNIT_GEO = new THREE.OctahedronGeometry(1, 0)
const HYP_UNIT_EDGES = new THREE.EdgesGeometry(HYP_UNIT_GEO)
const HIT_GEO = new THREE.SphereGeometry(1, 8, 8)

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

function hypToneColor(status: HypNode['status'], materials: TheaterMaterials): THREE.Color {
  switch (status) {
    case 'revised':
      return materials.violet
    case 'reevaluate':
      return materials.amber
    case 'rejected':
      return materials.muted
    default:
      return materials.accent
  }
}

function hypToneCssVar(status: HypNode['status']): string {
  switch (status) {
    case 'revised':
      return 'var(--violet)'
    case 'reevaluate':
      return 'var(--warn)'
    case 'rejected':
      return 'var(--faint)'
    default:
      return 'var(--accent)'
  }
}

export function DagLayer({ session, materials }: { session: SessionScene; materials: TheaterMaterials }) {
  const [ox, oy, oz] = session.offset
  const evs = session.evs.length > EV_RENDER_CAP ? session.evs.slice(-EV_RENDER_CAP) : session.evs
  const truncated = session.evs.length - evs.length

  const localPos = useMemo(() => {
    const m = new Map<string, [number, number, number]>()
    for (const h of session.hyps) m.set(h.id, h.position)
    for (const e of evs) m.set(e.id, e.position)
    return m
  }, [session.hyps, evs])

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
      if (!a || !b) continue
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
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      contradict: new THREE.LineBasicMaterial({
        color: materials.err,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
      dim: new THREE.LineBasicMaterial({
        color: materials.violet,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
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

  // Controlled high-tension micro-jitter on contradicted provenance beams.
  const contradictRef = useRef<THREE.LineSegments>(null)
  useFrame(({ clock }) => {
    const seg = contradictRef.current
    const base = edgeData.contradictBase
    if (!seg || base.length === 0) return
    const attr = seg.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const t = clock.elapsedTime
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = base[i] + Math.sin(t * 18 + i * 1.3) * 0.14
      arr[i + 1] = base[i + 1] + Math.cos(t * 15 + i * 0.7) * 0.14
      arr[i + 2] = base[i + 2] + Math.sin(t * 17 + i * 1.9) * 0.14
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
          <div className="theater-chip" style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--muted)' }}>
            ▲ 证据流截断 · 显示最近 {EV_RENDER_CAP} / {session.evs.length}
          </div>
        </Html>
      )}
    </group>
  )
}

/** H-NN Hypothesis Prism: translucent crystal core + razor-sharp edge cage + status pill. */
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
  const prismRef = useRef<THREE.Group>(null)
  const rejected = hyp.status === 'rejected'
  const size = 0.8 + clamp01(hyp.confidence) * 0.8
  const y = hyp.position[1] + (rejected ? -2 : 0)
  const tone = hypToneColor(hyp.status, materials)
  const toneVar = hypToneCssVar(hyp.status)

  const coreMat = useMemo(
    () => makeGlassCoreMaterial(tone, rejected ? 0.1 : 0.28, rejected ? 0.12 : 0.45),
    [tone, rejected],
  )
  const edgeMat = useMemo(
    () => makeEdgeLineMaterial(tone, rejected ? 0.34 : 0.88),
    [tone, rejected],
  )
  const haloMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: tone,
        transparent: true,
        opacity: 0.36,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [tone],
  )

  useEffect(
    () => () => {
      coreMat.dispose()
      edgeMat.dispose()
      haloMat.dispose()
    },
    [coreMat, edgeMat, haloMat],
  )

  useFrame(({ clock }, delta) => {
    const base = rejected ? 0.12 : 0.45
    if (hyp.status === 'active') {
      const wave = Math.sin(clock.elapsedTime * 2.4)
      coreMat.emissiveIntensity = base + 0.35 + wave * 0.22
      haloMat.opacity = 0.32 + wave * 0.16
    } else if (hovered) {
      coreMat.emissiveIntensity = base + 0.65
    } else {
      coreMat.emissiveIntensity = base
    }
    if (prismRef.current && !rejected) {
      prismRef.current.rotation.y += delta * (hovered ? 0.7 : 0.22)
    }
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

  // Fan hypothesis label radially outward from HYP tower axis so stacked
  // prisms remain distinct and readable without label overlap.
  const hypTower = zoneOf('HYP').center
  const rx = hyp.position[0] - hypTower[0]
  const rz = hyp.position[2] - hypTower[2]
  const rLen = Math.hypot(rx, rz) || 1
  const spread = rejected ? 3.8 : 3.2
  const labelOutX = (rx / rLen) * spread
  const labelOutZ = (rz / rLen) * spread

  return (
    <group position={[hyp.position[0], y, hyp.position[2]]}>
      <group ref={prismRef} scale={size}>
        <mesh geometry={HYP_UNIT_GEO} material={coreMat} />
        <lineSegments geometry={HYP_UNIT_EDGES} material={edgeMat} />
      </group>
      {/* Subtle orbital halo ring around active hypotheses */}
      {hyp.status === 'active' && (
        <mesh rotation-x={Math.PI / 2} material={haloMat}>
          <ringGeometry args={[size * 1.28, size * 1.42, 32]} />
        </mesh>
      )}
      {/* Expanded hit sphere for effortless clicking */}
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
        position={[labelOutX, size + 1.05 + (index % 2) * 1.4, labelOutZ]}
        center
        zIndexRange={[40, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div
          className="theater-hyp-pill"
          style={{
            borderTopColor: hovered ? toneVar : undefined,
            borderRightColor: hovered ? toneVar : undefined,
            borderBottomColor: hovered ? toneVar : undefined,
            borderLeftColor: toneVar,
            fontSize: rejected ? 9 : 10,
            padding: rejected ? '1px 5px' : '2px 7px',
            opacity: rejected ? 0.56 : 0.96,
          }}
        >
          <span style={{ color: toneVar, fontWeight: 700 }}>{hyp.id}</span>
          <span style={{ color: 'var(--faint)' }}>·</span>
          <span style={{ color: 'var(--text)' }}>{Math.round(clamp01(hyp.confidence) * 100)}%</span>
        </div>
      </Html>
    </group>
  )
}

/** ev_NNN Evidence Artifact: faceted glass core + crisp edge cage (emerald if verified, crimson if error). */
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
  const color = ev.isError ? materials.err : ev.verified ? materials.ok : materials.faint

  const coreMat = useMemo(
    () => makeGlassCoreMaterial(color, ev.isError ? 0.34 : ev.verified ? 0.24 : 0.18, ev.isError ? 0.65 : 0.35),
    [color, ev.isError, ev.verified],
  )
  const edgeMat = useMemo(
    () => makeEdgeLineMaterial(ev.verified ? materials.ok : color, ev.verified || ev.isError ? 0.92 : 0.62),
    [materials, color, ev.verified, ev.isError],
  )

  useEffect(
    () => () => {
      coreMat.dispose()
      edgeMat.dispose()
    },
    [coreMat, edgeMat],
  )

  useFrame(({ clock }) => {
    if (contradicted) {
      coreMat.emissiveIntensity = Math.sin(clock.elapsedTime * 8) > 0 ? 1.5 : 0.18
    } else if (hovered) {
      coreMat.emissiveIntensity = 1.25
    } else {
      coreMat.emissiveIntensity = ev.isError ? 0.65 : 0.35
    }
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
      <mesh geometry={EV_GEO} material={coreMat} />
      <lineSegments geometry={EV_EDGES} material={edgeMat} />
      <mesh geometry={HIT_GEO} scale={1.6} onClick={focusNode} onPointerOver={onOver} onPointerOut={onOut}>
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}
