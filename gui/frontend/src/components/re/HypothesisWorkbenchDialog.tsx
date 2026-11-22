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
  EvidenceRecord,
  FindingDTO,
  Hypothesis,
  HypothesisMutationDTO,
  LedgerDTO,
  VerificationCaseDTO,
  VerificationStats,
} from '../../lib/types'
import { ProSelect, type ProSelectOption } from '../crt'
import { Btn, Dialog, fieldStyle } from '../session/Dialog'
import { buildProvenanceChain, formatHypothesisCitation } from './forensics'
import { buildHypothesisArcs } from './cognitiveSynthesis'
import './re-pro.css'
import './controlLoop.css'

export type WorkbenchTab = 'hypothesis' | 'verify' | 'review'

type StructuredHypothesis = Hypothesis & {
  scope?: string
  falsifiers?: string[]
  nextTest?: string
}

type StructuredHypothesisMutation = HypothesisMutationDTO & {
  scope?: string
  falsifiers?: string[]
  nextTest?: string
}

type ExtendedVerificationStats = VerificationStats & {
  status?: 'candidate' | 'verified' | string
  boundaryPassed?: number
  differentialCases?: number
  uncoveredPaths?: string[]
}

type AuditVerdict = 'accepted' | 'rejected' | 'needs_more_evidence'

interface AuditCheckRecord {
  id?: string
  key?: string
  label?: string
  pass?: boolean
  passed?: boolean
  detail?: string
}

type ExtendedLedger = LedgerDTO & {
  auditVerdict?: AuditVerdict | string
  auditChecks?: AuditCheckRecord[]
}

