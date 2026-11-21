// HoloPanels — Mid-altitude holographic instrumentation trio:
// TRANSCRIPT card, TELE readout bar, and QUEUE telemetry ring.
// Renders cohesive single-card frosted `.theater-chip` overlays anchored to
// dual-layer obsidian glass geometry so lines never self-overlap at any angle.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import {
  makeEdgeLineMaterial,
  makeGlassCoreMaterial,
  makeWireMaterial,
  type TheaterMaterials,
} from './ThemeMaterials'

export interface HoloHudData {
  /** Recent think lines (rendered as last 3 rows in TRANSCRIPT card) */
  thinkLines: readonly string[]
  /** Cumulative tokens (TELE readout); null = unavailable */
  tokensUsed: number | null
  /** Queue depth (QUEUE ring); null = unavailable */
  queueCount: number | null
}

interface HoloPanelsProps {
  materials: TheaterMaterials
  hud: HoloHudData | null
  /** Clicking TRANSCRIPT returns to Classic workbench view */
  onExitToClassic?: () => void
}

const SLAB_TRANSCRIPT_GEO = new THREE.BoxGeometry(20, 6.4, 0.24)
const SLAB_TRANSCRIPT_EDGES = new THREE.EdgesGeometry(SLAB_TRANSCRIPT_GEO)
const SLAB_TELE_GEO = new THREE.BoxGeometry(13.5, 2.4, 0.24)
const SLAB_TELE_EDGES = new THREE.EdgesGeometry(SLAB_TELE_GEO)

export function HoloPanels({ materials, hud, onExitToClassic }: HoloPanelsProps) {
  return (
    <group>
      <TranscriptColumn materials={materials} lines={hud?.thinkLines ?? []} onExit={onExitToClassic} />
      <TeleBar materials={materials} tokens={hud?.tokensUsed ?? null} />
      <QueueRing materials={materials} count={hud?.queueCount ?? null} />
    </group>
  )
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function TranscriptColumn({
  materials,
  lines,
  onExit,
}: {
  materials: TheaterMaterials
  lines: readonly string[]
  onExit?: () => void
}) {
  const coreMat = useMemo(() => makeGlassCoreMaterial(materials.violet, 0.14, 0.24), [materials])
  const edgeMat = useMemo(() => makeEdgeLineMaterial(materials.violet, 0.56), [materials])
  useEffect(
    () => () => {
      coreMat.dispose()
      edgeMat.dispose()
    },
    [coreMat, edgeMat],
  )
  const strips = lines.slice(-3)
  const clickable = typeof onExit === 'function'

  return (
    <group position={[-68, 15, 8]}>
      <group rotation-y={0.14}>
        <mesh geometry={SLAB_TRANSCRIPT_GEO} material={coreMat} />
        <lineSegments geometry={SLAB_TRANSCRIPT_EDGES} material={edgeMat} />
      </group>
      <Html
        position={[0, 0, 0.5]}
        center
        zIndexRange={[40, 0]}
        style={clickable ? { pointerEvents: 'auto' } : { pointerEvents: 'none' }}
        onClick={clickable ? () => onExit?.() : undefined}
      >
        <div
          className={`theater-chip${clickable ? ' theater-chip--interactive' : ''}`}
          style={{
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 4,
            padding: '6px 9px',
            minWidth: 196,
            maxWidth: 232,
            borderLeftWidth: 2,
            borderLeftColor: 'var(--violet)',
          }}
          title={clickable ? '点击回到经典工作台视图' : undefined}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: '0.16em',
              color: 'var(--violet)',
              paddingBottom: 3,
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span>TRANSCRIPT</span>
            {clickable && <span style={{ color: 'var(--faint)', fontSize: 9, letterSpacing: '0.06em' }}>CLASSIC ↗</span>}
          </div>
          {strips.length === 0 ? (
            <div style={{ fontSize: 10, letterSpacing: '0.14em', color: 'var(--muted)', textAlign: 'center', padding: '3px 0' }}>
              ░ NO SIGNAL ░
            </div>
          ) : (
            strips.map((line, i) => (
              <div
                key={i}
                style={{
                  fontSize: 10,
                  lineHeight: 1.35,
                  color: i === strips.length - 1 ? 'var(--text)' : 'var(--muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {truncate(line, 34)}
              </div>
            ))
          )}
        </div>
      </Html>
    </group>
  )
}

function TeleBar({ materials, tokens }: { materials: TheaterMaterials; tokens: number | null }) {
  const coreMat = useMemo(() => makeGlassCoreMaterial(materials.accent, 0.14, 0.24), [materials])
  const edgeMat = useMemo(() => makeEdgeLineMaterial(materials.accent, 0.62), [materials])
  useEffect(
    () => () => {
      coreMat.dispose()
      edgeMat.dispose()
    },
    [coreMat, edgeMat],
  )
  return (
    <group position={[74, 14, 14]}>
      <group rotation-y={-0.14}>
        <mesh geometry={SLAB_TELE_GEO} material={coreMat} />
        <lineSegments geometry={SLAB_TELE_EDGES} material={edgeMat} />
      </group>
      <Html position={[0, 0, 0.4]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className="theater-chip"
          style={{
            borderLeftWidth: 2,
            borderLeftColor: 'var(--accent)',
            fontSize: 10.5,
            letterSpacing: '0.1em',
          }}
        >
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>TELE</span>
          <span style={{ color: 'var(--faint)' }}>·</span>
          <span style={{ color: 'var(--text)' }}>{tokens === null ? '——' : `${tokens.toLocaleString()} tok`}</span>
        </div>
      </Html>
    </group>
  )
}

function QueueRing({ materials, count }: { materials: TheaterMaterials; count: number | null }) {
  const ringRef = useRef<THREE.Mesh>(null)
  const coreMat = useMemo(() => makeGlassCoreMaterial(materials.ok, 0.22, 0.42), [materials])
  const wireMat = useMemo(() => makeWireMaterial(materials.ok, 0.45, 0.8), [materials])
  useEffect(
    () => () => {
      coreMat.dispose()
      wireMat.dispose()
    },
    [coreMat, wireMat],
  )
  useFrame(({ clock }, delta) => {
    const busy = (count ?? 0) > 0
    const pulse = busy ? 1.05 + Math.sin(clock.elapsedTime * 3.8) * 0.45 : 0.45
    coreMat.emissiveIntensity = pulse * 0.6
    wireMat.emissiveIntensity = pulse
    if (ringRef.current) {
      ringRef.current.rotation.z += delta * (busy ? 0.9 : 0.2)
    }
  })
  return (
    <group position={[66, 13, -24]}>
      <group rotation-y={0.5}>
        <mesh ref={ringRef} material={coreMat}>
          <torusGeometry args={[3.2, 0.16, 12, 48]} />
        </mesh>
        <mesh material={wireMat}>
          <torusGeometry args={[3.55, 0.08, 6, 36]} />
        </mesh>
      </group>
      <Html position={[0, 0, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className="theater-chip"
          style={{
            borderLeftWidth: 2,
            borderLeftColor: 'var(--ok)',
            fontSize: 10.5,
            letterSpacing: '0.12em',
          }}
        >
          <span style={{ color: 'var(--ok)', fontWeight: 700 }}>Q</span>
          <span style={{ color: 'var(--faint)' }}>·</span>
          <span style={{ color: 'var(--text)' }}>{count === null ? '—' : count}</span>
        </div>
      </Html>
    </group>
  )
}
