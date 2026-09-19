import type { EntityRecord } from '@podium/sync/replica'
import { describe, expect, it, vi } from 'vitest'
import type { ReplicaAddressedBatch } from '../replica/contract'
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
    expect(publications[0]!.addressed).toEqual({ type: 'replace', reason: 'rescope' })
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
    expect(publications[0]!.addressed).toEqual({ type: 'update', rows: [{ kind: 'sessions', id: 'new-session' }] })
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


describe('addressed replica binding (pilot remains opt-in)', () => {
  function fixture() {
    const cache = new BindingCache()
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    return { cache, replica }
  }

  it('reads one final row with zero collection arrays; the legacy control builds arrays', async () => {
    async function measure(addressed: boolean) {
      const { cache, replica } = fixture()
      for (let n = 0; n < 1000; n++) cache.put('session', `s${n}`, session(`s${n}`))
      cache.put('issue', 'unrelated', issue('unrelated'))
      const arrays = vi.spyOn(replica, 'rows')
      const scans = vi.spyOn(cache, 'readEntities')
      const reads = vi.spyOn(cache, 'read')
      const binding = createReplicaBinding({ replica })
      let final: unknown
      const stop = addressed
        ? binding.subscribeAddressedBatch!((batch) => {
            if (batch.type === 'update') for (const { kind, id } of batch.rows) final = binding.row!(kind, id)
          })
        : binding.start({ publish: (p) => { final = p.snapshot.sessions.find((row) => row.sessionId === 's42') } })
      await Promise.resolve()
      const setup = { arrays: arrays.mock.calls.length, scans: scans.mock.calls.length }
      arrays.mockClear(); scans.mockClear(); reads.mockClear()
      const value = session('s42', '2026-09-19T12:00:00Z')
      cache.put('session', 's42', value)
      // Deliberately stale payload: only the committed cache is authoritative.
      replica.onKernelEvent({ type: 'upserted', readmitted: false, record: { entity: 'session', entityId: 's42', value: session('wrong'), provenance: { seq: 1 } } })
      expect(final).toBe(value)
      const delta = { arrays: arrays.mock.calls.length, scans: scans.mock.calls.length, reads: reads.mock.calls.length }
      stop()
      return { setup, delta }
    }
    const legacy = await measure(false)
    const addressed = await measure(true)
    expect(legacy.setup.arrays).toBeGreaterThanOrEqual(REPLICA_BINDING_KINDS.length)
    expect(legacy.setup.scans).toBe(1)
    expect(legacy.delta).toEqual({ arrays: 1, scans: 0, reads: 1 })
    expect(addressed).toEqual({ setup: { arrays: 0, scans: 0 }, delta: { arrays: 0, scans: 0, reads: 1 } })
    // Negative control uses the old kind->rows route in the same run; it cannot
    // satisfy the addressed path's zero-array gate.
    expect(legacy.delta.arrays === addressed.delta.arrays).toBe(false)
    console.info('D3 1000-row array/read counters', JSON.stringify({ legacy, addressed }))
  })

  it('coalesces repeated upsert/remove sequences and reads final membership', () => {
    const { cache, replica } = fixture()
    const binding = createReplicaBinding({ replica })
    const batches: ReplicaAddressedBatch[] = []
    const values: unknown[] = []
    const stop = binding.subscribeAddressedBatch!((batch) => {
      batches.push(batch)
      if (batch.type === 'update') for (const { kind, id } of batch.rows) values.push(binding.row!(kind, id))
    })
    const upsert = (id: string) => {
      cache.put('session', id, session(id))
      replica.onKernelEvent({ type: 'upserted', readmitted: false, record: cache.read('session', id)! })
    }
    const remove = (id: string) => {
      cache.drop('session', id)
      replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: id })
    }
    replica.batch(() => {
      upsert('gone'); remove('gone'); upsert('gone'); remove('gone')
      replica.batch(() => { upsert('here'); remove('here'); upsert('here') })
      expect(batches).toHaveLength(0)
    })
    expect(batches).toEqual([{ type: 'update', rows: [{ kind: 'sessions', id: 'gone' }, { kind: 'sessions', id: 'here' }] }])
    expect(values).toEqual([undefined, session('here')])
    stop(); upsert('later')
    expect(batches).toHaveLength(1)
  })

  it('keeps exit-only invalidations even when legacy arrays keep their identity', async () => {
    const { replica } = fixture()
    const binding = createReplicaBinding({ replica })
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (p) => publications.push(p) })
    await Promise.resolve()
    const before = binding.snapshot().sessions
    publications.length = 0
    replica.onKernelEvent({ type: 'evicted', entity: 'session', entityId: 'absent' })
    replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 'absent' })
    expect(publications).toHaveLength(2)
    for (const p of publications) {
      expect(p.snapshot.sessions).toBe(before)
      expect(p.addressed).toEqual({ type: 'update', rows: [{ kind: 'sessions', id: 'absent' }] })
    }
    stop()
  })

  it('explicitly replaces empty rescopes and bootstraps, without waking on cursors', () => {
    const { cache, replica } = fixture()
    const binding = createReplicaBinding({ replica })
    const batches: ReplicaAddressedBatch[] = []
    binding.subscribeAddressedBatch!((batch) => batches.push(batch))
    replica.batch(() => {
      replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 'old' })
      replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'rescope', snapshotSeq: 1, entityCount: 0, bufferedFramesApplied: 0 })
      replica.onKernelEvent({ type: 'removed', entity: 'issue', entityId: 'old' })
    })
    expect(batches).toEqual([{ type: 'replace', reason: 'rescope' }])
    for (let seq = 2; seq < 302; seq++) {
      cache.cursor = { seq }
      replica.onKernelEvent({ type: 'cursor', cursor: { feedId: 'feed', epoch: 'epoch', seq }, watermarkOnly: true })
    }
    expect(batches).toHaveLength(1)
    replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq: 302, entityCount: 0, bufferedFramesApplied: 0 })
    expect(batches[1]).toEqual({ type: 'replace', reason: 'bootstrap' })
  })

  it('keeps addresses when legacy row and row-batch readers consume projection dirtiness', () => {
    const { cache, replica } = fixture()
    const binding = createReplicaBinding({ replica })
    const batches: ReplicaAddressedBatch[] = []
    const legacy: unknown[] = []
    replica.subscribeRows('sessions', () => legacy.push(replica.rows('sessions')))
    replica.subscribeRowBatch!((kinds) => { for (const kind of kinds) replica.rows(kind) })
    binding.subscribeAddressedBatch!((batch) => batches.push(batch))
    cache.put('session', 's', session('s'))
    replica.onKernelEvent({ type: 'upserted', readmitted: false, record: cache.read('session', 's')! })
    expect(legacy).toEqual([[session('s')]])
    expect(batches).toEqual([{ type: 'update', rows: [{ kind: 'sessions', id: 's' }] }])
    expect(binding.row!('sessions', 's')).toEqual(session('s'))
  })

  it('reads by envelope identity with the same object admission and error fallback as arrays', () => {
    const { cache, replica } = fixture()
    const binding = createReplicaBinding({ replica })
    const arrays = vi.spyOn(replica, 'rows')
    const scan = vi.spyOn(cache, 'readEntities')
    const value = session('payload-id')
    cache.put('session', 'envelope-id', value)
    cache.put('issue', 'null', null)
    cache.put('issue', 'primitive', 7)
    expect(binding.row!('sessions', 'envelope-id')).toBe(value)
    expect(binding.row!('sessions', 'payload-id')).toBeUndefined()
    expect(binding.row!('issues', 'null')).toBeUndefined()
    expect(binding.row!('issues', 'primitive')).toBeUndefined()
    vi.spyOn(cache, 'read').mockImplementation(() => { throw new Error('unreadable') })
    expect(binding.row!('sessions', 'envelope-id')).toBeUndefined()
    expect(arrays).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
  })
})
