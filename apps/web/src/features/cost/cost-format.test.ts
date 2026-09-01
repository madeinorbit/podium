import { describe, expect, it } from 'vitest'
import { approxUsd, exactUsd, floorLabel, rateLabel, rosterCostMeta } from './cost-format'

/**
 * The wording rules, which are the half of this feature most able to lie.
 *
 * Two precisions exist on purpose — a magnitude the reader is meant to take as
 * an estimate, and a component figure they are meant to check against the
 * others beside it — and the tests below are mostly about keeping the first one
 * from quietly acquiring cents.
 */

describe('approxUsd', () => {
  it('never prints cents above ten dollars', () => {
    expect(approxUsd(225.81)).toBe('≈$226')
    expect(approxUsd(58.4)).toBe('≈$58')
    expect(approxUsd(10)).toBe('≈$10')
  })

  it('keeps cents below ten, where they are the figure rather than noise', () => {
    expect(approxUsd(4.8)).toBe('≈$4.80')
    expect(approxUsd(4.396)).toBe('≈$4.40')
    expect(approxUsd(0.07)).toBe('≈$0.07')
  })

  it('falls back to three significant figures once a total runs to thousands', () => {
    // "$1,234" reads as a measurement; the money behind it is an estimate off a
    // public price list and the fourth digit is not one this feature has.
    expect(approxUsd(1234)).toBe('≈$1,230')
    expect(approxUsd(12_345)).toBe('≈$12,300')
    // Rounded at the third digit, not truncated to it.
    expect(approxUsd(1239)).toBe('≈$1,240')
  })

  it('separates thousands so a five-figure total cannot be misread', () => {
    expect(approxUsd(12_300)).toBe('≈$12,300')
  })
})

describe('exactUsd', () => {
  it('prints the component figures the reader will add up', () => {
    expect(exactUsd(225.81)).toBe('$225.81')
    expect(exactUsd(120.79)).toBe('$120.79')
    expect(exactUsd(1234.5)).toBe('$1,234.50')
  })

  it('prints a bare $0 for the one place a zero is honest', () => {
    // A parent whose whole figure is its children's spent nothing itself, and
    // the split legend has to say so. "$0.00" measures an absence to the cent.
    expect(exactUsd(0)).toBe('$0')
  })
})

describe('rateLabel', () => {
  it('reads as a multiple of the cohort, to one place', () => {
    expect(rateLabel(2.34)).toBe('2.3× median')
    expect(rateLabel(0.92)).toBe('0.9× median')
  })
})

describe('floorLabel', () => {
  it('says "all X" only when X really is all of it', () => {
    expect(floorLabel(['codex'])).toBe('≥ floor · all Codex')
  })

  it('names every harness on a mixed task rather than picking one', () => {
    // POD-1484 really does read [codex, grok]. "all Codex" over a task that also
    // ran Grok is a lie told confidently, in the ink reserved for facts.
    expect(floorLabel(['codex', 'grok'])).toBe('≥ floor · Codex + Grok')
    expect(floorLabel(['claude-code', 'codex'])).toBe('≥ floor · Claude + Codex')
  })

  it('still says the figure is a bound when it cannot say why', () => {
    expect(floorLabel([])).toBe('≥ floor')
  })
})

describe('rosterCostMeta', () => {
  it('states the rollup and the sessions it was read over', () => {
    expect(rosterCostMeta(225.81, 10)).toBe('≈$226 over 10')
  })

  it('says nothing rather than "over 0"', () => {
    expect(rosterCostMeta(0, 0)).toBeUndefined()
  })
})
