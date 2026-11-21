// 向导第④步（stage: review）——审计签章。
// mode 三选：operator_audit（引用实测证据签发 audit_finding，主线推荐）/
// arbitrate（宿主确定性四规则仲裁）/ model_audit（独立第三席位模型审计）。
// operator_audit 需 verdict + citedEvidence(≥1) + summary，顶部给出实时就绪检查项；
// 提交 api.SubmitReview 后展示 findings 列表；[完成归档] → closeWizard + 全局聚焦。
import { useMemo, useState, type CSSProperties } from 'react'
import { api } from '../../lib/api'
import type { FindingDTO } from '../../lib/types'
import { sceneActions, useSceneStore } from '../../store/scene'
import { actions, errText, useSessionRuntime } from '../../store/sessions'
import { Spinner } from '../crt/Spinner'
import {
  WizardCard,
  WizBanner,
  WizBtn,
  chipToneStyle,
  toggleIn,
  wizFieldStyle,
  wizFooterStyle,
  wizLabelStyle,
  wizSelectCardStyle,
} from './WizardCard'

type ReviewMode = 'arbitrate' | 'operator_audit' | 'model_audit'
type Verdict = 'support' | 'challenge' | 'reject'

const MODES: { key: ReviewMode; glyph: string; label: string; desc: string }[] = [
  {
    key: 'operator_audit',
    glyph: '✍',
    label: '操作员审查',
    desc: '引用实测证据签发不可篡改 audit_finding',
  },
  {
    key: 'arbitrate',
    glyph: '⚡',
    label: '宿主仲裁',
    desc: '确定性四规则：悬空引用 / 报错支撑 / 动静矛盾 / 单视角盲区',
  },
  {
    key: 'model_audit',
    glyph: '◍',
    label: '模型审计',
    desc: '独立第三席位零上下文对抗审计 (/audit)',
  },
]

const VERDICTS: { key: Verdict; label: string; tone: 'ok' | 'warn' | 'err' }[] = [
  { key: 'support', label: 'SUPPORT 核准支撑', tone: 'ok' },
  { key: 'challenge', label: 'CHALLENGE 反证降权', tone: 'warn' },
  { key: 'reject', label: 'REJECT 否决淘汰', tone: 'err' },
]

