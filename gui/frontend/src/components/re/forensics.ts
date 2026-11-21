// Pure forensic synthesis, mitigation posture, VA/RVA offset resolution,
// provenance calibration, tool telemetry classification, phase-gate readiness,
// and JSON bundle export helpers (zero React / DOM dependencies).
import type {
  BinaryTerrainDTO,
  EvidenceRecord,
  FindingDTO,
  Hypothesis,
  LedgerDTO,
  TerrainSectionDTO,
  TickDTO,
  ToolRunSnapshot,
} from '../../lib/types'
import { generateWriteupMarkdown, synthesizeProcessSummary, type WriteupTemplateId } from './cognitiveSynthesis'

// ---------- 1. Security Mitigation Posture & Entropy Risk ----------

export type MitigationStatus = 'secure' | 'partial' | 'weak' | 'alert' | 'info'

export interface MitigationPill {
  key: string
  label: string
  value: string
  raw: string
  status: MitigationStatus
  detail: string
}

export interface MitigationPosture {
  grade: 'HARDENED' | 'MIXED' | 'EXPOSED' | 'PACKED/RWX'
  tone: 'ok' | 'warn' | 'err' | 'accent'
  score: number
  pills: MitigationPill[]
  entropyVerdict: 'PACKED/ENCRYPTED' | 'HIGH/COMPRESSED' | 'CODE/STRUCTURED' | 'SPARSE'
  entropyTone: 'err' | 'warn' | 'accent' | 'muted'
  rwxCount: number
  ctorCount: number
}

export function classifyEntropy(entropy: number): {
  verdict: MitigationPosture['entropyVerdict']
  tone: MitigationPosture['entropyTone']
} {
  if (entropy >= 7.2) return { verdict: 'PACKED/ENCRYPTED', tone: 'err' }
  if (entropy >= 6.4) return { verdict: 'HIGH/COMPRESSED', tone: 'warn' }
  if (entropy >= 3.5) return { verdict: 'CODE/STRUCTURED', tone: 'accent' }
  return { verdict: 'SPARSE', tone: 'muted' }
}

