/**
 * Bootstrap (ADR 2 D6) and the ladder's terminal recovery (D7).
 *
 * The last describe here is the conformance test ADR 2 D7 names explicitly and
 * calls out as the one a suite is likeliest to skip: *offline writes queued →
 * force an epoch bump → reconnect → the queued writes still drain or surface,
 * and none vanish.* Its warning is worth repeating, because it is a statement
 * about test design rather than about code — "a suite that only checks entity
 * convergence would pass while the outbox is being silently eaten."
 */

import type { MetadataChangeLenient } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from '../outbox'
import { BootstrapSession, snapshotToChunks } from './bootstrap'
import { advanceCursor, COLD_CURSOR, decideFeedAction, type FeedCursor } from './feed'
import { createReplica, memoryStorage } from './replica'

const at = (feedId: string, epoch: string, seq: number): FeedCursor => ({ feedId, epoch, seq })
/** Tests pace synchronously — the real yield is a macrotask hop. */
const noYield = { yieldToLoop: () => Promise.resolve() }

const upsert = (entity: string, id: string, seq: number, value?: object): MetadataChangeLenient =>
  ({ seq, entity, id, op: 'upsert', value: value ?? { id, title: id } }) as MetadataChangeLenient
const remove = (entity: string, id: string, seq: number): MetadataChangeLenient =>
  ({ seq, entity, id, op: 'remove' }) as MetadataChangeLenient

const userWrite: OutboxEntry = {
  mutationId: 'mut_1',
  kind: 'issue.create',
  input: { title: 'the thing the user typed' },
  queuedAt: 1,
}

describe('BootstrapSession — staging and the atomic swap', () => {
  it('writes NOTHING until commit — a bootstrap in flight must not blank the UI', async () => {
    // D7's "stale-visible, never blank": a re-bootstrap that never finishes
    // (offline) keeps serving the last-known state. Clearing first and filling
    // after is the obvious implementation and the one D6 forbids.
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [{ id: 'old', title: 'stale but visible' } as never])
    replica.setFeedCursor(at('feed_1', 'epoch_1', 5))

    const session = new BootstrapSession(replica, at('feed_1', 'epoch_2', 9), noYield)
    await session.install({ changes: [upsert('issue', 'new', 1)] })

    // Mid-bootstrap: the old world is still there, untouched.
    expect(replica.rows('issues').map((i) => i.id)).toEqual(['old'])
    expect(replica.getFeedCursor()).toEqual(at('feed_1', 'epoch_1', 5))

    session.commit()
    expect(replica.rows('issues').map((i) => i.id)).toEqual(['new'])
    expect(replica.getFeedCursor()).toEqual(at('feed_1', 'epoch_2', 9))
  })

  it('an aborted bootstrap leaves the replica exactly as it was', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [{ id: 'old', title: 'old' } as never])
    replica.setFeedCursor(at('feed_1', 'epoch_1', 5))

    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 9), noYield)
    await session.install({ changes: [upsert('issue', 'new', 1)] })
    session.abort()

    expect(replica.rows('issues').map((i) => i.id)).toEqual(['old'])
    expect(replica.getFeedCursor()).toEqual(at('feed_1', 'epoch_1', 5))
  })

  it('the swap is ONE notification against the final state, not a flicker', () => {
    // A subscriber that reacted to the transient half-installed list is exactly
    // what yanked the engine's worktree selection once (#262).
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [{ id: 'old', title: 'old' } as never])
    const seen: string[][] = []
    replica.subscribeRows('issues', () => seen.push(replica.rows('issues').map((i) => i.id)))

    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 9), noYield)
    void session.install({ changes: [upsert('issue', 'a', 1), upsert('issue', 'b', 2)] })
    session.commit()

    expect(seen).toEqual([['a', 'b']])
  })

  it('installs across kinds and drops rows the authority no longer has', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [{ id: 'gone', title: 'gone' } as never])
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 3), noYield)
    await session.install({
      changes: [upsert('issue', 'i1', 1), upsert('session', 's1', 2, { sessionId: 's1' })],
    })
    session.commit()

    expect(replica.rows('issues').map((i) => i.id)).toEqual(['i1'])
    expect(replica.rows('sessions').map((s) => s.sessionId)).toEqual(['s1'])
  })

  it('ignores an unknown entity kind rather than quarantining the bootstrap', async () => {
    // D4's additive rule: a NEWER authority adding a kind must not break an
    // older client. The row is ignored, the bootstrap completes.
    const replica = createReplica({ storage: memoryStorage() })
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 2), noYield)
    await session.install({ changes: [upsert('machine', 'm1', 1), upsert('issue', 'i1', 2)] })
    session.commit()
    expect(replica.rows('issues').map((i) => i.id)).toEqual(['i1'])
  })
})

