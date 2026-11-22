// HoloPanels — Mid-altitude cyber-forensic holographic instrumentation trio:
// //01 TRANSCRIPT card, //02 TELEMETRY readout bar, and //03 QUEUE telemetry ring.
// Renders chamfered tactical terminal overlays anchored to dual-layer glass slabs,
// with optional `visible` toggle so users can inspect pure 3D geometry unobstructed.
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

export interface HoloPanelsProps {
  materials: TheaterMaterials
  hud: HoloHudData | null
  /** Clicking TRANSCRIPT returns to Classic workbench view */
  onExitToClassic?: () => void
  /** Layer toggle wired to the tactical HUD "浮窗" switch (default true) */
  visible?: boolean
}

// Shared static geometries (singleton per page lifetime — zero per-render allocations).
const SLAB_TRANSCRIPT_GEO = new THREE.BoxGeometry(20.5, 6.8, 0.24)
const SLAB_TRANSCRIPT_EDGES = new THREE.EdgesGeometry(SLAB_TRANSCRIPT_GEO)
const SLAB_TELE_GEO = new THREE.BoxGeometry(14.5, 3.2, 0.24)
const SLAB_TELE_EDGES = new THREE.EdgesGeometry(SLAB_TELE_GEO)
const QUEUE_CORE_TORUS_GEO = new THREE.TorusGeometry(3.2, 0.16, 12, 48)
const QUEUE_WIRE_TORUS_GEO = new THREE.TorusGeometry(3.6, 0.08, 6, 36)

export function HoloPanels({ materials, hud, onExitToClassic, visible = true }: HoloPanelsProps) {
  if (!visible) return null
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

/** Logarithmic 0..10 bar fill so both small (500 tok) and large (200k tok) sessions read clearly. */
function tokenBarSegments(tokens: number | null, slots = 10): number {
  if (tokens === null || tokens <= 0) return 0
  const norm = Math.min(1, Math.log10(1 + tokens / 350) / 3)
  return Math.max(1, Math.round(norm * slots))
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
  const edgeMat = useMemo(() => makeEdgeLineMaterial(materials.violet, 0.58), [materials])
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
          className={`tholo-card tholo-card--violet${clickable ? ' tholo-card--interactive' : ''}`}
          title={clickable ? '点击回到经典工作台视图' : undefined}
          data-hint={clickable ? '点击返回经典 2D 工作台查看完整推理流' : undefined}
          data-hint-side="top"
        >
          <div className="tholo-head" style={{ color: 'var(--violet)' }}>
            <span>
              <span className="tholo-index">//01</span>
              TRANSCRIPT
            </span>
            {clickable && <span className="tholo-action">CLASSIC ↗</span>}
          </div>
          {strips.length === 0 ? (
            <div className="tholo-empty">░ STANDBY // NO SIGNAL ░</div>
          ) : (
            strips.map((line, i) => {
              const latest = i === strips.length - 1
              return (
                <div key={i} className={`tholo-line${latest ? ' tholo-line--latest' : ''}`}>
                  <span className="tholo-line-idx">{latest ? '▸' : `0${i + 1}`}</span>
                  <span>{truncate(line, 32)}</span>
                </div>
              )
            })
          )}
        </div>
      </Html>
    </group>
  )
}

function TeleBar({ materials, tokens }: { materials: TheaterMaterials; tokens: number | null }) {
  const coreMat = useMemo(() => makeGlassCoreMaterial(materials.accent, 0.14, 0.24), [materials])
  const edgeMat = useMemo(() => makeEdgeLineMaterial(materials.accent, 0.64), [materials])
  useEffect(
    () => () => {
      coreMat.dispose()
      edgeMat.dispose()
    },
    [coreMat, edgeMat],
  )
  const lit = tokenBarSegments(tokens, 10)

  return (
    <group position={[74, 14, 14]}>
      <group rotation-y={-0.14}>
        <mesh geometry={SLAB_TELE_GEO} material={coreMat} />
        <lineSegments geometry={SLAB_TELE_EDGES} material={edgeMat} />
      </group>
      <Html position={[0, 0, 0.4]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div className="tholo-card tholo-card--accent">
          <div className="tholo-head" style={{ color: 'var(--accent)' }}>
            <span>
              <span className="tholo-index">//02</span>
              TELEMETRY
            </span>
            <span className="tholo-status-tag" style={{ color: tokens && tokens > 0 ? 'var(--accent)' : undefined }}>
              {tokens && tokens > 0 ? 'LIVE' : 'IDLE'}
            </span>
          </div>
          <div className="tholo-metric-row">
            <span>{tokens === null ? '——' : `${tokens.toLocaleString()} tok`}</span>
          </div>
          <div className="tholo-bars" aria-hidden="true">
            {Array.from({ length: 10 }, (_, idx) => (
              <span
                key={idx}
                className={`tholo-bar-seg${idx < lit ? ' tholo-bar-seg--accent' : ''}`}
              />
            ))}
          </div>
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

  const activeSlots = count === null ? 0 : Math.min(6, Math.max(0, count))

  return (
    <group position={[66, 13, -24]}>
      <group rotation-y={0.5}>
        <mesh ref={ringRef} geometry={QUEUE_CORE_TORUS_GEO} material={coreMat} />
        <mesh geometry={QUEUE_WIRE_TORUS_GEO} material={wireMat} />
      </group>
      <Html position={[0, 0, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div className="tholo-card tholo-card--ok">
          <div className="tholo-head" style={{ color: 'var(--ok)' }}>
            <span>
              <span className="tholo-index">//03</span>
              QUEUE
            </span>
            <span className="tholo-status-tag" style={{ color: activeSlots > 0 ? 'var(--ok)' : undefined }}>
              {activeSlots > 0 ? 'BUSY' : 'CLEAR'}
            </span>
          </div>
          <div className="tholo-metric-row">
            <span>{count === null ? '—' : `${count} pending`}</span>
          </div>
          <div className="tholo-bars tholo-bars--6" aria-hidden="true">
            {Array.from({ length: 6 }, (_, idx) => (
              <span
                key={idx}
                className={`tholo-bar-seg${idx < activeSlots ? ' tholo-bar-seg--ok' : ''}`}
              />
            ))}
          </div>
        </div>
      </Html>
    </group>
  )
}
