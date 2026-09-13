/**
 * A DELIVERED EVICTION REACHES THE CACHE (PDM-408) — the production apply path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT DOES *NOT* REPLACE
 * ---------------------------------------------------------------------------
 *
 * `engine/replica-binding.test.ts` has a witness that two marks survive a
 * publication and that evicting one leaves the other. That witness stands and is
 * credited for what it proves: the BINDING re-derives and republishes correctly.
 *
 * What it cannot prove — PDM-139's objection, and it is right — is that a
 * DELIVERED eviction causes the cache mutation in the first place. It calls
 * `cache.drop()` itself and then announces the event, so the expected end state
 * is manufactured by the test rather than produced by the code under test. A
 * replica that ignored every incoming eviction would pass it.
 *
 * So this file drives the REAL `Replica` from `@podium/sync/replica` over a real
 * `InMemoryReplicaStore`: the rows arrive through the real bootstrap path, the
 * eviction arrives as an ordinary delta frame, and the assertion is made against
 * the STORE. Nothing here deletes anything by hand.
 */

import { asUserId, issueMarksRowId } from '@podium/model'
import {
  type AuthorityReadPort,
  type BootstrapChunk,
  type ChangesSinceReply,
  type Cursor,
  InMemoryReplicaStore,
  Replica,
} from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'

const FEED = 'feed-1'
const EPOCH = 'epoch-1'
const ME = asUserId('mem_me')
const GONE = 'iss_gone'
const KEPT = 'iss_kept'

const marksValue = (issueId: string, readAt: string) => ({
  userId: ME,
  issueId,
  readAt,
  tuckedAt: null,
  pinned: false,
})

/** Serves one slice and nothing else — the rows arrive the way they really do. */
class SliceAuthority implements AuthorityReadPort {
  constructor(
    private readonly rows: readonly { entity: string; entityId: string; value: unknown }[],
  ) {}
  async changesSince(_cursor: Cursor): Promise<ChangesSinceReply> {
    return { kind: 'bootstrap-required', reason: 'this fixture only bootstraps' }
  }
  bootstrap(): AsyncIterable<BootstrapChunk> {
    const rows = this.rows
    return (async function* () {
      yield {
        feedId: FEED,
        epoch: EPOCH,
        snapshotSeq: rows.length,
        changes: rows.map((row, i) => ({
          seq: i + 1,
          entity: row.entity,
          entityId: row.entityId,
          op: 'upsert' as const,
          payload: row.value,
        })),
        last: true,
      }
    })()
  }
}

async function bootstrapped() {
  const store = new InMemoryReplicaStore()
  const authority = new SliceAuthority([
    { entity: 'issue', entityId: GONE, value: { id: GONE, title: 'gone' } },
    { entity: 'issue', entityId: KEPT, value: { id: KEPT, title: 'kept' } },
    {
      entity: 'issueMarks',
      entityId: issueMarksRowId(ME, GONE),
      value: marksValue(GONE, 'T-gone'),
    },
    {
      entity: 'issueMarks',
      entityId: issueMarksRowId(ME, KEPT),
      value: marksValue(KEPT, 'T-kept'),
    },
  ])
  const events: { type: string }[] = []
  const replica = new Replica({
    store: store.cache,
    authority,
    unitOfWork: store.unitOfWork,
    onEvent: (event: { type: string }) => events.push(event),
  } as never)
  // The real cold-start path: connect, let the bootstrap walk, settle.
  replica.connect()
  await replica.settled()
  return { store, replica, events }
}

const marksIn = (store: InMemoryReplicaStore): string[] =>
  store.cache
    .readEntities()
    .filter((record) => record.entity === 'issueMarks')
    .map((record) => (record.value as { issueId: string }).issueId)

describe('a delivered eviction removes exactly one mark from the cache', () => {
  it('drops the evicted issue’s mark and leaves the other, with no manual deletion', async () => {
    const { store, replica, events } = await bootstrapped()
    // BOTH preconditions, established by the real bootstrap rather than by the
    // fixture reaching into the cache.
    expect(marksIn(store).sort()).toEqual([GONE, KEPT].sort())

    // The eviction as the feed delivers it: an ordinary delta frame, addressed
    // by the (user, issue) composite the Authority logs.
    await replica.receive({
      kind: 'delta',
      feedId: FEED,
      epoch: EPOCH,
      fromSeq: 4,
      seq: 5,
      minAvailableSeq: 0,
      changes: [{ seq: 5, entity: 'issueMarks', entityId: issueMarksRowId(ME, GONE), op: 'evict' }],
    } as never)
    await replica.settled()

    // The cache lost exactly one row, and it is the right one. Under a replica
    // that ignored incoming evictions this reads [GONE, KEPT].
    expect(marksIn(store)).toEqual([KEPT])
    expect(store.cache.read('issueMarks', issueMarksRowId(ME, GONE))).toBeUndefined()
    expect(store.cache.read('issueMarks', issueMarksRowId(ME, KEPT))).toBeDefined()
  })
})