export function evaluateMitigationPosture(terrain: BinaryTerrainDTO): MitigationPosture {
  const mit = terrain.mitigations ?? {}
  const pills: MitigationPill[] = []
  let score = 50

  const norm = (k: string) => (mit[k] ?? '').trim().toLowerCase()

  const pie = norm('PIE')
  if (pie) {
    const ok = pie.startsWith('yes') || pie.startsWith('dso') || pie.includes('pie')
    pills.push({
      key: 'PIE',
      label: 'PIE',
      value: ok ? (pie.startsWith('dso') ? 'DSO' : 'ON') : 'OFF',
      raw: mit.PIE,
      status: ok ? 'secure' : 'weak',
      detail: ok ? 'ASLR-compatible position-independent base' : 'Fixed image base — trivial ROP/patch addressing',
    })
    score += ok ? 15 : -15
  }

  const nx = norm('NX')
  if (nx) {
    const ok = nx.startsWith('yes') || nx === 'on'
    pills.push({
      key: 'NX',
      label: 'NX',
      value: ok ? 'ON' : 'OFF',
      raw: mit.NX,
      status: ok ? 'secure' : 'weak',
      detail: ok ? 'Non-executable stack/heap (DEP active)' : 'Executable stack/heap — shellcode injectable',
    })
    score += ok ? 15 : -20
  }

  const relro = norm('RELRO')
  if (relro) {
    const isFull = relro.includes('full')
    const isPartial = relro.includes('partial')
    pills.push({
      key: 'RELRO',
      label: 'RELRO',
      value: isFull ? 'FULL' : isPartial ? 'PARTIAL' : 'NONE',
      raw: mit.RELRO,
      status: isFull ? 'secure' : isPartial ? 'partial' : 'weak',
      detail: isFull
        ? 'GOT read-only after dynamic link'
        : isPartial
          ? 'Partial RELRO — .got.plt remains writable'
          : 'No RELRO — GOT hijackable',
    })
    score += isFull ? 12 : isPartial ? 4 : -10
  }

  const canary = norm('canary')
  if (canary) {
    const ok = canary.startsWith('yes') || canary === 'on'
    pills.push({
      key: 'canary',
      label: 'CANARY',
      value: ok ? 'ON' : 'OFF',
      raw: mit.canary,
      status: ok ? 'secure' : 'weak',
      detail: ok ? 'Stack smash guard cookie (__stack_chk_fail)' : 'No stack canary detected',
    })
    score += ok ? 10 : -10
  }

  const stripped = norm('stripped')
  if (stripped) {
    const isStripped = stripped.startsWith('yes')
    pills.push({
      key: 'stripped',
      label: 'SYMBOLS',
      value: isStripped ? 'STRIPPED' : 'INTACT',
      raw: mit.stripped,
      status: isStripped ? 'partial' : 'info',
      detail: isStripped ? 'Symbol table stripped — rely on FLIRT/xrefs/strings' : 'Unstripped symbols available for static triage',
    })
  }

  const rwxSections = terrain.sections.filter((s) => s.rwx || (s.flags.includes('W') && s.flags.includes('X')))
  const rwxFlag = norm('RWX').startsWith('yes') || rwxSections.length > 0
  if (rwxFlag) {
    pills.push({
      key: 'RWX',
      label: 'RWX',
      value: rwxSections.length > 0 ? `${rwxSections.length} SEG` : 'YES',
      raw: mit.RWX || rwxSections.map((s) => s.name).join(', '),
      status: 'alert',
      detail: 'Writable + executable segment — strong unpacker/self-modifying stub indicator',
    })
    score -= 25
  }

  const ctorCount = terrain.sections.filter((s) => s.isConstructor).length
  const ent = classifyEntropy(terrain.maxEntropy)
  pills.push({
    key: 'ENTROPY',
    label: 'PEAK H',
    value: `${terrain.maxEntropy.toFixed(2)} b/B`,
    raw: `avg=${terrain.overallEntropy.toFixed(3)} max=${terrain.maxEntropy.toFixed(3)}`,
    status: terrain.maxEntropy >= 7.2 ? 'alert' : terrain.maxEntropy >= 6.4 ? 'partial' : 'info',
    detail: `Shannon entropy peak ${terrain.maxEntropy.toFixed(3)} b/B (${ent.verdict})`,
  })

  if (terrain.maxEntropy >= 7.2) score -= 12
  score = Math.max(0, Math.min(100, score))

  let grade: MitigationPosture['grade'] = 'MIXED'
  let tone: MitigationPosture['tone'] = 'warn'
  if (rwxFlag || terrain.maxEntropy >= 7.6) {
    grade = 'PACKED/RWX'
    tone = 'err'
  } else if (score >= 78) {
    grade = 'HARDENED'
    tone = 'ok'
  } else if (score < 45) {
    grade = 'EXPOSED'
    tone = 'err'
  }

  return {
    grade,
    tone,
    score,
    pills,
    entropyVerdict: ent.verdict,
    entropyTone: ent.tone,
    rwxCount: rwxSections.length,
    ctorCount,
  }
}

// ---------- 2. Virtual Address / File Offset / RVA Resolver ----------

export interface OffsetMapping {
  fileOffsetHex: string
  vaddrHex: string | null
  rvaHex: string | null
  section: TerrainSectionDTO | null
  sectionDeltaHex: string | null
  citation: string
}

function parseHexAddr(v?: string): number | null {
  if (!v) return null
  const clean = v.trim().toLowerCase()
  const parsed = Number.parseInt(clean.startsWith('0x') ? clean.slice(2) : clean, 16)
  return Number.isFinite(parsed) ? parsed : null
}

function formatHexAddress(n: number, pad = 6): string {
  return `0x${Math.max(0, Math.floor(n)).toString(16).padStart(pad, '0')}`
}

