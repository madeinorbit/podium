/**
 * The change-lifecycle field vocabulary, pinned.
 *
 * These are assertions about MEANING, not about whether zod works. Each one is
 * here because getting it wrong is a shipped defect somewhere downstream, and the
 * comment on each says which.
 */

import { describe, expect, it } from 'vitest'
import {
  CHANGE_OPS,
  ChangeCursorSeqField,
  ChangeEventTimeField,
  ChangeOpField,
  ChangePayloadField,
  ChangeProvenanceFields,
  ChangeRevisionField,
  ChangeSeqField,
  ChangeTargetFields,
  GLOBAL_CHANGE_OPS,
  GlobalChangeOpField,
  isGlobalChangeOp,
} from './change'

describe('the op vocabulary', () => {
  it('extends the global tuple rather than restating it', () => {
    // The property, stated as the relationship and not as two literal lists: if
    // someone adds a global op, it must appear in the full vocabulary for free.
    // Asserting `CHANGE_OPS === ['upsert','remove','evict']` would pass against a
    // second hand-written literal and prove nothing about the derivation.
    for (const op of GLOBAL_CHANGE_OPS) expect(CHANGE_OPS).toContain(op)
    expect(CHANGE_OPS.length).toBe(GLOBAL_CHANGE_OPS.length + 1)
  })

  it('keeps `evict` OUT of the global ops (Amendment 1 D14.5)', () => {
    // An eviction is per-principal and anchored at a grant's seq. A global row
    // carrying it is uninterpretable to a reader of the global log, and a replica
    // that got one through this schema would render a revoked share as a deletion.
    expect(GlobalChangeOpField.safeParse('evict').success).toBe(false)
    expect(ChangeOpField.safeParse('evict').success).toBe(true)
    expect(isGlobalChangeOp('evict')).toBe(false)
    expect(isGlobalChangeOp('remove')).toBe(true)
  })

  it('has no separate soft-delete op — that is `upsert` plus a flag (ADR 2 D5)', () => {
    expect(GlobalChangeOpField.safeParse('delete').success).toBe(false)
    expect(GlobalChangeOpField.safeParse('soft-delete').success).toBe(false)
  })
})

describe('seq versus cursor', () => {
  it('refuses seq 0 on a row but accepts it as a cursor', () => {
    // The one value that separates them. 0 means "I have seen nothing" for a
    // reader; a ROW at 0 is malformed, and accepting one would let a reader that
    // has seen everything be indistinguishable from a reader that has seen nothing.
    expect(ChangeSeqField.safeParse(0).success).toBe(false)
    expect(ChangeCursorSeqField.safeParse(0).success).toBe(true)
    expect(ChangeSeqField.safeParse(1).success).toBe(true)
  })

  it('refuses fractional and negative positions', () => {
    expect(ChangeSeqField.safeParse(1.5).success).toBe(false)
    expect(ChangeCursorSeqField.safeParse(-1).success).toBe(false)
  })
})

describe('provenance (ADR 2 D8)', () => {
  it('carries exactly origin, causation and mutation identity', () => {
    // Pinned as a SET, so adding a fourth key is a deliberate edit here rather
    // than something a downstream phase quietly grows on its own copy.
    expect(Object.keys(ChangeProvenanceFields.shape).sort()).toEqual([
      'causationId',
      'mutationId',
      'originId',
    ])
  })

  it('admits a change with NO causing command', () => {
    // A boot reconcile and a steward sweep have no outbox entry behind them. If
    // these were required, the Authority could not record its own writes.
    expect(ChangeProvenanceFields.safeParse({}).success).toBe(true)
  })

  it('carries no principal, owner, visibility or capability', () => {
    // The envelope records WHAT caused a write, never WHO may see the result:
    // visibility is computed per-principal at the feed boundary (Am1 D12/D13), and
    // a column here would be a writer-settable visibility decision.
    const parsed = ChangeProvenanceFields.parse({
      originId: 'peer-1',
      owner: 'user:sole',
      visibility: 'tenant',
      capability: 'write',
      actor: 'agent',
    } as never)
    expect(parsed).toEqual({ originId: 'peer-1' })
  })
})

describe('the target pair', () => {
  it('spells the id half `entityId` and strips a wire-shaped `id`', () => {
    // The wire spells it `id`; POD-308 owns reconciling the two. What this asserts
    // is that the storage-side spelling does not silently accept the wire one and
    // then read `undefined` from it.
    const parsed = ChangeTargetFields.parse({ entity: 'session', entityId: 's1', id: 's1' } as never)
    expect(parsed).toEqual({ entity: 'session', entityId: 's1' })
  })
})

describe('payload and clocks', () => {
  it('lets a payload be null — that is how a `remove` is stored', () => {
    expect(ChangePayloadField.safeParse(null).success).toBe(true)
    expect(ChangePayloadField.safeParse('{"a":1}').success).toBe(true)
  })

  it('takes the payload as SERIALIZED bytes, never a live object', () => {
    // Dedup compares serialized bytes. A stored row holding an object would make
    // two byte-identical changes compare unequal by reference and append forever.
    expect(ChangePayloadField.safeParse({ a: 1 }).success).toBe(false)
  })

  it('admits epoch-0 event time and rejects a negative clock', () => {
    expect(ChangeEventTimeField.safeParse(0).success).toBe(true)
    expect(ChangeEventTimeField.safeParse(-1).success).toBe(false)
  })

  it('admits revision 0 — "never yet revised" needs a value (ADR 2 D3)', () => {
    expect(ChangeRevisionField.safeParse(0).success).toBe(true)
    expect(ChangeRevisionField.safeParse(-1).success).toBe(false)
  })
})
