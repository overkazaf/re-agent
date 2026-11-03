// WS4 RE workflow HUD: seven-phase strip ▸TRI → STA → DYN → EVD → INT →
// HYP → WRU (current = ▸ + accent bold, past = muted, future = faint),
// H:N / E:N counters, phase progress bar. Mirrors internal/ui/rehud.go.
import type { CSSProperties } from 'react'
import type { ReDTO } from '../../lib/types'
import { GlowText, PanelBox } from '../crt'

const PHASES = ['TRI', 'STA', 'DYN', 'EVD', 'INT', 'HYP', 'WRU']
const BAR_W = 14

export function REHudPanel({ re, style }: { re: ReDTO | null; style?: CSSProperties }) {
  return (
    <div style={style}>
      <PanelBox title="re workflow" accent="violet">
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

            <div style={{ fontSize: 12, letterSpacing: 1 }}>
              <span style={{ color: 'var(--accent)' }}>{'▰'.repeat(filled(re))}</span>
              <span style={{ color: 'var(--faint)' }}>{'▱'.repeat(BAR_W - filled(re))}</span>
            </div>

            <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
              <GlowText tone="accent">H:{re.hypotheses}</GlowText>
              <GlowText tone="ok">E:{re.evidence}</GlowText>
            </div>
          </div>
        )}
      </PanelBox>
    </div>
  )
}

function filled(re: ReDTO): number {
  if (re.phaseCount <= 0) return 0
  return Math.min(BAR_W, Math.max(0, Math.round((re.phaseIndex * BAR_W) / re.phaseCount)))
}