export function resolveOffsetMapping(terrain: BinaryTerrainDTO, fileOffset: number): OffsetMapping {
  const safeOff = Math.max(0, Math.floor(fileOffset))
  const fileOffsetHex = formatHexAddress(safeOff, 6)

  const sec =
    terrain.sections.find((s) => safeOff >= s.offset && safeOff < s.offset + Math.max(1, s.size)) ?? null

  const secVaddr = parseHexAddr(sec?.vaddr)
  const vaddrs = terrain.sections.map((s) => parseHexAddr(s.vaddr)).filter((n): n is number => n !== null)
  const minVaddr = vaddrs.length > 0 ? Math.min(...vaddrs) : null
  // Infer canonical image base (e.g. 0x400000 for non-zero x86_64 ELF, 0x0 for DSO/PIE with low vaddr)
  const imageBase = minVaddr !== null ? (minVaddr >= 0x400000 ? minVaddr & ~0xffff : 0) : null

  let vaddrHex: string | null = null
  let rvaHex: string | null = null
  let sectionDeltaHex: string | null = null

  if (sec && secVaddr !== null) {
    const delta = safeOff - sec.offset
    const va = secVaddr + delta
    vaddrHex = formatHexAddress(va, va > 0xffffff ? 8 : 6)
    sectionDeltaHex = `+0x${delta.toString(16)}`
    if (imageBase !== null && va >= imageBase) {
      rvaHex = `+0x${(va - imageBase).toString(16)}`
    }
  } else if (imageBase !== null) {
    rvaHex = `+0x${safeOff.toString(16)}`
  }

  const loc = vaddrHex
    ? `${terrain.path}!${vaddrHex} (off:${fileOffsetHex}${rvaHex ? ` RVA:${rvaHex}` : ''}${sec ? ` ${sec.name}` : ''})`
    : `${terrain.path}@${fileOffsetHex}${sec ? ` (${sec.name})` : ''}`

  return {
    fileOffsetHex,
    vaddrHex,
    rvaHex,
    section: sec,
    sectionDeltaHex,
    citation: loc,
  }
}

// ---------- 3. Evidence Provenance Chain & Confidence Calibration ----------

export type AlignmentVerdict = 'VERIFIED' | 'DIVERGED' | 'UNCOVERED' | 'ANTI_ANALYSIS'

export interface ProvenanceChain {
  staticEvs: EvidenceRecord[]
  dynamicEvs: EvidenceRecord[]
  verifyEvs: EvidenceRecord[]
  auditEvs: EvidenceRecord[]
  contradictEvs: EvidenceRecord[]
  verdict: AlignmentVerdict
  verdictLabel: string
  calibration: {
    status: 'CALIBRATED' | 'OVERCONFIDENT' | 'UNRECONCILED' | 'FALSIFIED' | 'PROVISIONAL'
    tone: 'ok' | 'warn' | 'err' | 'muted'
    reason: string
  }
  falsificationCriteria: string | null
}

const ANTI_RE = /anti[_-]?debug|anti[_-]?frida|ptrace|tracerpid|svc\s*#0|packer|obfuscat|rwx|decrypt/i

