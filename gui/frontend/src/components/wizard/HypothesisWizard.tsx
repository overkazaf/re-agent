// 向导第①步（stage: hypothesis | revise）——建立 / 修正可证伪假设。
// - claim + 可证伪预测双必填；挂靠证据仅限账本中已实跑入账的 ev_NNN（最近 12 条）
// - revise 变体：预填原 claim，顶部红条回显失败实验的反证证据摘要
// - 提交成功 → 直接推进第②步（实验配置）并聚焦 EXP 区
// - [稍后再配实验] → 仅落账假设，关闭向导（不推进）
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

  // revise 或从第②步回退导航时：把原假设声明带回编辑器（hyp.id 稳定，仅切换假设时重置）
  const prefillId = hyp?.id
  useEffect(() => {
    if (!prefillId || !hyp) return
    setClaim(hyp.claim)
    setPrediction(hyp.note?.startsWith(PREDICTION_PREFIX) ? hyp.note.slice(PREDICTION_PREFIX.length) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillId])

  // stage=hypothesis 但 ctx 已带 hypId（第②步回退）：按修订语义保存，避免重复建卡
  const isRevise = ctx?.stage === 'revise' || (ctx?.stage === 'hypothesis' && Boolean(hypId))

  async function persist(): Promise<string | null> {
    if (!ctx) return null
    if (!claim.trim() || !prediction.trim()) {
      setBanner({ tone: 'err', text: '「假设声明」与「可证伪预测」均为必填——预测必须写成能被实验推翻的形式' })
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
      void actions.getState(ctx.sessionId) // 刷新 runtime ledger，供第②步读取
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
      sessionId={ctx.sessionId}
      onClose={sceneActions.closeWizard}
    >
      {isRevise && failedEv && (
        <div
          style={{
            border: '1px solid var(--err)',
            background: 'rgba(60, 8, 12, 0.45)',
            padding: '6px 9px',
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          <span style={{ color: 'var(--err)' }}>
            ✗ 实验反证 {failedEv.id}（{failedExp ? failedExp.title : failedEv.source}）——请修正假设或收窄断言
          </span>
          <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', fontSize: 10.5 }}>
            {failedExp?.actual || failedEv.summary || failedEv.excerpt}
          </span>
        </div>
      )}

      <label style={wizLabelStyle}>
        假设声明（Falsifiable Claim · 必填）
        <textarea
          aria-label="hypothesis claim"
          style={wizAreaStyle}
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder="例如：carrier.bin 偏移 0x00..0x0f 为未加密明文引导头 / sub_8f4c 使用 HMAC-SHA256"
        />
      </label>

      <label style={wizLabelStyle}>
        可证伪预测（必填 · 写下能被实验推翻的预测）
        <textarea
          aria-label="falsifiable prediction"
          style={wizAreaStyle}
          value={prediction}
          onChange={(e) => setPrediction(e.target.value)}
          placeholder="写下能被实验推翻的预测，例：解密后前 4 字节应为 magic 'MZPK'"
        />
      </label>

      <div style={wizLabelStyle}>
        <span>挂靠证据（可选 · 仅限账本中已实跑入账的 ev_NNN）</span>
        {recentEvidence.length === 0 ? (
          <div style={{ color: 'var(--faint)', fontSize: 10.5 }}>
            ○ 账本暂无证据——可留空，第②步实验实跑后会自动铸造并回连
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
            {recentEvidence.map((ev) => {
              const on = cited.includes(ev.id)
              return (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => setCited(toggleIn(cited, ev.id))}
                  title={`${ev.source}: ${ev.summary || ev.excerpt}`}
                  style={chipToneStyle(on, ev.isError ? 'err' : 'ok')}
                >
                  {on ? '✓ ' : ''}{ev.id} ({ev.source})
                </button>
              )
            })}
          </div>
        )}
      </div>

      {banner && <WizBanner tone={banner.tone} text={banner.text} />}

      <div style={wizFooterStyle}>
        <span style={{ marginRight: 'auto', color: 'var(--faint)', fontSize: 10 }}>
          {isRevise ? `修订 ${hypId ?? hyp?.id ?? ''}` : '新建 H-NNN'} · 初始置信度 50%
        </span>
        <WizBtn disabled={busy} onClick={() => void submitAndClose()}>
          稍后再配实验
        </WizBtn>
        <WizBtn tone="accent" disabled={busy} onClick={() => void submitAndAdvance()}>
          ✓ 提交假设 · 配置实验 →
        </WizBtn>
      </div>
    </WizardCard>
  )
}