describe('pacing — the bootstrap must never own the loop (D6)', () => {
  it('yields between install batches', async () => {
    // The transcript-mirror incident in one assertion: chunks that drain
    // back-to-back starve the loop the bootstrap itself depends on, and the
    // restart re-triggers the bootstrap. Yielding is what stops the loop.
    const replica = createReplica({ storage: memoryStorage() })
    const yieldToLoop = vi.fn(() => Promise.resolve())
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 1), {
      yieldToLoop,
      batchSize: 10,
    })
    await session.install({
      changes: Array.from({ length: 35 }, (_, i) => upsert('issue', `i${i}`, i + 1)),
    })
    expect(yieldToLoop).toHaveBeenCalledTimes(3)
  })

  it('a small bootstrap does not yield at all', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    const yieldToLoop = vi.fn(() => Promise.resolve())
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 1), {
      yieldToLoop,
      batchSize: 10,
    })
    await session.install({ changes: [upsert('issue', 'i1', 1)] })
    expect(yieldToLoop).not.toHaveBeenCalled()
  })
})

describe('concurrent deltas — the world moves while we stream (D6 step 3)', () => {
  it('buffers deltas past snapshotSeq and applies them in the commit', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 10), noYield)
    await session.install({ changes: [upsert('issue', 'i1', 1, { id: 'i1', title: 'as of 10' })] })

    // A live delta lands mid-bootstrap.
    expect(
      session.bufferDelta(11, [upsert('issue', 'i1', 11, { id: 'i1', title: 'as of 11' })]),
    ).toBe(true)
    // Nothing applied yet.
    expect(replica.rows('issues')).toHaveLength(0)

    session.commit()
    expect(replica.rows('issues')[0]?.title).toBe('as of 11')
    expect(replica.getFeedCursor().seq).toBe(11)
  })

  it('a buffered REMOVE deletes a row the snapshot still had', async () => {
    // The case that silently rots if buffering only handles upserts: the
    // snapshot was read before the delete, so the row is in staging and the
    // tombstone is in the buffer. Drop the buffer and the row lives forever.
    const replica = createReplica({ storage: memoryStorage() })
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 10), noYield)
    await session.install({ changes: [upsert('issue', 'i1', 1), upsert('issue', 'i2', 2)] })
    session.bufferDelta(11, [remove('issue', 'i1', 11)])
    session.commit()

    expect(replica.rows('issues').map((i) => i.id)).toEqual(['i2'])
    expect(replica.getFeedCursor().seq).toBe(11)
  })

  it('applies buffered deltas in seq order regardless of arrival order', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 10), noYield)
    await session.install({ changes: [upsert('issue', 'i1', 1)] })
    session.bufferDelta(13, [upsert('issue', 'i1', 13, { id: 'i1', title: 'last' })])
    session.bufferDelta(12, [upsert('issue', 'i1', 12, { id: 'i1', title: 'middle' })])
    session.commit()
    expect(replica.rows('issues')[0]?.title).toBe('last')
    expect(replica.getFeedCursor().seq).toBe(13)
  })

  it('declines a delta at or below snapshotSeq — the snapshot already has it', () => {
    const replica = createReplica({ storage: memoryStorage() })
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 10), noYield)
    expect(session.bufferDelta(10, [upsert('issue', 'i1', 10)])).toBe(false)
    expect(session.bufferDelta(9, [upsert('issue', 'i1', 9)])).toBe(false)
  })
})

describe('snapshotToChunks — today’s monolithic arm through the final machinery', () => {
  it('turns a product-typed snapshot into change-shaped chunks', () => {
    const chunks = snapshotToChunks(
      { issues: [{ id: 'i1' }, { id: 'i2' }], sessions: [{ sessionId: 's1' }] },
      2,
    )
    expect(chunks).toHaveLength(2)
    expect(chunks.flatMap((c) => c.changes).map((c) => [c.entity, c.id])).toEqual([
      ['session', 's1'],
      ['issue', 'i1'],
      ['issue', 'i2'],
    ])
  })

  it('an EMPTY authority still yields one chunk — an empty world is a valid world', () => {
    // Zero chunks would mean "no bootstrap happened" and leave the caller unable
    // to distinguish a fresh instance from a failed stream.
    expect(snapshotToChunks({})).toEqual([{ changes: [] }])
  })

  it('installs end-to-end through the session', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_1', 42), noYield)
    for (const chunk of snapshotToChunks({ issues: [{ id: 'i1' }, { id: 'i2' }] }, 1)) {
      await session.install(chunk)
    }
    session.commit()
    expect(replica.rows('issues').map((i) => i.id)).toEqual(['i1', 'i2'])
    expect(replica.getFeedCursor().seq).toBe(42)
  })
})

