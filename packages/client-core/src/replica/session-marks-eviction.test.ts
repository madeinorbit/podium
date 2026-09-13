/**
 * A DELIVERED EVICTION REACHES THE CACHE (PDM-424) — the production apply path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT DOES *NOT* REPLACE
 * ---------------------------------------------------------------------------
 *
 * `engine/replica-binding.test.ts` has a witness that two same-user session
 * marks survive a publication and that evicting one leaves the other. That
 * witness STANDS and is credited for exactly what it proves: the BINDING
 * re-derives and republishes correctly over whatever the cache holds.
 *
 * What it cannot prove — the phase reviewer's objection, and it is right — is
 * that a DELIVERED eviction causes the cache mutation in the first place. It
 * calls `cache.drop()` itself and then announces the event, so the end state is
 * manufactured by the fixture rather than produced by the code under test. A
 * replica that ignored every incoming eviction would pass it.
 *
 * So this file drives the REAL `Replica` from `@podium/sync/replica` over a real
 * `InMemoryReplicaStore`: the rows arrive through the real bootstrap path, the
 * eviction arrives as an ordinary delta frame, and the assertion is made against
 * the STORE. **Nothing here deletes anything by hand.**
 */

import { asUserId, sessionMarksRowId } from '@podium/model'
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
const GONE = 'ses_gone'
const KEPT = 'ses_kept'

const marksValue = (sessionId: string, readAt: string) => ({ userId: ME, sessionId, readAt })

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
    { entity: 'session', entityId: GONE, value: { sessionId: GONE, name: 'gone' } },
    { entity: 'session', entityId: KEPT, value: { sessionId: KEPT, name: 'kept' } },
    {
      entity: 'sessionMarks',
      entityId: sessionMarksRowId(ME, GONE),
      value: marksValue(GONE, 'T-gone'),
    },
    {
      entity: 'sessionMarks',
      entityId: sessionMarksRowId(ME, KEPT),
      value: marksValue(KEPT, 'T-kept'),
    },
  ])
  const replica = new Replica({
    store: store.cache,
    authority,
    unitOfWork: store.unitOfWork,
  } as never)
  // The real cold-start path: connect, let the bootstrap walk, settle.
  replica.connect()
  await replica.settled()
  return { store, replica }
}

const marksIn = (store: InMemoryReplicaStore): string[] =>
  store.cache
    .readEntities()
    .filter((record) => record.entity === 'sessionMarks')
    .map((record) => (record.value as { sessionId: string }).sessionId)

describe('a delivered eviction removes exactly one session mark from the cache', () => {
  it('drops the evicted session’s mark and leaves the other, with no manual deletion', async () => {
    const { store, replica } = await bootstrapped()
    // BOTH preconditions, established by the real bootstrap rather than by the
    // fixture reaching into the cache. TWO marks for the SAME user is the shape
    // that discriminates: a replica that dropped the whole kind passes a
    // one-row test.
    expect(marksIn(store).sort()).toEqual([GONE, KEPT].sort())

    // The eviction as the feed delivers it: an ordinary delta frame, addressed by
    // the (user, session) composite the Authority logs.
    await replica.receive({
      kind: 'delta',
      feedId: FEED,
      epoch: EPOCH,
      fromSeq: 4,
      seq: 5,
      minAvailableSeq: 0,
      changes: [
        { seq: 5, entity: 'sessionMarks', entityId: sessionMarksRowId(ME, GONE), op: 'evict' },
      ],
    } as never)
    await replica.settled()

    // The cache lost exactly one row, and it is the right one. Under a replica
    // that ignored incoming evictions this reads [GONE, KEPT].
    expect.soft(marksIn(store)).toEqual([KEPT])
    expect.soft(store.cache.read('sessionMarks', sessionMarksRowId(ME, GONE))).toBeUndefined()
    expect.soft(store.cache.read('sessionMarks', sessionMarksRowId(ME, KEPT))).toBeDefined()
    // AND THE SESSION ROWS ARE UNTOUCHED — the control that says the eviction was
    // scoped to the kind and the id rather than to anything that mentions GONE.
    expect.soft(store.cache.read('session', GONE)).toBeDefined()
    expect.soft(store.cache.read('session', KEPT)).toBeDefined()
  })
})
