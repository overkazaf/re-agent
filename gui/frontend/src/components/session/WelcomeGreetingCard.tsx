// WelcomeGreetingCard — sleek, minimalist, non-blocking startup greeting &
// clickable next-task suggestion card backed by the user's configured LLM
// and versioned local cache. Uses contextual `data-hint` tooltips across all 10 themes.
import type { GreetingResponse, GreetingSuggestion } from '../../lib/localCache'
import { formatGreetingSourceChip, greetingActionGlyph } from '../../lib/proactiveGreeting'
import './welcomeGreeting.css'

export interface WelcomeGreetingCardProps {
  greeting: GreetingResponse | null
  refreshing?: boolean
  dismissed?: boolean
  compact?: boolean
  /** When false and dismissed, hides the inline restore pill (e.g. parent toolbar owns it). */
  showRestorePill?: boolean
  onDismiss: () => void
  onRestore: () => void
  onRefresh: () => void
  onSelectSuggestion: (suggestion: GreetingSuggestion) => void
}

export function WelcomeGreetingCard({
  greeting,
  refreshing = false,
  dismissed = false,
  compact = false,
  showRestorePill = true,
  onDismiss,
  onRestore,
  onRefresh,
  onSelectSuggestion,
}: WelcomeGreetingCardProps) {
  if (!greeting) return null

  if (dismissed) {
    if (!showRestorePill) return null
    return (
      <div className="wgc-restore-wrap">
        <button
          type="button"
          className="wgc-restore-pill"
          onClick={onRestore}
          data-hint="展开智能问候与下一步任务建议"
          aria-label="展开智能问候卡片"
        >
          <span>✦</span>
          <span>{greeting.salutation}</span>
        </button>
      </div>
    )
  }

  const chip = formatGreetingSourceChip(greeting)

  return (
    <section
      className="wgc-card"
      data-compact={compact ? 'true' : undefined}
      data-source={greeting.source}
      aria-label="智能启动问候与任务建议"
    >
      <div className="wgc-head">
        <span className="wgc-salutation">
          <span className="wgc-glyph" aria-hidden>
            ✦
          </span>
          <span>{greeting.salutation}</span>
        </span>

        <span
          className="wgc-model-chip"
          data-source={greeting.source}
          data-hint={chip.hint}
        >
          {chip.label}
        </span>

        {refreshing && (
          <span className="wgc-sync-badge" aria-live="polite">
            ⠋ 同步中
          </span>
        )}

        <div className="wgc-head-actions">
          <button
            type="button"
            className="wgc-icon-btn"
            onClick={onRefresh}
            disabled={refreshing}
            data-hint="基于最新上下文重新让当前 LLM 生成建议"
            aria-label="刷新智能问候与建议"
          >
            ↻
          </button>
          <button
            type="button"
            className="wgc-icon-btn"
            onClick={onDismiss}
            data-hint="收起问候卡片（随时可点 ✦ 重新展开）"
            aria-label="收起问候卡片"
          >
            ✕
          </button>
        </div>
      </div>

      <p className="wgc-summary">{greeting.summary}</p>

      {greeting.suggestions.length > 0 && (
        <div className="wgc-actions" role="group" aria-label="下一步任务建议">
          {greeting.suggestions.map((item, idx) => (
            <button
              key={item.id || `${item.actionKind}-${idx}`}
              type="button"
              className="wgc-action-btn"
              data-primary={idx === 0 ? 'true' : undefined}
              data-action-kind={item.actionKind}
              onClick={() => onSelectSuggestion(item)}
              data-hint={item.reason}
            >
              <span className="wgc-action-glyph" aria-hidden>
                {greetingActionGlyph(item.actionKind)}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
