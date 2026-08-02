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

import {
  ChangeCursorSeqField,
  ChangeEntityIdField,
  ChangeSeqField,
  GlobalChangeOpField,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  MetadataChange,
  MetadataChangeOp,
  SyncChangesSinceResult,
  SyncChangesSinceResultLenientSchema,
  UnknownMetadataChange,
} from './sync'

/** The strict union's arms, as objects with a `.shape`. */
const strictArms = MetadataChange.options as unknown as {
  shape: Record<string, unknown>
}[]

const changesSinceArms = (union: unknown): { shape: Record<string, unknown> }[] =>
  (union as { options: { shape: Record<string, unknown> }[] }).options

describe('the wire change row composes the model vocabulary', () => {
  it('has all nine entity arms, so the loops below are not vacuous', () => {
    // The counterfactual guard: if `.options` ever stopped resolving, every
    // per-arm assertion below would iterate an empty list and pass silently.
    //
    // FIVE UNTIL THE POD-1246 CATCH-UP, EIGHT with issueProjection/issueDep/repo
    // (POD-796 / POD-822), NINE NOW: 'userLayout' (POD-1350) joined the union
    // for per-user sidebar/tab chrome. They are COUNTED here rather than
    // exempted because the loops below are what proves the new arms compose the
    // shared vocabulary too — main declared the earlier three as hand-written
    // `z.object`s restating `seq`/`id`/`op`, which is exactly the fork this file
    // exists to see. They are composed through `metadataChangeArm` instead, and
    // these assertions are the evidence that the port did not reintroduce the
    // five restatements POD-305 deleted.
    expect(strictArms).toHaveLength(9)
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

describe('the changesSince result composes the cursor field', () => {
  it('uses the shared cursor schema INSTANCE on the strict delta arm', () => {
    const delta = changesSinceArms(SyncChangesSinceResult)[0]
    expect(delta?.shape.cursor).toBe(ChangeCursorSeqField)
  })

  it('uses it on the lenient delta arm too — the copy that had already drifted', () => {
    // These two arms were written out side by side and their key ORDER had
    // already diverged before anyone noticed. Composing them from one factory is
    // what makes them differ in the one thing they are supposed to differ in.
    const delta = changesSinceArms(SyncChangesSinceResultLenientSchema)[0]
    expect(delta?.shape.cursor).toBe(ChangeCursorSeqField)
  })

  it('uses it on both snapshot arms', () => {
    for (const union of [SyncChangesSinceResult, SyncChangesSinceResultLenientSchema]) {
      const snapshot = changesSinceArms(union)[1]
      expect(snapshot?.shape.cursor).toBe(ChangeCursorSeqField)
    }
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
      UnknownMetadataChange.safeParse({ seq: 1, entity: 'machine', id: 'm1', op: 'remove' })
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
