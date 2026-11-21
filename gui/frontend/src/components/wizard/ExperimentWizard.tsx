// 向导第②步（stage: experiment）——为假设配置并实跑可证伪实验。
// 实验类型三卡（static_probe / sandbox_trace / artifact_replay）选中即预填
// 命令模板，命令与预期输出均可编辑。沙箱可写/只读路径 chip 点击即可复制，
// 命令引用 scope 外路径时即时红字警告。
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
    desc: '只读静态特征：字符串 / 头部 / 指纹',
    tpl: 'strings -a {artifact} | head -50',
    expected: '',
  },
  {
    key: 'sandbox_trace',
    glyph: '◉',
    label: '沙箱追踪',
    desc: '受控反汇编 / 动态执行切片',
    tpl: 'objdump -d {artifact} --start-address=0x401000',
    expected: '',
  },
  {
    key: 'artifact_replay',
    glyph: '◎',
    label: '产物重放',
    desc: 'verify_artifact 确定性重放',
    tpl: 'verify_artifact {artifact}',
    expected: 'accepted',
  },
]

/** 命令中引用到的路径形 token（/ ~ ./ ../ 开头） */
function referencedPaths(command: string): string[] {
  const tokens = command.split(/[\s'"|;&<>(){}]+/).filter((t) => /^(\.{1,2}\/|~\/|\/)/.test(t) && t.length > 1)
  return Array.from(new Set(tokens))
}

function isUnderScope(path: string, roots: readonly string[]): boolean {
  return roots.some((r) => Boolean(r) && (path === r || path.startsWith(r.endsWith('/') ? r : r + '/')))
}

/** 实验结果状态：从刷新后的 Hypothesis.experiments 按 evidenceId 比对 */
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
      setBanner({ tone: 'err', text: '缺少关联假设（hypId）——请回到第①步先建立假设' })
      return
    }
    if (!command.trim()) {
      setBanner({ tone: 'err', text: '请填写实验命令（由宿主真实执行并盖章为不可篡改 ev_NNN）' })
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
          <span style={{ color: 'var(--text)' }}>{hyp.claim}</span>
        </div>
      )}

      {/* 沙箱引导面板：可写绿 chip / 只读灰 chip / 网络状态 */}
      <div style={scopePanelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: sandboxActive ? 'var(--ok)' : 'var(--faint)', fontWeight: 700, fontSize: 11 }}>
            {sandboxActive ? '● 沙箱 · 已激活' : '○ 沙箱 · 未激活'}
          </span>
          {sandbox?.device && <span style={{ color: 'var(--muted)', fontSize: 10.5 }}>{sandbox.device}</span>}
          {sandbox && (
            <span style={{ color: 'var(--faint)', fontSize: 10.5 }}>
              授权 {sandbox.grantedCount} · 拒绝 {sandbox.deniedCount}
            </span>
          )}
          <span style={{ color: 'var(--muted)', fontSize: 10.5, marginLeft: 'auto' }}>
            网络：{network ?? '未声明'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {granted.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => copy(`scope-${g}`, g)}
              title="点击复制沙箱内可写路径"
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
              title="只读目标（可引用不可写，点击复制）"
              style={grayChipStyle}
            >
              {copiedKey === `ro-${p}` ? '✓ 已复制' : `${p}（只读）`}
            </button>
          ))}
          {!sandboxActive && (
            <span style={{ color: 'var(--faint)', fontSize: 10 }}>命令将在未受控环境执行</span>
          )}
        </div>
      </div>

      {/* 实验类型三卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {EXP_KINDS.map((k) => {
          const on = kind === k.key
          return (
            <button key={k.key} type="button" disabled={busy} onClick={() => pickKind(k)} style={wizSelectCardStyle(on, 'accent')}>
              <span style={{ color: on ? 'var(--accent)' : 'var(--muted)', fontSize: 13 }}>{k.glyph}</span>
              <span style={{ color: on ? 'var(--accent)' : 'var(--text)', fontWeight: 700, fontSize: 11.5 }}>{k.label}</span>
              <span style={{ color: 'var(--faint)', fontSize: 10, lineHeight: 1.4 }}>{k.desc}</span>
              <code style={{ color: 'var(--muted)', fontSize: 9.5, wordBreak: 'break-all' }}>{k.tpl}</code>
            </button>
          )
        })}
      </div>

      <label style={wizLabelStyle}>
        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            实跑命令（{artifact ? <>目标产物 <code style={{ color: 'var(--ok)' }}>{artifact}</code></> : '未指定目标产物'}）
          </span>
          <span style={{ color: command.trim() ? 'var(--ok)' : 'var(--faint)', fontSize: 10 }}>
            {command.trim() ? '✓ 就绪' : '必填'}
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
          placeholder="例如：strings -a carrier.bin | head -50"
        />
      </label>
      {outOfScope.length > 0 && (
        <div
          style={{
            color: 'var(--err)',
            fontSize: 10.5,
            padding: '5px 8px',
            border: '1px solid var(--err)',
            background: 'color-mix(in srgb, var(--err) 10%, var(--bg))',
          }}
        >
          ⚠ 该路径不在沙箱 scope 内：{outOfScope.join('、')} —— 实验将被沙箱拒绝或产生未受控读写
        </div>
      )}

      <label style={wizLabelStyle}>
        预期输出关键字（命中则支撑；不符则反证折半）
        <input
          aria-label="experiment expected"
          style={wizFieldStyle}
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder="例如：carrier-prefix / accepted / MZPK"
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
  alignItems: 'baseline',
  border: '1px solid var(--rule)',
  background: 'rgba(5, 8, 12, 0.5)',
  padding: '5px 8px',
  fontSize: 11,
}

const scopePanelStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--ok) 35%, var(--rule))',
  background: 'rgba(6, 16, 12, 0.55)',
  padding: '6px 9px',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
}

const greenChipStyle: CSSProperties = {
  border: '1px solid var(--ok)',
  background: 'color-mix(in srgb, var(--ok) 14%, transparent)',
  color: 'var(--ok)',
  fontSize: 10,
  padding: '1px 6px',
  cursor: 'pointer',
}

const grayChipStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(5, 8, 12, 0.6)',
  color: 'var(--muted)',
  fontSize: 10,
  padding: '1px 6px',
  cursor: 'pointer',
}
