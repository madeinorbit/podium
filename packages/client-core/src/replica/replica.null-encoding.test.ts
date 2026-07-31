/**
 * The unsnooze path: where POD-791's null encoding meets the TanStack
 * change-proxy scar (POD-170). Both are correct alone; they cannot both be true
 * at this seam, and the collision is INVISIBLE — `JSON.stringify` renders the
 * broken row and the correct one identically.
 *
 * The scenario is not hypothetical. It is literally the POD-170 incident: an
 * issue is unsnoozed, `deferUntil` goes date → null, and the "Unsnoozed" tag
 * never goes away. That shipped broken once already on exactly this field, which
 * is why the pin is on this path specifically rather than on nullability in
 * general.
 *
 * The chain, and where each link comes from:
 *   1. `dropNullValues` (model/shape.ts) OMITS null fields from the wire, so
 *      absence MEANS null.
 *   2. The replica applies the delta through a change proxy where `delete
 *      draft[k]` is a SILENT no-op (POD-794 finding (a), on 0.6.14 AND 0.6.16),
 *      so `replaceContents` assigns `undefined` instead. Absence becomes
 *      UNREPRESENTABLE: the key is present, holding undefined.
 *   3. `restoreNullValues` reverses step 1 — but only for keys it finds ABSENT.
 *
 * Steps 1 and 2 disagree about what absence looks like, and step 3 believes step
 * 1. Resolution (POD-795): step 3 reads present-with-undefined AS absent, because
 * on the wire — which is JSON — they are the same value. See model/shape.ts.
 */

// `issueDurableShape` on main; here the durable shape is the aggregate's own
// (`aggregates/issue.ts` — this tree derives the wire from R1 rather than keeping
// a second hand-written shape), so the seam under test is `IssueAggregate.shape`.
import { IssueAggregate, type IssueWire, restoreNullValues } from '@podium/model'

const issueDurableShape = IssueAggregate.shape
import { describe, expect, it } from 'vitest'
import { createReplica, memoryStorage } from './replica'

/** A snoozed issue, as the replica stores it. */
const snoozed = { id: 'i1', title: 'Snoozed', deferUntil: '2026-08-01T00:00:00.000Z' }
/** The SAME issue, unsnoozed, as it arrives on the wire: `deferUntil` OMITTED. */
const unsnoozed = { id: 'i1', title: 'Snoozed' }

describe('POD-170 present-to-absent, on the new apply path', () => {
  it('a field that goes present → absent is CLEARED, not left stale', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [snoozed as unknown as IssueWire])
    expect((replica.rows('issues')[0] as Record<string, unknown>).deferUntil).toBe(
      '2026-08-01T00:00:00.000Z',
    )

    // The unsnooze. The old value must not survive: #170 was exactly this,
    // where an issue's cleared snooze kept rendering its "Unsnoozed" tag.
    replica.applySnapshot('issues', [unsnoozed as unknown as IssueWire])
    const row = replica.rows('issues')[0] as Record<string, unknown>
    expect(row.deferUntil ?? null).toBeNull()
    expect(row.title).toBe('Snoozed')
  })

  it('the same clearing through the DELTA path (applyChanges), not just snapshots', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applyChanges('issues', [snoozed as unknown as IssueWire], [])
    replica.applyChanges('issues', [unsnoozed as unknown as IssueWire], [])
    const row = replica.rows('issues')[0] as Record<string, unknown>
    expect(row.deferUntil ?? null).toBeNull()
  })

  it('the cleared row survives a reload as cleared', async () => {
    // The in-memory row carries `deferUntil: undefined`; the PERSISTED row drops
    // the key entirely (JSON has no undefined). A reader that behaves
    // differently before and after a reload is the same bug wearing a hat, so
    // the pin covers both forms.
    const storage = memoryStorage()
    const first = createReplica({ storage })
    first.applySnapshot('issues', [snoozed as unknown as IssueWire])
    first.applySnapshot('issues', [unsnoozed as unknown as IssueWire])
    await first.hydrate()

    const second = createReplica({ storage })
    const result = await second.hydrate()
    const row = result.issues[0] as unknown as Record<string, unknown>
    expect(row.deferUntil ?? null).toBeNull()
  })
})

describe('the replica row → model aggregate seam (the POD-796 cutover path)', () => {
  /** The two shapes a cleared nullable can take at this seam. They are the same
   *  value and MUST map to the same aggregate — that is the whole property. */
  const clearedForms: Array<[string, Record<string, unknown>]> = [
    ['absent (persisted / straight off the wire)', { ...unsnoozed }],
    ['present-with-undefined (live, post-proxy)', { ...unsnoozed, deferUntil: undefined }],
  ]

  for (const [label, wire] of clearedForms) {
    it(`restoreNullValues reads a cleared deferUntil as null — ${label}`, () => {
      const restored = restoreNullValues(wire, issueDurableShape)
      expect(restored.deferUntil).toBeNull()
    })
  }

  it('the two forms are INDISTINGUISHABLE after restore — the pin', () => {
    // This is the assertion the collision breaks. Without the fix, the
    // present-with-undefined form leaves `deferUntil: undefined` and the
    // aggregate parse fails with "expected string, received undefined" — while
    // JSON.stringify renders both forms identically, so nothing upstream sees it.
    const [absent, undef] = clearedForms.map(([, wire]) =>
      restoreNullValues(wire, issueDurableShape),
    )
    expect(undef).toEqual(absent)
  })

  it('a REAL unsnoozed replica row restores its cleared field to null', () => {
    // The replica half of the chain, end to end through the actual apply path:
    // store snoozed, unsnooze, read the row back, hand it to the mapping seam.
    // This is the exact step POD-796's cutover runs on every delta, and it is
    // the one that threw. (The aggregate-level round trip lives in
    // model/src/issue/issue.unsnooze.test.ts, next to the fixtures it needs.)
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [snoozed as unknown as IssueWire])
    replica.applySnapshot('issues', [unsnoozed as unknown as IssueWire])
    const row = replica.rows('issues')[0] as unknown as Record<string, unknown>

    // The row really is in the hard-to-see form: the key is THERE, holding
    // undefined. If this ever stops being true the pin below is testing nothing.
    expect('deferUntil' in row).toBe(true)
    expect(row.deferUntil).toBeUndefined()
    expect(restoreNullValues(row, issueDurableShape).deferUntil).toBeNull()
  })

  it('a POPULATED nullable still restores to its value — the fix must not null everything', () => {
    // The failure mode of an over-broad fix: if `undefined` were confused with
    // "always clear", a set value would be silently wiped. A test that only
    // exercises the cleared case cannot see that.
    const restored = restoreNullValues({ ...snoozed }, issueDurableShape)
    expect(restored.deferUntil).toBe('2026-08-01T00:00:00.000Z')
  })
})
