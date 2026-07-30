/**
 * THE FIFTH RE-HOMED ITEM, AND THE ONE POD-306 DID NOT BUILD.
 *
 * POD-305 re-homed five items onto POD-306. Four were built (`../feed/`): feed
 * identity, the published retention floor, the bounded send queue, and the
 * `resync-required` demotion. This file is the fifth — `revision` on entity
 * tables (ADR 2 D3) — pinned as a TEST rather than left as a comment, so that a
 * green suite cannot be read as "revision works" and so the item is not left
 * unowned. Unowned items at a phase seam are how attempts 1 and 2 left half
 * migrations.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BUILT, WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * BUILT — the TOKEN and both ends of the seam. `arbitration.ts` reads
 * `current.revision` for the `exp-rev` rule (ADR 1 D2's DEFAULT rule); the
 * Replica stores `revision` on `EntityRecord` and echoes it without ever
 * comparing it for truth. Nothing needs to change at either end.
 *
 * NOT BUILT — the PRODUCER. No code in this repository assigns a revision. ADR 2
 * D3 says where it must come from: "every durable entity gains a monotonic
 * `revision`, incremented by the authority on each write", as a column on the
 * ENTITY TABLE, with a `revision = 1` backfill.
 *
 * ---------------------------------------------------------------------------
 * WHY POD-306 DID NOT BUILD IT, AND WHY THE OBVIOUS SHORTCUT IS WRONG
 * ---------------------------------------------------------------------------
 *
 * The tempting move is to derive the revision in the kernel — count a
 * `(entity, entityId)`'s rows in the change log, or read the latest retained one.
 * That compiles, needs no migration, and is WRONG in a way that is silent until
 * production:
 *
 *   The change log is HEAD-PRUNED (ADR 2 D5). Prune past every row for a quiet
 *   entity and a log-derived revision RESTARTS AT 1. A replica holding revision 5
 *   then meets revision 1 for the same entity, and `exp-rev` — whose entire job is
 *   to refuse a write against a stale revision — starts accepting stale writes,
 *   because the numbers happen to line up again. Every test of the rule still
 *   passes: the rule is present, the comparison runs, and its refusing arm is
 *   simply never reached for the rows that matter.
 *
 * That is the fails-open shape this run has now paid for four times. It is also
 * exactly why D3 puts the revision on the entity table, whose rows are not
 * pruned, rather than deriving it from a log whose rows are. Building the
 * shortcut here would have been worse than leaving the item undone, because it
 * would have LOOKED done.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT WENT
 * ---------------------------------------------------------------------------
 *
 * Entity tables are FEATURE-owned, as `../adapters/sqlite/schema.ts` states in
 * its own layering note: the kernel owns ports and state machines, this adapter
 * owns the GENERIC sync tables (the change log and the receipts), and
 * feature-owned tables stay with their feature. `sessions` and `issues` live in
 * `apps/server`'s schema. A kernel issue reaching into them to add a column to
 * each is precisely the large surprise diff the fan-out protocol warns costs a
 * review round-trip, and it is a migration whose blast radius belongs to whoever
 * owns those tables.
 *
 * So it is filed as separable work with a `discovered-from` edge back to
 * POD-306, rather than passed to POD-308. POD-308 is the WIRE cutover; the
 * revision column is a storage migration, and the wire half of D3 (carrying the
 * token in the negotiated frame) is already POD-308's by its own brief. Two
 * different jobs that happen to share a field name.
 *
 * THIS FILE MUST FAIL the day the producer lands, which is the point. The
 * assertions below are written so that adding a `revision` to the authority's
 * change vocabulary breaks them and brings whoever did it here to read the note
 * above and delete these cases deliberately.
 */

import { OWNERSHIP_MATRIX } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SequencedChange, StagedChangeSpec } from './change-lifecycle'
import { arbitrate } from './arbitration'

/**
 * The FIRST shipped matrix row declaring `exp-rev`, resolved the way
 * `arbitration.test.ts` resolves its rows: against `OWNERSHIP_MATRIX` itself, so
 * these cases exercise a rule the product actually assigns to a real row rather
 * than a `conflict` literal this file invented. If the matrix imported empty this
 * throws immediately, before any assertion below could fail confusingly.
 */
const EXP_REV_ROW = (() => {
  const row = OWNERSHIP_MATRIX.find((r) => r.conflict === 'exp-rev')
  if (!row) throw new Error('no shipped matrix row declares conflict \'exp-rev\'')
  return row.id
})()

describe('the revision TOKEN exists and both ends of the seam consume it', () => {
  it('exp-rev ACCEPTS a matching revision and REFUSES a stale one — the rule is live', () => {
    // Both arms over the SAME row, POD-305's pattern: a dispatch stuck on one
    // answer fails one of the pair. This is what makes "the rule is implemented
    // and merely unfed" a measured claim rather than a reading of the source.
    const row = { rowId: EXP_REV_ROW, current: { revision: 5 } }

    expect(
      arbitrate({ ...row, attempt: { expectedRevision: 5, eventTime: 1 } }).kind,
    ).toBe('accept')
    expect(
      arbitrate({ ...row, attempt: { expectedRevision: 4, eventTime: 1 } }).kind,
    ).toBe('reject')
  })

  it('refuses an UPDATE that supplies no expected revision at all', () => {
    // The fails-open arm of the same rule: a missing expected revision must be a
    // rejection, not a pass. Without this case, a producer that forgot to send one
    // would sail through and the rule would protect nothing.
    const verdict = arbitrate({
      rowId: EXP_REV_ROW,
      current: { revision: 5 },
      attempt: { eventTime: 1 },
    })
    expect(verdict.kind).toBe('reject')
  })
})

describe('NOTHING IN THIS REPOSITORY ASSIGNS A REVISION — the absence, pinned', () => {
  it('the authority’s change vocabulary carries NO revision field', () => {
    // A change row records what changed and where it sits in the one global
    // sequence. It does not carry the entity's revision, because no authority-side
    // code computes one. When the producer lands, D3's token will ride here (or on
    // the entity row the frame is built from) and this assertion will fail — which
    // is the notification this file exists to give.
    expect(Object.keys(SequencedChange.shape)).not.toContain('revision')
    expect(Object.keys(StagedChangeSpec.shape)).not.toContain('revision')
  })

  it('so every `exp-rev` row in the system is arbitrated against a revision NOBODY MAINTAINS', () => {
    // Stated as an executable fact rather than as a warning in prose. `current` is
    // supplied by the caller at the attempt, and with no producer the only honest
    // value is `undefined` — under which a CREATE is legal and an UPDATE cannot be
    // expressed at all, because there is no revision to have expected.
    const create = arbitrate({
      rowId: EXP_REV_ROW,
      current: undefined,
      attempt: { eventTime: 1 },
    })
    expect(create.kind).toBe('accept')

    // And an entity that exists but has NO revision refuses every update, which is
    // the correct default-closed behaviour and is also, today, the behaviour every
    // real row would get. That is the measure of how much D3 is still owed.
    const update = arbitrate({
      rowId: EXP_REV_ROW,
      current: {},
      attempt: { expectedRevision: 1, eventTime: 1 },
    })
    expect(update.kind).toBe('reject')
  })
})
