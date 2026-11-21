// DemoLauncherDialog — interactive gallery of the 5 curated GUI cases with
// completion tracking and per-scenario step previews.
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
    <Dialog title="0xAF-Re 演示环境 · 常见 Case 场景库" accent="accent" width={700} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
          零配置内存沙盒（无需 API Key、不触碰本地磁盘）。每个场景均内置分步操作指引，支持{' '}
          <span style={{ color: 'var(--accent)' }}>⚡ 填入指令</span>、{' '}
          <span style={{ color: 'var(--accent)' }}>▶ 自动演示</span>，也随时欢迎亲手输入任意 Prompt、斜杠命令或点击审批按钮。
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            padding: '2px 8px',
            border: `1px solid ${completedScenarios === DEMO_SCENARIOS.length ? 'var(--ok)' : 'var(--rule)'}`,
            color: completedScenarios === DEMO_SCENARIOS.length ? 'var(--ok)' : 'var(--muted)',
            whiteSpace: 'nowrap',
          }}
        >
          已完成 {completedScenarios}/{DEMO_SCENARIOS.length} 场景
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 450, overflowY: 'auto' }}>
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
                boxShadow: isCurrent ? '0 0 14px var(--accent-dim)' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--violet)', fontSize: 11, fontWeight: 700 }}>
                  CASE {sc.index}
                </span>
                <span style={{ color: isCurrent ? 'var(--accent)' : 'var(--text)', fontWeight: 700, fontSize: 13 }}>
                  {sc.title}
                </span>
                <span style={{ color: 'var(--faint)', fontSize: 11 }}>{sc.subtitle}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--faint)', fontSize: 10 }}>{sc.duration}</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    border: `1px solid ${allDone ? 'var(--ok)' : isCurrent ? 'var(--accent)' : 'var(--rule)'}`,
                    color: allDone ? 'var(--ok)' : isCurrent ? 'var(--accent)' : 'var(--faint)',
                  }}
                >
                  {allDone ? '✓ 已完成' : isCurrent ? `进行中 ${done}/${sc.steps.length}` : `${done}/${sc.steps.length} 步`}
                </span>
              </div>

              <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>{sc.summary}</div>

              {/* Compact step itinerary preview */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                {sc.steps.map((st, idx) => {
                  const stDone = Boolean(demo.completedSteps[`${sc.id}:${st.id}`])
                  return (
                    <span
                      key={st.id}
                      style={{
                        fontSize: 10,
                        color: stDone ? 'var(--ok)' : 'var(--faint)',
                        background: 'rgba(5, 8, 12, 0.5)',
                        border: `1px solid ${stDone ? 'color-mix(in srgb, var(--ok) 45%, var(--rule))' : 'var(--rule)'}`,
                        padding: '0 5px',
                      }}
                    >
                      {stDone ? '✓' : `${idx + 1}.`} {st.title}
                    </span>
                  )
                })}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {sc.tags.map((tag) => (
                  <span key={tag} style={tagStyle}>
                    {tag}
                  </span>
                ))}
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 600 }}>
                  {isCurrent ? '↻ 重新启动此场景' : '启动场景 →'}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--faint)', fontSize: 11 }}>
          支持 URL 直达：?case=welcome-approval | re-workflow | multi-queue-stop | commands-themes | shell-lab
        </span>
        <Btn onClick={onClose}>close</Btn>
      </div>
    </Dialog>
  )
}

const tagStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--faint)',
  border: '1px solid var(--rule)',
  padding: '0 5px',
  letterSpacing: '0.06em',
}
