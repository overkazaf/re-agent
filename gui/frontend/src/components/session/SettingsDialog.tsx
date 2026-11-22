// SettingsDialog — active session config with clean role-routing grid,
// concise labels, contextual `data-hint` tips, and collapsible provider list.
// Preserves E2E contracts: CONFIG, max turns, label:has-text("planner") select, save, 已保存, close.
import { useEffect, useMemo, useState } from 'react'
import { hasBackend } from '../../store/sessions'
import { api } from '../../lib/api'
import type { SettingsDTO, SettingsPatch } from '../../lib/types'
import { Btn, Dialog, fieldStyle, labelStyle } from './Dialog'
import { ProSelect, type ProSelectOption } from '../crt'
import { validateMaxTurns } from './usabilityHelpers'
import './usability.css'

const AUTO = ''
const TURN_PRESETS = [20, 30, 60, 100] as const

const ROLE_META = {
  planner: {
    color: 'var(--accent)',
    hint: '强推理规划 (/planner) · 推荐：codex sol / gemini 4 carbon',
  },
  executor: {
    color: 'var(--ok)',
    hint: '高速工具取证 (/executor) · 推荐：ds / gemini 4 neon / glm-5.3-flash',
  },
  researcher: {
    color: 'var(--warn)',
    hint: '知识库与调研 (/researcher) · 推荐：gemini 4 carbon / ds / glm-5.3',
  },
  auditor: {
    color: 'var(--violet)',
    hint: '独立零上下文对抗审计 (/auditor) · 推荐：codex sol / gemini 4 carbon / glm-5.3',
  },
} as const

function buildRouteOptions(settings: SettingsDTO): ProSelectOption[] {
  const byName = new Map(settings.providers.map((p) => [p.name, p]))
  return [
    {
      value: AUTO,
      label: 'auto',
      description: '跟随系统默认角色路由策略',
      badge: 'AUTO',
    },
    ...settings.providerNames.map((name) => {
      const info = byName.get(name)
      return {
        value: name,
        label: name,
        description: info?.model || undefined,
        badge: info?.type || undefined,
      }
    }),
  ]
}

function routeSelect(
  value: string,
  options: readonly ProSelectOption[],
  onChange: (v: string) => void,
  ariaLabel: string,
): React.ReactNode {
  return (
    <ProSelect
      value={value}
      options={options}
      onChange={onChange}
      fullWidth
      popoverMinWidth={248}
      searchPlaceholder="Filter providers…"
      ariaLabel={ariaLabel}
    />
  )
}

