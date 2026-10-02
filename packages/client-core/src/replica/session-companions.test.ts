import { asMachineId, asSessionId, asUserId, sessionUserStateRowId } from '@podium/model'
import type { EntityRecord } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import { BootstrapSession, snapshotToChunks } from './bootstrap'
import { createKernelReplica, type KernelCacheRead } from './kernel/facade'
import { entityForKind, kindForEntity, rowKey } from './kernel/kinds'
import { createSideCache } from './kernel/side-cache'
import { createReplica, memoryStorage } from './replica'

const userId = asUserId('user:a')
const sessionId = asSessionId('session:a')
const key = sessionUserStateRowId(userId, sessionId)
const state = { userId, sessionId, readAt: null, snoozedUntil: null }
const machine = {
  id: asMachineId('machine:a'),
  name: 'Host',
  loggedOutHarnesses: ['codex' as const],
}

class Cache implements KernelCacheRead {
  records: EntityRecord[] = []
  durability() { return 'durable' as const }
  readCursor() {
    return null
  }
  readEntities() {
    return this.records
  }
  read(entity: string, entityId: string) {
    return this.records.find((row) => row.entity === entity && row.entityId === entityId)
  }
  put(entity: string, entityId: string, value: unknown) {
    this.drop(entity, entityId)
    this.records.push({ entity, entityId, value, provenance: { seq: 1 } })
  }
  drop(entity: string, entityId: string) {
    this.records = this.records.filter((row) => row.entity !== entity || row.entityId !== entityId)
  }
}

describe('S1 session companion replica collections', () => {
  it('hydrates offline, preserves cleared values, and partitions personal caches', async () => {
    const storage = memoryStorage()
    const replica = createReplica({ storage, keyPrefix: 'sessions.a' })
    replica.applySnapshot('sessionUserStates', [state])
    replica.applySnapshot('machines', [machine])
    const reopened = createReplica({ storage, keyPrefix: 'sessions.a' })
    const hydrated = await reopened.hydrate()
    expect(hydrated.sessionUserStates).toMatchObject([state])
    expect(hydrated.machines).toMatchObject([machine])
    const cleared = { userId, sessionId, readAt: 'read' }
    reopened.applyChanges('sessionUserStates', [cleared], [])
    expect(reopened.rows('sessionUserStates')).toMatchObject([cleared])
    expect(reopened.rows('sessionUserStates')[0]?.snoozedUntil).toBeUndefined()
    reopened.applyChanges('sessionUserStates', [], [key])
    expect(reopened.rows('sessionUserStates')).toEqual([])
    const other = createReplica({ storage, keyPrefix: 'sessions.b' })
    expect((await other.hydrate()).sessionUserStates).toEqual([])
    const old = await createReplica({ storage: memoryStorage() }).hydrate()
    expect(old.sessionUserStates).toEqual([])
    expect(old.machines).toEqual([])
  })

  it('installs both kinds through snapshot bootstrap and buffered deltas', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    const bootstrap = new BootstrapSession(replica, { feedId: 'feed', epoch: 'epoch', seq: 2 })
    for (const chunk of snapshotToChunks({ sessionUserStates: [state], machines: [machine] }))
      await bootstrap.install(chunk)
    bootstrap.bufferDelta(3, [
      {
        seq: 3,
        entity: 'sessionUserState',
        id: key,
        op: 'upsert',
        value: { userId, sessionId, readAt: 'read' },
      },
    ])
    expect(replica.rows('sessionUserStates')).toEqual([])
    bootstrap.commit()
    expect(replica.rows('sessionUserStates')).toMatchObject([{ userId, sessionId, readAt: 'read' }])
    expect(replica.rows('sessionUserStates')[0]?.snoozedUntil).toBeUndefined()
    expect(replica.rows('machines')).toMatchObject([machine])
    replica.resetCache()
    expect(replica.rows('sessionUserStates')).toEqual([])
    expect(replica.rows('machines')).toEqual([])
  })

  it('maps, evicts, deletes, readmits and rescopes both kernel kinds', async () => {
    const cache = new Cache()
    const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
    const replica = createKernelReplica({ cache, side })
    cache.put('sessionUserState', key, state)
    cache.put('machine', machine.id, machine)
    expect(kindForEntity('sessionUserState')).toBe('sessionUserStates')
    expect(entityForKind('machines')).toBe('machine')
    expect(rowKey('sessionUserStates', state)).toBe(key)
    expect(rowKey('machines', machine)).toBe(machine.id)
    const hydrated = await replica.hydrate()
    expect(hydrated.sessionUserStates).toEqual([state])
    expect(hydrated.machines).toEqual([machine])
    for (const [entity, id, value, kind] of [
      ['sessionUserState', key, state, 'sessionUserStates'],
      ['machine', machine.id, machine, 'machines'],
    ] as const) {
      cache.drop(entity, id)
      replica.onKernelEvent({ type: 'evicted', entity, entityId: id })
      expect(replica.rows(kind)).toEqual([])
      cache.put(entity, id, value)
      replica.onKernelEvent({ type: 'upserted', record: cache.read(entity, id)!, readmitted: true })
      expect(replica.rows(kind)).toEqual([value])
      cache.drop(entity, id)
      replica.onKernelEvent({ type: 'removed', entity, entityId: id })
      expect(replica.rows(kind)).toEqual([])
      cache.put(entity, id, value)
      replica.onKernelEvent({ type: 'upserted', record: cache.read(entity, id)!, readmitted: true })
    }
    cache.records = []
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 4,
      entityCount: 0,
      bufferedFramesApplied: 0,
    })
    expect(replica.rows('sessionUserStates')).toEqual([])
    expect(replica.rows('machines')).toEqual([])
  })
})
