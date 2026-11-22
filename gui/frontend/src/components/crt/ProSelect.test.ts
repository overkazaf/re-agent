import { describe, expect, it } from 'vitest'
import {
  computePopoverPosition,
  filterProSelectOptions,
  findBoundaryEnabledIndex,
  findNextEnabledIndex,
  findTypeaheadIndex,
  groupProSelectOptions,
  type ProSelectOption,
} from './ProSelect'
import { getThemeMeta, THEME_CATALOG, THEME_NAMES } from '../../theme/ThemeContext'
import { THEATER_PALETTES } from '../../three/ThemeMaterials'

const SAMPLE_OPTIONS: ProSelectOption[] = [
  {
    value: 'deck',
    label: 'Cyberdeck',
    group: 'CRT Phosphor',
    description: 'Cyan obsidian default',
    swatches: ['#070b11', '#22d3ee', '#a78bfa'],
  },
  {
    value: 'amber',
    label: 'Amber P3',
    group: 'CRT Phosphor',
    description: 'Warm amber phosphor',
    disabled: true,
  },
  {
    value: 'obsidian',
    label: 'Obsidian Violet',
    group: 'Forensic IDE',
    description: 'Deep graphite + electric violet',
    badge: 'PRO',
    keywords: 'binary ninja purple',
  },
  {
    value: 'paper',
    label: 'Forensic Paper',
    group: 'Daylight Lab',
    description: 'Light alabaster theme',
    badge: 'LIGHT',
  },
]

describe('ProSelect helpers', () => {
  it('filters options across label, value, group, description, badge, and keywords', () => {
    expect(filterProSelectOptions(SAMPLE_OPTIONS, '')).toHaveLength(4)
    expect(filterProSelectOptions(SAMPLE_OPTIONS, 'ninja').map((o) => o.value)).toEqual(['obsidian'])
    expect(filterProSelectOptions(SAMPLE_OPTIONS, 'daylight light').map((o) => o.value)).toEqual(['paper'])
    expect(filterProSelectOptions(SAMPLE_OPTIONS, 'crt').map((o) => o.value)).toEqual(['deck', 'amber'])
    expect(filterProSelectOptions(SAMPLE_OPTIONS, 'nonexistent')).toEqual([])
  })

  it('groups options preserving encounter order and flat indices', () => {
    const groups = groupProSelectOptions(SAMPLE_OPTIONS)
    expect(groups.map((g) => g.group)).toEqual(['CRT Phosphor', 'Forensic IDE', 'Daylight Lab'])
    expect(groups[0].items.map((x) => x.flatIndex)).toEqual([0, 1])
    expect(groups[1].items.map((x) => x.flatIndex)).toEqual([2])
    expect(groups[2].items.map((x) => x.flatIndex)).toEqual([3])
  })

  it('steps through enabled options wrapping around and skipping disabled entries', () => {
    expect(findNextEnabledIndex(SAMPLE_OPTIONS, 0, 1)).toBe(2) // skips disabled amber (1)
    expect(findNextEnabledIndex(SAMPLE_OPTIONS, 3, 1)).toBe(0) // wraps to start
    expect(findNextEnabledIndex(SAMPLE_OPTIONS, 2, -1)).toBe(0) // skips disabled amber (1) backwards
    expect(findNextEnabledIndex(SAMPLE_OPTIONS, 0, -1)).toBe(3) // wraps to end
    expect(findNextEnabledIndex([{ value: 'x', label: 'X', disabled: true }], 0, 1)).toBe(-1)
  })

  it('finds first and last enabled boundaries', () => {
    const opts: ProSelectOption[] = [
      { value: 'a', label: 'A', disabled: true },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
      { value: 'd', label: 'D', disabled: true },
    ]
    expect(findBoundaryEnabledIndex(opts, 'first')).toBe(1)
    expect(findBoundaryEnabledIndex(opts, 'last')).toBe(2)
  })

  it('matches typeahead prefixes cyclically while skipping disabled items', () => {
    expect(findTypeaheadIndex(SAMPLE_OPTIONS, 'o', 0)).toBe(2)
    expect(findTypeaheadIndex(SAMPLE_OPTIONS, 'a', 0)).toBe(-1) // amber is disabled
    expect(findTypeaheadIndex(SAMPLE_OPTIONS, 'p', 2)).toBe(3) // matches value "paper"
    expect(findTypeaheadIndex(SAMPLE_OPTIONS, 'c', 3)).toBe(0) // wraps to "Cyberdeck"
  })

  it('positions popover below by default and flips upward near bottom viewport edge', () => {
    const down = computePopoverPosition(
      { top: 40, bottom: 68, left: 200, right: 320, width: 120 },
      { width: 260, height: 240 },
      { width: 1440, height: 900 },
      'left',
    )
    expect(down.placement).toBe('bottom')
    expect(down.top).toBe(72)
    expect(down.left).toBe(200)

    const up = computePopoverPosition(
      { top: 820, bottom: 850, left: 1260, right: 1420, width: 160 },
      { width: 280, height: 260 },
      { width: 1440, height: 900 },
      'right',
    )
    expect(up.placement).toBe('top')
    expect(up.top).toBeLessThan(820)
    expect(up.left + up.minWidth).toBeLessThanOrEqual(1440 - 8)
  })
})

describe('10-theme catalog & 3D Theater palettes', () => {
  it('preserves all 4 legacy IDs and ships all 10 curated themes with complete metadata', () => {
    expect(THEME_NAMES).toHaveLength(10)
    expect(THEME_NAMES.slice(0, 4)).toEqual(['deck', 'amber', 'matrix', 'mono'])
    expect(THEME_CATALOG.map((t) => t.id)).toEqual([...THEME_NAMES])

    for (const id of THEME_NAMES) {
      const meta = getThemeMeta(id)
      expect(meta.id).toBe(id)
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.swatches).toHaveLength(3)
      expect(THEATER_PALETTES[id]).toBeDefined()
    }

    expect(getThemeMeta('paper').mode).toBe('light')
    expect(THEATER_PALETTES.paper.isLight).toBe(true)
    expect(THEME_CATALOG.filter((t) => t.mode === 'dark')).toHaveLength(9)
  })
})
