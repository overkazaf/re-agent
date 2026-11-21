import { describe, expect, it } from 'vitest'
import { formatChord, fuzzyMatch, splitHighlightSegments } from './shortcuts'
import { escStackDepth, hasEscHandler, pushEsc } from '../../lib/escStack'

describe('fuzzyMatch', () => {
  it('matches empty query with zero score', () => {
    expect(fuzzyMatch('', '/workflow')).toEqual({ matched: true, score: 0, indices: [] })
  })

  it('prefers exact and prefix matches over scattered subsequences', () => {
    const exact = fuzzyMatch('/help', '/help')
    const prefix = fuzzyMatch('/he', '/help')
    const subseq = fuzzyMatch('/wf', '/workflow')
    expect(exact.matched).toBe(true)
    expect(prefix.matched).toBe(true)
    expect(subseq.matched).toBe(true)
    expect(exact.score).toBeGreaterThan(prefix.score)
    expect(subseq.indices).toEqual([0, 1, 5])
  })

  it('matches across spaces and word boundaries', () => {
    const res = fuzzyMatch('bin rad', 'Binary Forensic Radar')
    expect(res.matched).toBe(true)
    expect(res.indices.length).toBe(6)
  })

  it('returns matched=false when characters are missing or out of order', () => {
    expect(fuzzyMatch('xyz', 'Binary Forensic Radar').matched).toBe(false)
    expect(fuzzyMatch('ba', 'abc').matched).toBe(false)
  })
})

describe('splitHighlightSegments', () => {
  it('partitions matched and unmatched characters cleanly', () => {
    expect(splitHighlightSegments('/workflow', [0, 1, 5])).toEqual([
      { text: '/w', hit: true },
      { text: 'ork', hit: false },
      { text: 'f', hit: true },
      { text: 'low', hit: false },
    ])
  })
})

describe('formatChord', () => {
  it('formats Mac and non-Mac chords', () => {
    expect(formatChord(['Mod', 'Shift', 'K'], true)).toEqual(['⌘', '⇧', 'K'])
    expect(formatChord(['Mod', 'Shift', 'K'], false)).toEqual(['Ctrl', 'Shift', 'K'])
  })
})

describe('escStack', () => {
  it('tracks stack depth and unregisters cleanly in LIFO order', () => {
    const startDepth = escStackDepth()
    const calls: string[] = []
    const un1 = pushEsc(() => calls.push('first'))
    const un2 = pushEsc(() => calls.push('second'))
    expect(hasEscHandler()).toBe(true)
    expect(escStackDepth()).toBe(startDepth + 2)
    un2()
    expect(escStackDepth()).toBe(startDepth + 1)
    un1()
    expect(escStackDepth()).toBe(startDepth)
  })
})