export function SettingsDialog({
  sessionId,
  sessionName,
  onClose,
}: {
  sessionId: string
  sessionName: string
  onClose: () => void
}) {
  const [settings, setSettings] = useState<SettingsDTO | null>(null)
  const [planner, setPlanner] = useState(AUTO)
  const [executor, setExecutor] = useState(AUTO)
  const [researcher, setResearcher] = useState(AUTO)
  const [auditor, setAuditor] = useState(AUTO)
  const [maxTurns, setMaxTurns] = useState(30)
  const [providersOpen, setProvidersOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!hasBackend()) {
      setLoadError('浏览器 dev：无后端')
      return
    }
    api
      .getSettings(sessionId)
      .then((s) => {
        setSettings(s)
        setPlanner(s.plannerProvider)
        setExecutor(s.executorProvider)
        setResearcher(s.researcherProvider)
        setAuditor(s.auditProvider ?? '')
        setMaxTurns(s.maxTurns)
      })
      .catch((err) => setLoadError(String(err)))
  }, [sessionId])

  const maxTurnsError = useMemo(() => (settings ? validateMaxTurns(maxTurns) : null), [settings, maxTurns])
  const routeOptions = useMemo(() => (settings ? buildRouteOptions(settings) : []), [settings])

  const changedCount = useMemo(() => {
    if (!settings) return 0
    let n = 0
    if (planner !== settings.plannerProvider) n += 1
    if (executor !== settings.executorProvider) n += 1
    if (researcher !== settings.researcherProvider) n += 1
    if (auditor !== (settings.auditProvider ?? '')) n += 1
    if (maxTurns !== settings.maxTurns) n += 1
    return n
  }, [settings, planner, executor, researcher, auditor, maxTurns])

  const isDirty = changedCount > 0

  function markEdited<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setSavedAt(null)
      setSaveError(null)
    }
  }

  function resetDraft() {
    if (!settings) return
    setPlanner(settings.plannerProvider)
    setExecutor(settings.executorProvider)
    setResearcher(settings.researcherProvider)
    setAuditor(settings.auditProvider ?? '')
    setMaxTurns(settings.maxTurns)
    setSaveError(null)
    setSavedAt(null)
  }

  async function save() {
    if (!settings || maxTurnsError) return
    setBusy(true)
    setSaveError(null)
    setSavedAt(null)
    const patch: SettingsPatch = {
      plannerProvider: planner,
      executorProvider: executor,
      researcherProvider: researcher,
      auditProvider: auditor === '' && (settings.auditProvider ?? '') !== '' ? 'auto' : auditor,
      maxTurns: maxTurns === settings.maxTurns ? 0 : maxTurns,
    }
    try {
      await api.setSettings(sessionId, patch)
      setSettings({
        ...settings,
        plannerProvider: planner,
        executorProvider: executor,
        researcherProvider: researcher,
        auditProvider: auditor,
        maxTurns,
      })
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      const ss = String(now.getSeconds()).padStart(2, '0')
      setSavedAt(`${hh}:${mm}:${ss}`)
    } catch (err) {
      setSaveError(String(err))
    }
    setBusy(false)
  }

  return (
    <Dialog title="config" width={540} onClose={onClose}>
      {!settings ? (
        <div style={{ color: loadError ? 'var(--err)' : 'var(--faint)', fontSize: 12, padding: '8px 0' }}>
          {loadError ? `✗ ${loadError}` : '⠋ 加载会话配置…'}
        </div>
      ) : (
        <>
          {/* Compact session context line */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--faint)',
              fontSize: 11,
            }}
          >
            <strong style={{ color: 'var(--accent)' }}>{sessionName}</strong>
            <span>·</span>
            <span>{settings.role}</span>
            <span>·</span>
            <span data-hint={`上下文压缩策略：${settings.compactionStrategy || 'summary'}`}>
              mcp {settings.mcpServerCount}
            </span>
            {isDirty && (
              <span
                style={{
                  marginLeft: 'auto',
                  color: 'var(--warn)',
                  border: '1px solid color-mix(in srgb, var(--warn) 55%, var(--rule))',
                  borderRadius: 'var(--radius-xs, 2px)',
                  background: 'var(--warn-soft, color-mix(in srgb, var(--warn) 10%, transparent))',
                  padding: '0 6px',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                ● {changedCount} 未保存
              </span>
            )}
          </div>

          {/* Role Routing */}
          <div className="usa-section">
            <div className="usa-section-head">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span>Role Routing</span>
                <span
                  className="usa-hint-dot"
                  data-hint="修改后全局持久化，等同于终端 /planner /executor /researcher /auditor 命令"
                >
                  ?
                </span>
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: '7px 8px',
                  border: `1px solid ${
                    planner !== settings.plannerProvider ? 'var(--warn)' : 'var(--border-subtle, var(--rule))'
                  }`,
                  borderRadius: 'var(--radius-xs, 2px)',
                  background: 'var(--surface-2, transparent)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ ...labelStyle, color: ROLE_META.planner.color }}>planner</span>
                  <span className="usa-hint-dot" data-hint={ROLE_META.planner.hint}>
                    ?
                  </span>
                </span>
                {routeSelect(planner, routeOptions, markEdited(setPlanner), 'planner provider')}
              </label>

              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: '7px 8px',
                  border: `1px solid ${
                    executor !== settings.executorProvider ? 'var(--warn)' : 'var(--border-subtle, var(--rule))'
                  }`,
                  borderRadius: 'var(--radius-xs, 2px)',
                  background: 'var(--surface-2, transparent)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ ...labelStyle, color: ROLE_META.executor.color }}>executor</span>
                  <span className="usa-hint-dot" data-hint={ROLE_META.executor.hint}>
                    ?
                  </span>
                </span>
                {routeSelect(executor, routeOptions, markEdited(setExecutor), 'executor provider')}
              </label>

              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: '7px 8px',
                  border: `1px solid ${
                    researcher !== settings.researcherProvider ? 'var(--warn)' : 'var(--border-subtle, var(--rule))'
                  }`,
                  borderRadius: 'var(--radius-xs, 2px)',
                  background: 'var(--surface-2, transparent)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ ...labelStyle, color: ROLE_META.researcher.color }}>researcher</span>
                  <span className="usa-hint-dot" data-hint={ROLE_META.researcher.hint}>
                    ?
                  </span>
                </span>
                {routeSelect(researcher, routeOptions, markEdited(setResearcher), 'researcher provider')}
              </label>

              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: '7px 8px',
                  border: `1px solid ${
                    auditor !== (settings.auditProvider ?? '') ? 'var(--warn)' : 'var(--border-subtle, var(--rule))'
                  }`,
                  borderRadius: 'var(--radius-xs, 2px)',
                  background: 'var(--surface-2, transparent)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ ...labelStyle, color: ROLE_META.auditor.color }}>auditor</span>
                  <span className="usa-hint-dot" data-hint={ROLE_META.auditor.hint}>
                    ?
                  </span>
                </span>
                {routeSelect(auditor, routeOptions, markEdited(setAuditor), 'auditor provider')}
              </label>
            </div>
          </div>

          {/* Session max turns */}
          <div className="usa-section">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 150 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={labelStyle}>max turns</span>
                  <span className="usa-hint-dot" data-hint="当前会话单回合最大工具迭代步数（1–200，仅本会话生效）">
                    ?
                  </span>
                </span>
                <input
                  style={{
                    ...fieldStyle,
                    borderColor: maxTurnsError ? 'var(--err)' : maxTurns !== settings.maxTurns ? 'var(--warn)' : undefined,
                  }}
                  type="number"
                  min={1}
                  max={200}
                  value={maxTurns}
                  onChange={(e) => markEdited(setMaxTurns)(Number(e.target.value) || 0)}
                />
              </label>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, paddingBottom: 3 }}>
                {TURN_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="usa-pill"
                    data-active={maxTurns === p ? 'true' : undefined}
                    onClick={() => markEdited(setMaxTurns)(p)}
                    data-hint={`设为 ${p} 回合上限`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {maxTurnsError && <div style={{ color: 'var(--err)', fontSize: 11 }}>✗ {maxTurnsError}</div>}
          </div>

          {/* Collapsible Read-only Provider Inventory */}
          <div className="usa-section" style={{ padding: '7px 10px' }}>
            <div className="usa-section-head">
              <button
                type="button"
                onClick={() => setProvidersOpen((v) => !v)}
                aria-expanded={providersOpen}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'none',
                  border: 'none',
                  color: 'var(--muted)',
                  font: 'inherit',
                  fontSize: 10.5,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <span>{providersOpen ? '▾' : '▸'}</span>
                <span>Providers ({settings.providers.length})</span>
              </button>
              <span
                className="usa-hint-dot"
                data-hint="只读列表：API Key 仅保留在本地后端进程，不跨桥传至前端"
              >
                ?
              </span>
            </div>

            {providersOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, maxHeight: 110, overflowY: 'auto' }}>
                {settings.providers.map((p) => (
                  <div
                    key={p.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      color: 'var(--muted)',
                      padding: '2px 4px',
                      borderBottom: '1px solid var(--border-subtle, var(--rule))',
                    }}
                  >
                    <span style={{ color: 'var(--accent)', minWidth: 96, fontWeight: 600 }}>{p.name}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.model || '—'}
                    </span>
                    <span
                      style={{
                        color: 'var(--faint)',
                        fontSize: 10,
                        border: '1px solid var(--border-subtle, var(--rule))',
                        borderRadius: 'var(--radius-xs, 2px)',
                        padding: '0 5px',
                      }}
                    >
                      {p.type}
                    </span>
                  </div>
                ))}
                {settings.providers.length === 0 && (
                  <div style={{ color: 'var(--faint)' }}>○ 无 provider 配置</div>
                )}
              </div>
            )}
          </div>

          {saveError && (
            <div
              style={{
                color: 'var(--err)',
                fontSize: 11.5,
                padding: '6px 8px',
                border: '1px solid var(--err)',
                borderRadius: 'var(--radius-xs, 2px)',
                background: 'var(--err-soft, color-mix(in srgb, var(--err) 10%, var(--bg)))',
              }}
            >
              ✗ {saveError}
            </div>
          )}
          {savedAt && (
            <div
              style={{
                color: 'var(--ok)',
                fontSize: 11.5,
                padding: '6px 8px',
                border: '1px solid var(--ok)',
                borderRadius: 'var(--radius-xs, 2px)',
                background: 'var(--ok-soft, color-mix(in srgb, var(--ok) 10%, var(--bg)))',
              }}
            >
              ✓ 已保存 · {savedAt}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 10.5, color: isDirty ? 'var(--warn)' : 'var(--faint)' }}>
              {isDirty ? `${changedCount} 项待保存` : '已同步'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {isDirty && (
                <Btn type="button" onClick={resetDraft} disabled={busy} data-hint="放弃未保存的修改">
                  reset
                </Btn>
              )}
              <Btn type="button" onClick={onClose}>
                close
              </Btn>
              <Btn
                type="button"
                tone="accent"
                onClick={save}
                disabled={busy || Boolean(maxTurnsError)}
                style={{
                  borderColor: 'var(--accent)',
                  background: isDirty
                    ? 'color-mix(in srgb, var(--accent) 22%, transparent)'
                    : 'var(--accent-soft, color-mix(in srgb, var(--accent) 10%, transparent))',
                  fontWeight: 600,
                }}
              >
                {busy ? 'saving…' : 'save'}
              </Btn>
            </div>
          </div>
        </>
      )}
    </Dialog>
  )
}
