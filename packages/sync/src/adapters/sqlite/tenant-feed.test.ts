/**
 * ONE FEED PER WORKSPACE (ADR 13, POD-6959 design 2.7, POD-7021).
 *
 * Two workspaces over one database, with the same entity ids, mutation ids and
 * session ids: what one writes never reaches the other's feed, head, floor,
 * kind generations, mutation receipts or inbox, and a repository of one
 * workspace cannot run inside the other's transaction.
 */

import type { MutationId, SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChangeLogWriteRow } from '../../authority/change-lifecycle'
import { CrossWorkspaceStatementError } from './prepared'
import { SyncRepository } from './sync-repository'
import {
  createTestSyncDatabase,
  createTestSyncQueries,
  testSyncServerTables,
  testWorkspaceQueries,
} from './test-support'

const databases: ReturnType<typeof createTestSyncDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const fixture = () => {
  const db = createTestSyncDatabase()
  databases.push(db)
  const base = createTestSyncQueries(db)
  /** One workspace's queries over the shared connection. */
  const queriesOf = (id: string) => testWorkspaceQueries(base, id)
  return {
    db,
    queriesOf,
    tenant: (id: string) => new SyncRepository(queriesOf(id), testSyncServerTables, id),
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
    const { db, queriesOf, tenant } = fixture()
    const a = tenant('a')
    db.exec('CREATE TABLE source (id TEXT PRIMARY KEY)')
    await expect(
      queriesOf('a').createOrJoinTransaction(async () => {
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

  it("never shows a write of one workspace in another's feed, head or floor", async () => {
    const { tenant } = fixture()
    const a = tenant('ws_a'),
      b = tenant('ws_b')
    // The same entity ids in both workspaces.
    await b.appendChanges(rows(2), 1)
    const bBefore = await b.readFeedState()
    const bChanges = await b.changesSince(0)
    expect(await a.appendChanges(rows(3), 2)).toEqual([1, 2, 3])
    expect(await a.appendChanges(rows(2), 3)).toEqual([4, 5])
    expect(await b.readFeedState()).toEqual(bBefore)
    expect(await b.changesSince(0)).toEqual(bChanges)
    expect(await b.changesInRange(0, 10, 10)).toEqual(bChanges)
    expect(await b.maxChangeSeq()).toBe(2)
    // A's seqs 3 to 5 do not exist in B's log; 1 and 2 are B's own rows.
    expect([...(await b.changesWithPrior([1, 2, 3, 4, 5])).keys()].sort()).toEqual([1, 2])
    // A prune in A leaves B's floor and rows alone.
    const plan = await a.planChangePrune({ keepRows: 0, maxAgeMs: 0, now: 100 })
    expect(await a.pruneChangeBatch(plan, 10)).toBe(5)
    expect(await a.readFeedState()).toEqual({ headSeq: 5, floorSeq: 6 })
    expect(await b.readFeedState()).toEqual(bBefore)
    expect(await b.changesSince(0)).toEqual(bChanges)
  })

  it('moves kind generations per workspace', async () => {
    const { db, tenant } = fixture()
    const a = tenant('ws_a'),
      b = tenant('ws_b')
    await a.writeFeedIdentity({ feedId: 'fa', epoch: 'ea' }, 1)
    await b.writeFeedIdentity({ feedId: 'fb', epoch: 'eb' }, 1)
    db.exec(
      "INSERT INTO sync_kind VALUES ('ws_a', 'session', 4), ('ws_b', 'session', 4), ('ws_b', 'message', 2)",
    )
    // A bump of one workspace's kind moves only that workspace's generation.
    db.exec(
      "UPDATE sync_kind SET generation = generation + 1 WHERE workspace_id = 'ws_a' AND kind = 'session'",
    )
    expect(await a.readKindGenerations()).toEqual([{ kind: 'session', generation: 5 }])
    expect((await b.readKindGenerations()).sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([
      { kind: 'message', generation: 2 },
      { kind: 'session', generation: 4 },
    ])
    // A data migration's bump (design 2.7) moves the kind once in every workspace with a feed.
    db.exec(
      "INSERT INTO sync_kind (workspace_id, kind, generation) SELECT workspace_id, 'message', 1 FROM sync_feed WHERE true " +
        'ON CONFLICT (workspace_id, kind) DO UPDATE SET generation = sync_kind.generation + 1',
    )
    const generation = async (repo: SyncRepository, kind: string) =>
      (await repo.readKindGenerations()).find((row) => row.kind === kind)?.generation
    expect([await generation(a, 'message'), await generation(b, 'message')]).toEqual([1, 3])
    expect([await generation(a, 'session'), await generation(b, 'session')]).toEqual([5, 4])
  })

  it('keeps mutation receipts and the session inbox per workspace', async () => {
    const { tenant } = fixture()
    const a = tenant('ws_a'),
      b = tenant('ws_b')
    const mutation = 'mut-1' as MutationId
    await a.recordAppliedMutation(mutation, 'issue.create', '{"ok":"a"}', 10)
    expect(await a.getAppliedMutation(mutation)).toBe('{"ok":"a"}')
    expect(await b.getAppliedMutation(mutation)).toBeUndefined()
    expect(
      await b.getAppliedMutation(mutation, { mutationId: mutation, before: 100 }),
    ).toBeUndefined()
    await b.pruneAppliedMutations({ maxAgeMs: 0, now: 1_000 })
    expect(await a.getAppliedMutation(mutation)).toBe('{"ok":"a"}')

    const session = 'sess-1' as SessionId
    expect(await a.enqueueMessage({ id: 'q-a', sessionId: session, text: 'a', queuedAt: 1 })).toBe(
      true,
    )
    expect(await b.listQueuedMessages(session)).toEqual([])
    expect(await b.queuedMessageCounts()).toEqual(new Map())
    expect(await b.queuedMessageCounts([session])).toEqual(new Map())
    // B's writes by A's ids reach nothing of A's.
    await b.reserveQueuedDelivery('q-a')
    await b.deleteQueuedMessage('q-a')
    await b.deleteQueuedMessagesForSession(session)
    expect(await b.deleteUnreservedQueuedMessage('q-a')).toBe(false)
    const [row] = await a.listQueuedMessages(session)
    expect(row).toMatchObject({ id: 'q-a', deliveryOwner: null, attempts: 0 })
    expect(await a.queuedMessageCounts(session)).toEqual(new Map([[session, 1]]))
    expect(await b.listParkedUpstreamMutations()).toEqual([])
  })

  it("refuses a statement of one workspace inside another's transaction", async () => {
    const { queriesOf, tenant } = fixture()
    const a = tenant('ws_a'),
      b = tenant('ws_b')
    await expect(
      queriesOf('ws_a').createOrJoinTransaction(async () => {
        await a.appendChanges(rows(1), 1)
        await b.appendChanges(rows(1), 1)
      }),
    ).rejects.toBeInstanceOf(CrossWorkspaceStatementError)
    // The whole transaction rolled back: A's append did not commit either.
    expect(await a.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
    expect(await b.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
  })

  it("refuses to build a repository over another workspace's queries", () => {
    const { queriesOf } = fixture()
    expect(() => new SyncRepository(queriesOf('ws_a'), testSyncServerTables, 'ws_b')).toThrow(
      'built over the queries of workspace ws_a',
    )
  })
})
