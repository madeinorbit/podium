import type { EntityRecord } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import { createKernelReplica, createSideCache } from '../replica/kernel'
import type { KernelCacheRead } from '../replica/kernel'
import { createReplica, memoryStorage } from '../replica/replica'
import { createReplicaBinding, type ReplicaPublication } from './replica-binding'

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
    expect([...publications[0]!.changed]).toHaveLength(8)
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
