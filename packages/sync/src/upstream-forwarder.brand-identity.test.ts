import { IssueIdField, IssueWire, SessionIdField, UserIdField } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { optimisticIssuePatch, PATCH_ID_FIELDS } from './upstream-forwarder'

/**
 * IDENTITY, not shape — the assertion the golden wire fixtures structurally
 * CANNOT make.
 *
 * Branding is compile-time only, so re-typing a field is byte-identical on the
 * wire. POD-305 demonstrated this on this codebase rather than asserting it: a
 * restated `seq` schema failed two identity assertions and PASSED
 * `wire-golden.test.ts` in the same run. A golden fixture therefore cannot tell
 * `IssueIdField` from a local `z.string().brand<'IssueId'>()` that happens to
 * encode the same bytes — but the second one drifts the moment the shared field
 * changes, and nothing fails.
 *
 * So these assert `toBe` against the shared schema INSTANCE, and PER KEY rather
 * than on the first one. POD-305's reason for per-arm: pinning only the first
 * passes while a sixth kind arrives by copy-paste, "which is exactly how the five
 * restatements I deleted came to exist". The same argument applies key-by-key
 * here — `parentId` being right says nothing about `assignee`.
 */
describe('optimisticIssuePatch — branded id keys come from the SHARED field schemas', () => {
  // Every branded id key reachable through an update patch, with the exact
  // shared field instance it must be. Add a branded id to the issue vocabulary
  // and this table is what fails until it is accounted for.
  const EXPECTED = [
    ['parentId', IssueIdField],
    ['supersededBy', IssueIdField],
    ['duplicateOf', IssueIdField],
    ['assignee', UserIdField],
    ['startedBySession', SessionIdField],
    ['humanQuestionAskedBy', SessionIdField],
  ] as const

  // Identity is checked at EVERY level, not just the innermost: `ZodBranded`
  // exposes `.unwrap()` too, so peeling until you cannot peel further goes
  // straight past the brand onto the bare `z.string()` and matches nothing.
  const brandOf = (schema: unknown, wanted: readonly unknown[]): unknown => {
    let cur = schema
    for (let i = 0; i < 8; i++) {
      if (wanted.includes(cur)) return cur
      const c = cur as { unwrap?: () => unknown }
      if (typeof c?.unwrap !== 'function') break
      cur = c.unwrap()
    }
    return undefined
  }

  it.each(EXPECTED)('IssueWire.%s is the shared field INSTANCE, not a restatement', (key, field) => {
    // `toBe`, deliberately: `toEqual` passes against a structurally identical
    // restatement, which is the exact defect this test exists to catch.
    expect(brandOf(IssueWire.shape[key], [field])).toBe(field)
  })

  it.each(EXPECTED)(
    'the DERIVATION maps %s to that exact shared field, not merely to some brand',
    (key, field) => {
      // Asserting on `IssueWire.shape` above proves something about the MODEL.
      // This proves something about the derivation in this file — the distinction
      // is not academic: a version that matched brands by constructor rather than
      // by identity mapped every branded key to whichever field was listed first
      // (so `assignee` parsed as an IssueId) and survived every other assertion
      // here, because both brands accept any string at runtime.
      expect(PATCH_ID_FIELDS[key]).toBe(field)
    },
  )

  it('the id-key set is DERIVED, so a new branded id cannot be silently missed', () => {
    // The derivation must find every key in EXPECTED. If someone replaces the
    // derivation with a hand-written list that omits one, this fails.
    const brands = [IssueIdField, SessionIdField, UserIdField]
    const derived = Object.entries(IssueWire.shape)
      .filter(([, f]) => brandOf(f, brands) !== undefined)
      .map(([k]) => k)
    for (const [key] of EXPECTED) expect(derived).toContain(key)
  })

  it.each([
    ['parentId', 'iss_p'],
    ['supersededBy', 'iss_s'],
    ['duplicateOf', 'iss_d'],
    ['assignee', 'someone'],
  ])('update parses %s rather than passing it through unchecked', (key, value) => {
    const patch = optimisticIssuePatch('update', { id: 'i', patch: { [key]: value } }, 'now')
    // The VALUE is unchanged — branding is compile-time only, so the wire effect
    // of this whole change is nil. That is the property, and it is asserted per
    // key rather than once.
    expect(patch[key as 'parentId']).toBe(value)
  })

  it.each([
    ['parentId', 42],
    ['assignee', null],
    ['supersededBy', { nested: true }],
  ])('update DROPS a non-string %s instead of forging a branded id', (key, value) => {
    const patch = optimisticIssuePatch('update', { id: 'i', patch: { [key]: value } }, 'now')
    expect(patch).not.toHaveProperty(key)
  })

  it('a non-id key still passes through the update arm untouched', () => {
    // The counterfactual for the tests above: if the parse ran over EVERY key
    // rather than the id keys, this would be dropped too and the tests above
    // would pass for the wrong reason.
    const patch = optimisticIssuePatch('update', { id: 'i', patch: { title: 'T' } }, 'now')
    expect(patch.title).toBe('T')
  })
})
