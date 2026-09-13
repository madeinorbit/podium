import type { EntityRecord } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import { createKernelReplica, createSideCache } from '../replica/kernel'
import type { KernelCacheRead } from '../replica/kernel'
import { createReplica, memoryStorage } from '../replica/replica'
import {
  createReplicaBinding,
  REPLICA_BINDING_KINDS,
  type ReplicaPublication,
} from './replica-binding'

const session = (id: string, readAt: string | null = null) =>
  ({
    sessionId: id,
    name: id,
    cwd: '/repo',
    readAt,
    snoozedUntil: id === 'alice-session' ? '2026-08-02T12:00:00.000Z' : null,
  }) as never

const issue = (id: string, readAt: string | null = null) =>
  ({
    id,
    title: id,
    status: 'open',
    readAt,
    snoozeUntil: id === 'alice-issue' ? '2026-08-03T12:00:00.000Z' : null,
  }) as never

describe('replica snapshot binding', () => {
  it('cold-start snapshot paints the persisted principal slice, including per-user fields', async () => {
    const storage = memoryStorage()
    const keyPrefix = 'podium.replica.principal.alice'
    const first = createReplica({ storage, keyPrefix })
    first.applySnapshot('sessions', [session('alice-session', '2026-08-01T09:00:00.000Z')])
    first.applySnapshot('issues', [issue('alice-issue', '2026-08-01T10:00:00.000Z')])
    await first.flush()

    // A new app process reads synchronously before start()/network. These fields
    // are Authority-owned per-user rows projected into the slice, not rebuilt
    // from ad-hoc local UI storage.
    const reopened = createReplica({ storage, keyPrefix })
    const cold = createReplicaBinding({ replica: reopened }).snapshot()
    expect(cold.sessions).toMatchObject([
      {
        sessionId: 'alice-session',
        readAt: '2026-08-01T09:00:00.000Z',
        snoozedUntil: '2026-08-02T12:00:00.000Z',
      },
    ])
    expect(cold.issues).toMatchObject([
      {
        id: 'alice-issue',
        readAt: '2026-08-01T10:00:00.000Z',
        snoozeUntil: '2026-08-03T12:00:00.000Z',
      },
    ])
  })

  it('publishes an atomic rescope once, ignores cursor-only watermarks, and evicts by absence', async () => {
    const cache = new BindingCache()
    cache.put('session', 'old-session', session('old-session'))
    cache.put('issue', 'old-issue', issue('old-issue'))
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const binding = createReplicaBinding({ replica })
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0

    // Kernel installSnapshot has already atomically swapped the cache when this
    // event fires. One changed-kind batch means Store never sees old sessions
    // paired with new issues (or the inverse).
    cache.records = []
    cache.put('session', 'new-session', session('new-session'))
    cache.put('issue', 'new-issue', issue('new-issue'))
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 50,
      entityCount: 2,
      bufferedFramesApplied: 0,
    })
    expect(publications).toHaveLength(1)
    // EVERY bound kind, which is the property — a rescope replaces the whole
    // world, so a kind left out of the batch is one the Store would still be
    // showing from the previous scope. Asserted against the list itself so
    // adding a kind cannot quietly narrow what this asserts (POD-571 added
    // `userLayouts` and a bare count would have only said the number changed).
    expect(new Set(publications[0]!.changed)).toEqual(new Set(REPLICA_BINDING_KINDS))
    expect(publications[0]!.snapshot.sessions.map((row) => row.sessionId)).toEqual(['new-session'])
    expect(publications[0]!.snapshot.issues.map((row) => row.id)).toEqual(['new-issue'])

    publications.length = 0
    for (let seq = 51; seq <= 350; seq += 1) {
      cache.cursor = { seq }
      replica.onKernelEvent({
        type: 'cursor',
        cursor: { feedId: 'feed', epoch: 'epoch', seq },
        watermarkOnly: true,
      })
    }
    expect(publications).toEqual([])

    cache.drop('session', 'new-session')
    replica.onKernelEvent({ type: 'evicted', entity: 'session', entityId: 'new-session' })
    expect(publications).toHaveLength(1)
    expect(publications[0]!.snapshot.sessions).toEqual([])
    // Publication carries a replacement snapshot, not a remove/tombstone signal
    // a viewmodel could accidentally render as deletion.
    expect(Object.keys(publications[0]!).sort()).toEqual(['changed', 'reason', 'snapshot'])
    stop()
  })
})

