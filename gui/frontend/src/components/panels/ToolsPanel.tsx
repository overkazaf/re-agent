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

const CAT_HINT: Record<string, string> = {
  STATIC: 'STATIC · 静态分析工具（ELF/PE/反汇编/熵值/字节雕刻），产出 static 视角观测',
  DYNAMIC: 'DYNAMIC · 动态执行工具（子进程/调试/脚本实跑），产出 dynamic 视角运行轨迹',
  VERIFY: 'VERIFY · 确定性重放验证工具（verify_artifact），签发带 SHA256 的验证凭证',
  CRYPTO: 'CRYPTO · 编解码与密码学识别工具（Base64/XOR/哈希/熵分析）',
  LEDGER: 'LEDGER · 宿主元认知工具（假设栈、任务计划与阶段门禁管理）',
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
    >
      <div className="tools-head re-mono-num" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="t-ok" data-hint={`工具成功执行 ${flow.toolsOk} 次`}>✓ {flow.toolsOk}</span>
        <span className={flow.toolsFailed > 0 ? 't-err' : 't-faint'} data-hint={`工具失败或被拦截 ${flow.toolsFailed} 次`}>
          ✗ {flow.toolsFailed}
        </span>
        {flow.toolRuns.length > 0 && (
          <>
            <span
              className="t-muted"
              data-hint={`累计 ${flow.toolRuns.length} 次采样 · 成功率 ${latency.successRate}%`}
            >
              {latency.successRate}% ok
            </span>
            {latency.p95Ms > 0 && (
              <span
                className="t-faint"
                style={{ marginLeft: 'auto' }}
                data-hint={`工具耗时分布：平均 ${fmtDuration(latency.avgMs)} · P95 ${fmtDuration(latency.p95Ms)} · 峰值 ${fmtDuration(latency.maxMs)}`}
              >
                p95 {fmtDuration(latency.p95Ms)}
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
                  <span
                    className="re-tool-cat"
                    data-cat={category}
                    data-hint={CAT_HINT[category] ?? `${category} (${toolFamily})`}
                  >
                    {category}
                  </span>
                  <span className={failed ? 'tool-name t-err' : 'tool-name'}>{run.name}</span>
                  {targetArtifact && (
                    <span
                      className="re-tool-target"
                      data-hint={`目标样本 / 产物：${targetArtifact}`}
                    >
                      {targetArtifact}
                    </span>
                  )}
                  {run.argsText !== '' && <span className="tool-args t-muted">{run.argsText}</span>}
                  <span
                    className="re-tool-exit"
                    data-state={exitState}
                    data-hint={exitState === 'ok' ? '工具正常返回' : exitState === 'fail' ? '执行异常或被门禁拦截' : '正在执行中'}
                  >
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
