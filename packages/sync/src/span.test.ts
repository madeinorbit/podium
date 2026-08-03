/**
 * The unified unit of work (POD-1146): the ROLE split, and the cross-module
 * commit that having two definitions made impossible.
 *
 * The role assertions here are COMPILE-TIME. Each `@ts-expect-error` fails the
 * typecheck lane if the error it names stops occurring — so a span type that let a
 * participant settle somebody else's transaction, or let a bare participant handle
 * be passed where an owner is required, reddens `bunx tsgo --noEmit` even though
 * every runtime assertion below would still pass. Positive controls sit beside
 * each one, because a suppression that never had an error to suppress and a
 * suppression covering the wrong error read identically.
 */

import { actorUser, asUserId } from '@podium/model'
import type { MutationId } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from './outbox/records'
import { InMemoryOutboxStore } from './outbox/test-doubles'
import { InMemoryReplicaStore } from './replica/memory-store'
import type { Cursor } from './replica/types'
import type { OwnedSyncSpan, SyncSpan, SyncSpanParticipant } from './span'

const CLOSE: OutboxCommand = { name: 'issues.close', version: 1, delivery: 'offline-eligible' }
const ADA: OutboxAttribution = {
  actor: actorUser(asUserId('u-ada')),
  onBehalfOf: asUserId('u-ada'),
}

const queued = (id: string): OutboxRecord => ({
  mutationId: id as MutationId,
  command: CLOSE,
  input: {},
  partitionKey: 'p1',
  attribution: ADA,
  state: 'queued',
  queuedAt: 0,
  attempts: 0,
})

const absent = (id: string) => ({ mutationId: id as MutationId, expect: 'absent' as const })

const CURSOR: Cursor = { feedId: 'f1', epoch: 'e1', seq: 1 }

const upsert = (entityId: string, seq: number) =>
  ({
    kind: 'upsert',
    entity: 'issue',
    entityId,
    value: { id: entityId },
    provenance: { seq },
  }) as const

/**
 * COMPILE-TIME ONLY. Nothing in this block is ever called — the assertions are the
 * `@ts-expect-error` directives themselves, checked by `tsgo --noEmit`, and calling
 * them would only prove that a method TypeScript already refused to admit is also
 * missing at runtime. Vitest's `expect` has nothing to do here; the typecheck lane
 * is the instrument.
 */
const _roleSplitIsEnforcedByTheType = {
  /**
   * The mutant this kills: move `commit`/`abort` up onto `SyncSpan` (or declare a
   * participant's parameter as `OwnedSyncSpan`). Either collapses the role split,
   * and either makes both suppressions below UNUSED — TS2578, a typecheck failure.
   */
  participantCannotSettle(span: SyncSpan): void {
    // Positive control: the participant-side hooks ARE reachable, so the two errors
    // below are about the ROLE and not about `span` being unusable.
    span.join({ publish: () => {} })
    span.onCommit(() => {})
    // @ts-expect-error a participant cannot commit a transaction it does not own
    span.commit()
    // @ts-expect-error a participant cannot abort a transaction it does not own
    span.abort()
  },

  /** Widening is free; narrowing is not. */
  ownerIsAParticipantButNotTheReverse(owned: OwnedSyncSpan, participant: SyncSpan): void {
    const settle = (span: OwnedSyncSpan): void => span.abort()
    // Positive control: an owner satisfies both positions.
    settle(owned)
    this.participantCannotSettle(owned)
    // @ts-expect-error a participant handle is not an owner
    settle(participant)
  },

  /**
   * POD-370's asymmetry, asserted rather than only documented: the in-memory
   * adoption hook has no abort twin, so forgetting it can only leave memory BEHIND
   * durable truth. The mutant is adding `onAbort` — which makes this unused.
   *
   * `discard` on the DURABLE participant is not that hook and does not weaken it:
   * it drops a private draft nobody observed. The positive control is that it
   * type-checks in the position where it belongs.
   */
  noInMemoryAbortHook(span: SyncSpan): SyncSpanParticipant {
    // @ts-expect-error there is deliberately no in-memory abort hook
    span.onAbort(() => {})
    return { publish: () => {}, discard: () => {} }
  },
}
void _roleSplitIsEnforcedByTheType

describe('one span, both kernel halves — the commit two definitions made impossible', () => {
  /**
   * This is the wiring POD-305 and POD-373 were blocked on. The Replica OPENS the
   * span over its cache store; the Outbox's store is HANDED the same object and
   * enrols in it. Under two rival definitions this did not typecheck at all, which
   * is what the provisional barrel binding existed to make loud.
   */
  const bothRegions = async () => {
    const replica = new InMemoryReplicaStore()
    const outbox = new InMemoryOutboxStore()
    const span = replica.beginSpan()
    replica.cache.applyAtomic({ operations: [upsert('POD-1', 1)], cursor: CURSOR }, span)
    const outcome = await outbox.apply({ put: [queued('m1')], expect: [absent('m1')] }, span)
    expect(outcome.ok).toBe(true)
    return { replica, outbox, span }
  }

  it('publishes both regions together on commit', async () => {
    const { replica, outbox, span } = await bothRegions()
    // Neither region is visible while the span is open.
    expect(replica.cache.readEntities()).toEqual([])
    expect(outbox.durable()).toEqual([])

    span.commit()

    expect(replica.cache.readEntities().map((r) => r.entityId)).toEqual(['POD-1'])
    expect(outbox.durable().map((r) => r.mutationId)).toEqual(['m1'])
  })

  it('leaves both regions untouched on abort', async () => {
    const { replica, outbox, span } = await bothRegions()
    span.abort()
    expect(replica.cache.readEntities()).toEqual([])
    expect(outbox.durable()).toEqual([])
    // And the cursor did not advance past data that never landed.
    expect(replica.cache.readCursor()).toBeNull()
  })

  it("a veto in ONE region abandons the OTHER region's draft too", async () => {
    // The counterfactual that matters: the outbox's write was perfectly valid and
    // would have published on its own. It is abandoned because a region it shares a
    // span with refused — which is the whole point of enrolling it.
    const { replica, outbox, span } = await bothRegions()
    replica.cache.failNextPrepare = 'quota denied'
    expect(() => span.commit()).toThrow('quota denied')
    expect(outbox.durable()).toEqual([])
    expect(replica.cache.readEntities()).toEqual([])
    // Abort after a vetoed commit is the normal error path and must be a no-op.
    expect(() => span.abort()).not.toThrow()
  })

  it('runs in-memory adoptions only after BOTH regions are durable', async () => {
    // `onCommit` is the outbox kernel's adoption and emission gate. It must observe
    // a world in which every enrolled region has already published — not just its
    // own — or an event could report a fact the shared transaction had not yet made
    // durable.
    const { replica, outbox, span } = await bothRegions()
    const observed: { entities: number; records: number }[] = []
    span.onCommit(() => {
      observed.push({
        entities: replica.cache.readEntities().length,
        records: outbox.durable().length,
      })
    })
    expect(observed).toEqual([])
    span.commit()
    expect(observed).toEqual([{ entities: 1, records: 1 }])
  })

  it('drops adoptions on abort, so nothing is observed for a commit that never happened', async () => {
    const { span } = await bothRegions()
    let adopted = 0
    span.onCommit(() => {
      adopted += 1
    })
    span.abort()
    expect(adopted).toBe(0)
  })
})
