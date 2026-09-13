import { asUserId, issueMarksRowId } from '@podium/model'
import type { EntityRecord } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import type { KernelCacheRead } from '../replica/kernel'
import { createKernelReplica, createSideCache } from '../replica/kernel'
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

describe('a marks-only delta re-derives the joined issue rows (PDM-419)', () => {
  /**
   * FOUND BY PDM-139'S SOURCE REVIEW, not by a failing test — `readChanged`
   * re-derived `next.issues` only when `issues` or `issueExecutions` moved, so a
   * batch carrying ONLY `issueMarks` left `st.issues` holding the pre-mark
   * values. That is not an edge case: a marks-only delta is exactly what arrives
   * when this person marks an issue read on another device, or when the server
   * echoes the mark they just made here. The stale row then corrects itself on
   * the next unrelated issue change, which reads as lag rather than as a bug.
   *
   * `st.issues` is the binding roughly thirty surfaces read, so the witness is a
   * DIRECT SUBSCRIBER — what a publication actually carries — rather than a
   * re-derivation through the view models, which have their own join and would
   * mask this.
   */
  const marks = (issueId: string, readAt: string | null, pinned: boolean) =>
    ({ userId: 'mem_me', issueId, readAt, tuckedAt: null, pinned }) as never

  it('publishes issue rows carrying the new mark when ONLY issueMarks changed', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    // The broadcast row as the server now sends it: neutral marks for everybody.
    replica.applySnapshot('issues', [issue('iss_1', null)])
    const binding = createReplicaBinding({ replica })
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0

    // Nothing but the marks row moves.
    replica.applyChanges('issueMarks', [marks('iss_1', '2026-08-04T00:00:00.000Z', true)], [])
    // Row notifications are deferred out of `applyChanges`'s batch and flushed
    // on the microtask queue, same as every other event in this file.
    await Promise.resolve()

    expect(publications).toHaveLength(1)
    expect(publications[0]!.changed).toContain('issueMarks')
    // THE CLAIM: the joined issue row in the published snapshot carries MY mark,
    // on the very frame that delivered it. Before the fix this read `null`.
    const published = publications[0]!.snapshot.issues.find((row) => row.id === 'iss_1')
    expect(published?.readAt).toBe('2026-08-04T00:00:00.000Z')
    expect((published as { pinned?: boolean } | undefined)?.pinned).toBe(true)
    stop()
  })

  it('still leaves an unmarked issue unmarked — the control', async () => {
    // Without this, the case above is satisfied by a binding that had started
    // reporting a mark for every row.
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [issue('iss_1', null), issue('iss_2', null)])
    const binding = createReplicaBinding({ replica })
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0

    replica.applyChanges('issueMarks', [marks('iss_1', '2026-08-04T00:00:00.000Z', true)], [])
    await Promise.resolve()

    const rows = publications[0]!.snapshot.issues
    expect(rows.find((row) => row.id === 'iss_1')?.readAt).toBe('2026-08-04T00:00:00.000Z')
    expect(rows.find((row) => row.id === 'iss_2')?.readAt ?? null).toBeNull()
    stop()
  })
})

