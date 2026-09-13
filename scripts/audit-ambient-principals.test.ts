/**
 * The sibling test this instrument did not have — POD-3904.
 *
 * Its absence was part of the finding: 17 of the 27 `scripts/audit-*.ts` carry
 * one and this, the only one CI runs as a blocking ratchet, did not. The census
 * in `docs/baseline-ratchet-census.md` also found that having one would not by
 * itself have helped, because the repo's threshold tests are written relative
 * to the constant they guard and float with it. So this file tests the two
 * things a sibling test CAN settle that the script cannot settle about itself:
 * that the probe is armed, and that the raise ledger is well formed.
 */
import { describe, expect, it } from 'vitest'
import {
  BASELINE,
  census,
  checkDrift,
  countsOf,
  probe,
  RAISE_AUTHORISATIONS,
  sitesIn,
  stripImports,
  VOCABULARIES,
} from './audit-ambient-principals'
import { constantsInFile, MIN_REASON_LENGTH } from './baseline-ratchet'

describe('the instrument', () => {
  it('probes clean — every check found its planted fixture', () => {
    // `probe()` returns the checks that FAILED to fire, so the empty array is
    // the armed state. Asserting the array itself rather than its length so a
    // failure names which check went blind.
    expect(probe()).toEqual([])
  })

  it('counts usage, not lines: imports and comments are not ambient sites', () => {
    const fixture = [
      "import { firstAdminMemberId } from '@podium/model'",
      '// firstAdminMemberId in a line comment',
      '/* firstAdminMemberId in a block comment */',
      'const a = firstAdminMemberId()',
    ].join('\n')
    expect(sitesIn('f.ts', fixture, 'firstAdminMemberId').map((s) => s.line)).toEqual([4])
  })

  it('blanks a multi-line import without moving the lines after it', () => {
    const src = ['import {', '  a,', "} from 'x'", 'const b = a', ''].join('\n')
    expect(stripImports(src).split('\n')).toHaveLength(5)
  })
})

describe('checkDrift', () => {
  it('fails a count above the baseline', () => {
    expect(checkDrift({ firstAdminMemberId: 43 }, { firstAdminMemberId: 38 })).toHaveLength(1)
    expect(checkDrift({ firstAdminMemberId: 43 }, { firstAdminMemberId: 38 })[0]?.check).toBe(
      'ambient-principal-added',
    )
  })

  it('fails a count below it too, so the baseline cannot rot downwards', () => {
    expect(checkDrift({ firstAdminMemberId: 37 }, { firstAdminMemberId: 38 })[0]?.check).toBe(
      'ambient-principal-baseline-stale',
    )
  })

  it('is silent when they agree — which is exactly why the baseline needs its own guard', () => {
    // POD-3903's demonstration, kept as a test: this is the pass a one-character
    // edit buys, and nothing in `checkDrift` can tell it from a real fix.
    expect(checkDrift({ firstAdminMemberId: 43 }, { firstAdminMemberId: 43 })).toEqual([])
  })

  it('ignores a vocabulary that is reported rather than enforced', () => {
    expect(checkDrift({ DEVICE_GRADE_PRINCIPAL: 9999 }, { DEVICE_GRADE_PRINCIPAL: 1 })).toEqual([])
  })
})

describe('the raise ledger', () => {
  it('every entry names an issue and argues its case', () => {
    for (const entry of RAISE_AUTHORISATIONS) {
      expect(entry.issue.trim()).not.toBe('')
      expect(entry.reason.trim().length).toBeGreaterThanOrEqual(MIN_REASON_LENGTH)
    }
  })

  it('every rename entry points at a key this tree actually has', () => {
    for (const entry of RAISE_AUTHORISATIONS) {
      if (entry.renamedTo === undefined) continue
      expect(Object.keys(BASELINE)).toContain(entry.renamedTo)
      expect(BASELINE[entry.renamedTo]).toBe(entry.to)
    }
  })

  it('authorises no key that is neither baselined nor recorded as retired', () => {
    const retired = new Set(RAISE_AUTHORISATIONS.filter((a) => a.renamedTo).map((a) => a.key))
    for (const entry of RAISE_AUTHORISATIONS)
      expect(entry.key in BASELINE || retired.has(entry.key)).toBe(true)
  })
})

describe('the baseline', () => {
  it('is readable from the file by the same parser the raise check uses', () => {
    // The raise check compares a PARSE of the base commit against the module's
    // own export. If those two disagreed about what the baseline is, the check
    // would be comparing two different numbers and could not say no.
    expect(constantsInFile('scripts/audit-ambient-principals.ts', 'BASELINE')).toEqual({
      ...BASELINE,
    })
  })

  it('baselines exactly the vocabularies the run enforces', () => {
    const enforced = VOCABULARIES.filter((v) => v.enforced).map((v) => v.symbol)
    expect(Object.keys(BASELINE).sort()).toEqual([...enforced].sort())
  })
})

describe('the census over this repository', () => {
  it('measures every declared vocabulary, and finds the accessor it counts', () => {
    const counts = countsOf(census())
    for (const vocab of VOCABULARIES) expect(counts[vocab.symbol]).toBeTypeOf('number')
    // The accessor's own definition is deliberately counted rather than
    // special-cased, so its file is always in the census.
    expect(counts.firstAdminMemberId).toBeGreaterThan(0)
  })
})