export function buildProvenanceChain(
  hyp: Hypothesis,
  evidence: EvidenceRecord[],
  findings: FindingDTO[] = [],
): ProvenanceChain {
  const evById = new Map(evidence.map((e) => [e.id, e]))
  const sup = (hyp.supporting ?? []).map((id) => evById.get(id)).filter((x): x is EvidenceRecord => Boolean(x))
  const con = (hyp.contradicting ?? []).map((id) => evById.get(id)).filter((x): x is EvidenceRecord => Boolean(x))
  const audLinked = evidence.filter(
    (e) => e.kind === 'audit_finding' && ((e.supports ?? []).includes(hyp.id) || (e.contradicts ?? []).includes(hyp.id)),
  )

  const staticEvs = sup.filter((e) => !e.isError && (e.view === 'static' || (!e.view && (e.kind === 'tool_observation' || !e.kind))))
  const dynamicEvs = sup.filter(
    (e) => !e.isError && (e.view === 'dynamic' || e.kind === 'runtime_trace'),
  )
  const verifyEvs = sup.filter((e) => !e.isError && (e.kind === 'verification_result' || Boolean(e.verification)))
  const auditEvs = [
    ...sup.filter((e) => e.kind === 'audit_finding'),
    ...audLinked.filter((a) => !sup.some((s) => s.id === a.id)),
  ]

  const hasChallengeFinding = findings.some(
    (f) => f.hypothesisId === hyp.id && (f.action === 'challenge' || f.rule === 'runtime-contradiction'),
  )
  const hasConflict = con.length > 0 || hyp.status === 'rejected' || hyp.status === 'reevaluate' || hasChallengeFinding
  const hasStatic = staticEvs.length > 0
  const hasDynamicOrVerify = dynamicEvs.length > 0 || verifyEvs.length > 0

  const combinedText = [hyp.claim, hyp.note ?? '', ...sup.map((e) => `${e.summary ?? ''} ${e.excerpt}`)].join(' ')
  const touchesAnti = ANTI_RE.test(combinedText)

  let verdict: AlignmentVerdict
  let verdictLabel: string
  if (hasConflict) {
    verdict = 'DIVERGED'
    verdictLabel = 'Diverged · 动静冲突'
  } else if (hasStatic && hasDynamicOrVerify) {
    verdict = 'VERIFIED'
    verdictLabel = 'Verified · 双视角实证'
  } else if (touchesAnti && !hasDynamicOrVerify) {
    verdict = 'ANTI_ANALYSIS'
    verdictLabel = 'Anti-Analysis · 需绕过验证'
  } else {
    verdict = 'UNCOVERED'
    verdictLabel = hasStatic ? 'Uncovered · 仅静态推断' : 'Uncovered · 缺观测凭证'
  }

  let calibration: ProvenanceChain['calibration']
  if (hasConflict && hyp.confidence >= 0.45) {
    calibration = {
      status: 'UNRECONCILED',
      tone: 'err',
      reason: `存在 ${Math.max(con.length, 1)} 条反证或降级裁定，置信度需折半重校准`,
    }
  } else if (hasConflict) {
    calibration = {
      status: 'FALSIFIED',
      tone: 'err',
      reason: '已被反证折半淘汰或级联降权，排除在最终结论之外',
    }
  } else if (!hasDynamicOrVerify && hyp.confidence >= 0.8) {
    calibration = {
      status: 'OVERCONFIDENT',
      tone: 'warn',
      reason: '置信度 ≥80% 但无动态实测/重放凭证，存在单视角确认偏误风险',
    }
  } else if (hasStatic && (verifyEvs.length > 0 || (dynamicEvs.length > 0 && auditEvs.length > 0))) {
    calibration = {
      status: 'CALIBRATED',
      tone: 'ok',
      reason: '静态观测 + 动态/重放验证闭环，置信度校准充分',
    }
  } else if (hasStatic && hasDynamicOrVerify) {
    calibration = {
      status: 'CALIBRATED',
      tone: 'ok',
      reason: '双视角交叉支撑，建议补齐 verify_artifact 重放凭证',
    }
  } else {
    calibration = {
      status: 'PROVISIONAL',
      tone: 'muted',
      reason: '初始探索阶段假设，等待实验或动态追踪证伪',
    }
  }

  // Extract explicit falsification criteria from experiments or note
  const expWithExpected = (hyp.experiments ?? []).find((ex) => ex.expected && ex.expected.trim() !== '')
  let falsificationCriteria: string | null = null
  if (expWithExpected) {
    falsificationCriteria = `运行 \`${expWithExpected.command}\` 预期命中 "${expWithExpected.expected}"（不符即 ×0.5 证伪）`
  } else if (hyp.note && /预测|预期|falsif|expect|verify|校验/i.test(hyp.note)) {
    falsificationCriteria = hyp.note
  }

  return {
    staticEvs,
    dynamicEvs,
    verifyEvs,
    auditEvs,
    contradictEvs: con,
    verdict,
    verdictLabel,
    calibration,
    falsificationCriteria,
  }
}

