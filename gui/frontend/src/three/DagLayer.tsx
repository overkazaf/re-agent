// DagLayer — High-precision 3D Causal-Optics Provenance DAG:
// Curved quadratic-Bezier optical arcs, zero-GC pooled signal photons,
// interactive Hypothesis ↔ Evidence proof-chain spotlighting, orbiting 3D
// confidence gauge rings, floor telemetry plumb-lines, distinct polyhedron
// evidence archetypes, and crisp monospace hover telemetry.
//
// Preserves nodePositionIndex, EV_RENDER_CAP, single-click focus,
// double-click experiment wizard routing, and backwards-compatible props.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { zoneOf, type EdgeKind, type EvNode, type HypNode, type SessionScene } from './contract'
import { sceneActions, useSceneStore } from '../store/scene'
import {
  makeEdgeLineMaterial,
  makeGlassCoreMaterial,
  type TheaterMaterials,
} from './ThemeMaterials'
import {
  classifyEvidenceShape,
  collectCausalNeighborhood,
  confidenceArcSegments,
  evalBezierPointInto,
  evidenceKindTag,
  polylineToLineSegments,
  sampleBezierArc,
  truncateTelemetry,
  type EvidenceShapeKind,
  type Vec3,
} from './dagGeometry'

/** nodeId ('H-001' / 'ev_001') -> world position (including session offset). */
export const nodePositionIndex = new Map<string, [number, number, number]>()

/** Hard render cap for evidence nodes (most recent 200). */
export const EV_RENDER_CAP = 200

const ARC_SEGMENTS = 18
const PHOTONS_PER_EDGE = 2
const MAX_PHOTONS = 800

// ---------- Shared static geometries & invisible hit material ----------

const HYP_UNIT_GEO = new THREE.OctahedronGeometry(1, 0)
const HYP_UNIT_EDGES = new THREE.EdgesGeometry(HYP_UNIT_GEO)
const HYP_INNER_GEO = new THREE.OctahedronGeometry(0.42, 0)

const EV_STATIC_GEO = new THREE.BoxGeometry(0.92, 0.92, 0.92)
const EV_STATIC_EDGES = new THREE.EdgesGeometry(EV_STATIC_GEO)

const EV_DYNAMIC_GEO = new THREE.IcosahedronGeometry(0.66, 0)
const EV_DYNAMIC_EDGES = new THREE.EdgesGeometry(EV_DYNAMIC_GEO)

const EV_VERIFY_GEO = new THREE.OctahedronGeometry(0.66, 0)
const EV_VERIFY_EDGES = new THREE.EdgesGeometry(EV_VERIFY_GEO)

const EV_AUDIT_GEO = new THREE.CylinderGeometry(0.52, 0.52, 0.92, 6)
const EV_AUDIT_EDGES = new THREE.EdgesGeometry(EV_AUDIT_GEO)
const EV_AUDIT_SHIELD_GEO = new THREE.CylinderGeometry(0.74, 0.74, 1.1, 6)
const EV_AUDIT_SHIELD_EDGES = new THREE.EdgesGeometry(EV_AUDIT_SHIELD_GEO)
// Dispose temporary builder source geometry right away; EdgesGeometry owns its own buffer.
EV_AUDIT_SHIELD_GEO.dispose()

const HIT_GEO = new THREE.SphereGeometry(1, 8, 8)
const TIP_DOT_GEO = new THREE.OctahedronGeometry(0.11, 0)

const INVISIBLE_HIT_MAT = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
})

/** Unit vertical plumb line from y=0 to y=1; scaled per node to reach floor y=0. */
const UNIT_PLUMB_GEO = (() => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3))
  return g
})()

/** Floor telemetry crosshair reticle (+) with inner diamond at y=0 for HypPrism. */
const HYP_FLOOR_RETICLE_GEO = (() => {
  const s = 0.85
  const d = 0.34
  const pts = [
    // Crosshair ticks
    -s, 0, 0, -d, 0, 0,
    d, 0, 0, s, 0, 0,
    0, 0, -s, 0, 0, -d,
    0, 0, d, 0, 0, s,
    // Inner diamond
    0, 0, -d, d, 0, 0,
    d, 0, 0, 0, 0, d,
    0, 0, d, -d, 0, 0,
    -d, 0, 0, 0, 0, -d,
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return g
})()

/** Subtle ground anchor tick at y=0 for EvPoly. */
const EV_ANCHOR_TICK_GEO = (() => {
  const r = 0.32
  const pts = [
    -r, 0, 0, r, 0, 0,
    0, 0, -r, 0, 0, r,
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return g
})()

/** Unit 360° reference track circle in the XZ plane for confidence gauges. */
const GAUGE_TRACK_UNIT_GEO = (() => {
  const pts = confidenceArcSegments(1, 1, 64)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(polylineToLineSegments(pts), 3))
  return g
})()

/** Orthogonal double optical rings surrounding verification_result diamond cores. */
const EV_VERIFY_RINGS_GEO = (() => {
  const r1 = 0.92
  const r2 = 0.78
  const segs = 28
  const verts: number[] = []
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2
    const a1 = ((i + 1) / segs) * Math.PI * 2
    // Outer ring in XZ plane
    verts.push(
      Math.cos(a0) * r1, 0, Math.sin(a0) * r1,
      Math.cos(a1) * r1, 0, Math.sin(a1) * r1,
    )
    // Inner tilted ring in XY plane
    verts.push(
      Math.cos(a0) * r2, Math.sin(a0) * r2, 0,
      Math.cos(a1) * r2, Math.sin(a1) * r2, 0,
    )
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  return g
})()

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

function edgeKindColor(kind: EdgeKind, materials: TheaterMaterials): THREE.Color {
  switch (kind) {
    case 'support':
      return materials.ok
    case 'contradict':
      return materials.err
    case 'audit':
      return materials.amber
    default:
      return materials.violet
  }
}

function edgeLiftForKind(kind: EdgeKind): number | undefined {
  switch (kind) {
    case 'contradict':
      return 3.4
    case 'derive':
      return 3.8
    case 'audit':
      return 2.8
    default:
      return undefined // auto-scaled by horizontal distance
  }
}

function photonSpeedForKind(kind: EdgeKind): number {
  switch (kind) {
    case 'contradict':
      return 0.66
    case 'support':
      return 0.38
    case 'audit':
      return 0.34
    default:
      return 0.28
  }
}

/** Creates a soft radial optical-pulse sprite texture for THREE.Points photons. */
function createPhotonTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const grad = ctx.createRadialGradient(16, 16, 1, 16, 16, 15)
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)')
  grad.addColorStop(0.32, 'rgba(255, 255, 255, 0.9)')
  grad.addColorStop(0.68, 'rgba(255, 255, 255, 0.28)')
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 32, 32)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

