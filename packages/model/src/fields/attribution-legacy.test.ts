import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Attribution } from './attribution'
import {
  LEGACY_ATTRIBUTION_SITES,
  type LegacyAttributionSite,
  legacyAttributionViolations,
} from './attribution-legacy'

const REAL = LEGACY_ATTRIBUTION_SITES

describe('the four legacy attribution sites each have a decided shape', () => {
  it('covers exactly the fields readiness §3.2 names', () => {
    // The list is CLOSED to the readiness document's own enumeration. A fifth
    // entry means either the document grew one or somebody is using this as a
    // general attribution registry — which the matrix's per-row AttributionRule
    // column already is.
    expect(REAL.map((s) => s.legacyField)).toEqual([
      'humanQuestionAskedBy',
      'deletion_source / deletionSource',
      "nameSource: 'user' | 'agent'",
      'close / unblock actor (causedBySessionId on the event payload)',
    ])
  })

  it('passes the real list — every site names the shared pair at a real key', () => {
    expect(legacyAttributionViolations()).toEqual([])
  })

  it('records honestly that the pair is representable, NOT stamped at every write', () => {
    // The mechanism-presence trap, refused explicitly. The FIELD existing and
    // the field being FILLED IN are two facts, and this issue delivers the
    // first. Conflating them is what turns "the model is ready" into a claim
    // nobody can check.
    expect(REAL.every((s) => s.stamped === 'representable-only')).toBe(true)
    expect(REAL.every((s) => s.stampingOwner.includes('POD-311') || s.stampingOwner.includes('POD-315')))
      .toBe(true)
  })

  it('resolves NESTED pair paths — the nesting IS the decision at three sites', () => {
    // `deleted.by` sits inside the object that also holds `at`, precisely so a
    // half-recorded tombstone is unrepresentable. A resolver that only looked at
    // top-level keys would report `pair-absent` for exactly the sites that got
    // the strongest treatment — so this asserts the resolver reaches them.
    const nested = REAL.filter((s) => s.pairAt.includes('.'))
    expect(nested.map((s) => s.pairAt)).toEqual(['asked.attribution', 'deleted.by'])
    expect(legacyAttributionViolations(nested)).toEqual([])
  })
})

describe('the check can say NO — proved with fixtures, not asserted', () => {
  const base = REAL[0] as LegacyAttributionSite

  it('FAILS a site whose group carries a LOOK-ALIKE instead of the shared schema', () => {
    // The defect this instrument exists for, and the one a golden wire fixture
    // cannot see: a restated pair is byte-identical. Only asserting the shared
    // INSTANCE (`toBe`-grade identity) can tell them apart.
    const lookAlike = z.object({
      asked: z.object({
        actor: z.object({ kind: z.literal('user'), id: z.string() }),
        onBehalfOf: z.string().nullable(),
      }),
    })
    const violations = legacyAttributionViolations([
      { ...base, carriedBy: 'FixtureGroup', schema: lookAlike, pairAt: 'asked' },
    ])

    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('pair-not-composed')
    expect(violations[0]?.detail).toContain('look-alike')
  })

  it('FAILS a site whose pair has gone missing entirely', () => {
    const gone = z.object({ needsHuman: z.boolean() })
    const violations = legacyAttributionViolations([
      { ...base, carriedBy: 'FixtureGroup', schema: gone, pairAt: 'asked' },
    ])

    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('pair-absent')
  })

  it('FAILS a site that cannot say what it decided', () => {
    const violations = legacyAttributionViolations([{ ...base, decided: 'done' }])
    expect(violations.map((v) => v.kind)).toEqual(['undocumented'])
  })

  it('PASSES a fixture that genuinely composes the shared schema — it can say YES', () => {
    // The positive control. Without it, the three failures above could all be
    // produced by a check that never passes anything.
    const composed = z.object({ asked: Attribution })
    expect(
      legacyAttributionViolations([{ ...base, carriedBy: 'FixtureGroup', schema: composed, pairAt: 'asked' }]),
    ).toEqual([])
  })

  it('sees through .optional() to the shared schema underneath', () => {
    // Three of the four real sites wrap the pair in `.optional()`; a resolver
    // that stopped at the wrapper would report every one of them as a
    // look-alike, and "the sweep is complete" would be unprovable.
    const optional = z.object({ asked: Attribution.optional() })
    expect(
      legacyAttributionViolations([{ ...base, carriedBy: 'FixtureGroup', schema: optional, pairAt: 'asked' }]),
    ).toEqual([])
  })
})