const REVIEW_VERDICT_OPTIONS: readonly ProSelectOption<'support' | 'challenge' | 'reject' | ''>[] = [
  { value: 'support', label: 'SUPPORT (核准支撑)', badge: 'OK', description: '以勾选实测证据核准支撑目标假设' },
  { value: 'challenge', label: 'CHALLENGE (反证降权 ×0.5)', badge: '×0.5', description: '记录反证并将假设置信度折半' },
  { value: 'reject', label: 'REJECT (直接否决淘汰)', badge: 'REJECT', description: '标记目标假设已证伪并触发下游级联重审' },
  { value: '', label: '仅登记审计备注', badge: 'NOTE', description: '追加 audit_finding 而不变更假设状态' },
]

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

  const extLedger = (ledger ?? null) as ExtendedLedger | null
  const hypotheses = (ledger?.hypotheses ?? []) as StructuredHypothesis[]
  const evidence = ledger?.evidence ?? []
  const findings = ledger?.findings ?? []

  // --- Tab 1 state: Hypothesis Create / Edit + Experiments ---
  const [selectedHypId, setSelectedHypId] = useState<string>(initialHypId || '__new__')
  const [claim, setClaim] = useState('')
  const [confidencePct, setConfidencePct] = useState(75)
  const [note, setNote] = useState('')
  const [scope, setScope] = useState('')
  const [falsifiersText, setFalsifiersText] = useState('')
  const [nextTest, setNextTest] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [citeEvIds, setCiteEvIds] = useState<string[]>([])

  const [expTitle, setExpTitle] = useState('')
  const [expCommand, setExpCommand] = useState('')
  const [expExpected, setExpExpected] = useState('')

  const selectedHyp = hypotheses.find((h) => h.id === selectedHypId) ?? null
  const [copiedCite, setCopiedCite] = useState(false)

  const verificationPosture = useMemo(() => evaluateVerificationPosture(evidence), [evidence])
  const auditReport = useMemo(
    () => evaluateAdversarialChecklist(extLedger, evidence, hypotheses, findings),
    [extLedger, evidence, hypotheses, findings],
  )

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
      setScope('')
      setFalsifiersText('')
      setNextTest('')
      setDependsOn([])
      setCiteEvIds([])
    } else if (selectedHyp) {
      setClaim(selectedHyp.claim)
      setConfidencePct(Math.round(selectedHyp.confidence * 100))
      setNote(selectedHyp.note ?? '')
      setScope(selectedHyp.scope ?? '')
      setFalsifiersText((selectedHyp.falsifiers ?? []).join('；'))
      setNextTest(selectedHyp.nextTest ?? '')
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

  const verifyHypOptions = useMemo<ProSelectOption[]>(
    () => [
      { value: '', label: '（不自动关联假设）', description: '仅入账为独立验证证据' },
      ...hypotheses.map((h) => ({
        value: h.id,
        label: `${h.id}: ${h.claim.slice(0, 22)}${h.claim.length > 22 ? '…' : ''}`,
        badge: `${Math.round(h.confidence * 100)}%`,
        description: h.claim,
        keywords: `${h.id} ${h.status} ${h.claim}`,
      })),
    ],
    [hypotheses],
  )

  const reviewHypOptions = useMemo<ProSelectOption[]>(
    () => [
      { value: '', label: '（全局账本审查，不单独变更某条假设）', description: '记录全局审计发现，不改写单条假设状态' },
      ...hypotheses.map((h) => ({
        value: h.id,
        label: `${h.id} [${h.status}] — ${h.claim.slice(0, 36)}`,
        badge: `${Math.round(h.confidence * 100)}%`,
        description: h.claim,
        keywords: `${h.id} ${h.status} ${h.claim}`,
      })),
    ],
    [hypotheses],
  )

  function toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  }

  function parseFalsifiers(raw: string): string[] | undefined {
    const list = raw
      .split(/[;；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    return list.length > 0 ? list : undefined
  }

  function applyHypothesisPreset(kind: 'positive' | 'decoy') {
    if (kind === 'positive') {
      if (isWelcome) {
        setClaim('chall.js 对输入参数执行 0x2a 单字节异或比对，输入错误口令必定输出 rejected')
        setConfidencePct(85)
        setScope('chall.js 入口校验分支')
        setFalsifiersText('错误口令返回 accepted 或校验逻辑依赖外部状态')
        setNextTest('以非法探针输入实跑 chall.js 验证拒绝分支')
        setExpTitle('反例拒绝分支实跑验证')
        setExpCommand("node chall.js 'invalid_probe'")
        setExpExpected('rejected')
      } else {
        setClaim('carrier.bin 偏移 0x00..0x0f 存放明文前缀 carrier-prefix，属于未加密引导头')
        setConfidencePct(82)
        setScope('carrier.bin 偏移 0x00..0x0f 引导头段')
        setFalsifiersText('前 16 字节呈高熵密文或不含可打印前缀')
        setNextTest('实跑 strings 提取头部明文并与偏移对照')
        setExpTitle('提取头部可打印字符串验证明文前缀')
        setExpCommand('strings carrier.bin')
        setExpExpected('carrier-prefix')
      }
    } else {
      setClaim('carrier.bin 尾部包含完整可解压的 GZIP 归档流')
      setConfidencePct(70)
      setScope('carrier.bin 尾部疑似 1f 8b 偏移区')
      setFalsifiersText('gzip -t 报错或仅是伪造魔术头诱饵')
      setNextTest('实跑 gzip -t 校验归档完整性并观察是否触发反证折半')
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
      const createReq: StructuredHypothesisMutation = {
        action: 'create',
        claim: claim.trim(),
        confidence: confidencePct / 100,
        dependsOn,
        evidenceIds: citeEvIds,
        note: note.trim(),
        scope: scope.trim() || undefined,
        falsifiers: parseFalsifiers(falsifiersText),
        nextTest: nextTest.trim() || undefined,
        expTitle: !runExpNow && expCommand.trim() ? expTitle.trim() : undefined,
        expCommand: !runExpNow && expCommand.trim() ? expCommand.trim() : undefined,
        expExpected: !runExpNow && expCommand.trim() ? expExpected.trim() : undefined,
      }
      const created = await api.mutateHypothesis(sessionId, createReq)
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
      const updateReq: StructuredHypothesisMutation = {
        action,
        id: selectedHyp.id,
        claim: claim.trim(),
        confidence: confidencePct / 100,
        dependsOn,
        evidenceIds: citeEvIds,
        note: note.trim(),
        scope: scope.trim() || undefined,
        falsifiers: parseFalsifiers(falsifiersText),
        nextTest: nextTest.trim() || undefined,
      }
      const updated = await api.mutateHypothesis(sessionId, updateReq)
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
      title="scientific re workbench"
      accent="accent"
      width={900}
      onClose={onClose}
    >
      {/* Compact Forensic Invariant Notice */}
      <div style={invariantBarStyle}>
        <span style={{ color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>⚖ 科学逆向取证铁律：</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          假设 (H-NNN) 可自由演进；<b style={{ color: 'var(--ok)' }}>证据 (ev_NNN) 仅由真实执行自动哈希入账</b>，禁止手改。
        </span>
        <span
          className="re-hint-dot"
          data-hint="任何证据、实验输出与 verify_artifact 重放记录均由宿主实跑命令后签发 SHA256 并追加写入 evidence-ledger.jsonl，确保结论零幻觉可复现"
        >
          ?
        </span>
      </div>

      {/* Mode Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          aria-label={`◈ 新增 / 编辑假设与实验 (H:${hypotheses.length})`}
          data-hint="创建或修订可证伪假设，并挂载/实跑验证实验"
          onClick={() => setTab('hypothesis')}
          style={wbTabStyle(tab === 'hypothesis', 'accent')}
        >
          ◈ 假设与实验 <span className="re-mono-num" style={{ opacity: 0.78 }}>{hypotheses.length}</span>
        </button>
        <button
          type="button"
          aria-label="✓ 实跑产物重放验证 (verify_artifact)"
          data-hint="执行 verify_artifact 对脚本或样本跑通重放测试向量，签发解锁审计门禁的验证凭证"
          onClick={() => setTab('verify')}
          style={wbTabStyle(tab === 'verify', 'ok')}
        >
          ✓ 产物重放
        </button>
        <button
          type="button"
          aria-label={`⚖ 宿主仲裁与审查签章 (Findings:${findings.length})`}
          data-hint="运行四规则确定性仲裁、独立第三席位对抗审计 (/audit) 或签发基于实测证据的人工审查"
          onClick={() => setTab('review')}
          style={wbTabStyle(tab === 'review', 'violet')}
        >
          ⚖ 仲裁与签章 <span className="re-mono-num" style={{ opacity: 0.78 }}>{findings.length}</span>
        </button>
        <span
          className="re-mono-num"
          style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 10.5 }}
          data-hint="当前会话已实跑入账的只追加证据总数"
        >
          🔒 E:{evidence.length} · Append-Only
        </span>
      </div>

      {banner && (
        <div
          style={{
            padding: '7px 10px',
            fontSize: 11.5,
            borderRadius: 'var(--radius-xs)',
            border: `1px solid var(--${banner.tone === 'err' ? 'err' : banner.tone === 'ok' ? 'ok' : 'accent'})`,
            color: `var(--${banner.tone === 'err' ? 'err' : banner.tone === 'ok' ? 'ok' : 'accent'})`,
            background: banner.tone === 'err' ? 'var(--err-soft)' : banner.tone === 'ok' ? 'var(--ok-soft)' : 'var(--accent-soft)',
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
          <div style={{ minHeight: 0, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 6, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
            <button
              type="button"
              onClick={() => setSelectedHypId('__new__')}
              style={{
                ...hypItemBtnStyle,
                borderColor: selectedHypId === '__new__' ? 'var(--accent)' : 'var(--border-subtle)',
                background: selectedHypId === '__new__' ? 'var(--accent-soft)' : 'transparent',
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
                    borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
                    background: active ? 'var(--accent-soft)' : 'color-mix(in srgb, var(--surface-2) 50%, transparent)',
                  }}
                >
                  <div className="re-mono-num" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
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
          <div style={{ minHeight: 0, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9 }}>
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
                    data-hint={`复制假设引用：${formatHypothesisCitation(selectedHyp)}`}
                    onClick={() => {
                      navigator.clipboard?.writeText(formatHypothesisCitation(selectedHyp)).catch(() => {})
                      setCopiedCite(true)
                      setTimeout(() => setCopiedCite(false), 1400)
                    }}
                    style={{ marginLeft: 'auto' }}
                  >
                    {copiedCite ? '✓ 已复制' : '⎘ 引用'}
                  </button>
                </>
              )}
              {!selectedHyp && (
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5 }}>
                  <button
                    type="button"
                    aria-label="⚡ 填入正向实验示例"
                    data-hint="一键填入正向验证假设与实跑命令示例"
                    onClick={() => applyHypothesisPreset('positive')}
                    style={miniPresetBtnStyle}
                  >
                    ⚡ 正向示例
                  </button>
                  <button
                    type="button"
                    aria-label="⚡ 填入反证折半示例"
                    data-hint="一键填入反证实验示例，观察实跑失败后宿主自动折半置信度 (×0.5)"
                    onClick={() => applyHypothesisPreset('decoy')}
                    style={miniPresetBtnStyle}
                  >
                    ⚡ 反证示例
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
                <span className="re-calib-pill" data-tone={selectedChain.calibration.tone} data-hint={selectedChain.calibration.reason}>
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

            {/* §8.3 Structured Hypothesis Fields: scope / falsifiers / next_test */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
              <label style={lblStyle} data-hint="§8.3 scope：限定该假设适用的函数、地址段或运行条件">
                适用范围 (scope)
                <input
                  aria-label="hypothesis scope"
                  style={fieldStyle}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="可选，如 sub_1048A0 / 0x00..0x0f"
                />
              </label>
              <label style={lblStyle} data-hint="§8.3 falsifiers：出现何种观测即推翻该假设（多条用分号分隔）">
                可证伪反例 (falsifiers)
                <input
                  aria-label="hypothesis falsifiers"
                  style={fieldStyle}
                  value={falsifiersText}
                  onChange={(e) => setFalsifiersText(e.target.value)}
                  placeholder="可选，如仅做展示格式化不参与签名"
                />
              </label>
              <label style={lblStyle} data-hint="§8.3 next_test：下一步动态动作必须绑定的检验目标">
                下一步检验 (next_test)
                <input
                  aria-label="hypothesis next_test"
                  style={fieldStyle}
                  value={nextTest}
                  onChange={(e) => setNextTest(e.target.value)}
                  placeholder="可选，如追踪调用者并对比前后 buffer"
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--ok)', fontWeight: 700, fontSize: 11.5 }}>
                  🧪 假设可证伪实验台 (Experiment Design & Live Execution)
                </span>
              </div>

              {/* §8.4 Explicit Hypothesis-Bound Dynamic Action Banner */}
              <div
                className="cl-binding-banner re-mono-num"
                data-hint="§8.4 动态阶段铁律：每次动态动作必须绑定具体假设并回答要验证的 next_test；未命中目标则记录为 weakened"
              >
                <span style={{ color: 'var(--ok)', fontWeight: 700 }}>
                  🔗 绑定假设：为验证 {selectedHyp ? selectedHyp.id : 'H-NNN'} 的 next_test
                </span>
                {(nextTest.trim() || selectedHyp?.nextTest) && (
                  <span style={{ color: 'var(--muted)' }}>
                    — {nextTest.trim() || selectedHyp?.nextTest}
                  </span>
                )}
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
        <div style={{ maxHeight: 'min(52vh, 430px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)' }}>
            <span><code>verify_artifact</code> 确定性产物重放验证</span>
            <span
              className="cl-verdict-chip re-mono-num"
              data-verdict={verificationPosture.status}
              data-hint={verificationPosture.hint}
            >
              {verificationPosture.status === 'verified' ? '✓ VERIFIED' : '○ CANDIDATE'}
            </span>
            <span
              className="re-hint-dot"
              data-hint="宿主实地计算目标文件 SHA256 并逐条比对实跑 stdout 与预期值，自动签发解锁审计门禁的 verification_result 证据"
            >
              ?
            </span>
            {verificationPosture.summary && (
              <span className="re-mono-num" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' }}>
                {verificationPosture.summary}
              </span>
            )}
          </div>

          {/* §8.5 Single-Sample-Hit Guard Banner */}
          <div
            className="cl-guard-banner"
            data-hint="§8.5 产物验收门槛：仅跑通一条示例请求只能标记为 candidate（单样本命中），必须通过正反例、边界输入与差分比对后才能晋升为 verified"
          >
            <span style={{ color: 'var(--warn)', fontWeight: 700 }}>⚠ 单样本命中 ≠ 已还原算法，需正反例 + 边界/差分覆盖</span>
            {verCases.filter((c) => c.command.trim()).length < 2 && (
              <span className="re-mono-num" style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 10 }}>
                当前向量: {verCases.filter((c) => c.command.trim()).length} 条（建议 ≥2 条含反例/边界）
              </span>
            )}
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
              <ProSelect
                ariaLabel="verify linked hypothesis"
                size="md"
                fullWidth
                align="right"
                popoverMinWidth={260}
                value={verHypId}
                options={verifyHypOptions}
                onChange={setVerHypId}
              />
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '7px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)' }}>
            <div style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
              <b>自动化审查通道</b>
              <span
                className="re-hint-dot"
                data-hint="支持四规则确定性仲裁（悬空引用 / 报错支撑 / 动静矛盾 / 单视角盲区），或唤醒独立第三席位模型执行零上下文对抗审计 (/audit)"
              >
                ?
              </span>
            </div>
            <Btn disabled={busy} onClick={() => void handleSubmitReview('arbitrate')}>
              ⚡ 确定性仲裁
            </Btn>
            <Btn tone="accent" disabled={busy} onClick={() => void handleSubmitReview('model_audit')}>
              🤖 隔离审计 (/audit)
            </Btn>
          </div>

          {/* §8.6 5-Item Adversarial Auditor Checklist & 3-State Verdict */}
          <div className="cl-audit-card" data-testid="adversarial-audit-checklist">
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11 }}>
              <span style={{ color: 'var(--violet)', fontWeight: 700 }}>
                🛡 对抗审计 5 项核查清单 (Isolated Context)
              </span>
              <span
                className="cl-verdict-chip re-mono-num"
                data-verdict={auditReport.verdict}
                data-hint={auditReport.verdictHint}
              >
                {auditReport.verdict}
              </span>
              <span
                className="re-mono-num"
                style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 10 }}
                data-hint="§8.6 对抗审计器不继承主 Agent 对话，仅读范围声明、Evidence Ledger、候选结论与验证结果"
              >
                {auditReport.passedCount}/5 达标
              </span>
            </div>
            <div className="cl-audit-grid">
              {auditReport.items.map((item) => (
                <div
                  key={item.key}
                  className="cl-audit-item"
                  data-status={item.status}
                  data-hint={item.detail}
                >
                  <span style={{ fontWeight: 700 }}>
                    {item.status === 'pass' ? '✓' : item.status === 'fail' ? '✗' : '○'}
                  </span>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Evidence-Grounded Operator Audit Review */}
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--violet)', fontWeight: 700, fontSize: 11.5 }}>
              <span>✍ 人工证据审查签章</span>
              <span
                className="re-hint-dot"
                data-hint="必须引用 ≥1 条实跑入账证据 (ev_NNN)；签发后以 audit_finding 追加写入 evidence-ledger.jsonl 不可修改"
              >
                ?
              </span>
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
                <ProSelect
                  ariaLabel="review target hypothesis"
                  size="md"
                  fullWidth
                  popoverMinWidth={300}
                  value={revHypId}
                  options={reviewHypOptions}
                  onChange={setRevHypId}
                />
              </label>
              <label style={lblStyle}>
                3. 审查裁定动作
                <ProSelect<'support' | 'challenge' | 'reject' | ''>
                  ariaLabel="review verdict action"
                  size="md"
                  fullWidth
                  align="right"
                  searchable={false}
                  popoverMinWidth={250}
                  value={revVerdict}
                  options={REVIEW_VERDICT_OPTIONS}
                  onChange={setRevVerdict}
                />
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
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid color-mix(in srgb, var(--accent) 36%, var(--border-subtle))',
  borderRadius: 'var(--radius-sm)',
  background: 'color-mix(in srgb, var(--accent) 5%, var(--surface-2))',
  padding: '6px 10px',
  fontSize: 11,
  lineHeight: 1.45,
  color: 'var(--muted)',
}

