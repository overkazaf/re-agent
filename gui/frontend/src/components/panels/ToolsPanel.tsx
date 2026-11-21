// TOOLS — recent tool runs as compact tree cards with forensic RE telemetry:
//   ├─ <spinner|✓|✗> [CAT] name [artifact] args  [EXIT 0] 3.2s
//   └─ preview
// Running rows carry a Spinner + accent glow, failed rows go red. Pure render
// over FlowDTO.toolRuns (TUI reference: internal/ui/dashboard.go:225-302).
import { PanelBox, Spinner } from '../crt'
import type { FlowDTO, ToolRunSnapshot } from '../../lib/types'
import { classifyToolCall, computeLatencyStats } from '../re/forensics'
import '../re/re-pro.css'
import { fmtDuration } from './format'

/** TUI toolCardRows parity: only the most recent cards stay visible. */
const MAX_CARDS = 6

function runDuration(run: ToolRunSnapshot, now: number): string {
  if (run.status === 'running') {
    if (run.startedAt === 0 || now <= run.startedAt) return 'running'
    return fmtDuration(now - run.startedAt)
  }
  if (run.ms !== 0) return fmtDuration(run.ms)
  if (run.finishedAt > run.startedAt && run.startedAt !== 0) {
    return fmtDuration(run.finishedAt - run.startedAt)
  }
  return ''
}

export function ToolsPanel({ flow }: { flow: FlowDTO }) {
  const runs = flow.toolRuns.slice(-MAX_CARDS)
  const classified = runs.map(classifyToolCall)
  const latency = computeLatencyStats(flow.toolRuns)
  const now = Date.now()
  return (
    <PanelBox
      title="tools"
      accent={flow.toolsFailed > 0 ? 'err' : flow.toolRuns.length > 0 ? 'ok' : undefined}
      tier="primary"
      badge="执行采样"
    >
      <div className="tools-head re-mono-num" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="t-ok">✓ {flow.toolsOk}</span>
        <span className={flow.toolsFailed > 0 ? 't-err' : 't-faint'}>✗ {flow.toolsFailed}</span>
        <span className="t-faint">{flow.toolRuns.length} runs</span>
        {flow.toolRuns.length > 0 && (
          <>
            <span className="t-muted" title="Tool execution success rate">
              {latency.successRate}% ok
            </span>
            {latency.avgMs > 0 && (
              <span className="t-faint" title={`avg ${fmtDuration(latency.avgMs)} · p95 ${fmtDuration(latency.p95Ms)} · max ${fmtDuration(latency.maxMs)}`}>
                avg {fmtDuration(latency.avgMs)} · p95 {fmtDuration(latency.p95Ms)}
              </span>
            )}
          </>
        )}
      </div>
      {classified.length === 0 ? (
        <div className="panel-empty t-faint">waiting for tool events</div>
      ) : (
        <div className="tool-cards">
          {classified.map(({ run, category, toolFamily, targetArtifact, exitLabel, exitState }) => {
            const running = run.status === 'running'
            const failed = run.status === 'failed'
            return (
              <div
                key={run.id}
                className={running ? 'tool-card tool-running' : failed ? 'tool-card tool-failed' : 'tool-card'}
              >
                <div className="tool-line re-mono-num">
                  <span className="t-faint">├─</span>
                  {running ? (
                    <Spinner tone="accent" />
                  ) : (
                    <span className={failed ? 't-err' : 't-ok'}>{failed ? '✗' : '✓'}</span>
                  )}
                  <span className="re-tool-cat" data-cat={category} title={`RE Tool Domain: ${category} (${toolFamily})`}>
                    {category}
                  </span>
                  <span className={failed ? 'tool-name t-err' : 'tool-name'}>{run.name}</span>
                  {targetArtifact && (
                    <span className="re-tool-target" title={`Target artifact: ${targetArtifact}`}>
                      {targetArtifact}
                    </span>
                  )}
                  {run.argsText !== '' && <span className="tool-args t-muted">{run.argsText}</span>}
                  <span className="re-tool-exit" data-state={exitState}>
                    {exitLabel}
                  </span>
                  <span className="tool-dur t-faint">{runDuration(run, now)}</span>
                </div>
                {run.preview !== '' && (
                  <div className="tool-line tool-preview">
                    <span className="t-faint">└─</span>
                    <span className="tool-preview-text">{run.preview}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </PanelBox>
  )
}