/**
 * TWO SESSIONS FOR THE SAME USER, THROUGH THE REAL BINDING (PDM-424, phase
 * review item 3).
 *
 * `session-marks-join.test.ts` has ONE real registration case and then calls
 * `joinSessionMarks` directly; the existing binding cases above carry no
 * `sessionMarks` at all. So nothing in this package asserted that the BINDING
 * joins marks onto the session rows the engine publishes — which is the seam
 * `st.sessions` reaches every session surface through.
 *
 * Two sessions and one user is the shape that discriminates: a join keyed
 * wrongly, or a re-derivation that rebuilds the whole list, passes a one-session
 * test and fails here.
 *
 * WHAT THIS IS NOT: Authority-to-UI. The frames are fixture-authored and enter at
 * the kernel cache, which is a CONSUMER SEAM. `session-marks.feed.test.ts` is
 * where a real `Authority` decides what is served.
 */
describe('the binding joins THIS reader’s marks onto session rows', () => {
  const ME = 'mem_me'
  const A = 'ses_a'
  const B = 'ses_b'
  const marks = (sessionId: string, readAt: string | null) =>
    ({ userId: ME, sessionId, readAt }) as never
  /** A broadcast session row: NEUTRAL marks, and an activity stamp the derived
   *  `unread` is computed against. */
  const shared = (id: string, lastActiveAt: string) =>
    ({ sessionId: id, name: id, cwd: '/repo', lastActiveAt, readAt: null, unread: true }) as never

  const startBound = async () => {
    const cache = new BindingCache()
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const binding = createReplicaBinding({ replica })
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (p) => publications.push(p) })
    await Promise.resolve()
    publications.length = 0
    /** The kernel facade tracks rows it has been TOLD about, so a cache `put`
     *  with no event is invisible to `rows()`. Seeding through this pair is what
     *  makes the fixture model a real delivery rather than a cache poke. */
    const deliver = (entity: string, entityId: string, value: unknown) => {
      cache.put(entity, entityId, value)
      replica.onKernelEvent({ type: 'upserted', record: { entity, entityId } } as never)
    }
    /** The joined session rows of the LAST publication, by id. Throws rather than
     *  asserting non-null: a missing publication is a fixture fault and should
     *  say so by name, not fail three assertions later as `undefined`. */
    const lastRows = (): Map<string, Record<string, unknown>> => {
      const last = publications.at(-1)
      if (last === undefined) throw new Error('fixture: the binding published nothing')
      return new Map(
        last.snapshot.sessions.map((r) => [
          (r as { sessionId: string }).sessionId,
          r as unknown as Record<string, unknown>,
        ]),
      )
    }
    return { cache, replica, binding, publications, stop, deliver, lastRows }
  }

  it('a MARKS-ONLY delta republishes the intended session and leaves the other joined', async () => {
    const b = await startBound()
    b.deliver('session', A, shared(A, '2026-08-01T00:00:00.000Z'))
    b.deliver('session', B, shared(B, '2026-08-01T00:00:00.000Z'))
    b.deliver('sessionMarks', A, marks(A, '2026-08-02T00:00:00.000Z'))
    b.deliver('sessionMarks', B, marks(B, '2026-08-02T00:00:00.000Z'))
    b.publications.length = 0

    // ONLY the marks row for A moves. `unread` must flip for A and stay put for B.
    b.deliver('sessionMarks', A, marks(A, null))

    expect(b.publications.length).toBeGreaterThanOrEqual(1)
    const byId = b.lastRows()
    // A: its mark was cleared, so it is unread again.
    expect.soft(byId.get(A)?.readAt).toBeNull()
    expect.soft(byId.get(A)?.unread).toBe(true)
    // B: UNTOUCHED and STILL JOINED. This is the assertion a one-session test
    // cannot make, and the one a mis-keyed join fails.
    expect.soft(byId.get(B)?.readAt).toBe('2026-08-02T00:00:00.000Z')
    expect.soft(byId.get(B)?.unread).toBe(false)
    b.stop()
  })

  it('an EVICTION drops the intended marks row and preserves the other session’s', async () => {
    const b = await startBound()
    b.deliver('session', A, shared(A, '2026-08-01T00:00:00.000Z'))
    b.deliver('session', B, shared(B, '2026-08-01T00:00:00.000Z'))
    b.deliver('sessionMarks', A, marks(A, '2026-08-02T00:00:00.000Z'))
    b.deliver('sessionMarks', B, marks(B, '2026-08-02T00:00:00.000Z'))
    // PRECONDITION — both were joined before the eviction, so "it is gone
    // afterwards" cannot pass on a row that never arrived.
    const before = b.lastRows()
    expect.soft(before.get(A)?.readAt).toBe('2026-08-02T00:00:00.000Z')
    expect.soft(before.get(B)?.readAt).toBe('2026-08-02T00:00:00.000Z')
    b.publications.length = 0

    b.cache.drop('sessionMarks', A)
    b.replica.onKernelEvent({ type: 'evicted', entity: 'sessionMarks', entityId: A })

    const byId = b.lastRows()
    // A falls back to the broadcast row's own neutral values…
    expect.soft(byId.get(A)?.readAt).toBeNull()
    expect.soft(byId.get(A)?.unread).toBe(true)
    // …and B keeps its mark, which is what says the eviction was scoped.
    expect.soft(byId.get(B)?.readAt).toBe('2026-08-02T00:00:00.000Z')
    b.stop()
  })

  it('a SHARED-session change re-joins the marks this client already holds', async () => {
    // The other direction, and the reason the binding re-derives on BOTH kinds:
    // a session row arriving second carries the broadcast's NEUTRAL marks and
    // would otherwise overwrite a mark already held.
    const b = await startBound()
    b.deliver('sessionMarks', A, marks(A, '2026-08-02T00:00:00.000Z'))
    b.deliver('session', A, shared(A, '2026-08-01T00:00:00.000Z'))
    b.publications.length = 0

    // The SHARED row moves — new activity, still neutral marks on the wire.
    b.deliver('session', A, shared(A, '2026-08-03T00:00:00.000Z'))

    const row = b.lastRows().get(A)
    // The held mark survived the shared row's arrival…
    expect.soft(row?.readAt).toBe('2026-08-02T00:00:00.000Z')
    // …and `unread` is RE-DERIVED against the new activity rather than frozen:
    // the session became active after this person last looked.
    expect.soft(row?.unread).toBe(true)
    b.stop()
  })
})

class BindingCache implements KernelCacheRead {
  records: EntityRecord[] = []
  cursor: { seq: number } | null = null

  readCursor(): { seq: number } | null {
    return this.cursor
  }

  readEntities(): readonly EntityRecord[] {
    return this.records
  }

  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.records.find((record) => record.entity === entity && record.entityId === entityId)
  }

  durability(): 'durable' {
    return 'durable'
  }

  put(entity: string, entityId: string, value: unknown): void {
    this.records = [
      ...this.records.filter((record) => record.entity !== entity || record.entityId !== entityId),
      { entity, entityId, value, provenance: { seq: this.cursor?.seq ?? 0 } },
    ]
  }

  drop(entity: string, entityId: string): void {
    this.records = this.records.filter(
      (record) => record.entity !== entity || record.entityId !== entityId,
    )
  }
}
