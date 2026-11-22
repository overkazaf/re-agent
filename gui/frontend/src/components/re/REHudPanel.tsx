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
      <PanelBox title="re workflow" accent="violet" tier="primary" badge={re ? `${re.phaseIndex + 1}/${re.phaseCount}` : undefined}>
        {!re ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--faint)', fontSize: 11.5, padding: '3px 0' }}>
            <span>○ RE workflow off</span>
            <span
              className="re-hint-dot"
              data-hint="运行 /workflow reverse|ctf|research 启用 9 阶段硬门禁逆向流"
            >
              ?
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11 }}>
              <span
                data-hint={`当前样本类型：${re.sampleType || '未指定'}`}
                style={{
                  color: 'var(--violet)',
                  border: '1px solid color-mix(in srgb, var(--violet) 55%, var(--rule))',
                  background: 'var(--violet-soft)',
                  borderRadius: 'var(--radius-xs)',
                  padding: '0 6px',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                }}
              >
                {re.sampleType || '—'}
              </span>
              <GlowText tone="accent">
                <span style={{ fontWeight: 700 }}>{(re.phase || '').toUpperCase()}</span>
              </GlowText>
              <span className="re-mono-num" style={{ color: 'var(--faint)' }}>
                [{re.phaseIndex + 1}/{re.phaseCount}]
              </span>
              <span
                className="re-hint-dot"
                style={{ marginLeft: 'auto' }}
                data-hint={
                  re.phaseIndex >= PHASES.length - 1
                    ? '✓ WRI 交付门禁已全部达标，可导出完整取证 Writeup'
                    : `下一阶段门禁 ${PHASES[re.phaseIndex + 1]}：${PHASE_GATES[PHASES[re.phaseIndex + 1]] ?? ''}`
                }
              >
                ?
              </span>
            </div>

            <div className="re-mono-num" style={{ display: 'flex', alignItems: 'baseline', gap: 3, fontSize: 11, flexWrap: 'wrap' }}>
              {PHASES.map((p, i) => (
                <span key={p} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3 }}>
                  {i > 0 && <span style={{ color: 'var(--rule)' }}>→</span>}
                  <span
                    data-hint={`${p} 门禁：${PHASE_GATES[p] ?? ''}`}
                    style={
                      i === re.phaseIndex
                        ? { color: 'var(--accent)', fontWeight: 700 }
                        : i < re.phaseIndex
                          ? { color: 'var(--muted)' }
                          : { color: 'var(--faint)' }
                    }
                  >
                    {i === re.phaseIndex ? `▸${p}` : p}
                  </span>
                </span>
              ))}
            </div>

            <div
              className="re-mono-num"
              style={{ fontSize: 11.5, letterSpacing: 1 }}
              data-hint={
                re.phaseIndex >= PHASES.length - 1
                  ? '✓ WRI 交付门禁就绪 (9/9)'
                  : `阶段进度 ${re.phaseIndex + 1}/${re.phaseCount} · NEXT → ${PHASES[re.phaseIndex + 1]}: ${PHASE_GATES[PHASES[re.phaseIndex + 1]] ?? ''}`
              }
            >
              <span style={{ color: 'var(--accent)' }}>{'▰'.repeat(filled(re))}</span>
              <span style={{ color: 'var(--rule)' }}>{'▱'.repeat(BAR_W - filled(re))}</span>
            </div>

            <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
              <button
                type="button"
                onClick={() => onInspect?.('hypotheses')}
                title="点击查看假设栈明细"
                data-hint="点击打开假设栈明细，检视置信度与证据连线"
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
                data-hint="点击打开不可篡改证据账本明细 (ev_NNN)"
                style={{
                  padding: 0,
                  cursor: onInspect ? 'pointer' : 'default',
                  borderBottom: onInspect ? '1px dashed var(--ok)' : 'none',
                }}
              >
                <GlowText tone="ok">E:{re.evidence}</GlowText>
              </button>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5 }}>
                {onOpenGraph && (
                  <button
                    type="button"
                    onClick={onOpenGraph}
                    data-hint="打开多席位协同与因果证据图谱"
                    style={{
                      padding: '1px 6px',
                      fontSize: 10,
                      color: 'var(--violet)',
                      border: '1px solid color-mix(in srgb, var(--violet) 50%, var(--rule))',
                      borderRadius: 'var(--radius-xs)',
                      background: 'var(--violet-soft)',
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
                    data-hint="打开完整推理叙事与证据锚定 Writeup 报告工坊"
                    style={{
                      padding: '1px 6px',
                      fontSize: 10,
                      color: re.phase === 'writeup' ? 'var(--ok)' : 'var(--muted)',
                      border: `1px solid ${re.phase === 'writeup' ? 'color-mix(in srgb, var(--ok) 55%, var(--rule))' : 'var(--border-subtle)'}`,
                      borderRadius: 'var(--radius-xs)',
                      background: re.phase === 'writeup' ? 'var(--ok-soft)' : 'transparent',
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