export function formatEvidenceCitation(ev: EvidenceRecord): string {
  const parts = [ev.id, ev.view || 'static', ev.kind || 'tool_observation', ev.source]
  if (ev.sha256) parts.push(`sha256:${ev.sha256.slice(0, 12)}`)
  return `[${parts.join(' | ')}]`
}

export function formatHypothesisCitation(hyp: Hypothesis): string {
  const pct = `${Math.round(Math.max(0, Math.min(1, hyp.confidence)) * 100)}%`
  const sup = hyp.supporting?.length ? ` | sup:${hyp.supporting.join(',')}` : ''
  const con = hyp.contradicting?.length ? ` | con:${hyp.contradicting.join(',')}` : ''
  return `[${hyp.id} | ${hyp.status.toUpperCase()} ${pct}${sup}${con}]`
}

// ---------- 4. Tool Execution Fidelity & Telemetry Classifier ----------

export type ToolCategory = 'STATIC' | 'DYNAMIC' | 'VERIFY' | 'CRYPTO' | 'LEDGER'

export interface ClassifiedToolRun {
  run: ToolRunSnapshot
  category: ToolCategory
  toolFamily: string
  targetArtifact: string | null
  exitLabel: string
  exitState: 'ok' | 'fail' | 'run'
}

const ARTIFACT_RE = /([a-zA-Z0-9._/-]+\.(?:elf|so|bin|exe|dll|dylib|apk|dex|js|py|c|go|md|txt|json|zip|pdf))/i

export function classifyToolCall(run: ToolRunSnapshot): ClassifiedToolRun {
  const n = run.name.toLowerCase()
  const args = run.argsText || ''
  const combined = `${n} ${args}`.toLowerCase()

  let category: ToolCategory = 'STATIC'
  let toolFamily = run.name

  if (n.includes('verify') || combined.includes('verify_artifact') || combined.includes('diff')) {
    category = 'VERIFY'
    toolFamily = 'verify'
  } else if (
    n.includes('hypothesis') ||
    n.includes('audit') ||
    n.includes('plan') ||
    n.includes('goal') ||
    n.includes('write_file') ||
    n.includes('read_file')
  ) {
    category = 'LEDGER'
    toolFamily = n.includes('hypothesis') ? 'hyp-stack' : n.includes('audit') ? 'auditor' : 'workspace'
  } else if (
    combined.includes('base64') ||
    combined.includes('decode') ||
    combined.includes('decrypt') ||
    combined.includes('xor') ||
    combined.includes('entropy') ||
    combined.includes('hash')
  ) {
    category = 'CRYPTO'
    toolFamily = 'crypto'
  } else if (
    n.includes('run_command') ||
    n.includes('exec') ||
    n.includes('gdb') ||
    n.includes('lldb') ||
    n.includes('frida') ||
    n.includes('strace') ||
    n.includes('ltrace') ||
    combined.includes('node ') ||
    combined.includes('python') ||
    combined.includes('gzip ') ||
    combined.includes('unzip ')
  ) {
    category = 'DYNAMIC'
    if (combined.includes('gdb')) toolFamily = 'gdb'
    else if (combined.includes('frida')) toolFamily = 'frida'
    else if (combined.includes('python')) toolFamily = 'python'
    else if (combined.includes('node ')) toolFamily = 'node'
    else toolFamily = 'shell-exec'
  } else {
    category = 'STATIC'
    if (combined.includes('radare2') || combined.includes('r2 ')) toolFamily = 'radare2'
    else if (combined.includes('objdump')) toolFamily = 'objdump'
    else if (combined.includes('readelf')) toolFamily = 'readelf'
    else if (combined.includes('strings')) toolFamily = 'strings'
    else if (combined.includes('carve')) toolFamily = 'carve'
    else if (combined.includes('hex')) toolFamily = 'hexdump'
    else if (combined.includes('scan') || combined.includes('inspect')) toolFamily = 'elf/bin-scan'
  }

  const artMatch = args.match(ARTIFACT_RE)
  const targetArtifact = artMatch ? artMatch[1].split('/').pop() ?? artMatch[1] : null

  const exitState: ClassifiedToolRun['exitState'] =
    run.status === 'running' ? 'run' : run.status === 'failed' || !run.ok ? 'fail' : 'ok'
  const exitLabel = exitState === 'run' ? 'EXEC' : exitState === 'ok' ? 'EXIT 0' : 'ERR'

  return {
    run,
    category,
    toolFamily,
    targetArtifact,
    exitLabel,
    exitState,
  }
}

