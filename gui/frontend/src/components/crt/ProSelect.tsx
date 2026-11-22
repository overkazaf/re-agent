// ProSelect — zero-dependency IDE-caliber custom select component.
// Features:
//   - Rich trigger with optional color swatches, leading icon, label, badge & animated chevron
//   - Portal-mounted popover (never clipped by overflow:hidden) with smart viewport-collision flip
//   - Flat or grouped options with descriptions, swatches, badges, disabled state & active checkmark
//   - Optional quick search (defaults to options.length > 7)
//   - Full keyboard ergonomics (Enter/Space/Arrow/Home/End/typeahead + LIFO escStack integration)
//   - Visually hidden synced native <select> so Playwright selectOption() E2E tests stay 100% native
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { pushEsc } from '../../lib/escStack'

export interface ProSelectOption<T extends string = string> {
  value: T
  label: string
  group?: string
  description?: string
  swatches?: readonly string[]
  badge?: string
  icon?: string
  keywords?: string
  disabled?: boolean
}

export interface ProSelectProps<T extends string = string> {
  value: T
  options: readonly ProSelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  disabled?: boolean
  /** 'sm' for dense toolbars/TopBar; 'md' for dialogs & forms */
  size?: 'sm' | 'md'
  /** Show quick search input inside popover; defaults to options.length > 7 */
  searchable?: boolean
  searchPlaceholder?: string
  /** Minimum popover width in px (defaults to trigger width) */
  popoverMinWidth?: number
  /** Horizontal anchor preference when space permits */
  align?: 'left' | 'right'
  /** Show the selected option's badge inside the trigger button (defaults to true) */
  showTriggerBadge?: boolean
  ariaLabel?: string
  title?: string
  className?: string
  style?: CSSProperties
  fullWidth?: boolean
  id?: string
  testId?: string
}

export interface GroupedProSelectSection<T extends string = string> {
  group: string | null
  items: Array<{ option: ProSelectOption<T>; flatIndex: number }>
}

export interface PopoverRectInput {
  top: number
  bottom: number
  left: number
  right: number
  width: number
}

export interface PopoverPosition {
  top: number
  left: number
  minWidth: number
  maxHeight: number
  placement: 'bottom' | 'top'
}

// ---------- pure helpers (exported for unit testing) ----------