describe('two simultaneously marked issues, through the kernel’s composite ids', () => {
  /**
   * PDM-139 asked for this shape specifically: two rows with distinct values,
   * changed and cleared rather than only added, which is PDM-419's own
   * "changing and clearing" requirement — a witness that only ever ADDS a mark
   * cannot reach it.
   *
   * WHAT THIS BLOCK DOES **NOT** WITNESS, corrected after a plant said so. An
   * earlier version of this header claimed it also discriminated the legacy
   * `Replica.keyFor` defect. It does not, and the two are not one defect:
   *
   *  - LEGACY `Replica.keyFor` — an undefined key misclassifies every update as
   *    an insert, so the write is SILENTLY DISCARDED. Witnessed in
   *    `replica/issue-marks-join.test.ts`, over the legacy replica.
   *  - KERNEL `rowKey` — feeds `facade.keyOf` and therefore the SORT, so its
   *    failure is unstable row ORDER, not lost data. Witnessed by the ordering
   *    case below, and by nothing else here: I planted that arm expecting the
   *    update and removal cases to redden and THEY STAYED GREEN, because the
   *    kernel indexes by `entityId` and reads values off the payload.
   *
   * And it runs over the KERNEL replica rather than the legacy one, because the
   * mapping the reviewer named lives there: the kernel stores and addresses rows
   * by the ENVELOPE's `entityId` — the `(user, issue)` composite — while
   * `rowKey` projects them under `issueId`. A removal arrives addressed by the
   * composite, so it has to find a row indexed one way and drop it from a
   * projection sorted the other. A single-row witness cannot tell a working
   * mapping from one that drops the only row it has.
   *
   * Both issues are marked with DISTINCT values throughout, so "the other one is
   * untouched" is a real assertion rather than a vacuous one.
   */
  const ME = 'mem_me'
  const marksRow = (issueId: string, readAt: string | null, pinned: boolean) => ({
    userId: ME,
    issueId,
    readAt,
    tuckedAt: null,
    pinned,
  })

  const seeded = () => {
    const cache = new BindingCache()
    cache.put('issue', 'iss_1', issue('iss_1'))
    cache.put('issue', 'iss_2', issue('iss_2'))
    // Addressed by the COMPOSITE id, exactly as the Authority logs them.
    cache.put('issueMarks', issueMarksRowId(asUserId(ME), 'iss_1'), marksRow('iss_1', 'T1', true))
    cache.put('issueMarks', issueMarksRowId(asUserId(ME), 'iss_2'), marksRow('iss_2', 'T2', false))
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    return { cache, replica }
  }

  const marksOn = (publication: ReplicaPublication, id: string) =>
    publication.snapshot.issues.find((row) => row.id === id) as
      | { readAt?: string | null; pinned?: boolean }
      | undefined

  it('carries BOTH issues’ distinct marks, then updates ONE and leaves the other', async () => {
    const { cache, replica } = seeded()
    const binding = createReplicaBinding({ replica })
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()

    // Both distinct at the start — the precondition the update case needs.
    const first = publications[publications.length - 1]!
    expect(marksOn(first, 'iss_1')).toMatchObject({ readAt: 'T1', pinned: true })
    expect(marksOn(first, 'iss_2')).toMatchObject({ readAt: 'T2', pinned: false })

    publications.length = 0
    // CHANGE iss_1's mark — clearing the read and dropping the pin, which is the
    // "changing and clearing" half 419 is about. iss_2 is not touched.
    cache.put('issueMarks', issueMarksRowId(asUserId(ME), 'iss_1'), marksRow('iss_1', null, false))
    replica.onKernelEvent({
      type: 'upserted',
      record: {
        entity: 'issueMarks',
        entityId: issueMarksRowId(asUserId(ME), 'iss_1'),
        value: marksRow('iss_1', null, false),
        provenance: { seq: 1 },
      },
    } as never)
    await Promise.resolve()

    const afterUpdate = publications[publications.length - 1]!
    expect(marksOn(afterUpdate, 'iss_1')).toMatchObject({ readAt: null, pinned: false })
    // Under the key collapse this read `null`/`false` too, because the update
    // had landed on whichever row the shared key resolved to.
    expect(marksOn(afterUpdate, 'iss_2')).toMatchObject({ readAt: 'T2', pinned: false })
    stop()
  })

  it('orders the two marks rows by their issue, not by arrival', () => {
    // THE KERNEL'S OWN `rowKey` ARM, which the two cases above do NOT reach — I
    // checked by planting, and they stayed green. The kernel indexes rows by the
    // envelope's composite `entityId` and reads values off the payload, so a
    // missing `rowKey` arm costs neither of them anything.
    //
    // What it DOES cost is the sort: `facade.keyOf` feeds the merge that keeps
    // `rows()` stable, and a kind it cannot key puts every row under `undefined`
    // — an unstable order, which is the single thing that sort exists to
    // prevent. So the discriminating fixture is arrival order OPPOSITE to key
    // order.
    const cache = new BindingCache()
    cache.put('issueMarks', issueMarksRowId(asUserId(ME), 'iss_2'), marksRow('iss_2', 'T2', false))
    cache.put('issueMarks', issueMarksRowId(asUserId(ME), 'iss_1'), marksRow('iss_1', 'T1', true))
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })

    expect(replica.rows('issueMarks').map((row) => row.issueId)).toEqual(['iss_1', 'iss_2'])
  })

  it('REMOVES one by its composite id and leaves the other marked', async () => {
    const { cache, replica } = seeded()
    const binding = createReplicaBinding({ replica })
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0

    // The eviction arrives addressed by the (user, issue) COMPOSITE — the id the
    // Authority logged — not by the `issueId` the projection is keyed under.
    // That translation is the thing under test.
    cache.drop('issueMarks', issueMarksRowId(asUserId(ME), 'iss_1'))
    replica.onKernelEvent({
      type: 'evicted',
      entity: 'issueMarks',
      entityId: issueMarksRowId(asUserId(ME), 'iss_1'),
    })
    await Promise.resolve()

    const afterRemove = publications[publications.length - 1]!
    // iss_1's mark is gone — the row falls back to the broadcast's neutral.
    expect(marksOn(afterRemove, 'iss_1')?.readAt ?? null).toBeNull()
    // …and iss_2 still holds its own, which is what a removal that took both
    // rows (or the wrong one) would fail.
    expect(marksOn(afterRemove, 'iss_2')).toMatchObject({ readAt: 'T2' })
    stop()
  })
})
