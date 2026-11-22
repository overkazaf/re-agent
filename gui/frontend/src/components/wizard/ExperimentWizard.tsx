// ExperimentWizard — step ② (experiment): compact sandbox scope strip, clean
// 3-card experiment presets (templates tucked in `data-hint`), and live scope guard.
import { useMemo, useState, type CSSProperties } from 'react'
import { api } from '../../lib/api'
import type { EvidenceRecord } from '../../lib/types'
import { sceneActions, useSceneStore } from '../../store/scene'
import { actions, errText, useSessionRuntime } from '../../store/sessions'
import { Spinner } from '../crt/Spinner'
import { useCopyFeedback } from '../session/usabilityHelpers'
import { WizardCard, WizBanner, WizBtn, wizFieldStyle, wizFooterStyle, wizLabelStyle, wizSelectCardStyle } from './WizardCard'

type ExpKindKey = 'static_probe' | 'sandbox_trace' | 'artifact_replay'

const EXP_KINDS: { key: ExpKindKey; glyph: string; label: string; desc: string; tpl: string; expected: string }[] = [
  {
    key: 'static_probe',
    glyph: '◈',
    label: '静态探针',
    desc: '字符串 / 头部 / 指纹',
    tpl: 'strings -a {artifact} | head -50',
    expected: '',
  },
  {
    key: 'sandbox_trace',
    glyph: '◉',
    label: '沙箱追踪',
    desc: '受控反汇编 / 动态切片',
    tpl: 'objdump -d {artifact} --start-address=0x401000',
    expected: '',
  },
  {
    key: 'artifact_replay',
    glyph: '◎',
    label: '产物重放',
    desc: '确定性重放验证',
    tpl: 'verify_artifact {artifact}',
    expected: 'accepted',
  },
]