export function ReviewWizard() {
  const { wizard: ctx } = useSceneStore()
  const rt = useSessionRuntime(ctx?.sessionId)
  const ledger = rt?.latestTick?.ledger
  const recentEvidence = useMemo(() => (ledger?.evidence ?? []).slice(-12), [ledger])

  const [mode, setMode] = useState<ReviewMode>('operator_audit')
  const [verdict, setVerdict] = useState<Verdict>('support')
  const [cited, setCited] = useState<string[]>([])
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [findings, setFindings] = useState<FindingDTO[] | null>(null)
  const [recordId, setRecordId] = useState('')

  const evReady = cited.length > 0
  const summaryReady = summary.trim().length > 0

  async function submit() {
    if (!ctx) return
    if (mode === 'operator_audit') {
      if (recentEvidence.length === 0 || cited.length === 0) {
        setBanner({ tone: 'err', text: '审查结论必须引用账本中至少一条真实存在的 ev_NNN 实跑证据' })
        return
      }
      if (!summary.trim()) {
        setBanner({ tone: 'err', text: '请填写审查结论摘要' })
        return
      }
    }
    setBusy(true)
    setBanner(null)
    try {
      const res = await api.submitReview(ctx.sessionId, {
        mode,
        summary: summary.trim() || undefined,
        hypothesisId: ctx.hypId,
        verdict: mode === 'operator_audit' ? verdict : undefined,
        citedEvidence: mode === 'operator_audit' ? cited : undefined,
      })
      void actions.getState(ctx.sessionId) // 刷新 findings / 证据入账
      setFindings(res.findings ?? [])
      setRecordId(res.auditRecord?.id ?? '')
      setBanner({
        tone: res.auditRecord ? 'ok' : 'info',
        text:
          mode === 'arbitrate'
            ? `宿主确定性仲裁巡检完成：共检出 ${res.findings.length} 条规则判定`
            : mode === 'model_audit'
              ? `独立第三席位模型隔离对抗审计完成${res.auditRecord ? ` · 签章 ${res.auditRecord.id}` : ''}`
              : `审查结论已追加写入只读账本${res.auditRecord ? ` ${res.auditRecord.id}` : ''} (audit_finding)`,
      })
    } catch (err) {
      setBanner({ tone: 'err', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  function finishArchive() {
    sceneActions.closeWizard()
    sceneActions.setFocus({ kind: 'global' })
  }

  if (!ctx || ctx.stage !== 'review') return null

  return (
    <WizardCard
      title="审计 · 审查签章"
      step={4}
      why="审计结论将追加写入只读账本且不可篡改：绑定真实 ev_NNN 证据或触发独立第三席位对抗审计，确保最终报告零幻觉。"
      sessionId={ctx.sessionId}
      onClose={sceneActions.closeWizard}
    >
      {/* mode 三选卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {MODES.map((m) => {
          const on = mode === m.key
          return (
            <button
              key={m.key}
              type="button"
              disabled={busy || findings !== null}
              onClick={() => {
                setMode(m.key)
                setBanner(null)
              }}
              style={wizSelectCardStyle(on, 'violet')}
            >
              <span style={{ color: on ? 'var(--violet)' : 'var(--muted)', fontSize: 13 }}>{m.glyph}</span>
              <span style={{ color: on ? 'var(--violet)' : 'var(--text)', fontWeight: 700, fontSize: 11.5 }}>{m.label}</span>
              <span style={{ color: 'var(--faint)', fontSize: 10, lineHeight: 1.4 }}>{m.desc}</span>
            </button>
          )
        })}
      </div>

      {mode === 'operator_audit' ? (
        <>
          <div style={wizLabelStyle}>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>1. 引用核验过的实测证据（必选 ≥1 条，无证据不可签发审查）</span>
              <span style={{ color: evReady ? 'var(--ok)' : 'var(--warn)', fontSize: 10 }}>
                {evReady ? `✓ 已选 ${cited.length} 条` : '请至少选择 1 条'}
              </span>
            </span>
            {recentEvidence.length === 0 ? (
              <div style={{ color: 'var(--err)', fontSize: 10.5 }}>
                ✗ 当前账本为空——请先回到实验/验证步骤产生实跑证据
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                {recentEvidence.map((ev) => {
                  const on = cited.includes(ev.id)
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setCited(toggleIn(cited, ev.id))
                        if (banner) setBanner(null)
                      }}
                      title={`${ev.source}: ${ev.summary || ev.excerpt}`}
                      style={chipToneStyle(on, 'ok')}
                    >
                      {on ? '✓ ' : ''}{ev.id} ({ev.kind || ev.source})
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div style={wizLabelStyle}>
            <span>2. 审查裁定（追加写入只读账本后不可修改）</span>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 2 }}>
              {VERDICTS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  disabled={busy}
                  onClick={() => setVerdict(v.key)}
                  style={chipToneStyle(verdict === v.key, v.tone)}
                >
                  {verdict === v.key ? '● ' : '○ '}{v.label}
                </button>
              ))}
            </div>
          </div>

          <label style={wizLabelStyle}>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>3. 审查结论摘要（必填）</span>
              <span style={{ color: summaryReady ? 'var(--ok)' : 'var(--warn)', fontSize: 10 }}>
                {summaryReady ? '✓ 已填写' : '待填写'}
              </span>
            </span>
            <input
              aria-label="review summary"
              style={wizFieldStyle}
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value)
                if (banner) setBanner(null)
              }}
              placeholder="例如：经核对静态解码与动态重放记录，结论闭环且无未证实外推"
            />
          </label>
        </>
      ) : (
        <label style={wizLabelStyle}>
          备注摘要（可选 · 留给审计记录的上下文）
          <input
            aria-label="review summary optional"
            style={wizFieldStyle}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="例如：触发一次例行巡检"
          />
        </label>
      )}

      {banner && <WizBanner tone={banner.tone} text={banner.text} />}

      {findings !== null && findings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--violet)', fontWeight: 700 }}>
            仲裁 / 审计发现（{findings.length}）{recordId ? ` · 签章 ${recordId}` : ''}
          </span>
          {findings.map((f, i) => (
            <div key={`${f.rule}-${i}`} style={findingStyle}>
              <b style={{ color: 'var(--violet)' }}>{f.rule}</b>
              {f.hypothesisId && <span style={{ color: 'var(--accent)' }}> {f.hypothesisId}</span>}
              {f.evidenceId && <span style={{ color: 'var(--ok)' }}> {f.evidenceId}</span>}
              <span style={{ color: 'var(--muted)' }}> — {f.message}</span>
              {f.applied && <span style={{ color: 'var(--ok)' }}> · 已应用</span>}
            </div>
          ))}
        </div>
      )}

      <div style={wizFooterStyle}>
        {mode === 'operator_audit' && findings === null && (
          <span style={{ marginRight: 'auto', fontSize: 10, color: evReady && summaryReady ? 'var(--ok)' : 'var(--faint)' }}>
            {evReady ? '✓ 证据' : '○ 证据'} · ✓ 裁定 · {summaryReady ? '✓ 摘要' : '○ 摘要'}
          </span>
        )}
        {findings === null ? (
          <WizBtn type="button" tone="accent" disabled={busy} onClick={() => void submit()}>
            {busy ? (
              <>
                <Spinner /> 审查执行中…
              </>
            ) : (
              '▶ 提交审查'
            )}
          </WizBtn>
        ) : (
          <>
            <WizBtn type="button" onClick={() => setFindings(null)}>重新运行</WizBtn>
            <WizBtn type="button" tone="ok" onClick={finishArchive}>
              ✓ 完成归档
            </WizBtn>
          </>
        )}
      </div>
    </WizardCard>
  )
}

const findingStyle: CSSProperties = {
  borderLeft: '2px solid var(--violet-dim)',
  background: 'rgba(5, 8, 12, 0.55)',
  padding: '4px 8px',
  fontSize: 11,
  lineHeight: 1.5,
}