function wbTabStyle(active: boolean, tone: 'accent' | 'ok' | 'violet'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-xs)',
    background: active ? `color-mix(in srgb, var(--${tone}) 13%, transparent)` : 'transparent',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    padding: '3px 10px',
    cursor: 'pointer',
  }
}

const hypItemBtnStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  padding: '6px 8px',
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
  border: '1px solid color-mix(in srgb, var(--accent) 48%, var(--rule))',
  borderRadius: 'var(--radius-xs)',
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  fontSize: 10,
  padding: '1px 7px',
  cursor: 'pointer',
}

function pillSelectStyle(active: boolean, tone: 'ok' | 'err' | 'violet'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-xs)',
    background: active ? `color-mix(in srgb, var(--${tone}) 15%, transparent)` : 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 10,
    padding: '1px 6px',
    cursor: 'pointer',
  }
}

const expCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
  padding: '6px 9px',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

// ---------- §8.5 Verification Posture & §8.6 5-Check Adversarial Auditor ----------

function evaluateVerificationPosture(evidence: EvidenceRecord[]): {
  status: 'candidate' | 'verified'
  summary: string
  hint: string
} {
  const verEvs = evidence.filter((e) => !e.isError && e.kind === 'verification_result' && e.verification)
  if (verEvs.length === 0) {
    return {
      status: 'candidate',
      summary: '未重放 · candidate',
      hint: '当前尚无 verify_artifact 重放记录，所有脚本/算法均属于 candidate（未验收候选）',
    }
  }
  const latest = verEvs[verEvs.length - 1]
  const stats = latest.verification as ExtendedVerificationStats
  const passed = stats.passed ?? 0
  const total = stats.total ?? 0
  const multiVector = total >= 2 || (stats.differentialCases ?? 0) > 0 || (stats.boundaryPassed ?? 0) > 0
  const isVerified =
    stats.status === 'verified' || (passed > 0 && passed === total && multiVector)

  if (isVerified) {
    return {
      status: 'verified',
      summary: `已通过 ${passed}/${total} (${latest.id})`,
      hint: `产物已通过多向量重放校验 (${latest.id}: ${passed}/${total})，从 candidate 晋升为 verified`,
    }
  }
  return {
    status: 'candidate',
    summary: `仅 ${passed}/${total} (${latest.id} · 单样本/未全过)`,
    hint: `§8.5 守卫：${latest.id} 仅覆盖 ${passed}/${total}，单样本命中或存在失败用例时保持 candidate，不可宣称已还原算法`,
  }
}

