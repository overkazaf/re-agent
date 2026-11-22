import { describe, expect, it } from 'vitest'
import {
  classifyEvidenceShape,
  collectCausalNeighborhood,
  confidenceArcSegments,
  evalBezierPoint,
  evalBezierPointInto,
  evidenceKindTag,
  polylineToLineSegments,
  resolveArcLift,
  sampleBezierArc,
  truncateTelemetry,
  type CausalEdgeLike,
  type Vec3,
} from './dagGeometry'

describe('sampleBezierArc & evalBezierPoint', () => {
  it('starts at exact `from`, ends at exact `to`, and returns segments + 1 vertices', () => {
    const from: Vec3 = [18, 12, 24]
    const to: Vec3 = [34, 16, 36]
    const pts = sampleBezierArc(from, to, 3, 12)

    expect(pts).toHaveLength(13)
    expect(pts[0]![0]).toBeCloseTo(from[0], 6)
    expect(pts[0]![1]).toBeCloseTo(from[1], 6)
    expect(pts[0]![2]).toBeCloseTo(from[2], 6)
    expect(pts[12]![0]).toBeCloseTo(to[0], 6)
    expect(pts[12]![1]).toBeCloseTo(to[1], 6)
    expect(pts[12]![2]).toBeCloseTo(to[2], 6)
  })

  it('every sampled vertex matches evalBezierPoint at i / segments', () => {
    const from: Vec3 = [-10, 4, 20]
    const to: Vec3 = [26, 14, -12]
    const segments = 16
    const pts = sampleBezierArc(from, to, 2.5, segments)

    for (let i = 0; i <= segments; i++) {
      const exact = evalBezierPoint(from, to, 2.5, i / segments)
      expect(pts[i]![0]).toBeCloseTo(exact[0], 6)
      expect(pts[i]![1]).toBeCloseTo(exact[1], 6)
      expect(pts[i]![2]).toBeCloseTo(exact[2], 6)
    }
  })

  it('auto-scales arc lift by horizontal distance and arches above endpoints & stage floor', () => {
    const shortMid = evalBezierPoint([0, 10, 0], [4, 10, 0], undefined, 0.5)
    const longMid = evalBezierPoint([0, 10, 0], [32, 10, 0], undefined, 0.5)
    expect(shortMid[1]).toBeGreaterThan(10)
    expect(longMid[1]).toBeGreaterThan(shortMid[1])
    expect(resolveArcLift([0, 0, 0], [32, 0, 0])).toBeGreaterThan(
      resolveArcLift([0, 0, 0], [4, 0, 0]),
    )

    // Sunken error evidence (y = -1.5) still arches cleanly above the y = 0 floor
    const sunkenArc = sampleBezierArc([0, -1.5, 0], [10, -1.5, 0], undefined, 12)
    expect(sunkenArc[6]![1]).toBeGreaterThan(0)
  })

  it('clamps out-of-range t and invalid segment counts safely', () => {
    const from: Vec3 = [1, 2, 3]
    const to: Vec3 = [9, 8, 7]
    expect(evalBezierPoint(from, to, 2, -0.5)).toEqual(from)
    expect(evalBezierPoint(from, to, 2, 1.5)).toEqual(to)
    expect(evalBezierPoint(from, to, 2, Number.NaN)).toEqual(from)
    expect(sampleBezierArc(from, to, 2, 0)).toHaveLength(2)
  })

  it('evalBezierPointInto writes identical values into a pooled Float32Array', () => {
    const from: Vec3 = [20, 8, 30]
    const to: Vec3 = [30, 18, 22]
    const buf = new Float32Array(9)
    evalBezierPointInto(from, to, 3, 0.35, buf, 3)
    const expected = evalBezierPoint(from, to, 3, 0.35)
    expect(buf[3]).toBeCloseTo(expected[0], 5)
    expect(buf[4]).toBeCloseTo(expected[1], 5)
    expect(buf[5]).toBeCloseTo(expected[2], 5)
  })
})

