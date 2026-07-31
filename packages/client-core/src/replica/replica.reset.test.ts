/**
 * The reset (ADR 2 D7 rungs 4–6) and the cursor triple (D1).
 *
 * These tests exist because of one reproduced finding (POD-794 addendum 2): the
 * engine's own reset is COLLECTION-SCOPED. It clears the tables it knows about,
 * which means it can never eat our outbox — and, for exactly the same reason,
 * can never clear our cursor. entities=0 with cursor=77 is a permanent silent
 * hole: `changesSince(77)` answers "caught up" over an empty replica forever and
 * NO rung of the ladder detects it, because every rung's exit condition looks
 * satisfied. The cursor assertion below is the one that catches it.
 */

import type { IssueWire, SessionMeta } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from '../outbox'
import { COLD_CURSOR } from './feed'
import { createReplica, memoryStorage, parseFeedCursor, serializeFeedCursor } from './replica'

const issue = (id: string): IssueWire => ({ id, title: id }) as unknown as IssueWire
const session = (id: string): SessionMeta => ({ sessionId: id }) as unknown as SessionMeta

const userWrite: OutboxEntry = {
  mutationId: 'mut_1',
  kind: 'issue.create',
  input: { title: 'user work' },
  queuedAt: 1,
}

describe('resetCache — discard the cache, keep the outbox', () => {
  it('clears entities AND the cursor, and keeps the outbox (the D7 pin)', () => {
    const storage = memoryStorage()
    const replica = createReplica({ storage })
    replica.applySnapshot('issues', [issue('i1'), issue('i2')])
    replica.applySnapshot('sessions', [session('s1')])
    replica.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 77 })
    replica.outboxStorage().save([userWrite])

    replica.resetCache()

    expect(replica.rows('issues')).toHaveLength(0)
    expect(replica.rows('sessions')).toHaveLength(0)
    // THE assertion. A collection-scoped reset passes every line above and
    // fails this one.
    expect(replica.getFeedCursor()).toEqual(COLD_CURSOR)
    expect(replica.getCursor()).toBeNull()
    // The user's unsent write is not a cache.
    expect(replica.outboxStorage().load()).toEqual([userWrite])
  })

  it('a reset replica re-bootstraps from null rather than healing over the hole', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [issue('i1')])
    replica.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 77 })
    replica.resetCache()
    // getCursor() is what the sync driver passes to changesSince. null = "send
    // me the world", which is the only honest thing an empty replica can ask.
    expect(replica.getCursor()).toBeNull()
  })

  it('a cursor persist queued BEFORE the reset must not land after it', async () => {
    // The cursor persist is parked behind the entity-write fence (invariant 3),
    // so a reset can happen while a setFeedCursor is still in flight. If that
    // write persisted its captured value, the reset would re-create the exact
    // hole it exists to close — cursor=77 on disk, zero entities — from inside
    // itself, and only on a reload would anyone find out.
    const storage = memoryStorage()
    const replica = createReplica({ storage })
    replica.applySnapshot('issues', [issue('i1')])
    replica.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 77 })
    replica.resetCache()
    // Let every parked write drain.
    await new Promise((r) => setTimeout(r, 0))

    expect(parseFeedCursor(storage.getItem('podium.replica.cursor.v1'))).toEqual(COLD_CURSOR)
    const reloaded = createReplica({ storage })
    const result = await reloaded.hydrate()
    expect(result.issues).toHaveLength(0)
    expect(result.cursor).toBeNull()
  })

  it('survives being called on an already-empty replica', () => {
    const replica = createReplica({ storage: memoryStorage() })
    expect(() => replica.resetCache()).not.toThrow()
    expect(replica.getFeedCursor()).toEqual(COLD_CURSOR)
  })
})

