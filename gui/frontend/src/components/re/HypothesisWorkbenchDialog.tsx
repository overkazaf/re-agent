// HypothesisWorkbenchDialog — forensic-grade scientific workbench for:
//   1) Creating & editing falsifiable Hypotheses (H-NNN) + designing & running
//      real falsification Experiments (exp_NN -> mints ev_NNN on execution)
//   2) Running real Artifact Replay Verifications (verify_artifact -> mints
//      verification_result ev_NNN with SHA256 & pass/total counts)
//   3) Triggering Host Arbitration & filing Evidence-Cited Audit Reviews
//      (append-only audit_finding ev_NNN).
//
// Enforces the core provenance invariant: Evidence (ev_NNN) can NEVER be
// edited, deleted, or hand-typed; only real execution or grounded audit mints it.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { api } from '../../lib/api'
import type {
  LedgerDTO,
  VerificationCaseDTO,
} from '../../lib/types'
import { Btn, Dialog, fieldStyle } from '../session/Dialog'
import { buildProvenanceChain, formatHypothesisCitation } from './forensics'
import { buildHypothesisArcs } from './cognitiveSynthesis'
import './re-pro.css'

export type WorkbenchTab = 'hypothesis' | 'verify' | 'review'

export function HypothesisWorkbenchDialog({
  sessionId,
  workspace = '',
  ledger,
  initialTab = 'hypothesis',
  initialHypId,
  onClose,
}: {
  sessionId: string
  workspace?: string
  ledger: LedgerDTO | null | undefined
  initialTab?: WorkbenchTab
  initialHypId?: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<WorkbenchTab>(initialTab)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null)

  const hypotheses = ledger?.hypotheses ?? []
  const evidence = ledger?.evidence ?? []
  const findings = ledger?.findings ?? []

  // --- Tab 1 state: Hypothesis Create / Edit + Experiments ---
  const [selectedHypId, setSelectedHypId] = useState<string>(initialHypId || '__new__')
  const [claim, setClaim] = useState('')
  const [confidencePct, setConfidencePct] = useState(75)
  const [note, setNote] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [citeEvIds, setCiteEvIds] = useState<string[]>([])

  const [expTitle, setExpTitle] = useState('')
  const [expCommand, setExpCommand] = useState('')
  const [expExpected, setExpExpected] = useState('')

  const selectedHyp = hypotheses.find((h) => h.id === selectedHypId) ?? null
  const [copiedCite, setCopiedCite] = useState(false)

  const selectedChain = useMemo(
    () => (selectedHyp ? buildProvenanceChain(selectedHyp, evidence, findings) : null),
    [selectedHyp, evidence, findings],
  )
  const selectedArc = useMemo(() => {
    if (!selectedHyp) return null
    return (
      buildHypothesisArcs(evidence, hypotheses, findings, ledger?.auditorProvider).find(
        (a) => a.id === selectedHyp.id,
      ) ?? null
    )
  }, [selectedHyp, evidence, hypotheses, findings, ledger?.auditorProvider])

  // Live confidence calibration preview as the analyst adjusts the slider
  const liveCalibrationHint = useMemo(() => {
    const citedEvs = evidence.filter((e) => citeEvIds.includes(e.id))
    const hasDyn =
      (selectedChain ? selectedChain.dynamicEvs.length + selectedChain.verifyEvs.length > 0 : false) ||
      citedEvs.some((e) => e.view === 'dynamic' || e.kind === 'runtime_trace' || e.kind === 'verification_result')
    if (confidencePct >= 80 && !hasDyn) {
      return { tone: 'warn' as const, text: '⚠ ≥80% 且无动态/重放实证 → 触发 single-view 过自信风险' }
    }
    if (selectedChain && selectedChain.contradictEvs.length > 0 && confidencePct >= 45) {
      return { tone: 'err' as const, text: `⚠ 存在 ${selectedChain.contradictEvs.length} 条反证，建议先验证或下调置信度` }
    }
    if (hasDyn) {
      return { tone: 'ok' as const, text: '✓ 已含动态/重放凭证支撑，置信度校准良好' }
    }
    return { tone: 'muted' as const, text: '○ 探索期假设建议初始置信度 ≤75%，并配置可证伪实验' }
  }, [confidencePct, evidence, citeEvIds, selectedChain])

  useEffect(() => {
    if (selectedHypId === '__new__') {
      setClaim('')
      setConfidencePct(75)
      setNote('')
      setDependsOn([])
      setCiteEvIds([])
    } else if (selectedHyp) {
      setClaim(selectedHyp.claim)
      setConfidencePct(Math.round(selectedHyp.confidence * 100))
      setNote(selectedHyp.note ?? '')
      setDependsOn(selectedHyp.dependsOn ?? [])
      setCiteEvIds([])
    }
  }, [selectedHypId, selectedHyp?.id])

  // --- Tab 2 state: Verify Artifact Replay ---
  const isWelcome = workspace.includes('welcome')
  const [verArtifact, setVerArtifact] = useState(isWelcome ? 'chall.js' : 'artifact.txt')
  const [verBuildCmd, setVerBuildCmd] = useState('')
  const [verHypId, setVerHypId] = useState(hypotheses[0]?.id ?? '')
  const [verCases, setVerCases] = useState<VerificationCaseDTO[]>(
    isWelcome
      ? [
          { name: 'positive-token', command: "node chall.js '0xaf{warmup_deck}'", expected: 'accepted' },
          { name: 'negative-token', command: "node chall.js 'wrong_token'", expected: 'rejected' },
        ]
      : [
          {
            name: 'base64-decode-flag',
            command: 'base64 -d artifact.txt',
            expected: 'flag{demo_reverse_lab_flag}',
          },
        ],
  )

  // --- Tab 3 state: Arbitration & Review ---
  const [revHypId, setRevHypId] = useState(hypotheses[0]?.id ?? '')
  const [revVerdict, setRevVerdict] = useState<'support' | 'challenge' | 'reject' | ''>('support')
  const [revSummary, setRevSummary] = useState('')
  const [revCited, setRevCited] = useState<string[]>(
    evidence.length > 0 ? [evidence[evidence.length - 1].id] : [],
  )

  function toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  }

  function applyHypothesisPreset(kind: 'positive' | 'decoy') {
    if (kind === 'positive') {
      if (isWelcome) {
        setClaim('chall.js 对输入参数执行 0x2a 单字节异或比对，输入错误口令必定输出 rejected')
        setConfidencePct(85)
        setExpTitle('反例拒绝分支实跑验证')
        setExpCommand("node chall.js 'invalid_probe'")
        setExpExpected('rejected')
      } else {
        setClaim('carrier.bin 偏移 0x00..0x0f 存放明文前缀 carrier-prefix，属于未加密引导头')
        setConfidencePct(82)
        setExpTitle('提取头部可打印字符串验证明文前缀')
        setExpCommand('strings carrier.bin')
        setExpExpected('carrier-prefix')
      }
    } else {
      setClaim('carrier.bin 尾部包含完整可解压的 GZIP 归档流')
      setConfidencePct(70)
      setExpTitle('实跑 gzip 完整性测试（预期被动态反证折半降权）')
      setExpCommand('gzip -t carrier.bin')
      setExpExpected('OK')
    }
  }

  async function handleCreateHypothesis(runExpNow: boolean) {
    if (!claim.trim()) {
      setBanner({ tone: 'err', text: '请填写可证伪假设声明（Claim）' })
      return
    }
    if (runExpNow && !expCommand.trim()) {
      setBanner({ tone: 'err', text: '选择「创建并立即实跑实验」时请填写实跑命令' })
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const created = await api.mutateHypothesis(sessionId, {
        action: 'create',
        claim: claim.trim(),
        confidence: confidencePct / 100,
        dependsOn,
        evidenceIds: citeEvIds,
        note: note.trim(),
        expTitle: !runExpNow && expCommand.trim() ? expTitle.trim() : undefined,
        expCommand: !runExpNow && expCommand.trim() ? expCommand.trim() : undefined,
        expExpected: !runExpNow && expCommand.trim() ? expExpected.trim() : undefined,
      })
      if (runExpNow && expCommand.trim()) {
        const ev = await api.runHypothesisExperiment(sessionId, {
          hypothesisId: created.id,
          title: expTitle.trim() || expCommand.trim(),
          command: expCommand.trim(),
          expected: expExpected.trim(),
        })
        setBanner({
          tone: 'ok',
          text: `已创建假设 ${created.id} 并完成实跑实验，宿主自动签发不可篡改证据 ${ev.id}！`,
        })
      } else {
        setBanner({
          tone: 'ok',
          text: `已创建假设 ${created.id}（初始置信度 ${Math.round(created.confidence * 100)}%）`,
        })
      }
      setExpTitle('')
      setExpCommand('')
      setExpExpected('')
      setSelectedHypId(created.id)
    } catch (err) {
      setBanner({ tone: 'err', text: String((err as Error)?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleUpdateHypothesis(action: 'revise' | 'reject' | 'support' | 'challenge') {
    if (!selectedHyp) return
    if ((action === 'support' || action === 'challenge') && citeEvIds.length === 0) {
      setBanner({ tone: 'err', text: '请先在下方勾选至少一条已实跑入账的 ev_NNN 证据标签' })
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const updated = await api.mutateHypothesis(sessionId, {
        action,
        id: selectedHyp.id,
        claim: claim.trim(),
        confidence: confidencePct / 100,
        dependsOn,
        evidenceIds: citeEvIds,
        note: note.trim(),
      })
      setCiteEvIds([])
      setBanner({
        tone: 'ok',
        text: `已更新 ${updated.id} → 状态 [${updated.status}] · 置信度 ${Math.round(updated.confidence * 100)}%`,
      })
    } catch (err) {
      setBanner({ tone: 'err', text: String((err as Error)?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleAddOrRunExperiment(runNow: boolean, existingExpId?: string) {
    if (!selectedHyp) return
    if (!existingExpId && !expCommand.trim()) {
      setBanner({ tone: 'err', text: '请填写实验待执行的真实命令或工具参数' })
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      if (!runNow) {
        await api.mutateHypothesis(sessionId, {
          action: 'add_experiment',
          id: selectedHyp.id,
          expTitle: expTitle.trim() || expCommand.trim(),
          expCommand: expCommand.trim(),
          expExpected: expExpected.trim(),
        })
        setBanner({ tone: 'ok', text: `已为 ${selectedHyp.id} 添加待执行实验计划（实跑前不产生伪造证据）` })
      } else {
        const ev = await api.runHypothesisExperiment(sessionId, {
          hypothesisId: selectedHyp.id,
          experimentId: existingExpId,
          title: existingExpId ? undefined : expTitle.trim() || expCommand.trim(),
          command: existingExpId ? undefined : expCommand.trim(),
          expected: existingExpId ? undefined : expExpected.trim(),
        })
        setBanner({
          tone: ev.isError ? 'info' : 'ok',
          text: `实验已由宿主实跑完毕 → 自动盖章入账 ${ev.id}，并按实测输出更新了 ${selectedHyp.id} 的置信度与证据连线！`,
        })
      }
      if (!existingExpId) {
        setExpTitle('')
        setExpCommand('')
        setExpExpected('')
      }
    } catch (err) {
      setBanner({ tone: 'err', text: String((err as Error)?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleRunVerification() {
    const validCases = verCases.filter((c) => c.command.trim() !== '')
    if (!verArtifact.trim() || validCases.length === 0) {
      setBanner({ tone: 'err', text: '请指定工作区目标产物路径与至少一条实跑重放用例' })
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const ev = await api.runVerification(sessionId, {
        artifact: verArtifact.trim(),
        buildCommand: verBuildCmd.trim(),
        cases: validCases,
        hypothesisId: verHypId || undefined,
      })
      const stats = ev.verification
      setBanner({
        tone: ev.isError ? 'err' : 'ok',
        text: `verify_artifact 实跑完成 → 签发不可篡改证据 ${ev.id}（通过 ${stats?.passed ?? 0}/${stats?.total ?? validCases.length}${ev.sha256 ? ` · sha256:${ev.sha256.slice(0, 12)}…` : ''}）`,
      })
    } catch (err) {
      setBanner({ tone: 'err', text: String((err as Error)?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmitReview(mode: 'arbitrate' | 'operator_audit' | 'model_audit') {
    if (mode === 'operator_audit') {
      if (evidence.length === 0 || revCited.length === 0) {
        setBanner({ tone: 'err', text: '审查结论必须引用账本中至少一条真实存在的 ev_NNN 实跑证据' })
        return
      }
      if (!revSummary.trim()) {
        setBanner({ tone: 'err', text: '请填写审查结论摘要' })
        return
      }
    }
    setBusy(true)
    setBanner(null)
    try {
      const res = await api.submitReview(sessionId, {
        mode,
        summary: revSummary.trim(),
        hypothesisId: revHypId || undefined,
        verdict: revVerdict,
        citedEvidence: revCited,
      })
      if (mode === 'arbitrate') {
        setBanner({
          tone: 'info',
          text: `宿主确定性四规则仲裁巡检完成：共检出 ${res.findings.length} 条规则判定`,
        })
      } else if (mode === 'model_audit') {
        setBanner({
          tone: 'ok',
          text: `独立第三席位模型隔离对抗审计 (/audit) 已完成${res.auditRecord ? ` · 签章 ${res.auditRecord.id}` : ''}`,
        })
      } else {
        setRevSummary('')
        setBanner({
          tone: 'ok',
          text: `审查结论已追加写入只读账本 ${res.auditRecord?.id ?? ''} (audit_finding)`,
        })
      }
    } catch (err) {
      setBanner({ tone: 'err', text: String((err as Error)?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="scientific re workbench — 假设演进 · 实验取证 · 重放验证 · 审查签章"
      accent="accent"
      width={900}
      onClose={onClose}
    >
      {/* Forensic Invariant Notice */}
      <div style={invariantBarStyle}>
        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>⚖ 科学逆向取证铁律：</span>
        <span>
          <b>假设 (H-NNN) 与实验方案</b>允许自由新增、修订与推演；
          <b style={{ color: 'var(--ok)' }}> 证据账本 (ev_NNN) 严禁人工修改或凭空手填</b>
          ——任何证据、实验结果与验证记录必须由宿主<b>真实执行命令/重放产物</b>后自动哈希盖章入账。
        </span>
      </div>

      {/* Mode Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setTab('hypothesis')} style={wbTabStyle(tab === 'hypothesis', 'accent')}>
          ◈ 新增 / 编辑假设与实验 (H:{hypotheses.length})
        </button>
        <button type="button" onClick={() => setTab('verify')} style={wbTabStyle(tab === 'verify', 'ok')}>
          ✓ 实跑产物重放验证 (verify_artifact)
        </button>
        <button type="button" onClick={() => setTab('review')} style={wbTabStyle(tab === 'review', 'violet')}>
          ⚖ 宿主仲裁与审查签章 (Findings:{findings.length})
        </button>
        <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 10.5 }}>
          🔒 当前账本实测证据 E:{evidence.length} (Append-Only)
        </span>
      </div>

      {banner && (
        <div
          style={{
            padding: '6px 10px',
            fontSize: 11.5,
            border: `1px solid var(--${banner.tone === 'err' ? 'err' : banner.tone === 'ok' ? 'ok' : 'accent'})`,
            color: `var(--${banner.tone === 'err' ? 'err' : banner.tone === 'ok' ? 'ok' : 'accent'})`,
            background: 'rgba(5, 10, 16, 0.8)',
          }}
        >
          {banner.tone === 'err' ? '✗ ' : '✓ '}
          {banner.text}
        </div>
      )}

      {/* ==================== TAB 1: HYPOTHESIS & EXPERIMENTS ==================== */}
      {tab === 'hypothesis' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '220px 1fr',
            gridTemplateRows: 'minmax(0, 1fr)',
            gap: 10,
            height: 'min(52vh, 430px)',
          }}
        >
          {/* Left selector list */}
          <div style={{ minHeight: 0, border: '1px solid var(--rule)', padding: 6, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button
              type="button"
              onClick={() => setSelectedHypId('__new__')}
              style={{
                ...hypItemBtnStyle,
                borderColor: selectedHypId === '__new__' ? 'var(--accent)' : 'var(--rule)',
                color: 'var(--accent)',
                fontWeight: 700,
              }}
            >
              + 新建可证伪假设
            </button>
            {hypotheses.map((h) => {
              const active = selectedHypId === h.id
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setSelectedHypId(h.id)}
                  style={{
                    ...hypItemBtnStyle,
                    borderColor: active ? 'var(--accent)' : 'var(--rule)',
                    background: active ? 'rgba(34, 211, 238, 0.1)' : 'rgba(5, 8, 12, 0.45)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
                    <b style={{ color: h.status === 'rejected' ? 'var(--err)' : 'var(--accent)' }}>{h.id}</b>
                    <span style={{ color: 'var(--muted)' }}>
                      {h.status} · {Math.round(h.confidence * 100)}%
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                    {h.claim}
                  </div>
                  {h.experiments && h.experiments.length > 0 && (
                    <div style={{ fontSize: 9.5, color: 'var(--ok)', textAlign: 'left' }}>
                      🧪 实验: {h.experiments.length} 项
                    </div>
                  )}
                </button>
              )
            })}
          </div>

          {/* Right editor + experiment lab */}
          <div style={{ minHeight: 0, border: '1px solid var(--rule)', padding: '8px 10px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 12 }}>
                {selectedHyp ? `编辑假设 ${selectedHyp.id} [${selectedHyp.status.toUpperCase()}]` : '新建可证伪假设 (H-NNN)'}
              </span>
              {selectedHyp && selectedChain && (
                <>
                  <span className="re-verdict-badge" data-verdict={selectedChain.verdict}>
                    {selectedChain.verdict === 'ANTI_ANALYSIS' ? 'ANTI-ANALYSIS' : selectedChain.verdict}
                  </span>
                  <button
                    type="button"
                    className="re-copy-chip"
                    data-copied={copiedCite ? '1' : undefined}
                    onClick={() => {
                      navigator.clipboard?.writeText(formatHypothesisCitation(selectedHyp)).catch(() => {})
                      setCopiedCite(true)
                      setTimeout(() => setCopiedCite(false), 1400)
                    }}
                    style={{ marginLeft: 'auto' }}
                  >
                    {copiedCite ? '✓ 已复制引用' : '⎘ 复制引用'}
                  </button>
                </>
              )}
              {!selectedHyp && (
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5 }}>
                  <button type="button" onClick={() => applyHypothesisPreset('positive')} style={miniPresetBtnStyle}>
                    ⚡ 填入正向实验示例
                  </button>
                  <button type="button" onClick={() => applyHypothesisPreset('decoy')} style={miniPresetBtnStyle}>
                    ⚡ 填入反证折半示例
                  </button>
                </span>
              )}
            </div>

            {selectedChain && (
              <div className="re-chain" style={{ fontSize: 10 }}>
                <span className="re-chain-step" data-hit={selectedChain.staticEvs.length > 0 ? 'static' : undefined}>
                  Static ({selectedChain.staticEvs.length})
                </span>
                <span className="re-chain-arrow">→</span>
                <span
                  className="re-chain-step"
                  data-hit={
                    selectedChain.contradictEvs.length > 0
                      ? 'conflict'
                      : selectedChain.dynamicEvs.length > 0
                        ? '1'
                        : undefined
                  }
                >
                  Dynamic ({selectedChain.dynamicEvs.length}{selectedChain.contradictEvs.length > 0 ? `/✗${selectedChain.contradictEvs.length}` : ''})
                </span>
                <span className="re-chain-arrow">→</span>
                <span className="re-chain-step" data-hit={selectedChain.verifyEvs.length > 0 ? '1' : undefined}>
                  Oracle ({selectedChain.verifyEvs.length})
                </span>
                <span className="re-chain-arrow">→</span>
                <span className="re-chain-step" data-hit={selectedChain.auditEvs.length > 0 ? 'audit' : undefined}>
                  Audit ({selectedChain.auditEvs.length})
                </span>
                <span className="re-calib-pill" data-tone={selectedChain.calibration.tone} title={selectedChain.calibration.reason}>
                  {selectedChain.calibration.status}
                </span>
              </div>
            )}

            {selectedArc && (
              <div
                className="re-causal-strip"
                data-tone={selectedArc.tone === 'err' ? 'err' : selectedArc.tone === 'ok' ? 'ok' : selectedArc.tone === 'warn' ? 'warn' : undefined}
              >
                <div className="re-causal-row">
                  <span className="re-causal-k">提出依据</span>
                  <span>{selectedArc.triggerClues}</span>
                </div>
                <div className="re-causal-row">
                  <span className="re-causal-k">检验结果</span>
                  <span>{selectedArc.testAndObservation}</span>
                </div>
                <div className="re-causal-row">
                  <span className="re-causal-k">当前定论</span>
                  <span>{selectedArc.deductionVerdict}</span>
                </div>
              </div>
            )}

            <label style={lblStyle}>
              假设声明 (Falsifiable Claim)
              <input
                aria-label="hypothesis claim"
                style={fieldStyle}
                value={claim}
                onChange={(e) => setClaim(e.target.value)}
                placeholder="例如：偏移 0x00..0x0f 为未加密明文引导头 / sub_8f4c 使用 HMAC-SHA256"
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8 }}>
              <label style={lblStyle}>
                <span className="re-mono-num">置信度 ({confidencePct}%)</span>
                <input
                  type="range"
                  min={5}
                  max={99}
                  value={confidencePct}
                  onChange={(e) => setConfidencePct(Number(e.target.value))}
                />
                <span
                  className="re-calib-pill"
                  data-tone={liveCalibrationHint.tone}
                  style={{ whiteSpace: 'normal', lineHeight: 1.35 }}
                >
                  {liveCalibrationHint.text}
                </span>
              </label>
              <label style={lblStyle}>
                推导依据 / 修订备注 (Note)
                <input
                  style={fieldStyle}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="记录推理前提、边界条件或修订原因"
                />
              </label>
            </div>

            {/* Parent Hypothesis Dependencies */}
            {hypotheses.length > 0 && (
              <div style={lblStyle}>
                <span>上游依赖假设 (dependsOn —— 父假设被淘汰时本假设自动级联重审)：</span>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 2 }}>
                  {hypotheses
                    .filter((h) => h.id !== selectedHyp?.id)
                    .map((h) => {
                      const on = dependsOn.includes(h.id)
                      return (
                        <button
                          key={h.id}
                          type="button"
                          onClick={() => setDependsOn(toggleIn(dependsOn, h.id))}
                          style={pillSelectStyle(on, 'violet')}
                        >
                          {on ? '✓ ' : ''}{h.id} ({Math.round(h.confidence * 100)}%)
                        </button>
                      )
                    })}
                </div>
              </div>
            )}

            {/* Cite ONLY existing immutable ev_NNN records */}
            <div style={lblStyle}>
              <span>引用账本中已有的实测证据 (仅允许勾选真实入账的 ev_NNN)：</span>
              {evidence.length === 0 ? (
                <div style={{ color: 'var(--faint)', fontSize: 10.5 }}>
                  ○ 当前账本尚无证据 —— 可在下方直接实跑一条实验命令自动采集并绑定 ev_001
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                  {evidence.slice(-12).map((ev) => {
                    const on = citeEvIds.includes(ev.id)
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => setCiteEvIds(toggleIn(citeEvIds, ev.id))}
                        title={`${ev.source}: ${ev.summary || ev.excerpt}`}
                        style={pillSelectStyle(on, ev.isError ? 'err' : 'ok')}
                      >
                        {on ? '✓ ' : ''}{ev.id} ({ev.source})
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {selectedHyp ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Btn tone="accent" disabled={busy} onClick={() => void handleUpdateHypothesis('revise')}>
                  ✎ 保存修订 (Revise)
                </Btn>
                <Btn
                  disabled={busy || citeEvIds.length === 0}
                  onClick={() => void handleUpdateHypothesis('support')}
                >
                  + 绑定勾选证据为支撑
                </Btn>
                <Btn
                  tone="err"
                  disabled={busy || citeEvIds.length === 0}
                  onClick={() => void handleUpdateHypothesis('challenge')}
                >
                  ⚡ 绑定勾选证据为反证 (置信度×0.5)
                </Btn>
                <Btn tone="err" disabled={busy} onClick={() => void handleUpdateHypothesis('reject')}>
                  ⊘ 标记证伪淘汰 (Reject)
                </Btn>
              </div>
            ) : null}

            {/* Experiments Section */}
            <div style={{ borderTop: '1px dashed var(--rule)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ color: 'var(--ok)', fontWeight: 700, fontSize: 11.5 }}>
                🧪 假设可证伪实验台 (Experiment Design & Live Execution)
              </div>

              {selectedHyp && selectedHyp.experiments && selectedHyp.experiments.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {selectedHyp.experiments.map((exp) => {
                    const tone =
                      exp.status === 'passed'
                        ? 'var(--ok)'
                        : exp.status === 'falsified' || exp.status === 'error'
                          ? 'var(--err)'
                          : 'var(--warn)'
                    return (
                      <div key={exp.id} style={expCardStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5 }}>
                          <b style={{ color: tone }}>{exp.id} [{exp.status.toUpperCase()}]</b>
                          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{exp.title}</span>
                          {exp.evidenceId && (
                            <span style={{ color: 'var(--ok)', border: '1px solid var(--ok)', padding: '0 4px', fontSize: 9.5 }}>
                              🔒 实测凭证 {exp.evidenceId}
                            </span>
                          )}
                          <span style={{ marginLeft: 'auto' }}>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleAddOrRunExperiment(true, exp.id)}
                              style={miniPresetBtnStyle}
                            >
                              ▶ {exp.evidenceId ? '重新实跑' : '立即实跑取证'}
                            </button>
                          </span>
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          命令: <code>{exp.command}</code>
                          {exp.expected ? ` · 预期包含: "${exp.expected}"` : ''}
                        </div>
                        {exp.actual && (
                          <div style={{ fontSize: 10, color: 'var(--faint)', whiteSpace: 'pre-wrap' }}>
                            实测输出: {exp.actual}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* New Experiment Inputs */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <label style={lblStyle}>
                  实验目的 / 标题
                  <input
                    aria-label="experiment title"
                    style={fieldStyle}
                    value={expTitle}
                    onChange={(e) => setExpTitle(e.target.value)}
                    placeholder="例如：提取可读字符串检验明文引导头"
                  />
                </label>
                <label style={lblStyle}>
                  预期输出关键字（命中则支撑，不符则反证折半）
                  <input
                    aria-label="experiment expected"
                    style={fieldStyle}
                    value={expExpected}
                    onChange={(e) => setExpExpected(e.target.value)}
                    placeholder="例如：carrier-prefix 或 accepted"
                  />
                </label>
              </div>
              <label style={lblStyle}>
                实跑命令 (由宿主真实执行并将原始输出盖章为不可篡改 ev_NNN)
                <input
                  aria-label="experiment command"
                  style={fieldStyle}
                  value={expCommand}
                  onChange={(e) => setExpCommand(e.target.value)}
                  placeholder="例如：strings carrier.bin 或 node chall.js '0xaf{warmup_deck}'"
                />
              </label>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {selectedHyp ? (
                  <>
                    <Btn disabled={busy} onClick={() => void handleAddOrRunExperiment(false)}>
                      + 仅保存实验计划 (planned)
                    </Btn>
                    <Btn tone="accent" disabled={busy} onClick={() => void handleAddOrRunExperiment(true)}>
                      ▶ 立即实跑实验并盖章入账 (Mint ev_NNN)
                    </Btn>
                  </>
                ) : (
                  <>
                    <Btn disabled={busy} onClick={() => void handleCreateHypothesis(false)}>
                      ✓ 创建假设{expCommand.trim() ? '（含实验计划）' : ''}
                    </Btn>
                    <Btn tone="accent" disabled={busy} onClick={() => void handleCreateHypothesis(true)}>
                      ▶ 创建假设并立即实跑实验入账
                    </Btn>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== TAB 2: VERIFY ARTIFACT REPLAY ==================== */}
      {tab === 'verify' && (
        <div style={{ maxHeight: 'min(52vh, 430px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            调用内置 <code>verify_artifact</code> 对目标脚本/求解器/样本执行确定性重放测试：宿主计算目标文件真实 <code>SHA256</code>，逐条比对实跑 <code>stdout</code> 与预期值，生成唯一可解锁审计门禁的 <code>verification_result</code> 证据记录。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 220px', gap: 8 }}>
            <label style={lblStyle}>
              工作区产物文件 (Artifact)
              <input
                aria-label="verify artifact path"
                style={fieldStyle}
                value={verArtifact}
                onChange={(e) => setVerArtifact(e.target.value)}
                placeholder="例如：chall.js 或 solver.py"
              />
            </label>
            <label style={lblStyle}>
              可选前置编译命令 (Build Command)
              <input
                style={fieldStyle}
                value={verBuildCmd}
                onChange={(e) => setVerBuildCmd(e.target.value)}
                placeholder="留空则直接重放用例（例如 gcc solve.c -o solve）"
              />
            </label>
            <label style={lblStyle}>
              验证结果自动关联假设
              <select style={fieldStyle} value={verHypId} onChange={(e) => setVerHypId(e.target.value)}>
                <option value="">（不自动关联假设）</option>
                {hypotheses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.id}: {h.claim.slice(0, 22)}…
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>重放测试向量 (Replay Cases)</span>
              <button
                type="button"
                onClick={() =>
                  setVerCases([...verCases, { name: `case-${verCases.length + 1}`, command: '', expected: '' }])
                }
                style={miniPresetBtnStyle}
              >
                + 添加用例行
              </button>
            </div>
            {verCases.map((c, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 200px 32px', gap: 6 }}>
                <input
                  style={fieldStyle}
                  value={c.name}
                  onChange={(e) =>
                    setVerCases(verCases.map((it, i) => (i === idx ? { ...it, name: e.target.value } : it)))
                  }
                  placeholder="case 名称"
                />
                <input
                  style={fieldStyle}
                  value={c.command}
                  onChange={(e) =>
                    setVerCases(verCases.map((it, i) => (i === idx ? { ...it, command: e.target.value } : it)))
                  }
                  placeholder="实跑命令，如 node chall.js '0xaf{warmup_deck}'"
                />
                <input
                  style={fieldStyle}
                  value={c.expected}
                  onChange={(e) =>
                    setVerCases(verCases.map((it, i) => (i === idx ? { ...it, expected: e.target.value } : it)))
                  }
                  placeholder="预期 stdout"
                />
                <button
                  type="button"
                  onClick={() => setVerCases(verCases.filter((_, i) => i !== idx))}
                  style={miniPresetBtnStyle}
                  title="移除该行"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Btn tone="accent" disabled={busy} onClick={() => void handleRunVerification()}>
              ▶ 实跑 verify_artifact 并签发不可篡改验证凭证
            </Btn>
          </div>
        </div>
      )}

      {/* ==================== TAB 3: ARBITRATION & REVIEW ==================== */}
      {tab === 'review' && (
        <div style={{ maxHeight: 'min(52vh, 430px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Automated Host Arbitrator + Isolated GLM Model Audit */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '6px 8px', border: '1px solid var(--rule)', background: 'rgba(5, 8, 12, 0.5)' }}>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>
              <b>自动化审查通道：</b>可随时运行宿主四规则确定性仲裁器（悬空引用 / 报错充当支撑 / 动静矛盾 / 单视角盲区），或唤醒独立第三席位模型执行零上下文对抗审计。
            </div>
            <Btn disabled={busy} onClick={() => void handleSubmitReview('arbitrate')}>
              ⚡ 运行宿主确定性仲裁
            </Btn>
            <Btn tone="accent" disabled={busy} onClick={() => void handleSubmitReview('model_audit')}>
              🤖 运行隔离模型审计 (/audit)
            </Btn>
          </div>

          {/* Evidence-Grounded Operator Audit Review */}
          <div style={{ border: '1px solid var(--rule)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ color: 'var(--violet)', fontWeight: 700, fontSize: 11.5 }}>
              ✍ 签发基于实测证据链的审查记录 (Append-Only Audit Finding)
            </div>

            <div style={lblStyle}>
              <span>1. 选择本次审查核验过的实测证据（必选 ≥1 条，无证据不可签发审查）：</span>
              {evidence.length === 0 ? (
                <div style={{ color: 'var(--err)', fontSize: 10.5 }}>
                  ✗ 当前账本为空 —— 请先通过工具分析、实验台或 verify_artifact 产生实跑证据后再签发审查。
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                  {evidence.slice(-12).map((ev) => {
                    const on = revCited.includes(ev.id)
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => setRevCited(toggleIn(revCited, ev.id))}
                        style={pillSelectStyle(on, 'ok')}
                      >
                        {on ? '✓ ' : ''}{ev.id} ({ev.kind || 'obs'})
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 8 }}>
              <label style={lblStyle}>
                2. 针对目标假设（可选）
                <select style={fieldStyle} value={revHypId} onChange={(e) => setRevHypId(e.target.value)}>
                  <option value="">（全局账本审查，不单独变更某条假设）</option>
                  {hypotheses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.id} [{h.status}] — {h.claim.slice(0, 36)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={lblStyle}>
                3. 审查裁定动作
                <select
                  style={fieldStyle}
                  value={revVerdict}
                  onChange={(e) => setRevVerdict(e.target.value as 'support' | 'challenge' | 'reject' | '')}
                >
                  <option value="support">SUPPORT (核准支撑)</option>
                  <option value="challenge">CHALLENGE (反证降权 ×0.5)</option>
                  <option value="reject">REJECT (直接否决淘汰)</option>
                  <option value="">仅登记审计备注</option>
                </select>
              </label>
            </div>

            <label style={lblStyle}>
              4. 审查结论摘要（追加写入 evidence-ledger.jsonl 后不可修改或删除）
              <input
                aria-label="review summary"
                style={fieldStyle}
                value={revSummary}
                onChange={(e) => setRevSummary(e.target.value)}
                placeholder="例如：经核对静态解码与动态重放记录，结论闭环且无未证实外推"
              />
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Btn
                tone="accent"
                disabled={busy || evidence.length === 0 || revCited.length === 0}
                onClick={() => void handleSubmitReview('operator_audit')}
              >
                ✓ 签发不可篡改审查记录 (audit_finding)
              </Btn>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn onClick={onClose}>close</Btn>
      </div>
    </Dialog>
  )
}

const invariantBarStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--rule))',
  background: 'rgba(6, 14, 24, 0.8)',
  padding: '6px 10px',
  fontSize: 11,
  lineHeight: 1.45,
  color: 'var(--muted)',
}

function wbTabStyle(active: boolean, tone: 'accent' | 'ok' | 'violet'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--rule)'}`,
    background: active ? `color-mix(in srgb, var(--${tone}) 14%, transparent)` : 'transparent',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 11,
    padding: '3px 10px',
    cursor: 'pointer',
  }
}

const hypItemBtnStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  padding: '5px 7px',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  cursor: 'pointer',
}

const lblStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  fontSize: 10.5,
  color: 'var(--muted)',
}

const miniPresetBtnStyle: CSSProperties = {
  border: '1px solid var(--accent-dim)',
  background: 'rgba(34, 211, 238, 0.08)',
  color: 'var(--accent)',
  fontSize: 10,
  padding: '1px 7px',
  cursor: 'pointer',
}

function pillSelectStyle(active: boolean, tone: 'ok' | 'err' | 'violet'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--rule)'}`,
    background: active ? `color-mix(in srgb, var(--${tone}) 16%, transparent)` : 'rgba(5, 8, 12, 0.6)',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 10,
    padding: '1px 6px',
    cursor: 'pointer',
  }
}

const expCardStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  background: 'rgba(3, 6, 10, 0.65)',
  padding: '5px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}
