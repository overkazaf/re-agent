// HypothesisWizard — step ① (hypothesis | revise): clean falsifiable claim &
// prediction form with contextual `data-hint` guidance.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { sceneActions, useSceneStore } from '../../store/scene'
import { actions, errText, useSessionRuntime } from '../../store/sessions'
import {
  WizardCard,
  WizBanner,
  WizBtn,
  chipToneStyle,
  toggleIn,
  wizAreaStyle,
  wizFooterStyle,
  wizLabelStyle,
} from './WizardCard'

const PREDICTION_PREFIX = '可证伪预测：'

export function HypothesisWizard() {
  const { wizard: ctx } = useSceneStore()
  const rt = useSessionRuntime(ctx?.sessionId)
  const ledger = rt?.latestTick?.ledger
  const hypId = ctx?.hypId

  const hyp = useMemo(
    () => (hypId ? ledger?.hypotheses.find((h) => h.id === hypId) : undefined),
    [hypId, ledger],
  )
  const failedEv = useMemo(
    () => (ctx?.failureEvidenceId ? ledger?.evidence.find((e) => e.id === ctx.failureEvidenceId) : undefined),
    [ctx?.failureEvidenceId, ledger],
  )
  const failedExp = useMemo(
    () => hyp?.experiments?.find((e) => e.evidenceId === ctx?.failureEvidenceId && e.status === 'falsified'),
    [hyp, ctx?.failureEvidenceId],
  )
  const recentEvidence = useMemo(() => (ledger?.evidence ?? []).slice(-12), [ledger])

  const [claim, setClaim] = useState('')
  const [prediction, setPrediction] = useState('')
  const [cited, setCited] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null)

  const prefillId = hyp?.id
  const prefillClaim = ctx?.prefillClaim
  useEffect(() => {
    if (prefillId && hyp) {
      setClaim(hyp.claim)
      setPrediction(hyp.note?.startsWith(PREDICTION_PREFIX) ? hyp.note.slice(PREDICTION_PREFIX.length) : '')
      return
    }
    if (!prefillId && prefillClaim) {
      setClaim(prefillClaim)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillId, prefillClaim])

  const isRevise = ctx?.stage === 'revise' || (ctx?.stage === 'hypothesis' && Boolean(hypId))
  const claimReady = claim.trim().length > 0
  const predReady = prediction.trim().length > 0

  async function persist(): Promise<string | null> {
    if (!ctx) return null
    if (!claimReady || !predReady) {
      setBanner({ tone: 'err', text: '请同时填写「假设声明」与「可证伪预测」' })
      return null
    }
    setBusy(true)
    setBanner(null)
    try {
      const saved = await api.mutateHypothesis(ctx.sessionId, {
        action: isRevise ? 'revise' : 'create',
        id: isRevise ? (hypId ?? hyp?.id) : undefined,
        claim: claim.trim(),
        confidence: 0.5,
        evidenceIds: cited,
        note: `${PREDICTION_PREFIX}${prediction.trim()}`,
      })
      void actions.getState(ctx.sessionId)
      return saved.id
    } catch (err) {
      setBanner({ tone: 'err', text: errText(err) })
      return null
    } finally {
      setBusy(false)
    }
  }

  async function submitAndAdvance() {
    const id = await persist()
    if (!id || !ctx) return
    sceneActions.setFocus({ kind: 'zone', zone: 'EXP' })
    sceneActions.openWizard({ sessionId: ctx.sessionId, stage: 'experiment', hypId: id })
  }

  async function submitAndClose() {
    const id = await persist()
    if (!id) return
    sceneActions.closeWizard()
  }

  if (!ctx || (ctx.stage !== 'hypothesis' && ctx.stage !== 'revise')) return null

  return (
    <WizardCard
      title={isRevise ? `假设 · 修正 ${hypId ?? ''}` : '假设 · 建立'}
      step={1}
      why="先写下能被实验证伪的具体预测，避免分析陷入事后圆谎；账本会持续记录每条实测证据对假设的支撑与反证。"
      sessionId={ctx.sessionId}
      onClose={sceneActions.closeWizard}
    >
      {isRevise && failedEv && (
        <div
          style={{
            border: '1px solid var(--err)',
            borderRadius: 'var(--radius-xs, 2px)',
            background: 'var(--err-soft, color-mix(in srgb, var(--err) 10%, var(--bg)))',
            padding: '6px 9px',
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ color: 'var(--err)', fontWeight: 600 }}>
            ✗ 反证 {failedEv.id}（{failedExp ? failedExp.title : failedEv.source}）
          </span>
          <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', fontSize: 10.5 }}>
            {failedExp?.actual || failedEv.summary || failedEv.excerpt}
          </span>
        </div>
      )}

      <label style={wizLabelStyle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>假设声明</span>
          <span className="usa-hint-dot" data-hint="写下明确、可检验的逆向论断（必填）">
            ?
          </span>
          <span style={{ marginLeft: 'auto', color: claimReady ? 'var(--ok)' : 'var(--faint)', fontSize: 10 }}>
            {claimReady ? '✓' : '必填'}
          </span>
        </span>
        <textarea
          aria-label="hypothesis claim"
          style={wizAreaStyle}
          value={claim}
          onChange={(e) => {
            setClaim(e.target.value)
            if (banner) setBanner(null)
          }}
          placeholder="例：carrier.bin 0x00..0x0f 为明文引导头 / sub_8f4c 使用 HMAC-SHA256"
        />
      </label>

      <label style={wizLabelStyle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>可证伪预测</span>
          <span className="usa-hint-dot" data-hint="必须写成能被后续实验输出直接推翻的具体预期（必填）">
            ?
          </span>
          <span style={{ marginLeft: 'auto', color: predReady ? 'var(--ok)' : 'var(--warn)', fontSize: 10 }}>
            {predReady ? '✓' : '必填'}
          </span>
        </span>
        <textarea
          aria-label="falsifiable prediction"
          style={wizAreaStyle}
          value={prediction}
          onChange={(e) => {
            setPrediction(e.target.value)
            if (banner) setBanner(null)
          }}
          placeholder="例：解密后前 4 字节应为 magic 'MZPK'"
        />
      </label>

      <div style={wizLabelStyle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>关联证据</span>
          <span className="usa-hint-dot" data-hint="可选：仅限账本中已实跑入账的 ev_NNN；留空则在第②步实跑后自动回连">
            ?
          </span>
          {cited.length > 0 && (
            <span style={{ marginLeft: 'auto', color: 'var(--ok)', fontSize: 10 }}>已选 {cited.length}</span>
          )}
        </span>
        {recentEvidence.length === 0 ? (
          <div style={{ color: 'var(--faint)', fontSize: 10.5 }}>○ 暂无入账证据</div>
        ) : (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {recentEvidence.map((ev) => {
              const on = cited.includes(ev.id)
              return (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => setCited(toggleIn(cited, ev.id))}
                  data-hint={`${ev.source}: ${ev.summary || ev.excerpt}`}
                  style={chipToneStyle(on, ev.isError ? 'err' : 'ok')}
                >
                  {on ? '✓ ' : ''}
                  {ev.id}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {banner && <WizBanner tone={banner.tone} text={banner.text} />}

      <div style={wizFooterStyle}>
        <span
          style={{ marginRight: 'auto', color: 'var(--faint)', fontSize: 10 }}
          data-hint="新假设默认起始置信度 50%，后续由实验与仲裁动态校准"
        >
          {isRevise ? `修订 ${hypId ?? hyp?.id ?? ''}` : 'H-NNN'} · 50%
        </span>
        <WizBtn type="button" disabled={busy} onClick={() => void submitAndClose()} data-hint="仅保存假设并关闭向导">
          稍后再配实验
        </WizBtn>
        <WizBtn type="button" tone="accent" disabled={busy} onClick={() => void submitAndAdvance()}>
          ✓ 提交假设 · 配置实验 →
        </WizBtn>
      </div>
    </WizardCard>
  )
}