describe('rung 5 — a poisoned replica cold-starts, and its cursor goes with it', () => {
  it('a hydrate that throws leaves NO cursor behind', async () => {
    // The silent hole via the poison path: clearing the cache while a cursor
    // survives in memory would have the next changesSince report "caught up"
    // over nothing. The cursor is cache too, and dies with it.
    const storage = memoryStorage()
    const replica = createReplica({ storage })
    replica.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 77 })
    // Poison the load.
    storage.setItem('podium.replica.issues.v1', '{ not json')
    const cols = replica.collection('issues') as { preload: () => Promise<void> }
    cols.preload = () => Promise.reject(new Error('poisoned'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await replica.hydrate()
      expect(result.cursor).toBeNull()
      expect(result.feedCursor).toEqual(COLD_CURSOR)
      expect(replica.getFeedCursor()).toEqual(COLD_CURSOR)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('cursor triple persistence (ADR 2 D1)', () => {
  it('round-trips the whole triple, not just the seq', () => {
    const storage = memoryStorage()
    const replica = createReplica({ storage })
    const cursor = { feedId: 'feed_1', epoch: 'epoch_1', seq: 42 }
    replica.setFeedCursor(cursor)
    expect(replica.getFeedCursor()).toEqual(cursor)
  })

  it('setCursor keeps the identity a stamped reply established', () => {
    // The seq-only seam must not blank feedId/epoch to null: the next stamped
    // reply would then read as a mismatch against nothing and reset forever.
    const replica = createReplica({ storage: memoryStorage() })
    replica.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 10 })
    replica.setCursor(11)
    expect(replica.getFeedCursor()).toEqual({ feedId: 'feed_1', epoch: 'epoch_1', seq: 11 })
  })

  it('hydrate reports the triple a previous session persisted', async () => {
    const storage = memoryStorage()
    const first = createReplica({ storage })
    first.applySnapshot('issues', [issue('i1')])
    first.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 5 })
    await first.hydrate()

    const second = createReplica({ storage })
    const result = await second.hydrate()
    expect(result.feedCursor).toEqual({ feedId: 'feed_1', epoch: 'epoch_1', seq: 5 })
    expect(result.cursor).toBe(5)
    expect(result.schemaReset).toBe(false)
  })
})

describe('parseFeedCursor — lenient by design', () => {
  it('reads a LEGACY bare-number cursor as a seq on an unnamed feed', () => {
    // Not a discard: a pre-identity cursor is not wrong, it is unnamed. The
    // first stamped reply confirms it or trips rung 4. Discarding it would make
    // every warm client re-download the world once, buying nothing.
    expect(parseFeedCursor('77')).toEqual({ feedId: null, epoch: null, seq: 77 })
  })

  it('reads garbage as COLD rather than guessing', () => {
    for (const raw of ['', '{', 'null', '{"seq":"x"}', '{"feedId":"f"}', '[]']) {
      expect(parseFeedCursor(raw)).toEqual(COLD_CURSOR)
    }
  })

  it('reads an absent cursor as COLD', () => {
    expect(parseFeedCursor(null)).toEqual(COLD_CURSOR)
  })

  it('normalises an empty-string id to null — a blank id compares equal to another blank', () => {
    expect(parseFeedCursor('{"feedId":"","epoch":"","seq":3}')).toEqual({
      feedId: null,
      epoch: null,
      seq: 3,
    })
  })

  it('an OLDER build reading our blob sees "never synced", never a false cursor', () => {
    // The rollback path: old code does Number(raw) and checks isFinite.
    const blob = serializeFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 77 })
    expect(Number.isFinite(Number(blob))).toBe(false)
  })
})

describe('schema version gate (ADR 2 D7 rung 6) — it must not fail open', () => {
  it('discards a cache written by another schema version, keeping the outbox', async () => {
    const storage = memoryStorage()
    const first = createReplica({ storage })
    first.applySnapshot('issues', [issue('i1'), issue('i2')])
    first.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 77 })
    first.outboxStorage().save([userWrite])
    await first.hydrate()

    // A build whose replica format moved on.
    storage.setItem('podium.replica.schema.v1', '999')

    const second = createReplica({ storage })
    const result = await second.hydrate()
    expect(result.schemaReset).toBe(true)
    expect(result.issues).toHaveLength(0)
    expect(result.feedCursor).toEqual(COLD_CURSOR)
    expect(result.cursor).toBeNull()
    expect(second.outboxStorage().load()).toEqual([userWrite])
  })

  it('an UNSTAMPED cache is not a mismatch — v1 is the version the stamp arrived at', async () => {
    const storage = memoryStorage()
    const first = createReplica({ storage })
    first.applySnapshot('issues', [issue('i1')])
    first.setFeedCursor({ feedId: 'feed_1', epoch: 'epoch_1', seq: 9 })
    await first.hydrate()
    storage.removeItem('podium.replica.schema.v1')

    const second = createReplica({ storage })
    const result = await second.hydrate()
    expect(result.schemaReset).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.cursor).toBe(9)
  })
})