function evaluateAdversarialChecklist(
  ledger: ExtendedLedger | null,
  evidence: EvidenceRecord[],
  hypotheses: StructuredHypothesis[],
  findings: FindingDTO[],
): {
  verdict: AuditVerdict
  verdictHint: string
  passedCount: number
  items: Array<{ key: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
} {
  const validEvIds = new Set(evidence.filter((e) => !e.isError).map((e) => e.id))
  const liveHyps = hypotheses.filter((h) => h.status === 'active' || h.status === 'revised')
  const verEvs = evidence.filter((e) => !e.isError && e.kind === 'verification_result' && e.verification)
  const audEvs = evidence.filter((e) => e.kind === 'audit_finding')
  const sandbox = ledger?.sandbox

  const totalVerCases = verEvs.reduce((acc, e) => acc + (e.verification?.total ?? 0), 0)
  const passedVerCases = verEvs.reduce((acc, e) => acc + (e.verification?.passed ?? 0), 0)
  const hasFailureTrace =
    totalVerCases >= 2 || evidence.some((e) => e.isError || (e.view === 'dynamic' && e.kind === 'runtime_trace'))

  const checkDirect =
    liveHyps.length > 0 && liveHyps.every((h) => (h.supporting ?? []).some((id) => validEvIds.has(id)))
  const checkEdge = verEvs.length > 0 && passedVerCases === totalVerCases && hasFailureTrace
  const hasUnresolvedConflict =
    hypotheses.some((h) => h.status === 'reevaluate') ||
    findings.some((f) => f.rule === 'single-view' && !f.applied)
  const checkAlt = hypotheses.length > 0 && !hasUnresolvedConflict
  const checkOverreach = !sandbox || sandbox.active || sandbox.deniedCount === 0
  const checkLineage = verEvs.some((e) => Boolean(e.sha256 || e.artifact))

  const fallbackItems: Array<{ key: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = [
    {
      key: 'direct_evidence',
      label: '① 直接证据',
      status: checkDirect ? 'pass' : 'warn',
      detail: checkDirect
        ? `全部 ${liveHyps.length} 条活跃结论均已回溯至实测 ev_NNN`
        : '存在未绑定非报错实测证据的活跃假设，不可直接交付',
    },
    {
      key: 'failure_coverage',
      label: '② 异常/失败输入覆盖',
      status: checkEdge ? 'pass' : 'warn',
      detail: checkEdge
        ? `已覆盖多向量重放与异常/动态对照（${passedVerCases}/${totalVerCases}）`
        : '缺少正反例、边界输入或失败样本覆盖（单样本命中将被退回 needs_more_evidence）',
    },
    {
      key: 'alternative_check',
      label: '③ 替代解释排查',
      status: checkAlt ? 'pass' : 'fail',
      detail: checkAlt
        ? '竞争假设与冲突反证均已完成收敛或淘汰'
        : '存在待重审 (reevaluate) 或单视角盲区，需排除更简单的替代解释',
    },
    {
      key: 'zero_overreach',
      label: '④ 零越权动作',
      status: checkOverreach ? 'pass' : 'fail',
      detail: sandbox?.deniedCount
        ? `Capability Sandbox 已同步拦截 ${sandbox.deniedCount} 次任务外越权动作，零未授权访问`
        : '未发现任务范围外的文件、网络、设备或凭据越权访问',
    },
    {
      key: 'artifact_lineage',
      label: '⑤ 产物步骤一致',
      status: checkLineage ? 'pass' : 'warn',
      detail: checkLineage
        ? '验证产物已绑定真实 SHA256 与可复现重放记录'
        : '尚未记录带 SHA256 指纹的产物重放血缘，无法确认产物来自声明步骤',
    },
  ]

  // Merge backend auditChecks if supplied by go-schema
  const backendChecks = ledger?.auditChecks
  const items =
    backendChecks && backendChecks.length >= 5
      ? fallbackItems.map((fb, idx) => {
          const bc = backendChecks[idx]
          if (!bc) return fb
          const passed = bc.pass ?? bc.passed
          return {
            key: bc.key || bc.id || fb.key,
            label: fb.label,
            status: passed === true ? ('pass' as const) : passed === false ? ('warn' as const) : fb.status,
            detail: bc.detail || fb.detail,
          }
        })
      : fallbackItems

  const passedCount = items.filter((i) => i.status === 'pass').length
  const explicit = ledger?.auditVerdict

  let verdict: AuditVerdict
  if (explicit === 'accepted' || explicit === 'rejected' || explicit === 'needs_more_evidence') {
    verdict = explicit
  } else if (items.some((i) => i.status === 'fail')) {
    verdict = 'rejected'
  } else if (passedCount === 5 && audEvs.length > 0) {
    verdict = 'accepted'
  } else {
    verdict = 'needs_more_evidence'
  }

  const verdictHint =
    verdict === 'accepted'
      ? 'accepted — 5 项对抗核查通过并签发 audit_finding，可交付可复现报告'
      : verdict === 'rejected'
        ? 'rejected — 存在未消解冲突或越权风险，审计拒绝当前结论'
        : 'needs_more_evidence — 证据覆盖或边界重放不足，退回补证（模型补文字不能改状态）'

  return { verdict, verdictHint, passedCount, items }
}
