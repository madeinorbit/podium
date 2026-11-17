import { afterEach, describe, expect, it } from 'vitest'
import type { ChangeLogWriteRow } from '../../authority/change-lifecycle'
import { SyncRepository } from './sync-repository'
import { createTestSyncDatabase, createTestSyncQueries, testSyncServerTables } from './test-support'

const databases: ReturnType<typeof createTestSyncDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const fixture = () => {
  const db = createTestSyncDatabase()
  databases.push(db)
  const queries = createTestSyncQueries(db)
  return {
    db,
    queries,
    tenant: (id: string) => new SyncRepository(queries, testSyncServerTables, id),
  }
}
const rows = (n: number): ChangeLogWriteRow[] =>
  Array.from({ length: n }, (_, i) => ({
    entity: 'issueProjection',
    entityId: `i${i}`,
    op: 'upsert',
    payload: '{}',
  }))

describe('tenant feed isolation', () => {
  it('isolates identities, generations, heads and both range reads with overlapping keys', async () => {
    const { db, tenant } = fixture()
    const a = tenant('a'),
      b = tenant('b')
    await a.writeFeedIdentity({ feedId: 'feed-a', epoch: 'epoch-a' }, 1)
    await b.writeFeedIdentity({ feedId: 'feed-b', epoch: 'epoch-b' }, 2)
    db.exec("INSERT INTO sync_kind VALUES ('a', 'issueProjection', 7), ('b', 'issueProjection', 9)")
    // An identity minted before any append starts the feed at head 1 (ADR 2 D12).
    expect(await a.appendChanges(rows(2), 1)).toEqual([2, 3])
    expect(await b.appendChanges(rows(1), 2)).toEqual([2])
    expect(await a.readKindGenerations()).toEqual([{ kind: 'issueProjection', generation: 7 }])
    expect(await b.readKindGenerations()).toEqual([{ kind: 'issueProjection', generation: 9 }])
    expect(await b.readFeedIdentity()).toEqual({ feedId: 'feed-b', epoch: 'epoch-b' })
    expect((await a.changesSince(0)).map((r) => r.seq)).toEqual([2, 3])
    expect((await b.changesInRange(0, 2, 10)).map((r) => r.seq)).toEqual([2])
    expect(await b.readFeedState()).toEqual({ headSeq: 2, floorSeq: 1 })
  })

  it('prunes only its tenant, persists the empty floor and never reuses a committed number', async () => {
    const { tenant } = fixture()
    const a = tenant('a'),
      b = tenant('b')
    await a.appendChanges(rows(4), 1)
    await b.appendChanges(rows(4), 100)
    const plan = await a.planChangePrune({ keepRows: 1, maxAgeMs: 10, now: 100 })
    expect(plan.thresholdSeq).toBe(4)
    expect(await a.pruneChangeBatch(plan, 2)).toBe(2)
    expect(await a.readFeedState()).toEqual({ headSeq: 4, floorSeq: 3 })
    expect(await a.pruneChangeBatch(plan, 2)).toBe(2)
    expect(await a.readFeedState()).toEqual({ headSeq: 4, floorSeq: 5 })
    expect(await a.minChangeSeq()).toBeNull()
    expect(await tenant('a').appendChanges(rows(1), 101)).toEqual([5])
    expect(await b.readFeedState()).toEqual({ headSeq: 4, floorSeq: 1 })
    expect(await b.changesSince(0)).toHaveLength(4)
    expect(await b.planChangePrune({ keepRows: 10, maxAgeMs: 10, now: 100 })).toEqual({
      thresholdSeq: 0,
    })
  })

  it('rolls reservations, source writes and all chunks back with the enclosing write', async () => {
    const { db, queries, tenant } = fixture()
    const a = tenant('a')
    db.exec('CREATE TABLE source (id TEXT PRIMARY KEY)')
    await expect(
      queries.createOrJoinTransaction(async () => {
        db.exec("INSERT INTO source VALUES ('changed')")
        await a.appendChanges(rows(250), 1)
        expect(await a.maxChangeSeq()).toBe(250)
        throw new Error('abort source write')
      }),
    ).rejects.toThrow('abort source write')
    expect(db.prepare('SELECT * FROM source').all()).toEqual([])
    expect(await a.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
    expect(await a.changesSince(0)).toEqual([])
    expect(await a.appendChanges(rows(1), 2)).toEqual([1])
  })

  it('rolls back an insert failure after an earlier chunk succeeded', async () => {
    const { tenant } = fixture()
    const a = tenant('a')
    const invalid = rows(101)
    invalid[100] = { ...invalid[100]!, entityId: null as unknown as string }
    await expect(a.appendChanges(invalid, 1)).rejects.toThrow()
    expect(await a.changesSince(0)).toEqual([])
    expect(await a.appendChanges(rows(2), 2)).toEqual([1, 2])
  })

  it('raises only an empty head, per tenant, so no start-up load is stamped at 0', async () => {
    const { db, tenant } = fixture()
    // The fresh-install row the tenant-feed migration writes: head 0, floor 1.
    db.exec(
      "INSERT INTO sync_feed (workspace_id, feed_id, epoch, minted_at, head_seq, floor_seq) VALUES ('a', 'fa', 'ea', 0, 0, 1), ('b', 'fb', 'eb', 0, 0, 1)",
    )
    const a = tenant('a'),
      b = tenant('b')
    await a.raiseEmptyHead()
    // The floor stays 1: the empty range (0, 1] is what a cursor at 0 reads.
    expect(await a.readFeedState()).toEqual({ headSeq: 1, floorSeq: 1 })
    expect(await b.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
    expect(await a.appendChanges(rows(1), 1)).toEqual([2])
    await a.raiseEmptyHead()
    expect(await a.readFeedState()).toEqual({ headSeq: 2, floorSeq: 1 })
    // A feed whose identity is minted before any append is created at head 1.
    await tenant('c').writeFeedIdentity({ feedId: 'fc', epoch: 'ec' }, 1)
    expect(await tenant('c').readFeedState()).toEqual({ headSeq: 1, floorSeq: 1 })
  })

  it('identity bumps preserve counters and empty appends reserve nothing', async () => {
    const { tenant } = fixture()
    const a = tenant('a')
    expect(await a.appendChanges([], 0)).toEqual([])
    expect(await a.readFeedIdentity()).toBeNull()
    await a.appendChanges(rows(2), 1)
    await a.writeFeedIdentity({ feedId: 'feed-a', epoch: 'epoch-next' }, 2)
    expect(await a.readFeedState()).toEqual({ headSeq: 2, floorSeq: 1 })
    expect(await a.appendChanges(rows(1), 3)).toEqual([3])
  })
})