export function computeLatencyStats(runs: ToolRunSnapshot[]): {
  samples: number[]
  avgMs: number
  maxMs: number
  p95Ms: number
  successRate: number
} {
  const finished = runs.filter((r) => r.status !== 'running')
  const samples = finished
    .map((r) => (r.ms > 0 ? r.ms : r.finishedAt > r.startedAt ? r.finishedAt - r.startedAt : 0))
    .filter((ms) => ms > 0)

  if (samples.length === 0) {
    return {
      samples: [],
      avgMs: 0,
      maxMs: 0,
      p95Ms: 0,
      successRate: finished.length === 0 ? 100 : Math.round((finished.filter((r) => r.ok && r.status === 'done').length / finished.length) * 100),
    }
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const sum = samples.reduce((a, b) => a + b, 0)
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  const okCount = finished.filter((r) => r.ok && r.status === 'done').length

  return {
    samples,
    avgMs: Math.round(sum / samples.length),
    maxMs: sorted[sorted.length - 1],
    p95Ms: sorted[p95Idx],
    successRate: finished.length > 0 ? Math.round((okCount / finished.length) * 100) : 100,
  }
}

// ---------- 5. Phase-Gate Readiness Evaluator (9-Phase RE Workflow) ----------

export interface PhaseGateStatus {
  code: string
  phase: string
  index: number
  ready: 'pass' | 'current' | 'blocked' | 'pending'
  criterion: string
  progress: string
}

const PHASE_DEFS: Array<{ code: string; phase: string; criterion: string }> = [
  { code: 'TRI', phase: 'triage', criterion: '样本指纹/格式初筛' },
  { code: 'STA', phase: 'static', criterion: '静态观测 ev ≥ 1' },
  { code: 'DYN', phase: 'dynamic', criterion: '可证伪假设 H ≥ 1' },
  { code: 'EVI', phase: 'evidence', criterion: '双视角证据入账' },
  { code: 'IFC', phase: 'interface', criterion: '关键接口/符号定位' },
  { code: 'HYP', phase: 'hypothesis', criterion: '假设收敛与冲突仲裁' },
  { code: 'VER', phase: 'verify', criterion: '动态追踪 ≥1 或静态 ≥3' },
  { code: 'AUD', phase: 'audit', criterion: 'verify_artifact 重放 ≥ 1' },
  { code: 'WRI', phase: 'writeup', criterion: 'audit_finding ≥ 1 + /goal 全绿' },
]

export function evaluatePhaseGates(tick: TickDTO | null): PhaseGateStatus[] {
  const re = tick?.re ?? null
  const ledger = tick?.ledger ?? null
  const evs = ledger?.evidence ?? []
  const hyps = ledger?.hypotheses ?? []
  const goal = ledger?.goal ?? null

  const staticObs = evs.filter((e) => !e.isError && (e.view === 'static' || !e.view)).length
  const dynObs = evs.filter((e) => !e.isError && (e.view === 'dynamic' || e.kind === 'runtime_trace')).length
  const activeHyps = hyps.filter((h) => h.status === 'active' || h.status === 'revised').length
  const verCount = evs.filter((e) => !e.isError && e.kind === 'verification_result').length
  const audCount = evs.filter((e) => !e.isError && e.kind === 'audit_finding').length
  const goalCriteria = goal?.criteria ?? []
  const goalAllPass = goalCriteria.length === 0 || goalCriteria.every((c) => c.pass)

  const currentIdx = re ? re.phaseIndex : -1

  return PHASE_DEFS.map((def, idx) => {
    let met = false
    let progress = ''
    switch (def.code) {
      case 'TRI':
        met = Boolean(re || goal || evs.length > 0)
        progress = met ? 'ok' : '0/1'
        break
      case 'STA':
        met = staticObs >= 1
        progress = `${staticObs}/1`
        break
      case 'DYN':
        met = activeHyps >= 1
        progress = `H:${activeHyps}`
        break
      case 'EVI':
        met = evs.length >= 2
        progress = `E:${evs.length}`
        break
      case 'IFC':
        met = staticObs >= 2 || activeHyps >= 1
        progress = `${staticObs} obs`
        break
      case 'HYP':
        met = hyps.length >= 1
        progress = `H:${hyps.length}`
        break
      case 'VER':
        met = dynObs >= 1 || staticObs >= 3
        progress = dynObs >= 1 ? `dyn:${dynObs}` : `sta:${staticObs}/3`
        break
      case 'AUD':
        met = verCount >= 1
        progress = `VER:${verCount}/1`
        break
      case 'WRI':
        met = audCount >= 1 && goalAllPass
        progress = `AUD:${audCount}/1`
        break
    }

    let ready: PhaseGateStatus['ready']
    if (idx === currentIdx) {
      ready = 'current'
    } else if (idx < currentIdx || met) {
      ready = 'pass'
    } else if (idx === currentIdx + 1) {
      ready = 'blocked'
    } else {
      ready = 'pending'
    }

    return {
      code: def.code,
      phase: def.phase,
      index: idx,
      ready,
      criterion: def.criterion,
      progress,
    }
  })
}

// ---------- 6. Exportable Forensic JSON Bundle ----------

export interface ForensicBundle {
  schema: '0xaf-re/forensic-bundle/v1'
  exportedAt: string
  workspace: string
  rePhase: {
    sampleType: string
    phase: string
    phaseIndex: number
    phaseCount: number
  } | null
  goal: LedgerDTO['goal']
  summary: ReturnType<typeof synthesizeProcessSummary>
  phaseGates: PhaseGateStatus[]
  hypotheses: Array<
    Hypothesis & {
      alignmentVerdict: AlignmentVerdict
      calibration: ProvenanceChain['calibration']
      falsificationCriteria: string | null
    }
  >
  evidence: EvidenceRecord[]
  findings: FindingDTO[]
  sandbox: LedgerDTO['sandbox']
  markdownWriteup: string
}

export function buildForensicJsonBundle(
  tick: TickDTO | null,
  template: WriteupTemplateId,
  workspace: string,
  markdownOverride?: string,
): ForensicBundle {
  const ledger = tick?.ledger ?? null
  const evidence = ledger?.evidence ?? []
  const hypotheses = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []

  return {
    schema: '0xaf-re/forensic-bundle/v1',
    exportedAt: new Date().toISOString(),
    workspace,
    rePhase: tick?.re
      ? {
          sampleType: tick.re.sampleType,
          phase: tick.re.phase,
          phaseIndex: tick.re.phaseIndex,
          phaseCount: tick.re.phaseCount,
        }
      : null,
    goal: ledger?.goal ?? null,
    summary: synthesizeProcessSummary(tick),
    phaseGates: evaluatePhaseGates(tick),
    hypotheses: hypotheses.map((h) => {
      const chain = buildProvenanceChain(h, evidence, findings)
      return {
        ...h,
        alignmentVerdict: chain.verdict,
        calibration: chain.calibration,
        falsificationCriteria: chain.falsificationCriteria,
      }
    }),
    evidence,
    findings,
    sandbox: ledger?.sandbox ?? null,
    markdownWriteup: markdownOverride ?? generateWriteupMarkdown(tick, template, workspace),
  }
}
