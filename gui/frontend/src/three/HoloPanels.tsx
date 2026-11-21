// HoloPanels — 中低空全息三件套：TRANSCRIPT 摘要柱 / TELE 遥测条 / QUEUE 计数环。
// 低频消费：数据全部由 ForensicTheater 的 props 喂入（集成层低频组装 hud），
// 不直接订阅 90ms tick 事件。文字走 drei <Html> + CSS 变量（离线安全）。
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { makeWireMaterial, type TheaterMaterials } from './ThemeMaterials'

export interface HoloHudData {
  /** 最近若干条 think 行（TRANSCRIPT 摘要柱，取末 3 条渲染） */
  thinkLines: readonly string[]
  /** token 累计（TELE 遥测条）；null = 无数据 */
  tokensUsed: number | null
  /** 队列深度（QUEUE 计数环）；null = 无数据 */
  queueCount: number | null
}

interface HoloPanelsProps {
  materials: TheaterMaterials
  hud: HoloHudData | null
  /** 点击 TRANSCRIPT 摘要条 → 回经典视图（集成层接线） */
  onExitToClassic?: () => void
}

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
  const mat = useMemo(() => makeWireMaterial(materials.violet, 0.45, 0.8), [materials])
  useEffect(() => () => mat.dispose(), [mat])
  const strips = lines.slice(-3)
  const clickable = typeof onExit === 'function'
  return (
    <group position={[-52, 12, 6]}>
      <Html position={[0, 5.2, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div className="glow-violet" style={{ fontSize: 11, letterSpacing: '0.2em', whiteSpace: 'nowrap', opacity: 0.9 }}>
          TRANSCRIPT
        </div>
      </Html>
      {strips.length === 0 ? (
        <>
          <mesh material={mat}>
            <boxGeometry args={[19, 1.6, 0.25]} />
          </mesh>
          <Html position={[0, 0, 0.4]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
            <div className="glow-muted" style={{ fontSize: 11, letterSpacing: '0.18em', whiteSpace: 'nowrap' }}>
              ░ NO SIGNAL ░
            </div>
          </Html>
        </>
      ) : (
        strips.map((line, i) => (
          <group key={i} position={[0, 2.6 - i * 2.2, 0]}>
            <mesh material={mat} rotation-y={0.06}>
              <boxGeometry args={[19, 1.6, 0.25]} />
            </mesh>
            <Html
              position={[0, 0, 0.4]}
              center
              zIndexRange={[40, 0]}
              style={clickable ? { pointerEvents: 'auto', cursor: 'pointer' } : { pointerEvents: 'none' }}
              onClick={clickable ? () => onExit?.() : undefined}
            >
              <div className="glow-violet" style={{ fontSize: 11, whiteSpace: 'nowrap', opacity: 0.85 }}>
                {truncate(line, 44)}
              </div>
            </Html>
          </group>
        ))
      )}
    </group>
  )
}

function TeleBar({ materials, tokens }: { materials: TheaterMaterials; tokens: number | null }) {
  const mat = useMemo(() => makeWireMaterial(materials.accent, 0.45, 0.8), [materials])
  useEffect(() => () => mat.dispose(), [mat])
  return (
    <group position={[50, 9, 18]}>
      <mesh material={mat}>
        <boxGeometry args={[13, 2.6, 0.3]} />
      </mesh>
      <Html position={[0, 0, 0.4]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div className="glow-accent" style={{ fontSize: 11, letterSpacing: '0.14em', whiteSpace: 'nowrap' }}>
          TELE · {tokens === null ? '——' : `${tokens.toLocaleString()} tok`}
        </div>
      </Html>
    </group>
  )
}

function QueueRing({ materials, count }: { materials: TheaterMaterials; count: number | null }) {
  const mat = useMemo(() => makeWireMaterial(materials.ok, 0.5, 0.9), [materials])
  useEffect(() => () => mat.dispose(), [mat])
  useFrame(({ clock }) => {
    const busy = (count ?? 0) > 0
    mat.emissiveIntensity = busy ? 1.2 + Math.sin(clock.elapsedTime * 4) * 0.6 : 0.7
  })
  return (
    <group position={[50, 9, -10]}>
      <mesh material={mat} rotation-y={0.5}>
        <torusGeometry args={[3.2, 0.22, 8, 40]} />
      </mesh>
      <Html position={[0, 0, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div className="glow-ok" style={{ fontSize: 11, letterSpacing: '0.14em', whiteSpace: 'nowrap' }}>
          Q · {count === null ? '—' : count}
        </div>
      </Html>
    </group>
  )
}
