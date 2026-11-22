import { describe, expect, it } from 'vitest'
import {
  computeHintPosition,
  DEFAULT_HINT_DELAY_MS,
  DEFAULT_WARM_WINDOW_MS,
  normalizeHintSide,
  parseHintKbd,
  resolveShowDelay,
} from './HintOverlay'

describe('HintOverlay pure helpers', () => {
  it('normalizes preferred side values with bottom fallback', () => {
    expect(normalizeHintSide('top')).toBe('top')
    expect(normalizeHintSide('bottom')).toBe('bottom')
    expect(normalizeHintSide('left')).toBe('left')
    expect(normalizeHintSide('right')).toBe('right')
    expect(normalizeHintSide(undefined)).toBe('bottom')
    expect(normalizeHintSide(null)).toBe('bottom')
    expect(normalizeHintSide('diagonal')).toBe('bottom')
  })

  it('parses single and slash-separated keyboard hint badges', () => {
    expect(parseHintKbd(undefined)).toEqual([])
    expect(parseHintKbd('')).toEqual([])
    expect(parseHintKbd('⌘K')).toEqual(['⌘K'])
    expect(parseHintKbd('? / ⌘/')).toEqual(['?', '⌘/'])
    expect(parseHintKbd(' ⌘⇧T ')).toEqual(['⌘⇧T'])
  })

  it('applies cold hover delay and warm-tooltip instant handoff within 300ms', () => {
    // Cold hover
    expect(resolveShowDelay(false, null, 1000)).toBe(DEFAULT_HINT_DELAY_MS)
    // Already showing another hint -> instant switch
    expect(resolveShowDelay(true, null, 1000)).toBe(0)
    // Recently hidden within warm window -> instant show
    expect(resolveShowDelay(false, 1000, 1000 + DEFAULT_WARM_WINDOW_MS)).toBe(0)
    expect(resolveShowDelay(false, 1000, 1180)).toBe(0)
    // Past warm window -> back to cold delay
    expect(resolveShowDelay(false, 1000, 1000 + DEFAULT_WARM_WINDOW_MS + 1)).toBe(DEFAULT_HINT_DELAY_MS)
  })

  it('places tooltip below anchor centered by default and clamps inside viewport edges', () => {
    const pos = computeHintPosition(
      { top: 10, bottom: 34, left: 200, right: 260, width: 60, height: 24 },
      { width: 160, height: 30 },
      { width: 1440, height: 900 },
      'bottom',
    )
    expect(pos.placement).toBe('bottom')
    expect(pos.top).toBe(41) // 34 + 7 gap
    expect(pos.left).toBe(150) // 200 + 30 - 80

    // Clamps right edge within 8px margin
    const rightEdge = computeHintPosition(
      { top: 10, bottom: 34, left: 1390, right: 1430, width: 40, height: 24 },
      { width: 220, height: 30 },
      { width: 1440, height: 900 },
      'bottom',
    )
    expect(rightEdge.left).toBe(1440 - 8 - 220)

    // Clamps left edge within 8px margin
    const leftEdge = computeHintPosition(
      { top: 10, bottom: 34, left: 4, right: 28, width: 24, height: 24 },
      { width: 180, height: 30 },
      { width: 1440, height: 900 },
      'bottom',
    )
    expect(leftEdge.left).toBe(8)
  })

  it('auto-flips vertical placement near bottom and top viewport edges', () => {
    const flipUp = computeHintPosition(
      { top: 860, bottom: 888, left: 500, right: 580, width: 80, height: 28 },
      { width: 180, height: 36 },
      { width: 1440, height: 900 },
      'bottom',
    )
    expect(flipUp.placement).toBe('top')
    expect(flipUp.top).toBe(860 - 7 - 36)

    const flipDown = computeHintPosition(
      { top: 8, bottom: 32, left: 500, right: 580, width: 80, height: 24 },
      { width: 180, height: 36 },
      { width: 1440, height: 900 },
      'top',
    )
    expect(flipDown.placement).toBe('bottom')
    expect(flipDown.top).toBe(32 + 7)
  })

  it('auto-flips horizontal placement near right and left viewport edges', () => {
    const flipLeft = computeHintPosition(
      { top: 400, bottom: 428, left: 1380, right: 1428, width: 48, height: 28 },
      { width: 200, height: 32 },
      { width: 1440, height: 900 },
      'right',
    )
    expect(flipLeft.placement).toBe('left')
    expect(flipLeft.left).toBe(1380 - 7 - 200)

    const flipRight = computeHintPosition(
      { top: 400, bottom: 428, left: 12, right: 48, width: 36, height: 28 },
      { width: 200, height: 32 },
      { width: 1440, height: 900 },
      'left',
    )
    expect(flipRight.placement).toBe('right')
    expect(flipRight.left).toBe(48 + 7)
  })
})
