// DemoLauncherDialog — clean interactive gallery of the 5 curated GUI cases
// with compact step dots and contextual hover hints (`data-hint`).
import type { CSSProperties } from 'react'
import { DEMO_SCENARIOS, type DemoScenarioId } from '../../demo/scenarios'
import { demoActions, useDemoStore } from '../../demo/store'
import { Btn, Dialog } from '../session/Dialog'
import '../session/usability.css'

export function DemoLauncherDialog({ onClose }: { onClose: () => void }) {
  const demo = useDemoStore()

  const completedScenarios = DEMO_SCENARIOS.filter((sc) =>
    sc.steps.every((st) => demo.completedSteps[`${sc.id}:${st.id}`]),
  ).length

  function launch(id: DemoScenarioId) {
    void demoActions.selectScenario(id)
    onClose()
  }

  return (
    <Dialog title="0xAF-Re 演示环境 · 常见 Case 场景库" accent="accent" width={640} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 11.5 }}>
          <span>零配置内存沙盒 · 支持手动输入或一键演示</span>
          <span
            className="usa-hint-dot"
            tabIndex={0}
            data-hint="无需 API Key、不触碰本地磁盘。支持 URL 直达：?case=welcome-approval | re-workflow | multi-queue-stop | commands-themes | shell-lab"
          >
            ?
          </span>
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            padding: '1px 7px',
            border: `1px solid ${completedScenarios === DEMO_SCENARIOS.length ? 'var(--ok)' : 'var(--border-subtle, var(--rule))'}`,
            borderRadius: 'var(--radius-xs, 2px)',
            color: completedScenarios === DEMO_SCENARIOS.length ? 'var(--ok)' : 'var(--muted)',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {completedScenarios}/{DEMO_SCENARIOS.length} 完成
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, maxHeight: 440, overflowY: 'auto' }}>
        {DEMO_SCENARIOS.map((sc) => {
          const isCurrent = demo.active && demo.scenarioId === sc.id
          const done = sc.steps.filter((st) => demo.completedSteps[`${sc.id}:${st.id}`]).length
          const allDone = done === sc.steps.length
          return (
            <div
              key={sc.id}
              role="button"
              tabIndex={0}
              onClick={() => launch(sc.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  launch(sc.id)
                }
              }}
              className="usa-demo-card"
              style={{
                borderColor: isCurrent ? 'var(--accent)' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ color: 'var(--violet)', fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>
                  CASE {sc.index}
                </span>
                <span
                  style={{
                    color: isCurrent ? 'var(--accent)' : 'var(--text)',
                    fontWeight: 600,
                    fontSize: 12.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {sc.title}
                </span>
                <span
                  className="usa-hint-dot"
                  data-hint={sc.summary}
                  onClick={(e) => e.stopPropagation()}
                >
                  ?
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--faint)', fontSize: 10, whiteSpace: 'nowrap' }}>{sc.duration}</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    border: `1px solid ${allDone ? 'var(--ok)' : isCurrent ? 'var(--accent)' : 'var(--border-subtle, var(--rule))'}`,
                    borderRadius: 'var(--radius-xs, 2px)',
                    color: allDone ? 'var(--ok)' : isCurrent ? 'var(--accent)' : 'var(--faint)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {allDone ? '✓ 完成' : isCurrent ? `进行中 ${done}/${sc.steps.length}` : `${done}/${sc.steps.length}`}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--faint)', fontSize: 10.5 }}>{sc.subtitle}</span>
                <span style={{ color: 'var(--rule)' }}>·</span>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {sc.steps.map((st, idx) => {
                    const stDone = Boolean(demo.completedSteps[`${sc.id}:${st.id}`])
                    return (
                      <span
                        key={st.id}
                        style={{
                          ...stepChipStyle,
                          color: stDone ? 'var(--ok)' : 'var(--muted)',
                          borderColor: stDone
                            ? 'color-mix(in srgb, var(--ok) 45%, var(--rule))'
                            : 'var(--border-subtle, var(--rule))',
                        }}
                        data-hint={`${idx + 1}. ${st.title} — ${st.guide}`}
                      >
                        {stDone ? '✓' : `${idx + 1}.`} {st.title}
                      </span>
                    )
                  })}
                </div>
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {isCurrent ? '↻ 重启' : '启动 →'}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn onClick={onClose}>close</Btn>
      </div>
    </Dialog>
  )
}

const stepChipStyle: CSSProperties = {
  fontSize: 10,
  background: 'var(--surface-2, color-mix(in srgb, var(--bg) 60%, transparent))',
  border: '1px solid var(--border-subtle, var(--rule))',
  borderRadius: 'var(--radius-xs, 2px)',
  padding: '0 5px',
  whiteSpace: 'nowrap',
}
