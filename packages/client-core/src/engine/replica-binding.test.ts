import type { EntityRecord } from '@podium/sync/replica'
import { asMachineId, asRepoId, asSessionId, asUserId, shipLaneId } from '@podium/model'
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
  it('hydrates shipping lanes and publishes lane changes, eviction, readmission, removal and empty rescopes', async () => {
    const cache = new BindingCache()
    const repoId = asRepoId('repo-a')
    const lane = {
      id: shipLaneId(repoId, 'local:main'),
      repoId,
      destination: 'local:main',
      trains: [{ orderIds: ['ship-a' as never] }],
      blockedOrderIds: [],
    }
    cache.put('shipLane', lane.id, lane)
    const exits = new Map<string, 'evicted' | 'removed'>()
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
      exits: (_entity, id) => exits.get(id),
    })
    const binding = createReplicaBinding({ replica })
    expect(binding.snapshot().shipLanes).toEqual([lane])
    expect((await replica.hydrate()).shipLanes).toEqual([lane])
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0
    const changed = { ...lane, trains: [], blockedOrderIds: ['ship-a'] }
    const changedRecord = cache.put('shipLane', lane.id, changed)
    replica.onKernelEvent({
      type: 'upserted',
      record: changedRecord,
      readmitted: false,
    })
    expect(publications).toHaveLength(1)
    expect([...(publications[0]?.changed ?? [])]).toEqual(['shipLanes'])
    expect(publications[0]?.snapshot.shipLanes).toEqual([changed])
    for (const kind of ['evicted', 'removed'] as const) {
      cache.drop('shipLane', lane.id)
      exits.set(lane.id, kind)
      replica.onKernelEvent({ type: kind, entity: 'shipLane', entityId: lane.id })
      expect(binding.snapshot().shipLanes).toEqual([])
      expect(replica.exitKind?.('shipLane', lane.id)).toBe(kind)
      const readmittedRecord = cache.put('shipLane', lane.id, lane)
      exits.delete(lane.id)
      replica.onKernelEvent({
        type: 'upserted',
        record: readmittedRecord,
        readmitted: kind === 'evicted',
      })
      expect(binding.snapshot().shipLanes).toEqual([lane])
      expect(replica.exitKind?.('shipLane', lane.id)).toBeUndefined()
    }
    cache.records = []
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 10,
      entityCount: 0,
      bufferedFramesApplied: 0,
    })
    expect(binding.snapshot().shipLanes).toEqual([])
    expect(publications.at(-1)?.changed.has('shipLanes')).toBe(true)
    stop()
  })

  it('cold-start snapshot paints the persisted principal slice, including per-user fields', async () => {
    const storage = memoryStorage()
    const keyPrefix = 'podium.replica.principal.alice'
    const first = createReplica({ storage, keyPrefix })
    first.applySnapshot('sessions', [session('alice-session', '2026-08-01T09:00:00.000Z')])
    first.applySnapshot('issues', [issue('alice-issue', '2026-08-01T10:00:00.000Z')])
    const personal = { userId: asUserId('alice'), sessionId: asSessionId('alice-session'), readAt: null, snoozedUntil: null }
    const machine = { id: asMachineId('machine:alice'), name: 'Laptop', loggedOutHarnesses: ['codex' as const] }
    first.applySnapshot('sessionUserStates', [personal])
    first.applySnapshot('machines', [machine])
    await first.flush()

    // A new app process reads synchronously before start()/network. These fields
    // are Authority-owned per-user rows projected into the slice, not rebuilt
    // from ad-hoc local UI storage.
    const reopened = createReplica({ storage, keyPrefix })
    const cold = createReplicaBinding({ replica: reopened }).snapshot()
    expect(cold.sessionUserStates).toMatchObject([personal])
    expect(cold.machines).toMatchObject([machine])
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

  put(entity: string, entityId: string, value: unknown): EntityRecord {
    const record = { entity, entityId, value, provenance: { seq: this.cursor?.seq ?? 0 } }
    this.records = [
      ...this.records.filter((record) => record.entity !== entity || record.entityId !== entityId),
      record,
    ]
    return record
  }

  drop(entity: string, entityId: string): void {
    this.records = this.records.filter(
      (record) => record.entity !== entity || record.entityId !== entityId,
    )
  }
}
