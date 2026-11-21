// 向导第③步（stage: verification）——verify_artifact 确定性重放验证。
// artifact 预填 ctx.artifact（第②步 passed 实验的产物回填），build 命令可选，
// cases 列表（name/command/expected，可增删行）。提交 api.RunVerification：
// 成功展示 VerificationStats 绿红条（passed/total + build ✓/✗ + sha256），
// 并推进第④步（review）+ 聚焦 AUD；绿红条停留 1.5s 供确认，也可手动点进。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api } from '../../lib/api'
import type { VerificationCaseDTO } from '../../lib/types'
import { sceneActions, useSceneStore } from '../../store/scene'
import { actions, errText } from '../../store/sessions'
import { Spinner } from '../crt/Spinner'
import { WizardCard, WizBanner, WizBtn, wizFieldStyle, wizFooterStyle, wizLabelStyle } from './WizardCard'

const AUTO_ADVANCE_MS = 1500

export function VerificationWizard() {
  const { wizard: ctx } = useSceneStore()

  const [artifact, setArtifact] = useState('')
  const [buildCmd, setBuildCmd] = useState('')
  const [cases, setCases] = useState<VerificationCaseDTO[]>([{ name: 'case-1', command: '', expected: '' }])
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [stats, setStats] = useState<{
    evId: string
    passed: number
    total: number
    build: boolean
    sha256?: string
  } | null>(null)
  const timerRef = useRef<number | null>(null)

  // 第②步推进过来时预填产物路径（ctx.artifact 变化即新开一次验证）
  const prefillArtifact = ctx?.artifact
  useEffect(() => {
    setArtifact(prefillArtifact ?? '')
  }, [prefillArtifact])

  // 卸载时清掉待触发的自动推进
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const hypLabel = useMemo(() => ctx?.hypId ?? '（不关联假设）', [ctx?.hypId])
  const validCaseCount = useMemo(() => cases.filter((c) => c.command.trim()).length, [cases])

  function goReview() {
    if (!ctx) return
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    sceneActions.openWizard({ sessionId: ctx.sessionId, stage: 'review', hypId: ctx.hypId })
    sceneActions.setFocus({ kind: 'zone', zone: 'AUD' })
  }

  function updateCase(idx: number, patch: Partial<VerificationCaseDTO>) {
    setCases((cs) => cs.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  }

  async function run() {
    if (!ctx) return
    const valid = cases.filter((c) => c.command.trim())
    if (!artifact.trim() || valid.length === 0) {
      setBanner({ tone: 'err', text: '请指定工作区目标产物路径与至少一条实跑重放用例' })
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const ev = await api.runVerification(ctx.sessionId, {
        artifact: artifact.trim(),
        buildCommand: buildCmd.trim() || undefined,
        cases: valid,
        hypothesisId: ctx.hypId,
      })
      void actions.getState(ctx.sessionId) // 刷新 ledger，供第④步读取 findings/证据
      const s = ev.verification
      setStats({
        evId: ev.id,
        passed: s?.passed ?? 0,
        total: s?.total ?? valid.length,
        build: s?.build ?? true,
        sha256: ev.sha256,
      })
      sceneActions.setFocus({ kind: 'zone', zone: 'AUD' })
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(goReview, AUTO_ADVANCE_MS)
    } catch (err) {
      setBanner({ tone: 'err', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  if (!ctx || ctx.stage !== 'verification') return null

  return (
    <WizardCard
      title="验证 · 产物重放"
      step={3}
      why="确定性重放为目标产物计算真实 SHA256 并逐条比对 stdout，签发唯一可解锁审计门禁的 verification_result 凭证。"
      sessionId={ctx.sessionId}
      onClose={sceneActions.closeWizard}
    >
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        调用内置 <code style={{ color: 'var(--accent)' }}>verify_artifact</code> 执行确定性重放 · 关联假设{' '}
        <strong style={{ color: 'var(--text)' }}>{hypLabel}</strong>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={wizLabelStyle}>
          <span style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>工作区产物文件（Artifact）</span>
            <span style={{ color: artifact.trim() ? 'var(--ok)' : 'var(--faint)', fontSize: 10 }}>
              {artifact.trim() ? '✓' : '必填'}
            </span>
          </span>
          <input
            aria-label="verify artifact path"
            style={wizFieldStyle}
            value={artifact}
            onChange={(e) => setArtifact(e.target.value)}
            placeholder="例如：chall.js 或 solver.py"
          />
        </label>
        <label style={wizLabelStyle}>
          可选前置编译命令（Build）
          <input
            aria-label="verify build command"
            style={wizFieldStyle}
            value={buildCmd}
            onChange={(e) => setBuildCmd(e.target.value)}
            placeholder="留空则直接重放（例如 gcc solve.c -o solve）"
          />
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
            重放测试向量（Replay Cases · {validCaseCount}/{cases.length} 有效）
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setCases((cs) => [...cs, { name: `case-${cs.length + 1}`, command: '', expected: '' }])}
            style={addRowBtnStyle}
          >
            + 添加用例行
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '130px 1fr 180px 28px',
            gap: 6,
            fontSize: 9.5,
            color: 'var(--faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            padding: '0 2px',
          }}
        >
          <span>Case Name</span>
          <span>Command</span>
          <span>Expected stdout</span>
          <span />
        </div>

        {cases.map((c, idx) => (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 180px 28px', gap: 6, alignItems: 'center' }}>
            <input
              style={wizFieldStyle}
              value={c.name}
              onChange={(e) => updateCase(idx, { name: e.target.value })}
              placeholder="case 名称"
              aria-label={`case ${idx + 1} name`}
            />
            <input
              style={wizFieldStyle}
              value={c.command}
              onChange={(e) => updateCase(idx, { command: e.target.value })}
              placeholder="实跑命令，如 node chall.js '0xaf{warmup_deck}'"
              aria-label={`case ${idx + 1} command`}
            />
            <input
              style={wizFieldStyle}
              value={c.expected}
              onChange={(e) => updateCase(idx, { expected: e.target.value })}
              placeholder="预期 stdout"
              aria-label={`case ${idx + 1} expected`}
            />
            <button
              type="button"
              disabled={busy || cases.length === 1}
              onClick={() => setCases((cs) => cs.filter((_, i) => i !== idx))}
              style={addRowBtnStyle}
              title="移除该行"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {banner && <WizBanner tone={banner.tone} text={banner.text} />}

      {stats && (
        <div style={statsBoxStyle}>
          <div style={{ display: 'flex', gap: 10, fontSize: 11, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <b style={{ color: stats.passed === stats.total ? 'var(--ok)' : 'var(--warn)' }}>
              重放通过 {stats.passed}/{stats.total}
            </b>
            <span style={{ color: stats.build ? 'var(--ok)' : 'var(--err)' }}>{stats.build ? 'build ✓' : 'build ✗'}</span>
            <span style={{ color: 'var(--faint)' }}>
              {stats.evId}
              {stats.sha256 ? ` · sha256:${stats.sha256.slice(0, 12)}…` : ''}
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 10 }}>
              1.5s 后自动进入审计，或直接点击继续
            </span>
          </div>
          <div style={{ height: 8, display: 'flex', border: '1px solid var(--rule)' }}>
            <div style={{ flex: stats.passed, background: 'var(--ok)', boxShadow: '0 0 8px var(--ok)' }} />
            <div style={{ flex: stats.total - stats.passed, background: 'var(--err)' }} />
          </div>
        </div>
      )}

      <div style={wizFooterStyle}>
        {stats ? (
          <WizBtn type="button" tone="accent" onClick={goReview}>
            ▸ 进入审计 →
          </WizBtn>
        ) : (
          <WizBtn type="button" tone="accent" disabled={busy} onClick={() => void run()}>
            {busy ? (
              <>
                <Spinner /> 重放执行中…
              </>
            ) : (
              '▶ 实跑 verify_artifact 签发验证凭证'
            )}
          </WizBtn>
        )}
      </div>
    </WizardCard>
  )
}

const addRowBtnStyle: CSSProperties = {
  border: '1px solid var(--accent-dim)',
  background: 'rgba(34, 211, 238, 0.08)',
  color: 'var(--accent)',
  fontSize: 10,
  padding: '1px 7px',
  cursor: 'pointer',
  font: 'inherit',
}

const statsBoxStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  padding: '7px 9px',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  background: 'rgba(5, 10, 16, 0.7)',
}
