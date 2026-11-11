/**
 * THE COMPOSITION IS ASSERTED BY OBJECT IDENTITY, BECAUSE NOTHING ELSE CAN SEE IT.
 *
 * POD-305's claim is that the change lifecycle has ONE field vocabulary and that
 * the wire phase COMPOSES it. The failure mode is that an arm quietly RESTATES a
 * field instead — `seq: z.number().int().positive()` in place of `ChangeSeqField`.
 *
 * Every other instrument in this repository is structurally blind to that:
 *
 *  - both golden suites (`wire-golden.json`, `__fixtures__/golden/*.json`) pass,
 *    because a restatement is BYTE-IDENTICAL on the wire — that is the whole
 *    point of the refactor, and it is also what makes the goldens useless as
 *    evidence for it;
 *  - `toEqual` passes, because two zod schemas built the same way are equal;
 *  - the typechecker passes, because the inferred types are identical;
 *  - the deletion audit's detector passes, because a restatement inside the one
 *    factory is still one composition site.
 *
 * The only thing that sees the fork is `toBe` — reference identity against the
 * shared instance. POD-351 asserted its contract's composition the same way and
 * for the same reason. Without this file the one-definition-site claim is
 * unverifiable by construction.
 *
 * Note the loops: every arm is checked, not arm 0. A test that pinned the first
 * arm would pass while a sixth entity kind was added by copy-paste — which is
 * precisely how the five restatements this refactor deleted came to exist.
 */

import { ChangeEntityIdField, ChangeSeqField, GlobalChangeOpField } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { MetadataChange, MetadataChangeOp, UnknownMetadataChange } from './sync'

/** The strict union's arms, as objects with a `.shape`. */
const strictArms = MetadataChange.options as unknown as {
  shape: Record<string, unknown>
}[]

describe('the wire change row composes the model vocabulary', () => {
  it('has all thirty-seven entity arms, so the loops below are not vacuous', () => {
    // Count every current entity arm so the shared-field assertions cannot
    // silently narrow to a subset of the record vocabulary.
    expect(strictArms).toHaveLength(37)
  })

  it('takes `seq` from the shared field schema INSTANCE in every arm', () => {
    for (const arm of strictArms) expect(arm.shape.seq).toBe(ChangeSeqField)
  })

  it('takes the target id from the shared field schema INSTANCE in every arm', () => {
    for (const arm of strictArms) expect(arm.shape.id).toBe(ChangeEntityIdField)
  })

  it('takes the op vocabulary from the shared field schema INSTANCE in every arm', () => {
    for (const arm of strictArms) expect(arm.shape.op).toBe(GlobalChangeOpField)
  })

  it('re-exports the op vocabulary rather than declaring a second one', () => {
    // `MetadataChangeOp` is the wire's NAME for the model's schema, not a copy of
    // it. If this ever becomes a fresh `z.enum(['upsert','remove'])`, adding
    // `evict` to the model would leave the wire silently behind.
    expect(MetadataChangeOp).toBe(GlobalChangeOpField)
  })

  it('keeps the lenient catch-all on the same shared fields', () => {
    // The catch-all is the arm most likely to drift: it is the one that cannot
    // use `z.literal` for its entity, so it is the one somebody rewrites by hand.
    const shape = (UnknownMetadataChange as unknown as { shape: Record<string, unknown> }).shape
    expect(shape.seq).toBe(ChangeSeqField)
    expect(shape.id).toBe(ChangeEntityIdField)
    expect(shape.op).toBe(GlobalChangeOpField)
  })
})

describe('the composition did not change what parses', () => {
  // Identity is necessary but not sufficient: a shared instance wired into the
  // wrong position would satisfy every `toBe` above. These are the behaviours the
  // arms are FOR, asserted independently of how they are built.

  it('still rejects seq 0 on a change row', () => {
    expect(
      MetadataChange.safeParse({ seq: 0, entity: 'session', id: 's1', op: 'remove' }).success,
    ).toBe(false)
  })

  it('still rejects a known entity kind through the catch-all', () => {
    // The refine survived the move into the factory. Without it a known-kind row
    // with a malformed value would sneak through as "unknown" and the cursor
    // would advance past it permanently.
    expect(
      UnknownMetadataChange.safeParse({ seq: 1, entity: 'session', id: 's1', op: 'remove' })
        .success,
    ).toBe(false)
    expect(
      UnknownMetadataChange.safeParse({ seq: 1, entity: 'futureKind', id: 'm1', op: 'remove' })
        .success,
    ).toBe(true)
  })

  it('still rejects `evict` on the wire', () => {
    // The wire is pre-cutover and speaks two ops. `evict` is kernel vocabulary
    // (ADR 2 Am1 D14.5) and POD-308 owns bringing it across; composing the op
    // field from the model must not have brought it early.
    expect(
      MetadataChange.safeParse({ seq: 1, entity: 'session', id: 's1', op: 'evict' }).success,
    ).toBe(false)
  })
})