describe('D7 conformance: THE OUTBOX SURVIVES EVERY RUNG', () => {
  it('offline writes → epoch bump → reconnect → the writes are still there', async () => {
    // The test ADR 2 D7 demands by name. It is not testing a line of code — it
    // is testing that a *cache* discard did not take *authored truth* with it.
    // ADR 6 puts entities, cursor and outbox in one store, so "clear the store"
    // reads as one innocent operation and is in fact two: throwing away a cache,
    // which is free, and throwing away the user's unsent writes, which is data
    // loss. The danger is that it is invisible: entity convergence looks perfect
    // either way.
    const storage = memoryStorage()
    const replica = createReplica({ storage })

    // A warm replica on epoch_1.
    replica.applySnapshot('issues', [{ id: 'i1', title: 'from epoch 1' } as never])
    replica.setFeedCursor(at('feed_1', 'epoch_1', 77))
    // The user, offline, types something.
    replica.outboxStorage().save([userWrite])

    // Reconnect. The authority was restored from a backup: same feed, new epoch.
    const action = decideFeedAction(replica.getFeedCursor(), {
      kind: 'delta',
      firstSeq: 78,
      cursor: 78,
      stamp: { feedId: 'feed_1', epoch: 'epoch_2' },
    })
    expect(action).toEqual({ rung: 4, effect: 'discard', reason: 'epoch-mismatch' })

    // Rung 4: discard the cache, re-bootstrap.
    replica.resetCache()
    expect(replica.rows('issues')).toHaveLength(0)
    expect(replica.getFeedCursor()).toEqual(COLD_CURSOR)

    // THE ASSERTION. A command is a request against an entity, not against a
    // feed position — the mutationId is minted by the client and does not derive
    // from the feed, so an epoch change cannot invalidate it.
    expect(replica.outboxStorage().load()).toEqual([userWrite])

    // Re-bootstrap onto the new timeline.
    const session = new BootstrapSession(replica, at('feed_1', 'epoch_2', 78), noYield)
    await session.install({
      changes: [upsert('issue', 'i2', 1, { id: 'i2', title: 'from epoch 2' })],
    })
    session.commit()

    expect(replica.rows('issues').map((i) => i.id)).toEqual(['i2'])
    expect(replica.getFeedCursor()).toEqual(at('feed_1', 'epoch_2', 78))
    // Still there, on the far side of the whole ladder, ready to drain.
    expect(replica.outboxStorage().load()).toEqual([userWrite])
  })

  it('survives the reload that follows the discard, too', async () => {
    // The rung-4 discard and the reload are different code paths and the outbox
    // has to survive both. A discard that keeps the queue in memory and loses it
    // on the next reload passes the test above and still eats the user's work.
    const storage = memoryStorage()
    const first = createReplica({ storage })
    first.applySnapshot('issues', [{ id: 'i1', title: 'i1' } as never])
    first.setFeedCursor(at('feed_1', 'epoch_1', 77))
    first.outboxStorage().save([userWrite])
    first.resetCache()
    await new Promise((r) => setTimeout(r, 0))

    const reloaded = createReplica({ storage })
    const result = await reloaded.hydrate()
    expect(result.issues).toHaveLength(0)
    expect(result.cursor).toBeNull()
    expect(reloaded.outboxStorage().load()).toEqual([userWrite])
  })

  it('the cursor a discard leaves behind cannot be advanced over — it must bootstrap', () => {
    // The silent-hole guard, stated as the ladder sees it: after a discard the
    // replica is COLD, so the next thing it can legally do is take a snapshot.
    // Were the cursor to survive at 77, this would say "apply" over an empty
    // replica and be wrong forever.
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [{ id: 'i1', title: 'i1' } as never])
    replica.setFeedCursor(at('feed_1', 'epoch_1', 77))
    replica.resetCache()

    const action = decideFeedAction(replica.getFeedCursor(), {
      kind: 'delta',
      firstSeq: 78,
      cursor: 78,
      stamp: { feedId: 'feed_1', epoch: 'epoch_1' },
    })
    expect(action).toEqual({ rung: 1, effect: 'heal', reason: 'gap' })
    expect(
      advanceCursor(replica.getFeedCursor(), {
        kind: 'snapshot',
        cursor: 90,
        stamp: { feedId: 'feed_1', epoch: 'epoch_1' },
      }),
    ).toEqual(at('feed_1', 'epoch_1', 90))
  })
})
