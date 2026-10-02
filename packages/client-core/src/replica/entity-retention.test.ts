import { describe, expect, it, vi } from 'vitest'
import { BootstrapSession } from './bootstrap'
import { createKernelReplica, createSideCache, kindForEntity, retainReplicaEntity } from './kernel'
import { createReplica, memoryStorage } from './replica'

describe('current entity retention', () => {
  it('admits only current kinds', () => {
    expect(kindForEntity('issue')).toBeUndefined()
    expect(kindForEntity('issueProjection')).toBe('issueProjections')
    expect(retainReplicaEntity('futureKind')).toBe(false)
    expect(retainReplicaEntity('__proto__')).toBe(false)
  })

  it('drops unsupported bootstrap rows and deltas while advancing the cursor', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    const snapshot = vi.spyOn(replica, 'applySnapshot')
    const delta = vi.spyOn(replica, 'applyChanges')
    const bootstrap = new BootstrapSession(replica, { feedId: 'f', epoch: 'e', seq: 10 })
    await bootstrap.install({ changes: [
      { seq: 1, entity: 'issue', id: 'i', op: 'upsert', value: { id: 'i' } },
      { seq: 2, entity: 'issueProjection', id: 'i', op: 'upsert', value: { id: 'i' } },
    ] as never })
    expect(bootstrap.bufferDelta(12, [
      { seq: 11, entity: 'issue', id: 'i', op: 'remove' },
      { seq: 12, entity: 'issue', id: 'i', op: 'upsert', value: { id: 'i' } },
    ] as never)).toBe(true)
    bootstrap.commit()
    expect(snapshot.mock.calls.map(([kind]) => kind)).not.toContain('issues')
    expect(delta).not.toHaveBeenCalled()
    expect(replica.rows('issueProjections')).toMatchObject([{ id: 'i' }])
    expect(replica.getFeedCursor().seq).toBe(12)
    expect(await replica.hydrate()).not.toHaveProperty('issues')
  })

  it('never projects unsupported cache rows or notifies readers about them', async () => {
    const unknown = { entity: 'issue', entityId: 'i', value: { id: 'i' }, provenance: { seq: 1 } }
    const projection = { ...unknown, entity: 'issueProjection' }
    const cache = {
      readCursor: () => ({ seq: 1 }),
      readEntities: () => [unknown, projection],
      read: (entity: string) => entity === 'issueProjection' ? projection : unknown,
      durability: () => 'durable' as const,
    }
    const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage() }) })
    const notified = vi.fn()
    replica.subscribeRowBatch?.(notified)
    expect(await replica.hydrate()).not.toHaveProperty('issues')
    expect(replica.rows('issueProjections')).toHaveLength(1)
    replica.onKernelEvent({ type: 'upserted', record: unknown, readmitted: false })
    expect(notified).not.toHaveBeenCalled()
  })
})