export function filterProSelectOptions<T extends string>(
  options: readonly ProSelectOption<T>[],
  query: string,
): ProSelectOption<T>[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  const tokens = q.split(/\s+/).filter(Boolean)
  return options.filter((opt) => {
    const haystack = [
      opt.label,
      opt.value,
      opt.group ?? '',
      opt.description ?? '',
      opt.badge ?? '',
      opt.keywords ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return tokens.every((tok) => haystack.includes(tok))
  })
}

export function groupProSelectOptions<T extends string>(
  options: readonly ProSelectOption<T>[],
): GroupedProSelectSection<T>[] {
  const sections: GroupedProSelectSection<T>[] = []
  const byGroup = new Map<string | null, GroupedProSelectSection<T>>()
  options.forEach((option, flatIndex) => {
    const key = option.group ?? null
    let sec = byGroup.get(key)
    if (!sec) {
      sec = { group: key, items: [] }
      byGroup.set(key, sec)
      sections.push(sec)
    }
    sec.items.push({ option, flatIndex })
  })
  return sections
}

export function findNextEnabledIndex<T extends string>(
  options: readonly ProSelectOption<T>[],
  currentIndex: number,
  delta: 1 | -1,
): number {
  const len = options.length
  if (len === 0) return -1
  let idx = currentIndex
  for (let step = 0; step < len; step += 1) {
    if (idx < 0 || idx >= len) {
      idx = delta === 1 ? 0 : len - 1
    } else {
      idx = (idx + delta + len) % len
    }
    if (!options[idx].disabled) return idx
  }
  return -1
}

export function findBoundaryEnabledIndex<T extends string>(
  options: readonly ProSelectOption<T>[],
  edge: 'first' | 'last',
): number {
  if (edge === 'first') {
    for (let i = 0; i < options.length; i += 1) {
      if (!options[i].disabled) return i
    }
    return -1
  }
  for (let i = options.length - 1; i >= 0; i -= 1) {
    if (!options[i].disabled) return i
  }
  return -1
}

export function findTypeaheadIndex<T extends string>(
  options: readonly ProSelectOption<T>[],
  prefix: string,
  startIndex: number,
): number {
  const needle = prefix.trim().toLowerCase()
  if (!needle || options.length === 0) return -1
  const len = options.length
  const begin = startIndex >= 0 && startIndex < len ? (startIndex + 1) % len : 0
  for (let offset = 0; offset < len; offset += 1) {
    const idx = (begin + offset) % len
    const opt = options[idx]
    if (opt.disabled) continue
    if (opt.label.toLowerCase().startsWith(needle) || opt.value.toLowerCase().startsWith(needle)) {
      return idx
    }
  }
  return -1
}

export function computePopoverPosition(
  trigger: PopoverRectInput,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'left' | 'right' = 'left',
  margin = 8,
  gap = 4,
): PopoverPosition {
  const desiredWidth = Math.min(Math.max(trigger.width, popover.width), Math.max(120, viewport.width - margin * 2))
  const spaceBelow = Math.max(0, viewport.height - trigger.bottom - gap - margin)
  const spaceAbove = Math.max(0, trigger.top - gap - margin)
  const capHeight = Math.min(440, Math.max(120, viewport.height - margin * 2))

  let placement: 'bottom' | 'top' = 'bottom'
  if (popover.height > spaceBelow && spaceAbove > spaceBelow) {
    placement = 'top'
  }

  const availHeight = placement === 'bottom' ? spaceBelow : spaceAbove
  const maxHeight = Math.max(96, Math.min(capHeight, availHeight || capHeight))
  const effectiveHeight = Math.min(popover.height, maxHeight)

  const rawTop = placement === 'bottom' ? trigger.bottom + gap : trigger.top - gap - effectiveHeight
  const top = Math.max(margin, Math.min(rawTop, viewport.height - margin - effectiveHeight))

  let left = align === 'right' ? trigger.right - desiredWidth : trigger.left
  if (left + desiredWidth > viewport.width - margin) {
    left = viewport.width - margin - desiredWidth
  }
  if (left < margin) {
    left = margin
  }

  return {
    top: Math.round(top),
    left: Math.round(left),
    minWidth: Math.round(desiredWidth),
    maxHeight: Math.round(maxHeight),
    placement,
  }
}

// ---------- component ----------

function SwatchDots({ swatches }: { swatches?: readonly string[] }) {
  if (!swatches || swatches.length === 0) return null
  return (
    <span className="pro-select__swatches" aria-hidden="true">
      {swatches.slice(0, 3).map((color, i) => (
        <span key={`${color}-${i}`} className="pro-select__swatch" style={{ backgroundColor: color }} />
      ))}
    </span>
  )
}

function ChevronSvg() {
  return (
    <svg
      className="pro-select__chevron"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5L6 8L9.5 4.5" />
    </svg>
  )
}

export function ProSelect<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  size = 'md',
  searchable,
  searchPlaceholder = 'Filter options…',
  popoverMinWidth,
  align = 'left',
  showTriggerBadge = true,
  ariaLabel,
  title,
  className,
  style,
  fullWidth = false,
  id,
  testId,
}: ProSelectProps<T>) {
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(-1)
  const [pos, setPos] = useState<PopoverPosition | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeaheadRef = useRef<{ buf: string; timer: ReturnType<typeof setTimeout> | null }>({
    buf: '',
    timer: null,
  })

  const showSearch = searchable ?? options.length > 7
  const selectedOption = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value])
  const filtered = useMemo(() => filterProSelectOptions(options, showSearch ? query : ''), [options, query, showSearch])
  const sections = useMemo(() => groupProSelectOptions(filtered), [filtered])

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
    }
  }, [])

  const openMenu = useCallback(
    (initialEdge?: 'first' | 'last') => {
      if (disabled) return
      setQuery('')
      let nextIdx = options.findIndex((o) => o.value === value && !o.disabled)
      if (initialEdge === 'first') nextIdx = findBoundaryEnabledIndex(options, 'first')
      else if (initialEdge === 'last') nextIdx = findBoundaryEnabledIndex(options, 'last')
      else if (nextIdx < 0) nextIdx = findBoundaryEnabledIndex(options, 'first')
      setActiveIdx(nextIdx)
      setOpen(true)
    },
    [disabled, options, value],
  )

  const commit = useCallback(
    (opt: ProSelectOption<T> | undefined) => {
      if (!opt || opt.disabled) return
      if (opt.value !== value) onChange(opt.value)
      close(true)
    },
    [onChange, value, close],
  )

  // Register top-of-stack Esc dismissal so closing popover never closes parent Dialog
  useEffect(() => {
    if (!open) return
    return pushEsc(() => close(true))
  }, [open, close])

  // Focus search input when opening a searchable popover
  useEffect(() => {
    if (!open) return
    if (showSearch) {
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }))
    }
  }, [open, showSearch])

  // Reset active highlight when search query narrows filtered list
  useEffect(() => {
    if (!open) return
    setActiveIdx((cur) => {
      if (cur >= 0 && cur < filtered.length && !filtered[cur].disabled) return cur
      const selIdx = filtered.findIndex((o) => o.value === value && !o.disabled)
      return selIdx >= 0 ? selIdx : findBoundaryEnabledIndex(filtered, 'first')
    })
  }, [open, filtered, value])

  // Keep active option visible inside scroll viewport
  useEffect(() => {
    if (!open || activeIdx < 0) return
    const item = listRef.current?.querySelector<HTMLElement>(`[data-opt-idx="${activeIdx}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIdx])

  // Compute smart viewport-collision position
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const popEl = popoverRef.current
    const measuredWidth = Math.max(popoverMinWidth ?? 0, rect.width, popEl?.offsetWidth ?? 0)
    const measuredHeight = popEl?.offsetHeight || Math.min(320, filtered.length * 42 + (showSearch ? 44 : 12))
    setPos(
      computePopoverPosition(
        {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        },
        { width: measuredWidth, height: measuredHeight },
        { width: window.innerWidth, height: window.innerHeight },
        align,
      ),
    )
  }, [align, filtered.length, popoverMinWidth, showSearch])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const raf = requestAnimationFrame(updatePosition)
    const onReflow = () => updatePosition()
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, updatePosition])

  // Outside click closes popover
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [open, close])

  // Cleanup typeahead timer on unmount
  useEffect(() => {
    return () => {
      if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer)
    }
  }, [])

  const runTypeahead = useCallback(
    (char: string) => {
      const state = typeaheadRef.current
      if (state.timer) clearTimeout(state.timer)
      state.buf += char
      state.timer = setTimeout(() => {
        state.buf = ''
        state.timer = null
      }, 600)
      const list = open ? filtered : options
      const start = open ? activeIdx : options.findIndex((o) => o.value === value)
      const hit = findTypeaheadIndex(list, state.buf, start)
      if (hit >= 0) {
        if (open) {
          setActiveIdx(hit)
        } else {
          const opt = options[hit]
          if (opt && !opt.disabled && opt.value !== value) onChange(opt.value)
        }
      }
    },
    [open, filtered, options, activeIdx, value, onChange],
  )

  const handleNavKey = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>, fromSearch: boolean) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (!open) {
          openMenu()
        } else {
          setActiveIdx((cur) => findNextEnabledIndex(filtered, cur, 1))
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!open) {
          openMenu('last')
        } else {
          setActiveIdx((cur) => findNextEnabledIndex(filtered, cur, -1))
        }
        return
      }
      if (e.key === 'Home' && (!fromSearch || query.length === 0)) {
        e.preventDefault()
        if (!open) openMenu('first')
        else setActiveIdx(findBoundaryEnabledIndex(filtered, 'first'))
        return
      }
      if (e.key === 'End' && (!fromSearch || query.length === 0)) {
        e.preventDefault()
        if (!open) openMenu('last')
        else setActiveIdx(findBoundaryEnabledIndex(filtered, 'last'))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (!open) openMenu()
        else commit(filtered[activeIdx])
        return
      }
      if (e.key === ' ' && !fromSearch) {
        e.preventDefault()
        if (!open) openMenu()
        else commit(filtered[activeIdx])
        return
      }
      if (e.key === 'Tab' && open) {
        close(false)
        return
      }
      if (!fromSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        runTypeahead(e.key)
      }
    },
    [open, openMenu, filtered, activeIdx, commit, close, query.length, runTypeahead],
  )

  const rootClasses = [
    'pro-select',
    `pro-select--${size}`,
    fullWidth ? 'pro-select--full' : '',
    open ? 'pro-select--open' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const popoverNode =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`pro-select__popover${pos?.placement === 'top' ? ' pro-select__popover--top' : ''}`}
            style={{
              top: pos ? pos.top : -9999,
              left: pos ? pos.left : -9999,
              minWidth: pos ? pos.minWidth : popoverMinWidth ?? 180,
              maxWidth: 'calc(100vw - 16px)',
              maxHeight: pos ? pos.maxHeight : 320,
              visibility: pos ? 'visible' : 'hidden',
            }}
            data-testid={testId ? `${testId}-popover` : undefined}
          >
            {showSearch && (
              <div className="pro-select__search-wrap">
                <span className="pro-select__search-glyph" aria-hidden="true">
                  ⌕
                </span>
                <input
                  ref={searchRef}
                  type="text"
                  className="pro-select__search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => handleNavKey(e, true)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="pro-select__search-count">
                  {filtered.length}/{options.length}
                </span>
              </div>
            )}

            <div
              ref={listRef}
              id={listboxId}
              className="pro-select__list"
              role="listbox"
              aria-label={ariaLabel ?? title ?? 'Options'}
            >
              {filtered.length === 0 ? (
                <div className="pro-select__empty">No matches for “{query}”</div>
              ) : (
                sections.map((section) => (
                  <div key={section.group ?? '__default__'} role="presentation">
                    {section.group && <div className="pro-select__group">{section.group}</div>}
                    {section.items.map(({ option, flatIndex }) => {
                      const isSelected = option.value === value
                      const isActive = flatIndex === activeIdx
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          aria-disabled={option.disabled || undefined}
                          disabled={option.disabled}
                          data-opt-idx={flatIndex}
                          data-value={option.value}
                          className={[
                            'pro-select__option',
                            isActive ? 'pro-select__option--active' : '',
                            isSelected ? 'pro-select__option--selected' : '',
                            option.disabled ? 'pro-select__option--disabled' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onMouseEnter={() => {
                            if (!option.disabled) setActiveIdx(flatIndex)
                          }}
                          onMouseDown={(e) => {
                            // Keep focus stable so blur/outside handlers never race click selection
                            e.preventDefault()
                          }}
                          onClick={() => commit(option)}
                        >
                          <span className="pro-select__option-main">
                            {option.swatches ? (
                              <SwatchDots swatches={option.swatches} />
                            ) : option.icon ? (
                              <span className="pro-select__icon" aria-hidden="true">
                                {option.icon}
                              </span>
                            ) : null}
                            <span className="pro-select__option-text">
                              <span className="pro-select__option-title-row">
                                <span className="pro-select__option-label">{option.label}</span>
                              </span>
                              {option.description && (
                                <span className="pro-select__option-desc">{option.description}</span>
                              )}
                            </span>
                          </span>
                          <span className="pro-select__option-right">
                            {option.badge && <span className="pro-select__badge">{option.badge}</span>}
                            <span className="pro-select__check" aria-hidden="true">
                              {isSelected ? '✓' : ''}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div ref={rootRef} className={rootClasses} style={style} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        className="pro-select__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={(e) => {
          e.preventDefault()
          if (open) close(false)
          else openMenu()
        }}
        onKeyDown={(e) => handleNavKey(e, false)}
      >
        <span className="pro-select__value">
          {selectedOption?.swatches ? (
            <SwatchDots swatches={selectedOption.swatches} />
          ) : selectedOption?.icon ? (
            <span className="pro-select__icon" aria-hidden="true">
              {selectedOption.icon}
            </span>
          ) : null}
          {selectedOption ? (
            <span className="pro-select__label">{selectedOption.label}</span>
          ) : (
            <span className="pro-select__label pro-select__placeholder">{placeholder}</span>
          )}
          {showTriggerBadge && selectedOption?.badge && (
            <span className="pro-select__badge">{selectedOption.badge}</span>
          )}
        </span>
        <ChevronSvg />
      </button>

      {/* Synced visually hidden native <select> for Playwright selectOption() compatibility */}
      <select
        id={id}
        className="pro-select__native"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const next = e.target.value as T
          if (next !== value) onChange(next)
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>

      {popoverNode}
    </div>
  )
}