function referencedPaths(command: string): string[] {
  const tokens = command.split(/[\s'"|;&<>(){}]+/).filter((t) => /^(\.{1,2}\/|~\/|\/)/.test(t) && t.length > 1)
  return Array.from(new Set(tokens))
}

function isUnderScope(path: string, roots: readonly string[]): boolean {
  return roots.some((r) => Boolean(r) && (path === r || path.startsWith(r.endsWith('/') ? r : r + '/')))
}

async function resolveExpStatus(sessionId: string, hypId: string, ev: EvidenceRecord): Promise<'passed' | 'falsified' | 'error'> {
  if (ev.isError) return 'error'
  const res = await actions.getState(sessionId)
  if (res.ok) {
    const exp = res.value.ledger?.hypotheses?.find((h) => h.id === hypId)?.experiments?.find((e) => e.evidenceId === ev.id)
    if (exp) {
      if (exp.status === 'falsified') return 'falsified'
      if (exp.status === 'error') return 'error'
      return 'passed'
    }
  }
  return 'passed'
}

export function ExperimentWizard() {
  const { wizard: ctx } = useSceneStore()
  const rt = useSessionRuntime(ctx?.sessionId)
  const ledger = rt?.latestTick?.ledger
  const sandbox = ledger?.sandbox ?? null
  const goal = ledger?.goal ?? null
  const hyp = useMemo(
    () => (ctx?.hypId ? ledger?.hypotheses.find((h) => h.id === ctx.hypId) : undefined),
    [ctx?.hypId, ledger],
  )

  const artifact = ctx?.artifact ?? goal?.targetFile ?? ''
  const [kind, setKind] = useState<ExpKindKey | null>(null)
  const [command, setCommand] = useState('')
  const [expected, setExpected] = useState('')
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const { copiedKey, copy } = useCopyFeedback()

  const granted = sandbox?.granted ?? []
  const readonlyRoots = useMemo(
    () => [goal?.targetFile].filter((x): x is string => Boolean(x)),
    [goal?.targetFile],
  )
  const sandboxActive = sandbox?.active === true
  const outOfScope = useMemo(() => {
    if (!sandboxActive) return []
    const refs = referencedPaths(command)
    return refs.filter((p) => !isUnderScope(p, granted) && !isUnderScope(p, readonlyRoots))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, sandboxActive, granted.join('\u0000'), readonlyRoots.join('\u0000')])

  const network = useMemo(() => {
    if (!goal?.constraints) return undefined
    const hit = Object.entries(goal.constraints).find(([k]) => k.toLowerCase().includes('network'))
    return hit?.[1]
  }, [goal?.constraints])

  function pickKind(k: (typeof EXP_KINDS)[number]) {
    setKind(k.key)
    setCommand(k.tpl.replaceAll('{artifact}', artifact || '{artifact}'))
    setExpected(k.expected)
    setBanner(null)
  }

  function goBackToHypothesis() {
    sceneActions.advanceWizard({ stage: 'hypothesis' })
    sceneActions.setFocus({ kind: 'zone', zone: 'HYP' })
  }

  async function run() {
    if (!ctx) return
    if (!ctx.hypId) {
      setBanner({ tone: 'err', text: '缺少关联假设，请回到第①步先建立假设' })
      return
    }
    if (!command.trim()) {
      setBanner({ tone: 'err', text: '请填写实验命令' })
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const label = EXP_KINDS.find((k) => k.key === kind)?.label ?? '可证伪实验'
      const ev = await api.runHypothesisExperiment(ctx.sessionId, {
        hypothesisId: ctx.hypId,
        title: `${label}｜${command.trim()}`.slice(0, 80),
        command: command.trim(),
        expected: expected.trim(),
      })
      const status = await resolveExpStatus(ctx.sessionId, ctx.hypId, ev)
      if (status === 'passed') {
        sceneActions.openWizard({ sessionId: ctx.sessionId, stage: 'verification', hypId: ctx.hypId, artifact: ev.artifact })
        sceneActions.setFocus({ kind: 'zone', zone: 'VER' })
      } else if (status === 'falsified') {
        sceneActions.openWizard({ sessionId: ctx.sessionId, stage: 'revise', hypId: ctx.hypId, failureEvidenceId: ev.id })
        sceneActions.setFocus({ kind: 'zone', zone: 'HYP' })
      } else {
        setBanner({ tone: 'err', text: `实验执行出错（${ev.id}）：${ev.summary || ev.excerpt || '无输出'}` })
      }
    } catch (err) {
      setBanner({ tone: 'err', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  if (!ctx || ctx.stage !== 'experiment') return null

  return (
    <WizardCard
      title={`实验 · ${hyp ? hyp.id : (ctx.hypId ?? '—')}`}
      step={2}
      why="由宿主真实执行探针并铸造不可篡改证据 ev_NNN：命中预期则推进产物重放，不符则自动反证折半并回到假设修正。"
      sessionId={ctx.sessionId}
      onClose={sceneActions.closeWizard}
    >
      {hyp && (
        <div style={hypBarStyle}>
          <b style={{ color: 'var(--accent)', flexShrink: 0 }}>{hyp.id}</b>
          <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-hint={hyp.claim}>
            {hyp.claim}
          </span>
        </div>
      )}

      {/* Compact sandbox status & scope chips */}
      <div style={scopePanelStyle}>
        <span
          style={{ color: sandboxActive ? 'var(--ok)' : 'var(--faint)', fontWeight: 600, fontSize: 10.5, whiteSpace: 'nowrap' }}
          data-hint={
            sandboxActive
              ? `能力沙箱已启用${sandbox?.device ? ` (${sandbox.device})` : ''} · 授权 ${sandbox?.grantedCount ?? 0} · 拒绝 ${sandbox?.deniedCount ?? 0}`
              : '沙箱未激活：命令将在当前宿主环境执行'
          }
        >
          {sandboxActive ? '● 沙箱' : '○ 无沙箱'}
        </span>

        {granted.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => copy(`scope-${g}`, g)}
            data-hint="点击复制沙箱内可写路径"
            style={greenChipStyle}
          >
            {copiedKey === `scope-${g}` ? '✓ 已复制' : g}
          </button>
        ))}

        {readonlyRoots.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => copy(`ro-${p}`, p)}
            data-hint="只读目标路径（点击复制）"
            style={grayChipStyle}
          >
            {copiedKey === `ro-${p}` ? '✓ 已复制' : `${p} (RO)`}
          </button>
        ))}

        <span
          style={{ color: 'var(--faint)', fontSize: 10, marginLeft: 'auto', whiteSpace: 'nowrap' }}
          data-hint="来自 /goal 契约的网络访问策略"
        >
          net:{network ?? '—'}
        </span>
      </div>

      {/* 3 clean experiment preset cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {EXP_KINDS.map((k) => {
          const on = kind === k.key
          return (
            <button
              key={k.key}
              type="button"
              disabled={busy}
              onClick={() => pickKind(k)}
              style={wizSelectCardStyle(on, 'accent')}
              data-hint={`点击填入模板：${k.tpl}`}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: on ? 'var(--accent)' : 'var(--muted)', fontSize: 12 }}>{k.glyph}</span>
                <span style={{ color: on ? 'var(--accent)' : 'var(--text)', fontWeight: 600, fontSize: 11.5 }}>{k.label}</span>
              </span>
              <span style={{ color: 'var(--faint)', fontSize: 10 }}>{k.desc}</span>
            </button>
          )
        })}
      </div>

      <label style={wizLabelStyle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>实跑命令</span>
          {artifact && (
            <code
              style={{
                color: 'var(--ok)',
                fontSize: 10,
                padding: '0 4px',
                border: '1px solid var(--border-subtle, var(--rule))',
                borderRadius: 'var(--radius-xs, 2px)',
              }}
              data-hint="当前目标产物"
            >
              {artifact}
            </code>
          )}
          <span className="usa-hint-dot" data-hint="由宿主实际执行并将输出铸造为不可篡改证据 ev_NNN">
            ?
          </span>
          <span style={{ marginLeft: 'auto', color: command.trim() ? 'var(--ok)' : 'var(--faint)', fontSize: 10 }}>
            {command.trim() ? '✓' : '必填'}
          </span>
        </span>
        <input
          aria-label="experiment command"
          style={{
            ...wizFieldStyle,
            borderColor: outOfScope.length > 0 ? 'var(--err)' : undefined,
          }}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="例：strings -a carrier.bin | head -50"
        />
      </label>

      {outOfScope.length > 0 && (
        <div
          style={{
            color: 'var(--err)',
            fontSize: 10.5,
            padding: '5px 8px',
            border: '1px solid var(--err)',
            borderRadius: 'var(--radius-xs, 2px)',
            background: 'var(--err-soft, color-mix(in srgb, var(--err) 10%, var(--bg)))',
          }}
        >
          ⚠ 超出沙箱路径：{outOfScope.join('、')}
        </div>
      )}

      <label style={wizLabelStyle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span>预期输出</span>
          <span className="usa-hint-dot" data-hint="命中关键字则支撑假设；不符则自动反证折半并回到假设修正">
            ?
          </span>
        </span>
        <input
          aria-label="experiment expected"
          style={wizFieldStyle}
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder="例：accepted / MZPK"
        />
      </label>

      {banner && <WizBanner tone={banner.tone} text={banner.text} />}

      <div style={wizFooterStyle}>
        <WizBtn type="button" disabled={busy} onClick={goBackToHypothesis}>
          ← 上一步
        </WizBtn>
        <WizBtn type="button" tone="accent" disabled={busy} onClick={() => void run()}>
          {busy ? (
            <>
              <Spinner /> 实验实跑中…
            </>
          ) : (
            '▶ 运行实验并实跑取证'
          )}
        </WizBtn>
      </div>
    </WizardCard>
  )
}

const hypBarStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  border: '1px solid var(--border-subtle, var(--rule))',
  borderRadius: 'var(--radius-xs, 2px)',
  background: 'var(--surface-1, transparent)',
  padding: '5px 8px',
  fontSize: 11,
  minWidth: 0,
}

const scopePanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle, var(--rule))',
  borderRadius: 'var(--radius-xs, 2px)',
  background: 'var(--surface-1, transparent)',
  padding: '5px 8px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
}

const greenChipStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--ok) 65%, var(--rule))',
  borderRadius: 'var(--radius-xs, 2px)',
  background: 'var(--ok-soft, color-mix(in srgb, var(--ok) 12%, transparent))',
  color: 'var(--ok)',
  fontSize: 10,
  padding: '1px 6px',
  cursor: 'pointer',
}

const grayChipStyle: CSSProperties = {
  border: '1px solid var(--border-subtle, var(--rule))',
  borderRadius: 'var(--radius-xs, 2px)',
  background: 'var(--surface-2, transparent)',
  color: 'var(--muted)',
  fontSize: 10,
  padding: '1px 6px',
  cursor: 'pointer',
}
