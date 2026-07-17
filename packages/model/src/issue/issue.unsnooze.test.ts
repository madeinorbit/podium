/**
 * The unsnooze path, at the aggregate level [POD-795].
 *
 * `issue.mapping.test.ts` proves the bijection over payloads that are CLEAN —
 * the two spellings of a cleared nullable that a JSON wire can produce. This
 * file covers the third spelling, which only a REPLICA produces: a key present
 * and holding `undefined`.
 *
 * Where it comes from: a replica applies deltas through a TanStack change proxy
 * on which `delete draft[k]` is a silent no-op (POD-794 finding (a), reproduced
 * on 0.6.14 and 0.6.16). Clearing a field there means ASSIGNING `undefined`,
 * because assignment is the only mutation the proxy records. So the row for an
 * unsnoozed issue holds `deferUntil: undefined` where the wire held nothing.
 *
 * Why it earns its own file rather than a case in the mapping test: this is the
 * POD-170 incident (`deferUntil` date → null; the "Unsnoozed" tag that never went
 * away), it shipped broken on this exact transition once already, and the failure
 * is invisible — `JSON.stringify` renders the broken row and the correct one
 * identically, so only a test that looks at the VALUE can tell them apart.
 */

import { describe, expect, it } from 'vitest'
import { minimalIssue, populatedIssue } from './__fixtures__/issues'
import { fromWire, toWire } from './mapping'

/** What a replica hands back after a field was cleared through the change proxy:
 *  the wire payload, plus the cleared key present and holding `undefined`. */
const asReplicaRow = <T extends object>(wire: T, cleared: string): T =>
  ({ ...wire, [cleared]: undefined }) as T

describe('unsnooze: a cleared nullable arrives from the replica as present-with-undefined', () => {
  it('fromWire restores deferUntil to null — the POD-170 transition', () => {
    // Snoozed → unsnoozed: the authority drops the key; the replica spells that
    // drop as `undefined`. Both mean null, and null is what the aggregate must
    // see. Under the old `!(key in out)` rule this threw
    // "expected string, received undefined".
    const wire = toWire(populatedIssue)
    expect(wire.deferUntil).toBe(populatedIssue.deferUntil)

    const issue = fromWire(asReplicaRow(wire, 'deferUntil'))
    expect(issue.deferUntil).toBeNull()
  })

  it('agrees with the genuinely-absent form — they are one value, not two', () => {
    // The property that matters: a replica row and a straight-off-the-wire
    // payload for the SAME cleared field must produce the same aggregate. If
    // these ever diverge, the replica and the authority disagree about an
    // issue's state while every log line and payload dump looks identical.
    const wire = toWire(populatedIssue)
    const { deferUntil: _dropped, ...absent } = wire
    expect(fromWire(asReplicaRow(wire, 'deferUntil'))).toEqual(fromWire(absent as typeof wire))
  })

  it('holds for EVERY nullable field, not just the one that bit us', () => {
    // POD-170 was reported as a deferUntil bug and fixed as a deferUntil bug.
    // It was never a deferUntil bug — it is a property of every nullable field,
    // and pinning only the field that happened to surface it leaves the other
    // ~25 free to break the same way.
    const wire = toWire(populatedIssue)
    for (const key of Object.keys(minimalIssue).filter(
      (k) => minimalIssue[k as keyof typeof minimalIssue] === null,
    )) {
      const issue = fromWire(asReplicaRow(wire, key))
      expect({ key, value: issue[key as keyof typeof issue] }).toEqual({ key, value: null })
    }
  })

  it('a populated field is untouched — the fix must not null what is set', () => {
    // The over-broad fix nulls everything and passes every test above.
    const issue = fromWire(toWire(populatedIssue))
    expect(issue).toEqual(populatedIssue)
  })
})
