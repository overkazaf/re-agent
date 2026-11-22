// ReviewWizard — step ④ (review): clean 3-mode audit & sign-off wizard with
// concise labels and contextual `data-hint` guidance.
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

const MODES: { key: ReviewMode; glyph: string; label: string; short: string; hint: string }[] = [
  {
    key: 'operator_audit',
    glyph: '✍',
    label: '操作员审查',
    short: '证据签章',
    hint: '引用账本实测证据签发不可篡改 audit_finding',
  },
  {
    key: 'arbitrate',
    glyph: '⚡',
    label: '宿主仲裁',
    short: '四规则巡检',
    hint: '确定性四规则：悬空引用 / 报错支撑 / 动静矛盾 / 单视角盲区',
  },
  {
    key: 'model_audit',
    glyph: '◍',
    label: '模型审计',
    short: '隔离对抗 (/audit)',
    hint: '独立第三席位零上下文对抗审计，独立审查所有假设与证据',
  },
]

const VERDICTS: { key: Verdict; label: string; tone: 'ok' | 'warn' | 'err'; hint: string }[] = [
  { key: 'support', label: 'SUPPORT 核准支撑', tone: 'ok', hint: '确认实测证据充分支撑当前结论' },
  { key: 'challenge', label: 'CHALLENGE 反证降权', tone: 'warn', hint: '存在疑点或反例，降低置信度并待复核' },
  { key: 'reject', label: 'REJECT 否决淘汰', tone: 'err', hint: '证据证伪原假设，正式淘汰该分支' },
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
        setBanner({ tone: 'err', text: '请至少引用 1 条账本中的 ev_NNN 实跑证据' })
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
      void actions.getState(ctx.sessionId)
      setFindings(res.findings ?? [])
      setRecordId(res.auditRecord?.id ?? '')
      setBanner({
        tone: res.auditRecord ? 'ok' : 'info',
        text:
          mode === 'arbitrate'
            ? `宿主仲裁完成：检出 ${res.findings.length} 条判定`
            : mode === 'model_audit'
              ? `隔离对抗审计完成${res.auditRecord ? ` · ${res.auditRecord.id}` : ''}`
              : `审查结论已写入只读账本${res.auditRecord ? ` ${res.auditRecord.id}` : ''}`,
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
      {/* 3 clean mode cards */}
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
              data-hint={m.hint}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: on ? 'var(--violet)' : 'var(--muted)', fontSize: 12 }}>{m.glyph}</span>
                <span style={{ color: on ? 'var(--violet)' : 'var(--text)', fontWeight: 600, fontSize: 11.5 }}>{m.label}</span>
              </span>
              <span style={{ color: 'var(--faint)', fontSize: 10 }}>{m.short}</span>
            </button>
          )
        })}
      </div>

      {mode === 'operator_audit' ? (
        <>
          <div style={wizLabelStyle}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span>实测证据</span>
              <span className="usa-hint-dot" data-hint="必选 ≥1 条账本中已实跑入账的 ev_NNN，无证据不可签发审查">
                ?
              </span>
              <span style={{ marginLeft: 'auto', color: evReady ? 'var(--ok)' : 'var(--warn)', fontSize: 10 }}>
                {evReady ? `✓ 已选 ${cited.length}` : '必选 ≥1'}
              </span>
            </span>
            {recentEvidence.length === 0 ? (
              <div style={{ color: 'var(--err)', fontSize: 10.5 }}>✗ 账本暂无实跑证据</div>
            ) : (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
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
                      data-hint={`${ev.source}: ${ev.summary || ev.excerpt}`}
                      style={chipToneStyle(on, 'ok')}
                    >
                      {on ? '✓ ' : ''}
                      {ev.id}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div style={wizLabelStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span>审查裁定</span>
              <span className="usa-hint-dot" data-hint="追加写入只读账本后不可篡改">
                ?
              </span>
            </span>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {VERDICTS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  disabled={busy}
                  onClick={() => setVerdict(v.key)}
                  style={chipToneStyle(verdict === v.key, v.tone)}
                  data-hint={v.hint}
                >
                  <span>{verdict === v.key ? '●' : '○'}</span>
                  <span>{v.label}</span>
                </button>
              ))}
            </div>
          </div>

          <label style={wizLabelStyle}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span>审查摘要</span>
              <span style={{ marginLeft: 'auto', color: summaryReady ? 'var(--ok)' : 'var(--warn)', fontSize: 10 }}>
                {summaryReady ? '✓' : '必填'}
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
              placeholder="例：静态解码与动态重放记录核对一致，结论闭环"
            />
          </label>
        </>
      ) : (
        <label style={wizLabelStyle}>
          <span>备注（可选）</span>
          <input
            aria-label="review summary optional"
            style={wizFieldStyle}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="例：例行巡检"
          />
        </label>
      )}

      {banner && <WizBanner tone={banner.tone} text={banner.text} />}

      {findings !== null && findings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--violet)', fontWeight: 600 }}>
            发现 ({findings.length}){recordId ? ` · ${recordId}` : ''}
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
            {evReady ? '✓' : '○'} 证据 · ✓ 裁定 · {summaryReady ? '✓' : '○'} 摘要
          </span>
        )}
        {findings === null ? (
          <WizBtn type="button" tone="accent" disabled={busy} onClick={() => void submit()}>
            {busy ? (
              <>
                <Spinner /> 审查中…
              </>
            ) : (
              '▶ 提交审查'
            )}
          </WizBtn>
        ) : (
          <>
            <WizBtn type="button" onClick={() => setFindings(null)}>
              重跑
            </WizBtn>
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
  background: 'var(--surface-1, transparent)',
  padding: '4px 8px',
  fontSize: 11,
  lineHeight: 1.5,
}
