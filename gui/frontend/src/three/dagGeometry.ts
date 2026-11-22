// dagGeometry — Pure math & causal-graph helpers for the 3D Forensic Theater DAG.
// Zero React or WebGL dependencies so every geometric invariant can be unit-tested
// directly in Node/Vitest.

export type Vec3 = readonly [number, number, number]

export interface CausalEdgeLike {
  from: string
  to: string
  kind?: string
}

export interface CausalNeighborhood {
  /** Selected node plus all directed upstream & downstream nodes in its proof chain. */
  nodeIds: Set<string>
  /** Indices into the input `edges` array belonging to the causal proof chain. */
  edgeIndices: Set<number>
}

export type EvidenceShapeKind = 'static' | 'dynamic' | 'verification' | 'audit'

/** Minimum Y elevation for quadratic arc control points so arcs clear floor pads. */
const MIN_ARC_CLEARANCE_Y = 1.6

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/**
 * Resolves the vertical arc lift between two 3D nodes, auto-scaling with horizontal
 * distance so long cross-stage arcs clear the floor gracefully and short spans never flatten.
 */
export function resolveArcLift(from: Vec3, to: Vec3, lift?: number): number {
  const horiz = Math.hypot(to[0] - from[0], to[2] - from[2])
  const autoLift = Math.max(1.8, Math.min(16, 1.5 + horiz * 0.28))
  if (lift === undefined || !Number.isFinite(lift) || lift <= 0) {
    return autoLift
  }
  return Math.max(lift, lift + horiz * 0.14)
}

/**
 * Computes the quadratic Bezier control point for an elevated 3D optical arc.
 * Guarantees floor clearance even when an endpoint is sunken (e.g. error evidence at y = -1.5).
 */
export function computeArcControlPoint(from: Vec3, to: Vec3, lift?: number): [number, number, number] {
  const effectiveLift = resolveArcLift(from, to, lift)
  const mx = (from[0] + to[0]) * 0.5
  const mz = (from[2] + to[2]) * 0.5
  const topY = Math.max(from[1], to[1])
  const cy = Math.max(topY + effectiveLift, MIN_ARC_CLEARANCE_Y)
  return [mx, cy, mz]
}

/**
 * Zero-allocation evaluator writing the quadratic Bezier point at `t ∈ [0, 1]`
 * directly into `out[offset..offset+2]`. Used in hot `useFrame` loops.
 */
export function evalBezierPointInto(
  from: Vec3,
  to: Vec3,
  lift: number | undefined,
  t: number,
  out: Float32Array | number[],
  offset: number,
): void {
  const u = clamp01(t)
  const inv = 1 - u
  const w0 = inv * inv
  const w1 = 2 * inv * u
  const w2 = u * u

  const effectiveLift = resolveArcLift(from, to, lift)
  const cx = (from[0] + to[0]) * 0.5
  const cy = Math.max(Math.max(from[1], to[1]) + effectiveLift, MIN_ARC_CLEARANCE_Y)
  const cz = (from[2] + to[2]) * 0.5

  out[offset] = w0 * from[0] + w1 * cx + w2 * to[0]
  out[offset + 1] = w0 * from[1] + w1 * cy + w2 * to[1]
  out[offset + 2] = w0 * from[2] + w1 * cz + w2 * to[2]
}

/**
 * Evaluates the exact 3D point at parameter `t ∈ [0, 1]` along the elevated
 * quadratic Bezier causal arc between `from` and `to`.
 */
export function evalBezierPoint(
  from: Vec3,
  to: Vec3,
  lift: number | undefined,
  t: number,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0]
  evalBezierPointInto(from, to, lift, t, out, 0)
  return out
}

/**
 * Samples an elevated 3D quadratic Bezier curve from `from` to `to` into
 * `segments + 1` vertices (inclusive of both endpoints).
 */
export function sampleBezierArc(
  from: Vec3,
  to: Vec3,
  lift?: number,
  segments = 16,
): [number, number, number][] {
  const count = Math.max(1, Math.floor(Number.isFinite(segments) ? segments : 16))
  const pts: [number, number, number][] = new Array(count + 1)
  for (let i = 0; i <= count; i++) {
    pts[i] = evalBezierPoint(from, to, lift, i / count)
  }
  return pts
}

/**
 * Collects the full directed upstream & downstream causal proof-chain neighborhood
 * for `selectedId`.
 *
 * - Upstream traversal follows incoming edges (`u -> v` from `v` to `u`), capturing
 *   supporting/contradicting/audit evidence and ancestor hypotheses.
 * - Downstream traversal follows outgoing edges (`u -> v` from `u` to `v`), capturing
 *   affected hypotheses and derived child hypotheses.
 * - Keeps sibling hypotheses sharing an evidence node isolated when hovering one
 *   hypothesis, while capturing all edges in diamond subgraphs and terminating safely
 *   even if edges contain cycles.
 */
