// WS4 RE workflow HUD: nine-phase strip ▸TRI → STA → DYN → EVI → IFC →
// HYP → VER → AUD → WRI (current = ▸ + accent bold, past = muted, future = faint),
// H:N / E:N counters, phase progress bar. Mirrors internal/ui/rehud.go.
import type { CSSProperties } from 'react'
import type { ReDTO } from '../../lib/types'
import { GlowText, PanelBox } from '../crt'
import './re-pro.css'

// Glyphs match workflow.PhaseCodes / internal/ui/rehud.go exactly.
const PHASES = ['TRI', 'STA', 'DYN', 'EVI', 'IFC', 'HYP', 'VER', 'AUD', 'WRI']
const PHASE_GATES: Record<string, string> = {
  TRI: '样本指纹 / 格式 / 保护初筛',
  STA: '静态观测入账 (ev ≥ 1)',
  DYN: '可证伪假设建栈 (H ≥ 1)',
  EVI: '动静双视角证据采集',
  IFC: '核心接口 / 偏移定位',
  HYP: '冲突仲裁与置信度校准',
  VER: '动态追踪 ≥ 1 或静态观测 ≥ 3',
  AUD: 'verify_artifact 重放凭证 ≥ 1',
  WRI: 'audit_finding ≥ 1 + /goal 达标',
}
const BAR_W = 14

export function REHudPanel({
  re,
  onInspect,
  onOpenGraph,
  onOpenWriteup,
  style,
}: {
  re: ReDTO | null
  onInspect?: (tab: 'hypotheses' | 'evidence') => void
  onOpenGraph?: () => void
  onOpenWriteup?: () => void
  style?: CSSProperties
}) {
  return (
    <div style={style}>
      <PanelBox title="re workflow" accent="violet" tier="primary" badge={re ? '9-GATE' : undefined}>
        {!re ? (
          <div style={{ color: 'var(--faint)', fontSize: 12, padding: '4px 0' }}>
            ○ RE workflow off — /workflow reverse|ctf|research… 启用
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
              <span
                style={{
                  color: 'var(--violet)',
                  border: '1px solid var(--violet)',
                  padding: '0 6px',
                  fontSize: 10,
                  letterSpacing: '0.1em',
                }}
              >
                {re.sampleType || '—'}
              </span>
              <GlowText tone="accent">
                <span style={{ fontWeight: 700 }}>{(re.phase || '').toUpperCase()}</span>
              </GlowText>
              <span style={{ color: 'var(--faint)' }}>
                [{re.phaseIndex + 1}/{re.phaseCount}]
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, fontSize: 12, flexWrap: 'wrap' }}>
              {PHASES.map((p, i) => (
                <span key={p} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                  {i > 0 && <span style={{ color: 'var(--faint)' }}>→</span>}
                  {i < re.phaseIndex && <span style={{ color: 'var(--muted)' }}>{p}</span>}
                  {i === re.phaseIndex && (
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>▸{p}</span>
                  )}
                  {i > re.phaseIndex && <span style={{ color: 'var(--faint)' }}>{p}</span>}
                </span>
              ))}
            </div>

            <div className="re-mono-num" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 12, letterSpacing: 1 }}>
                <span style={{ color: 'var(--accent)' }}>{'▰'.repeat(filled(re))}</span>
                <span style={{ color: 'var(--faint)' }}>{'▱'.repeat(BAR_W - filled(re))}</span>
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: re.phaseIndex >= PHASES.length - 1 ? 'var(--ok)' : 'var(--muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={
                  re.phaseIndex >= PHASES.length - 1
                    ? '✓ WRI 交付门禁就绪'
                    : `NEXT → ${PHASES[re.phaseIndex + 1]}: ${PHASE_GATES[PHASES[re.phaseIndex + 1]] ?? ''}`
                }
              >
                {re.phaseIndex >= PHASES.length - 1
                  ? '✓ WRI 交付门禁就绪'
                  : `NEXT → ${PHASES[re.phaseIndex + 1]}: ${PHASE_GATES[PHASES[re.phaseIndex + 1]] ?? ''}`}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
              <button
                type="button"
                onClick={() => onInspect?.('hypotheses')}
                title="点击查看假设栈明细"
                style={{
                  padding: 0,
                  cursor: onInspect ? 'pointer' : 'default',
                  borderBottom: onInspect ? '1px dashed var(--accent-dim)' : 'none',
                }}
              >
                <GlowText tone="accent">H:{re.hypotheses}</GlowText>
              </button>
              <button
                type="button"
                onClick={() => onInspect?.('evidence')}
                title="点击查看证据账本明细"
                style={{
                  padding: 0,
                  cursor: onInspect ? 'pointer' : 'default',
                  borderBottom: onInspect ? '1px dashed var(--ok)' : 'none',
                }}
              >
                <GlowText tone="ok">E:{re.evidence}</GlowText>
              </button>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                {onOpenGraph && (
                  <button
                    type="button"
                    onClick={onOpenGraph}
                    title="打开假设/证据/审核/安全协同图谱"
                    style={{
                      padding: '0 5px',
                      fontSize: 10,
                      color: 'var(--violet)',
                      border: '1px solid var(--violet-dim)',
                      cursor: 'pointer',
                    }}
                  >
                    ◈ 图谱
                  </button>
                )}
                {onOpenWriteup && (
                  <button
                    type="button"
                    onClick={onOpenWriteup}
                    title="打开逆向过程总结与结构化 Writeup 报告工坊"
                    style={{
                      padding: '0 5px',
                      fontSize: 10,
                      color: re.phase === 'writeup' ? 'var(--ok)' : 'var(--muted)',
                      border: `1px solid ${re.phase === 'writeup' ? 'var(--ok)' : 'var(--rule)'}`,
                      cursor: 'pointer',
                    }}
                  >
                    ✎ 报告
                  </button>
                )}
              </span>
            </div>
          </div>
        )}
      </PanelBox>
    </div>
  )
}

function filled(re: ReDTO): number {
  if (re.phaseCount <= 0) return 0
  return Math.min(BAR_W, Math.max(0, Math.round(((re.phaseIndex + 1) * BAR_W) / re.phaseCount)))
}