interface ResolvedArc {
  index: number
  from: string
  to: string
  kind: EdgeKind
  fromPos: Vec3
  toPos: Vec3
  lift: number | undefined
  sampled: [number, number, number][]
  phaseSeed: number
}

interface JitterBucket {
  geometry: THREE.BufferGeometry
  base: Float32Array
  weights: Float32Array
  phases: Float32Array
}

function buildLineBucket(arcs: readonly ResolvedArc[]): THREE.BufferGeometry {
  const totalFloats = arcs.length * ARC_SEGMENTS * 6
  const pos = new Float32Array(totalFloats)
  let cursor = 0
  for (let a = 0; a < arcs.length; a++) {
    const pts = arcs[a]!.sampled
    for (let s = 0; s < pts.length - 1; s++) {
      const p0 = pts[s]!
      const p1 = pts[s + 1]!
      pos[cursor++] = p0[0]
      pos[cursor++] = p0[1]
      pos[cursor++] = p0[2]
      pos[cursor++] = p1[0]
      pos[cursor++] = p1[1]
      pos[cursor++] = p1[2]
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}

function buildJitterBucket(arcs: readonly ResolvedArc[]): JitterBucket {
  const vertexCount = arcs.length * ARC_SEGMENTS * 2
  const pos = new Float32Array(vertexCount * 3)
  const weights = new Float32Array(vertexCount)
  const phases = new Float32Array(vertexCount)
  let vCursor = 0
  let pCursor = 0
  for (let a = 0; a < arcs.length; a++) {
    const arc = arcs[a]!
    const pts = arc.sampled
    const nSeg = pts.length - 1
    for (let s = 0; s < nSeg; s++) {
      const p0 = pts[s]!
      const p1 = pts[s + 1]!
      const w0 = Math.sin((s / nSeg) * Math.PI)
      const w1 = Math.sin(((s + 1) / nSeg) * Math.PI)
      // Shared sample phase guarantees adjacent segments stay seamlessly welded.
      const ph0 = arc.phaseSeed + s * 1.73
      const ph1 = arc.phaseSeed + (s + 1) * 1.73

      pos[pCursor++] = p0[0]
      pos[pCursor++] = p0[1]
      pos[pCursor++] = p0[2]
      weights[vCursor] = w0
      phases[vCursor] = ph0
      vCursor++

      pos[pCursor++] = p1[0]
      pos[pCursor++] = p1[1]
      pos[pCursor++] = p1[2]
      weights[vCursor] = w1
      phases[vCursor] = ph1
      vCursor++
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return {
    geometry: g,
    base: Float32Array.from(pos),
    weights,
    phases,
  }
}

interface PhotonSlot {
  arc: ResolvedArc
  offset: number
  speed: number
  highlighted: boolean
}

export interface DagLayerProps {
  session: SessionScene
  materials: TheaterMaterials
  showLabels?: boolean
}

export function DagLayer({ session, materials, showLabels = true }: DagLayerProps) {
  const { focus } = useSceneStore()
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const [ox, oy, oz] = session.offset
  const evs = session.evs.length > EV_RENDER_CAP ? session.evs.slice(-EV_RENDER_CAP) : session.evs
  const truncated = session.evs.length - evs.length

  // Reset hover cleanly if the hovered node disappears from the ledger.
  const localPos = useMemo(() => {
    const m = new Map<string, [number, number, number]>()
    for (const h of session.hyps) {
      const y = h.position[1] + (h.status === 'rejected' ? -2 : 0)
      m.set(h.id, [h.position[0], y, h.position[2]])
    }
    for (const e of evs) m.set(e.id, e.position)
    return m
  }, [session.hyps, evs])

  useEffect(() => {
    if (hoveredId && !localPos.has(hoveredId)) setHoveredId(null)
  }, [hoveredId, localPos])

  useEffect(() => {
    for (const [id, p] of localPos) {
      nodePositionIndex.set(id, [p[0] + ox, p[1] + oy, p[2] + oz])
    }
  }, [localPos, ox, oy, oz])

  // Clear pointer cursor if DagLayer unmounts while hovering a node.
  useEffect(
    () => () => {
      if (typeof document !== 'undefined') document.body.style.cursor = ''
    },
    [],
  )

  const { contradictedIds, evRelationTag } = useMemo(() => {
    const contra = new Set<string>()
    const rel = new Map<string, string>()
    for (const e of session.edges) {
      if (e.kind === 'contradict') {
        contra.add(e.from)
        contra.add(e.to)
        rel.set(e.from, 'CONTRADICT')
      } else if (e.kind === 'audit' && !rel.has(e.from)) {
        rel.set(e.from, 'AUDIT')
      } else if (e.kind === 'support' && !rel.has(e.from)) {
        rel.set(e.from, 'SUPPORT')
      }
    }
    return { contradictedIds: contra, evRelationTag: rel }
  }, [session.edges])

  // Pre-sample curved Bezier arcs once per topology change.
  const resolvedArcs = useMemo<ResolvedArc[]>(() => {
    const list: ResolvedArc[] = []
    for (let i = 0; i < session.edges.length; i++) {
      const edge = session.edges[i]!
      const a = localPos.get(edge.from)
      const b = localPos.get(edge.to)
      if (!a || !b) continue
      const lift = edgeLiftForKind(edge.kind)
      list.push({
        index: list.length,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        fromPos: a,
        toPos: b,
        lift,
        sampled: sampleBezierArc(a, b, lift, ARC_SEGMENTS),
        phaseSeed: (i + 1) * 7.31,
      })
    }
    return list
  }, [session.edges, localPos])

  const focusedNodeId = focus.kind === 'node' && localPos.has(focus.nodeId) ? focus.nodeId : null
  const spotlightId = hoveredId ?? focusedNodeId
  const hasSpotlight = spotlightId !== null

  const neighborhood = useMemo(
    () => collectCausalNeighborhood(spotlightId, resolvedArcs),
    [spotlightId, resolvedArcs],
  )

  // Partition arcs into bright (active / spotlight) and dimmed (background) buckets.
  const arcBuckets = useMemo(() => {
    const supBright: ResolvedArc[] = []
    const supDim: ResolvedArc[] = []
    const conBright: ResolvedArc[] = []
    const conDim: ResolvedArc[] = []
    const depBright: ResolvedArc[] = []
    const depDim: ResolvedArc[] = []
    const audBright: ResolvedArc[] = []
    const audDim: ResolvedArc[] = []

    for (let i = 0; i < resolvedArcs.length; i++) {
      const arc = resolvedArcs[i]!
      const isBright = !hasSpotlight || neighborhood.edgeIndices.has(i)
      if (arc.kind === 'support') {
        ;(isBright ? supBright : supDim).push(arc)
      } else if (arc.kind === 'contradict') {
        ;(isBright ? conBright : conDim).push(arc)
      } else if (arc.kind === 'audit') {
        ;(isBright ? audBright : audDim).push(arc)
      } else {
        ;(isBright ? depBright : depDim).push(arc)
      }
    }

    return {
      supportBright: buildLineBucket(supBright),
      supportDim: buildLineBucket(supDim),
      contradictBright: buildJitterBucket(conBright),
      contradictDim: buildJitterBucket(conDim),
      deriveBright: buildLineBucket(depBright),
      deriveDim: buildLineBucket(depDim),
      auditBright: buildLineBucket(audBright),
      auditDim: buildLineBucket(audDim),
    }
  }, [resolvedArcs, hasSpotlight, neighborhood])

  useEffect(
    () => () => {
      arcBuckets.supportBright.dispose()
      arcBuckets.supportDim.dispose()
      arcBuckets.contradictBright.geometry.dispose()
      arcBuckets.contradictDim.geometry.dispose()
      arcBuckets.deriveBright.dispose()
      arcBuckets.deriveDim.dispose()
      arcBuckets.auditBright.dispose()
      arcBuckets.auditDim.dispose()
    },
    [arcBuckets],
  )

  const lineMats = useMemo(() => {
    const blend = materials.isLight ? THREE.NormalBlending : THREE.AdditiveBlending
    return {
      supportBright: new THREE.LineBasicMaterial({
        color: materials.ok,
        transparent: true,
        opacity: hasSpotlight ? 0.96 : 0.78,
        blending: blend,
        depthWrite: false,
      }),
      supportDim: new THREE.LineBasicMaterial({
        color: materials.ok,
        transparent: true,
        opacity: 0.11,
        depthWrite: false,
      }),
      contradictBright: new THREE.LineBasicMaterial({
        color: materials.err,
        transparent: true,
        opacity: hasSpotlight ? 1.0 : 0.9,
        depthWrite: false,
      }),
      contradictDim: new THREE.LineBasicMaterial({
        color: materials.err,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }),
      deriveBright: new THREE.LineBasicMaterial({
        color: materials.violet,
        transparent: true,
        opacity: hasSpotlight ? 0.92 : 0.52,
        blending: blend,
        depthWrite: false,
      }),
      deriveDim: new THREE.LineBasicMaterial({
        color: materials.violet,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
      }),
      auditBright: new THREE.LineBasicMaterial({
        color: materials.amber,
        transparent: true,
        opacity: hasSpotlight ? 0.94 : 0.72,
        blending: blend,
        depthWrite: false,
      }),
      auditDim: new THREE.LineBasicMaterial({
        color: materials.amber,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
      }),
    }
  }, [materials, hasSpotlight])

  useEffect(
    () => () => {
      lineMats.supportBright.dispose()
      lineMats.supportDim.dispose()
      lineMats.contradictBright.dispose()
      lineMats.contradictDim.dispose()
      lineMats.deriveBright.dispose()
      lineMats.deriveDim.dispose()
      lineMats.auditBright.dispose()
      lineMats.auditDim.dispose()
    },
    [lineMats],
  )

  // Pooled signal photons traveling along all curved causal arcs (0 GC per frame).
  const photonTexture = useMemo(() => createPhotonTexture(), [])
  useEffect(
    () => () => {
      photonTexture?.dispose()
    },
    [photonTexture],
  )

  const photonPool = useMemo(() => {
    const slots: PhotonSlot[] = []
    const perEdge =
      resolvedArcs.length * PHOTONS_PER_EDGE > MAX_PHOTONS ? 1 : PHOTONS_PER_EDGE
    const edgeLimit = Math.min(resolvedArcs.length, Math.floor(MAX_PHOTONS / perEdge))

    for (let i = 0; i < edgeLimit; i++) {
      const arc = resolvedArcs[i]!
      const highlighted = !hasSpotlight || neighborhood.edgeIndices.has(i)
      const baseSpeed = photonSpeedForKind(arc.kind) * (hasSpotlight && highlighted ? 1.28 : 1)
      const seedOffset = ((i * 0.37) % 1)
      for (let p = 0; p < perEdge; p++) {
        slots.push({
          arc,
          offset: (seedOffset + p / perEdge) % 1,
          speed: baseSpeed,
          highlighted,
        })
      }
    }

    const brightSlots = slots.filter((s) => s.highlighted)
    const dimSlots = slots.filter((s) => !s.highlighted)

    const buildPhotonGeo = (list: readonly PhotonSlot[], dim: boolean) => {
      const positions = new Float32Array(list.length * 3)
      const colors = new Float32Array(list.length * 3)
      const tmp = new THREE.Color()
      for (let i = 0; i < list.length; i++) {
        const slot = list[i]!
        evalBezierPointInto(
          slot.arc.fromPos,
          slot.arc.toPos,
          slot.arc.lift,
          slot.offset,
          positions,
          i * 3,
        )
        tmp.copy(edgeKindColor(slot.arc.kind, materials))
        if (!dim && !materials.isLight) {
          tmp.lerp(materials.text, 0.25)
        }
        colors[i * 3] = tmp.r
        colors[i * 3 + 1] = tmp.g
        colors[i * 3 + 2] = tmp.b
      }
      const g = new THREE.BufferGeometry()
      const posAttr = new THREE.Float32BufferAttribute(positions, 3)
      posAttr.setUsage(THREE.DynamicDrawUsage)
      g.setAttribute('position', posAttr)
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      return { geometry: g, positions, posAttr, slots: list }
    }

    return {
      bright: buildPhotonGeo(brightSlots, false),
      dim: buildPhotonGeo(dimSlots, true),
    }
  }, [resolvedArcs, hasSpotlight, neighborhood, materials])

  useEffect(
    () => () => {
      photonPool.bright.geometry.dispose()
      photonPool.dim.geometry.dispose()
    },
    [photonPool],
  )

  const photonMats = useMemo(() => {
    const blend = materials.isLight ? THREE.NormalBlending : THREE.AdditiveBlending
    return {
      bright: new THREE.PointsMaterial({
        size: hasSpotlight ? 1.55 : 1.3,
        sizeAttenuation: true,
        vertexColors: true,
        map: photonTexture ?? undefined,
        transparent: true,
        opacity: hasSpotlight ? 0.98 : 0.88,
        blending: blend,
        depthWrite: false,
      }),
      dim: new THREE.PointsMaterial({
        size: 0.72,
        sizeAttenuation: true,
        vertexColors: true,
        map: photonTexture ?? undefined,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    }
  }, [materials.isLight, hasSpotlight, photonTexture])

  useEffect(
    () => () => {
      photonMats.bright.dispose()
      photonMats.dim.dispose()
    },
    [photonMats],
  )

  const contradictBrightRef = useRef<THREE.LineSegments>(null)
  const contradictDimRef = useRef<THREE.LineSegments>(null)

  useFrame(({ clock }) => {
    const t = clock.elapsedTime

    // 1. Controlled high-tension electric micro-jitter on contradicted arcs
    //    (interior curve points crackle while endpoints remain locked to nodes).
    const animateJitter = (
      seg: THREE.LineSegments | null,
      bucket: JitterBucket,
      amp: number,
    ) => {
      if (!seg || bucket.base.length === 0) return
      const attr = seg.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      const base = bucket.base
      const weights = bucket.weights
      const phases = bucket.phases
      for (let v = 0; v < weights.length; v++) {
        const w = weights[v]!
        if (w <= 0) continue
        const o = v * 3
        const ph = phases[v]!
        const scale = amp * w
        arr[o] = base[o]! + Math.sin(t * 21 + ph) * scale
        arr[o + 1] = base[o + 1]! + Math.cos(t * 17 + ph * 0.73) * scale
        arr[o + 2] = base[o + 2]! + Math.sin(t * 19 + ph * 1.29) * scale
      }
      attr.needsUpdate = true
    }
    animateJitter(contradictBrightRef.current, arcBuckets.contradictBright, hasSpotlight ? 0.24 : 0.18)
    animateJitter(contradictDimRef.current, arcBuckets.contradictDim, 0.08)

    // 2. Zero-GC directional optical signal photons gliding along causal Bezier arcs.
    const updatePhotons = (group: {
      positions: Float32Array
      posAttr: THREE.Float32BufferAttribute
      slots: readonly PhotonSlot[]
    }) => {
      const { slots, positions, posAttr } = group
      if (slots.length === 0) return
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!
        const u = (slot.offset + t * slot.speed) % 1
        evalBezierPointInto(
          slot.arc.fromPos,
          slot.arc.toPos,
          slot.arc.lift,
          u,
          positions,
          i * 3,
        )
      }
      posAttr.needsUpdate = true
    }
    updatePhotons(photonPool.bright)
    updatePhotons(photonPool.dim)
  })

  const hypCenter = zoneOf('HYP').center

  return (
    <group>
      {session.hyps.map((h, i) => {
        const isHovered = hoveredId === h.id
        const isFocused = focusedNodeId === h.id
        const isHighlighted = hasSpotlight && neighborhood.nodeIds.has(h.id)
        const isDimmed = hasSpotlight && !isHighlighted
        return (
          <HypPrism
            key={h.id}
            hyp={h}
            index={i}
            sessionId={session.sessionId}
            materials={materials}
            showLabels={showLabels}
            hovered={isHovered}
            focused={isFocused}
            highlighted={isHighlighted}
            dimmed={isDimmed}
            onHoverChange={(over) => setHoveredId((prev) => (over ? h.id : prev === h.id ? null : prev))}
          />
        )
      })}

      {evs.map((e) => {
        const isHovered = hoveredId === e.id
        const isFocused = focusedNodeId === e.id
        const isHighlighted = hasSpotlight && neighborhood.nodeIds.has(e.id)
        const isDimmed = hasSpotlight && !isHighlighted
        return (
          <EvPoly
            key={e.id}
            ev={e}
            contradicted={contradictedIds.has(e.id)}
            relationTag={evRelationTag.get(e.id) ?? null}
            materials={materials}
            showLabels={showLabels}
            hovered={isHovered}
            focused={isFocused}
            highlighted={isHighlighted}
            dimmed={isDimmed}
            onHoverChange={(over) => setHoveredId((prev) => (over ? e.id : prev === e.id ? null : prev))}
          />
        )
      })}

      {/* Curved optical causal arcs */}
      <lineSegments geometry={arcBuckets.supportBright} material={lineMats.supportBright} />
      <lineSegments geometry={arcBuckets.supportDim} material={lineMats.supportDim} />
      <lineSegments
        ref={contradictBrightRef}
        geometry={arcBuckets.contradictBright.geometry}
        material={lineMats.contradictBright}
      />
      <lineSegments
        ref={contradictDimRef}
        geometry={arcBuckets.contradictDim.geometry}
        material={lineMats.contradictDim}
      />
      <lineSegments geometry={arcBuckets.deriveBright} material={lineMats.deriveBright} />
      <lineSegments geometry={arcBuckets.deriveDim} material={lineMats.deriveDim} />
      <lineSegments geometry={arcBuckets.auditBright} material={lineMats.auditBright} />
      <lineSegments geometry={arcBuckets.auditDim} material={lineMats.auditDim} />

      {/* Directional animated signal photons */}
      {photonPool.bright.slots.length > 0 && (
        <points geometry={photonPool.bright.geometry} material={photonMats.bright} frustumCulled={false} />
      )}
      {photonPool.dim.slots.length > 0 && (
        <points geometry={photonPool.dim.geometry} material={photonMats.dim} frustumCulled={false} />
      )}

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

/**
 * H-NN Hypothesis Prism: translucent crystal octahedron + inner refraction core +
 * razor-sharp EdgesGeometry wire cage + orbiting 3D confidence gauge ring +
 * vertical floor telemetry plumb-line & crosshair reticle + crisp HUD chip.
 */
function HypPrism({
  hyp,
  index,
  sessionId,
  materials,
  showLabels,
  hovered,
  focused,
  highlighted,
  dimmed,
  onHoverChange,
}: {
  hyp: HypNode
  index: number
  sessionId: string
  materials: TheaterMaterials
  showLabels: boolean
  hovered: boolean
  focused: boolean
  highlighted: boolean
  dimmed: boolean
  onHoverChange: (over: boolean) => void
}) {
  const prismRef = useRef<THREE.Group>(null)
  const gaugeGroupRef = useRef<THREE.Group>(null)
  const rejected = hyp.status === 'rejected'
  const conf = clamp01(hyp.confidence)
  const confPct = Math.round(conf * 100)
  const size = 0.8 + conf * 0.8
  const gaugeRadius = size * 1.42
  const y = hyp.position[1] + (rejected ? -2 : 0)
  const tone = hypToneColor(hyp.status, materials)
  const toneVar = hypToneCssVar(hyp.status)

  // Partial circular confidence gauge geometry derived directly from confidenceArcSegments().
  const { gaugeArcGeo, gaugeTipPos } = useMemo(() => {
    const pts = confidenceArcSegments(conf, gaugeRadius, 56)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(polylineToLineSegments(pts), 3))
    const tip = pts.length > 0 ? pts[pts.length - 1]! : null
    return { gaugeArcGeo: g, gaugeTipPos: tip }
  }, [conf, gaugeRadius])

  useEffect(() => () => gaugeArcGeo.dispose(), [gaugeArcGeo])

  const mats = useMemo(() => {
    const dimFactor = dimmed ? 0.24 : 1
    const hiBoost = highlighted || hovered || focused ? 1.3 : 1
    const coreOpacity = (rejected ? 0.1 : 0.28) * (dimmed ? 0.35 : 1)
    const coreEmissive = (rejected ? 0.12 : 0.45) * dimFactor * hiBoost
    return {
      core: makeGlassCoreMaterial(tone, coreOpacity, coreEmissive),
      inner: makeGlassCoreMaterial(tone, dimmed ? 0.08 : rejected ? 0.16 : 0.46, coreEmissive * 1.45),
      edge: makeEdgeLineMaterial(tone, Math.min(1, (rejected ? 0.34 : 0.88) * dimFactor * hiBoost)),
      gaugeArc: new THREE.LineBasicMaterial({
        color: tone,
        transparent: true,
        opacity: Math.min(1, (rejected ? 0.36 : 0.92) * dimFactor * hiBoost),
        blending: materials.isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
      }),
      gaugeTrack: new THREE.LineBasicMaterial({
        color: materials.rule,
        transparent: true,
        opacity: dimmed ? 0.08 : 0.34,
        depthWrite: false,
      }),
      gaugeTip: new THREE.MeshBasicMaterial({
        color: materials.isLight ? tone : materials.text,
        transparent: true,
        opacity: dimmed ? 0.14 : 0.95,
        depthWrite: false,
      }),
      plumb: new THREE.LineBasicMaterial({
        color: tone,
        transparent: true,
        opacity: dimmed ? 0.05 : hovered || focused || highlighted ? 0.48 : 0.2,
        depthWrite: false,
      }),
      reticle: new THREE.LineBasicMaterial({
        color: tone,
        transparent: true,
        opacity: dimmed ? 0.08 : hovered || focused || highlighted ? 0.72 : 0.36,
        depthWrite: false,
      }),
    }
  }, [tone, rejected, dimmed, highlighted, hovered, focused, materials])

  useEffect(
    () => () => {
      mats.core.dispose()
      mats.inner.dispose()
      mats.edge.dispose()
      mats.gaugeArc.dispose()
      mats.gaugeTrack.dispose()
      mats.gaugeTip.dispose()
      mats.plumb.dispose()
      mats.reticle.dispose()
    },
    [mats],
  )

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime
    const base = rejected ? 0.12 : 0.45
    if (dimmed) {
      mats.core.emissiveIntensity = base * 0.25
    } else if (hovered || focused) {
      mats.core.emissiveIntensity = base + 0.85 + Math.sin(t * 4.2) * 0.15
    } else if (highlighted) {
      mats.core.emissiveIntensity = base + 0.65
    } else if (hyp.status === 'active') {
      const wave = Math.sin(t * 2.4 + index * 0.9)
      mats.core.emissiveIntensity = base + 0.35 + wave * 0.22
    } else {
      mats.core.emissiveIntensity = base
    }
    if (prismRef.current && !rejected) {
      prismRef.current.rotation.y += delta * (hovered || focused ? 0.72 : highlighted ? 0.44 : 0.22)
    }
    if (gaugeGroupRef.current && !rejected) {
      gaugeGroupRef.current.rotation.y -= delta * (hovered || focused ? 0.48 : 0.18)
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
    onHoverChange(true)
    document.body.style.cursor = 'pointer'
  }
  const onOut = () => {
    onHoverChange(false)
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

  const plumbBottomY = -y
  const plumbTopY = -size * 1.12
  const plumbSpan = plumbBottomY - plumbTopY
  const showExpanded = hovered || focused
  const showIdleChip = showLabels && !showExpanded

  return (
    <group position={[hyp.position[0], y, hyp.position[2]]}>
      {/* Crystal octahedron + inner refraction core + razor-sharp wire cage */}
      <group ref={prismRef} scale={size}>
        <mesh geometry={HYP_UNIT_GEO} material={mats.core} />
        <mesh geometry={HYP_INNER_GEO} material={mats.inner} />
        <lineSegments geometry={HYP_UNIT_EDGES} material={mats.edge} />
      </group>

      {/* Orbiting 3D confidence gauge ring (partial arc proportional to hyp.confidence) */}
      <group ref={gaugeGroupRef}>
        <lineSegments geometry={GAUGE_TRACK_UNIT_GEO} scale={[gaugeRadius, 1, gaugeRadius]} material={mats.gaugeTrack} />
        {conf > 0 && <lineSegments geometry={gaugeArcGeo} material={mats.gaugeArc} />}
        {gaugeTipPos && (
          <mesh position={gaugeTipPos} geometry={TIP_DOT_GEO} material={mats.gaugeTip} />
        )}
      </group>

      {/* Vertical telemetry plumb-line + floor crosshair reticle at y = 0 */}
      {Math.abs(plumbSpan) > 0.2 && (
        <lineSegments
          position={[0, plumbTopY, 0]}
          scale={[1, plumbSpan, 1]}
          geometry={UNIT_PLUMB_GEO}
          material={mats.plumb}
        />
      )}
      <lineSegments
        position={[0, plumbBottomY + 0.04, 0]}
        geometry={HYP_FLOOR_RETICLE_GEO}
        material={mats.reticle}
      />

      {/* Expanded hit sphere for effortless clicking & double-clicking */}
      <mesh
        geometry={HIT_GEO}
        material={INVISIBLE_HIT_MAT}
        scale={size + 1.3}
        onClick={focusNode}
        onDoubleClick={openExperimentWizard}
        onPointerOver={onOver}
        onPointerOut={onOut}
      />

      {/* Directly clickable H-NNN pill + non-interfering hover/focus telemetry preview */}
      {(showIdleChip || showExpanded) && (
        <Html
          position={[labelOutX, size + 1.05 + (index % 2) * 1.4, labelOutZ]}
          center
          zIndexRange={showExpanded ? [60, 0] : [40, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none' }}>
            <button
              type="button"
              data-theater-interactive="true"
              data-node-pill={hyp.id}
              className={`theater-hyp-pill thud-3d-pill${focused ? ' thud-3d-pill--focused' : ''}`}
              aria-label={`查看假设 ${hyp.id} 详情（双击配置实验）`}
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                borderTopColor: showExpanded || highlighted ? toneVar : undefined,
                borderRightColor: showExpanded || highlighted ? toneVar : undefined,
                borderBottomColor: showExpanded || highlighted ? toneVar : undefined,
                borderLeftColor: toneVar,
                borderLeftWidth: showExpanded ? 3 : 2.5,
                fontSize: rejected && !showExpanded ? 9 : 10,
                padding: rejected && !showExpanded ? '1px 5px' : '2px 7px',
                opacity: dimmed && !showExpanded ? 0.24 : rejected && !showExpanded ? 0.62 : 0.98,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                sceneActions.setFocus({ kind: 'node', nodeId: hyp.id })
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                sceneActions.openWizard({ sessionId, stage: 'experiment', hypId: hyp.id })
              }}
              onMouseEnter={() => onHoverChange(true)}
              onMouseLeave={() => onHoverChange(false)}
            >
              <span style={{ color: toneVar, fontWeight: 700 }}>{hyp.id}</span>
              <span style={{ color: 'var(--faint)' }}>·</span>
              <span style={{ color: 'var(--text)', fontWeight: showExpanded ? 700 : 500 }}>{confPct}%</span>
              {showExpanded && (
                <>
                  <span style={{ color: 'var(--faint)' }}>//</span>
                  <span style={{ color: toneVar, letterSpacing: '0.06em', fontWeight: 600 }}>
                    {hyp.status.toUpperCase()}
                  </span>
                  {hyp.experiments.length > 0 && (
                    <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                      [{hyp.experiments.length} EXP]
                    </span>
                  )}
                </>
              )}
            </button>
            {showExpanded && hyp.claim && (
              <div
                className="theater-hyp-pill thud-3d-subcard"
                style={{
                  pointerEvents: 'none',
                  borderLeftColor: toneVar,
                  borderLeftWidth: 2.5,
                }}
              >
                {truncateTelemetry(hyp.claim, 56)}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  )
}

function evidenceArchetypeGeo(shape: EvidenceShapeKind): {
  core: THREE.BufferGeometry
  edges: THREE.BufferGeometry
  scale: [number, number, number]
} {
  switch (shape) {
    case 'verification':
      return { core: EV_VERIFY_GEO, edges: EV_VERIFY_EDGES, scale: [0.88, 1.24, 0.88] }
    case 'audit':
      return { core: EV_AUDIT_GEO, edges: EV_AUDIT_EDGES, scale: [1, 1, 1] }
    case 'dynamic':
      return { core: EV_DYNAMIC_GEO, edges: EV_DYNAMIC_EDGES, scale: [1, 1, 1] }
    default:
      return { core: EV_STATIC_GEO, edges: EV_STATIC_EDGES, scale: [1, 1, 1] }
  }
}

/**
 * ev_NNN Evidence Artifact: distinct geek polyhedron per kind/view
 * (static cube, dynamic icosahedron, double-ringed verification diamond,
 * shielded audit prism) + subtle ground anchor tick + rich hover telemetry.
 */
function EvPoly({
  ev,
  contradicted,
  relationTag,
  materials,
  showLabels,
  hovered,
  focused,
  highlighted,
  dimmed,
  onHoverChange,
}: {
  ev: EvNode
  contradicted: boolean
  relationTag: string | null
  materials: TheaterMaterials
  showLabels: boolean
  hovered: boolean
  focused: boolean
  highlighted: boolean
  dimmed: boolean
  onHoverChange: (over: boolean) => void
}) {
  const polyRef = useRef<THREE.Group>(null)
  const ringsRef = useRef<THREE.LineSegments>(null)
  const shape = classifyEvidenceShape(ev.kind)
  const geo = evidenceArchetypeGeo(shape)

  const color = ev.isError
    ? materials.err
    : shape === 'audit'
      ? materials.amber
      : ev.verified
        ? materials.ok
        : shape === 'dynamic'
          ? materials.accent
          : materials.faint

  const badgeColorVar = ev.isError || contradicted
    ? 'var(--err)'
    : shape === 'audit'
      ? 'var(--warn)'
      : ev.verified
        ? 'var(--ok)'
        : 'var(--accent)'

  const mats = useMemo(() => {
    const dimFactor = dimmed ? 0.22 : 1
    const hiBoost = highlighted || hovered || focused ? 1.32 : 1
    const baseOpacity = ev.isError ? 0.34 : ev.verified ? 0.26 : 0.2
    const baseEmissive = ev.isError ? 0.65 : 0.36
    return {
      core: makeGlassCoreMaterial(color, baseOpacity * (dimmed ? 0.32 : 1), baseEmissive * dimFactor * hiBoost),
      edge: makeEdgeLineMaterial(
        ev.verified ? materials.ok : color,
        Math.min(1, (ev.verified || ev.isError ? 0.92 : 0.68) * dimFactor * hiBoost),
      ),
      accentWire: new THREE.LineBasicMaterial({
        color: shape === 'audit' ? materials.amber : materials.ok,
        transparent: true,
        opacity: Math.min(1, (dimmed ? 0.12 : 0.72) * hiBoost),
        depthWrite: false,
      }),
      anchor: new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: dimmed ? 0.04 : hovered || focused || highlighted ? 0.42 : 0.14,
        depthWrite: false,
      }),
    }
  }, [color, shape, ev.isError, ev.verified, dimmed, highlighted, hovered, focused, materials])

  useEffect(
    () => () => {
      mats.core.dispose()
      mats.edge.dispose()
      mats.accentWire.dispose()
      mats.anchor.dispose()
    },
    [mats],
  )

  useFrame(({ clock }, delta) => {
    if (dimmed) {
      mats.core.emissiveIntensity = 0.08
    } else if (contradicted) {
      mats.core.emissiveIntensity = Math.sin(clock.elapsedTime * 8) > 0 ? 1.55 : 0.22
    } else if (hovered || focused) {
      mats.core.emissiveIntensity = 1.35
    } else if (highlighted) {
      mats.core.emissiveIntensity = 0.95
    } else {
      mats.core.emissiveIntensity = ev.isError ? 0.65 : 0.36
    }

    if (polyRef.current && (hovered || focused || highlighted || shape === 'dynamic')) {
      polyRef.current.rotation.y += delta * (hovered || focused ? 0.9 : highlighted ? 0.45 : 0.18)
    }
    if (ringsRef.current) {
      ringsRef.current.rotation.y += delta * (hovered || focused ? 0.85 : 0.35)
      ringsRef.current.rotation.z += delta * 0.22
    }
  })

  const focusNode = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    sceneActions.setFocus({ kind: 'node', nodeId: ev.id })
  }
  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHoverChange(true)
    document.body.style.cursor = 'pointer'
  }
  const onOut = () => {
    onHoverChange(false)
    document.body.style.cursor = ''
  }

  const floorOffsetY = -ev.position[1]
  const anchorStartY = ev.position[1] >= 0 ? -0.78 : 0.78
  const anchorSpan = floorOffsetY - anchorStartY
  const showTelemetry = hovered || focused
  const statusTag = ev.isError
    ? 'ERROR'
    : relationTag ?? (ev.verified ? 'VERIFIED' : 'LEDGER')

  return (
    <group position={ev.position}>
      <group ref={polyRef}>
        <group scale={geo.scale}>
          <mesh geometry={geo.core} material={mats.core} />
          <lineSegments geometry={geo.edges} material={mats.edge} />
        </group>
        {/* Shielded outer prism cage for audit_finding artifacts */}
        {shape === 'audit' && (
          <lineSegments geometry={EV_AUDIT_SHIELD_EDGES} material={mats.accentWire} />
        )}
      </group>

      {/* Double orthogonal orbital rings for verification_result diamond cores */}
      {shape === 'verification' && (
        <lineSegments ref={ringsRef} geometry={EV_VERIFY_RINGS_GEO} material={mats.accentWire} />
      )}

      {/* Subtle ground anchor hairline & tick on floor y = 0 */}
      {Math.abs(anchorSpan) > 0.25 && (
        <lineSegments
          position={[0, anchorStartY, 0]}
          scale={[1, anchorSpan, 1]}
          geometry={UNIT_PLUMB_GEO}
          material={mats.anchor}
        />
      )}
      <lineSegments
        position={[0, floorOffsetY + 0.03, 0]}
        geometry={EV_ANCHOR_TICK_GEO}
        material={mats.anchor}
      />

      {/* Expanded hit sphere for effortless 3D picking */}
      <mesh
        geometry={HIT_GEO}
        material={INVISIBLE_HIT_MAT}
        scale={2.1}
        onClick={focusNode}
        onPointerOver={onOver}
        onPointerOut={onOut}
      />

      {/* Directly clickable ev_NNN mini-chip (idle when showLabels) + non-interfering hover/focus readout */}
      {(showLabels || showTelemetry) && (
        <Html
          position={[0, showTelemetry ? 1.55 : 1.32, 0]}
          center
          zIndexRange={showTelemetry ? [60, 0] : [36, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none' }}>
            <button
              type="button"
              data-theater-interactive="true"
              data-node-pill={ev.id}
              className={`theater-hyp-pill thud-3d-pill thud-3d-pill--ev${focused ? ' thud-3d-pill--focused' : ''}`}
              aria-label={`查看证据 ${ev.id} 详情`}
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                borderTopColor: showTelemetry || highlighted ? badgeColorVar : undefined,
                borderRightColor: showTelemetry || highlighted ? badgeColorVar : undefined,
                borderBottomColor: showTelemetry || highlighted ? badgeColorVar : undefined,
                borderLeftColor: badgeColorVar,
                borderLeftWidth: showTelemetry ? 3 : 2,
                fontSize: showTelemetry ? 10 : 9,
                padding: showTelemetry ? '2px 7px' : '1px 5px',
                opacity: dimmed && !showTelemetry ? 0.2 : showTelemetry || highlighted ? 0.98 : 0.88,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                sceneActions.setFocus({ kind: 'node', nodeId: ev.id })
              }}
              onMouseEnter={() => onHoverChange(true)}
              onMouseLeave={() => onHoverChange(false)}
            >
              <span style={{ color: badgeColorVar, fontWeight: 700 }}>{ev.id}</span>
              {showTelemetry && (
                <>
                  <span style={{ color: 'var(--faint)' }}>//</span>
                  <span style={{ color: 'var(--text)', fontWeight: 600 }}>{evidenceKindTag(ev.kind)}</span>
                  <span style={{ color: 'var(--faint)' }}>//</span>
                  <span style={{ color: badgeColorVar, fontWeight: 700, letterSpacing: '0.06em' }}>
                    {statusTag}
                  </span>
                </>
              )}
            </button>
            {showTelemetry && ev.summary && (
              <div
                className="theater-hyp-pill thud-3d-subcard"
                style={{
                  pointerEvents: 'none',
                  borderLeftColor: badgeColorVar,
                  borderLeftWidth: 2.5,
                }}
              >
                {truncateTelemetry(ev.summary, 52)}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  )
}