export function collectCausalNeighborhood(
  selectedId: string | null | undefined,
  edges: readonly CausalEdgeLike[],
): CausalNeighborhood {
  const nodeIds = new Set<string>()
  const edgeIndices = new Set<number>()
  if (!selectedId) return { nodeIds, edgeIndices }

  nodeIds.add(selectedId)
  if (edges.length === 0) return { nodeIds, edgeIndices }

  const incoming = new Map<string, number[]>()
  const outgoing = new Map<string, number[]>()
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!
    let outList = outgoing.get(e.from)
    if (!outList) {
      outList = []
      outgoing.set(e.from, outList)
    }
    outList.push(i)

    let inList = incoming.get(e.to)
    if (!inList) {
      inList = []
      incoming.set(e.to, inList)
    }
    inList.push(i)
  }

  // Directed upstream BFS (evidence & ancestor hypotheses feeding selectedId)
  const visitedUp = new Set<string>([selectedId])
  const upQueue: string[] = [selectedId]
  for (let q = 0; q < upQueue.length; q++) {
    const cur = upQueue[q]!
    const inEdges = incoming.get(cur)
    if (!inEdges) continue
    for (const idx of inEdges) {
      edgeIndices.add(idx)
      const parent = edges[idx]!.from
      nodeIds.add(parent)
      if (!visitedUp.has(parent)) {
        visitedUp.add(parent)
        upQueue.push(parent)
      }
    }
  }

  // Directed downstream BFS (hypotheses & derivations impacted by selectedId)
  const visitedDown = new Set<string>([selectedId])
  const downQueue: string[] = [selectedId]
  for (let q = 0; q < downQueue.length; q++) {
    const cur = downQueue[q]!
    const outEdges = outgoing.get(cur)
    if (!outEdges) continue
    for (const idx of outEdges) {
      edgeIndices.add(idx)
      const child = edges[idx]!.to
      nodeIds.add(child)
      if (!visitedDown.has(child)) {
        visitedDown.add(child)
        downQueue.push(child)
      }
    }
  }

  return { nodeIds, edgeIndices }
}

/**
 * Generates vertices along a partial horizontal (XZ-plane, y = 0) circular
 * confidence gauge ring proportional to `confidence ∈ [0, 1]` (e.g. 0.95 → 342°,
 * 0.42 → 151.2°). Returns an empty array when confidence <= 0 or radius <= 0.
 */
export function confidenceArcSegments(
  confidence: number,
  radius: number,
  maxSegments = 48,
): [number, number, number][] {
  const c = clamp01(confidence)
  if (c <= 0 || !Number.isFinite(radius) || radius <= 0) return []
  const resolution = Math.max(4, Math.floor(Number.isFinite(maxSegments) ? maxSegments : 48))
  const sweep = c * Math.PI * 2
  const steps = Math.max(2, Math.ceil(c * resolution))
  const pts: [number, number, number][] = new Array(steps + 1)
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * sweep
    pts[i] = [Math.cos(angle) * radius, 0, Math.sin(angle) * radius]
  }
  return pts
}

/**
 * Packs a polyline (`N` points) into `(N - 1) * 2 * 3` floats suitable for
 * `THREE.LineSegments`.
 */
export function polylineToLineSegments(points: readonly Vec3[]): Float32Array {
  if (points.length < 2) return new Float32Array(0)
  const out = new Float32Array((points.length - 1) * 6)
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const o = i * 6
    out[o] = a[0]
    out[o + 1] = a[1]
    out[o + 2] = a[2]
    out[o + 3] = b[0]
    out[o + 4] = b[1]
    out[o + 5] = b[2]
  }
  return out
}

/** Maps an evidence record's `kind` (or fallback `source`) to its 3D polyhedron archetype. */
export function classifyEvidenceShape(kind: string): EvidenceShapeKind {
  const k = kind.toLowerCase()
  if (k.includes('verif')) return 'verification'
  if (k.includes('audit')) return 'audit'
  if (
    k.includes('dynamic') ||
    k.includes('runtime') ||
    k.includes('trace') ||
    k.includes('emu') ||
    k.includes('exp')
  ) {
    return 'dynamic'
  }
  return 'static'
}

/** Compact geek telemetry tag for evidence kind readouts. */
export function evidenceKindTag(kind: string): string {
  switch (classifyEvidenceShape(kind)) {
    case 'verification':
      return 'VERIFY'
    case 'audit':
      return 'AUDIT'
    case 'dynamic':
      return 'DYN'
    default:
      return 'STATIC'
  }
}

/** Single-line telemetry truncator keeping hover HUD chips crisp and compact. */
export function truncateTelemetry(text: string, maxChars = 54): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}