describe('collectCausalNeighborhood', () => {
  const edges: CausalEdgeLike[] = [
    { from: 'ev_001', to: 'H-001', kind: 'support' }, // 0
    { from: 'ev_002', to: 'H-001', kind: 'contradict' }, // 1
    { from: 'H-001', to: 'H-003', kind: 'derive' }, // 2
    { from: 'ev_005', to: 'H-003', kind: 'support' }, // 3
    { from: 'ev_001', to: 'H-002', kind: 'support' }, // 4 (shared ev_001 -> unrelated sibling H-002)
    { from: 'ev_009', to: 'H-009', kind: 'support' }, // 5 (disconnected component)
  ]

  it('returns empty sets for null/undefined/empty selection', () => {
    expect(collectCausalNeighborhood(null, edges).nodeIds.size).toBe(0)
    expect(collectCausalNeighborhood(undefined, edges).edgeIndices.size).toBe(0)
    expect(collectCausalNeighborhood('', edges).nodeIds.size).toBe(0)
  })

  it('collects upstream evidence + downstream derived hypotheses without bleeding into unrelated siblings', () => {
    const nb = collectCausalNeighborhood('H-001', edges)
    expect(nb.nodeIds).toEqual(new Set(['H-001', 'ev_001', 'ev_002', 'H-003']))
    expect(nb.edgeIndices).toEqual(new Set([0, 1, 2]))
    // Must not pull in unrelated H-002 (even though ev_001 also supports H-002) or H-009
    expect(nb.nodeIds.has('H-002')).toBe(false)
    expect(nb.nodeIds.has('H-009')).toBe(false)
  })

  it('traces full multi-hop provenance upstream from a derived child hypothesis', () => {
    const nb = collectCausalNeighborhood('H-003', edges)
    expect(nb.nodeIds).toEqual(new Set(['H-003', 'H-001', 'ev_001', 'ev_002', 'ev_005']))
    expect(nb.edgeIndices).toEqual(new Set([0, 1, 2, 3]))
  })

  it('traces full downstream blast radius from a shared evidence node', () => {
    const nb = collectCausalNeighborhood('ev_001', edges)
    expect(nb.nodeIds).toEqual(new Set(['ev_001', 'H-001', 'H-002', 'H-003']))
    expect(nb.edgeIndices).toEqual(new Set([0, 2, 4]))
  })

  it('captures every edge in diamond proof chains and handles cycles safely', () => {
    const diamondWithCycle: CausalEdgeLike[] = [
      { from: 'ev_1', to: 'H-1' }, // 0
      { from: 'ev_1', to: 'H-2' }, // 1
      { from: 'H-1', to: 'H-3' }, // 2
      { from: 'H-2', to: 'H-3' }, // 3
      { from: 'H-3', to: 'H-1' }, // 4 (cycle)
    ]
    const nb = collectCausalNeighborhood('H-3', diamondWithCycle)
    expect(nb.nodeIds).toEqual(new Set(['ev_1', 'H-1', 'H-2', 'H-3']))
    expect(nb.edgeIndices).toEqual(new Set([0, 1, 2, 3, 4]))
  })

  it('retains an isolated node in nodeIds with empty edgeIndices', () => {
    const nb = collectCausalNeighborhood('H-ISOLATED', edges)
    expect(nb.nodeIds).toEqual(new Set(['H-ISOLATED']))
    expect(nb.edgeIndices.size).toBe(0)
  })
})

describe('confidenceArcSegments', () => {
  it('generates partial circular arc proportional to confidence (95% = 342°, 42% = 151.2°)', () => {
    const r = 2.4
    const pts95 = confidenceArcSegments(0.95, r)
    expect(pts95.length).toBeGreaterThanOrEqual(40)

    // Every point sits on the horizontal XZ circle of radius r (y === 0)
    for (const [x, y, z] of pts95) {
      expect(y).toBe(0)
      expect(Math.hypot(x, z)).toBeCloseTo(r, 6)
    }

    // Start at angle 0 → (r, 0, 0)
    expect(pts95[0]![0]).toBeCloseTo(r, 6)
    expect(pts95[0]![2]).toBeCloseTo(0, 6)

    // End at 0.95 * 2π = 342°
    const end95 = pts95[pts95.length - 1]!
    const angle95 = 0.95 * Math.PI * 2
    expect(end95[0]).toBeCloseTo(Math.cos(angle95) * r, 6)
    expect(end95[2]).toBeCloseTo(Math.sin(angle95) * r, 6)

    // 42% → 151.2°
    const pts42 = confidenceArcSegments(0.42, r)
    const end42 = pts42[pts42.length - 1]!
    const angle42 = 0.42 * Math.PI * 2
    expect(end42[0]).toBeCloseTo(Math.cos(angle42) * r, 6)
    expect(end42[2]).toBeCloseTo(Math.sin(angle42) * r, 6)
    expect(pts42.length).toBeLessThan(pts95.length)
  })

  it('clamps confidence > 1 to a full 360° ring and returns empty for <= 0 or invalid radius', () => {
    const full = confidenceArcSegments(1.4, 2)
    expect(full.length).toBeGreaterThanOrEqual(48)
    const end = full[full.length - 1]!
    expect(end[0]).toBeCloseTo(2, 6)
    expect(end[2]).toBeCloseTo(0, 6)

    expect(confidenceArcSegments(0, 2)).toEqual([])
    expect(confidenceArcSegments(-0.3, 2)).toEqual([])
    expect(confidenceArcSegments(Number.NaN, 2)).toEqual([])
    expect(confidenceArcSegments(0.8, 0)).toEqual([])
    expect(confidenceArcSegments(0.8, -1)).toEqual([])
  })
})

describe('packing & telemetry helpers', () => {
  it('packs polyline points into LineSegments pairs', () => {
    const packed = polylineToLineSegments([
      [0, 0, 0],
      [1, 2, 3],
      [4, 5, 6],
    ])
    expect(Array.from(packed)).toEqual([0, 0, 0, 1, 2, 3, 1, 2, 3, 4, 5, 6])
    expect(polylineToLineSegments([[0, 0, 0]]).length).toBe(0)
  })

  it('classifies evidence kinds and formats compact telemetry strings', () => {
    expect(classifyEvidenceShape('tool_observation')).toBe('static')
    expect(classifyEvidenceShape('runtime_trace')).toBe('dynamic')
    expect(classifyEvidenceShape('verification_result')).toBe('verification')
    expect(classifyEvidenceShape('audit_finding')).toBe('audit')

    expect(evidenceKindTag('runtime_trace')).toBe('DYN')
    expect(evidenceKindTag('verification_result')).toBe('VERIFY')
    expect(evidenceKindTag('audit')).toBe('AUDIT')
    expect(evidenceKindTag('strings')).toBe('STATIC')

    expect(truncateTelemetry('  short   claim  ', 20)).toBe('short claim')
    expect(truncateTelemetry('a very long forensic hypothesis claim for truncation', 16)).toBe(
      'a very long for…',
    )
  })
})
