import { describe, expect, it } from 'vitest'
import {
  anyRefMatcher,
  derivePrefix,
  formatIssueRef,
  formatLong,
  formatSessionRef,
  formatShort,
  indexForLetter,
  isValidPrefix,
  letterForIndex,
  parseAnyRef,
  parseIssueRef,
  parseSessionRef,
  resolveSessionIdentifier,
  truncateTitle,
} from './refs'

const none = () => false

describe('derivePrefix', () => {
  it('takes the first three letters uppercased', () => {
    expect(derivePrefix('podium', none)).toBe('POD')
    expect(derivePrefix('MyApp', none)).toBe('MYA')
  })

  it('strips non-letters before deriving', () => {
    expect(derivePrefix('my-cool-repo', none)).toBe('MYC')
    expect(derivePrefix('123abc', none)).toBe('ABC')
  })

  it('pads short names to the minimum length', () => {
    expect(isValidPrefix(derivePrefix('go', none))).toBe(true)
    expect(derivePrefix('a', none)).toMatch(/^[A-Z]{2,5}$/)
  })

  it('falls back to the consonant-skip variant on collision', () => {
    const taken = new Set(['POD'])
    expect(derivePrefix('podium', (p) => taken.has(p))).toBe('PDM')
  })

  it('bumps the last letter when both base and consonant-skip collide', () => {
    const taken = new Set(['POD', 'PDM'])
    const out = derivePrefix('podium', (p) => taken.has(p))
    expect(taken.has(out)).toBe(false)
    expect(isValidPrefix(out)).toBe(true)
  })

  it('always yields a unique valid prefix under heavy collision', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const p = derivePrefix('podium', (x) => taken.has(x))
      expect(isValidPrefix(p)).toBe(true)
      expect(taken.has(p)).toBe(false)
      taken.add(p)
    }
    expect(taken.size).toBe(50)
  })
})

describe('letter allocation', () => {
  it('maps indexes to spreadsheet columns', () => {
    expect(letterForIndex(0)).toBe('A')
    expect(letterForIndex(25)).toBe('Z')
    expect(letterForIndex(26)).toBe('AA')
    expect(letterForIndex(27)).toBe('AB')
    expect(letterForIndex(51)).toBe('AZ')
    expect(letterForIndex(52)).toBe('BA')
  })

  it('round-trips index <-> letter', () => {
    for (let i = 0; i < 1000; i++) {
      expect(indexForLetter(letterForIndex(i))).toBe(i)
    }
  })

  it('crosses Z -> AA', () => {
    expect(letterForIndex(indexForLetter('Z') + 1)).toBe('AA')
  })
})

describe('ref grammar', () => {
  it('parses and formats issue refs round-trip', () => {
    expect(parseIssueRef('POD-13')).toEqual({ prefix: 'POD', seq: 13 })
    expect(formatIssueRef('POD', 13)).toBe('POD-13')
    expect(parseIssueRef(formatIssueRef('ABCDE', 7))).toEqual({ prefix: 'ABCDE', seq: 7 })
  })

  it('rejects non-issue tokens', () => {
    expect(parseIssueRef('UTF-8-thing')).toBeNull()
    expect(parseIssueRef('TOOLONG-1')).toBeNull()
    expect(parseIssueRef('P-1')).toBeNull()
  })

  it('parses session refs round-trip', () => {
    expect(parseSessionRef('POD-13-A')).toEqual({ prefix: 'POD', seq: 13, letter: 'A' })
    expect(parseSessionRef('POD-DRAFT-3')).toEqual({ prefix: 'POD', draft: 3 })
    expect(formatSessionRef({ prefix: 'POD', seq: 13, letter: 'AA' })).toBe('POD-13-AA')
    expect(formatSessionRef({ prefix: 'POD', draft: 3 })).toBe('POD-DRAFT-3')
  })

  it('disambiguates session vs issue in parseAnyRef', () => {
    expect(parseAnyRef('POD-13')).toEqual({ kind: 'issue', prefix: 'POD', seq: 13 })
    expect(parseAnyRef('POD-13-A')).toEqual({ kind: 'session', prefix: 'POD', seq: 13, letter: 'A' })
    expect(parseAnyRef('POD-DRAFT-3')).toEqual({ kind: 'session', prefix: 'POD', draft: 3 })
    // `UTF-8` is grammatically a bare issue ref; the linkify/resolve caller
    // rejects it because no registered repo owns the `UTF` prefix.
    expect(parseAnyRef('UTF-8')).toEqual({ kind: 'issue', prefix: 'UTF', seq: 8 })
    expect(parseAnyRef('lowercase-1')).toBeNull()
  })

  describe('resolveSessionIdentifier', () => {
    const sessions = [
      { sessionId: 'uuid-a', displayRef: 'POD-529-A' },
      { sessionId: 'uuid-draft', displayRef: 'POD-DRAFT-3' },
    ]

    it('resolves internal ids and both permanent birth-ref forms', () => {
      expect(resolveSessionIdentifier('uuid-a', sessions)?.sessionId).toBe('uuid-a')
      expect(resolveSessionIdentifier('POD-529-A', sessions)?.sessionId).toBe('uuid-a')
      expect(resolveSessionIdentifier('POD-DRAFT-3', sessions)?.sessionId).toBe('uuid-draft')
    })

    it('trims nice refs but does not mistake issue refs or arbitrary labels for sessions', () => {
      expect(resolveSessionIdentifier('  POD-529-A  ', sessions)?.sessionId).toBe('uuid-a')
      expect(resolveSessionIdentifier('POD-529', sessions)).toBeUndefined()
      expect(resolveSessionIdentifier('uuid-draft ', sessions)).toBeUndefined()
      expect(resolveSessionIdentifier('not-a-ref', sessions)).toBeUndefined()
    })
  })
})

describe('anyRefMatcher', () => {
  it('finds all ref tokens in text', () => {
    const text = 'see POD-13 and POD-13-A plus POD-DRAFT-3 but not UTF-8 or WORD'
    const found = [...text.matchAll(anyRefMatcher())].map((m) => m[0])
    expect(found).toContain('POD-13')
    expect(found).toContain('POD-13-A')
    expect(found).toContain('POD-DRAFT-3')
    // UTF-8 has a digit-only tail, so `UTF-8` DOES match the bare-issue branch;
    // the linkify caller filters by registered prefix — the grammar is permissive.
  })

  it('captures the prefix in group 1', () => {
    const m = anyRefMatcher().exec('ref POD-13-A here')
    expect(m?.[1]).toBe('POD')
  })
})

describe('display formatter', () => {
  it('short is the ref itself', () => {
    expect(formatShort('POD-13')).toBe('POD-13')
  })

  it('long joins ref and title', () => {
    expect(formatLong('POD-13', 'Fix session naming')).toBe('POD-13 · Fix session naming')
  })

  it('long omits the separator when there is no title', () => {
    expect(formatLong('POD-13', '')).toBe('POD-13')
    expect(formatLong('POD-13', null)).toBe('POD-13')
  })

  it('truncates long titles at ~40 chars with an ellipsis', () => {
    const title = 'A'.repeat(60)
    const out = truncateTitle(title, 40)
    expect(out.length).toBe(40)
    expect(out.endsWith('…')).toBe(true)
  })

  it('leaves short titles intact', () => {
    expect(truncateTitle('short', 40)).toBe('short')
  })
})
