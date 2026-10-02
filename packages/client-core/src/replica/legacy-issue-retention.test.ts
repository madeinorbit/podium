import { describe, expect, it, vi } from 'vitest'
import { BootstrapSession } from './bootstrap'
import { createKernelReplica, createSideCache, kindForEntity, retainReplicaEntity } from './kernel'
import { createReplica, memoryStorage } from './replica'

describe('legacy issue retention switch', () => {
  it('keeps mobile/shared defaults and drops only the old web kind', () => {
    expect(kindForEntity('issue')).toBe('issues')
    expect(kindForEntity('issue', true)).toBeUndefined()
    expect(kindForEntity('issueProjection', true)).toBe('issueProjections')
    expect(retainReplicaEntity('futureKind', true)).toBe(true)
    const mobile = createReplica({ storage: memoryStorage() })
    mobile.applySnapshot('issues', [{ id: 'i' } as never])
    expect(mobile.rows('issues')).toHaveLength(1)
  })

  it('never opens the old blob, and ignores snapshots and deltas without notifications', async () => {
    const storage = memoryStorage()
    const old = createReplica({ storage })
    old.applySnapshot('issues', [{ id: 'i', title: 'old' } as never])
    old.applySnapshot('issueProjections', [{ id: 'i', title: 'normalized' } as never])
    old.setCursor(8)
    await old.flush()
    const get = vi.spyOn(storage, 'getItem')
    const web = createReplica({ storage, dropLegacyIssues: true })
    const notified = vi.fn()
    web.subscribeRows('issues', notified)
    const hydrated = await web.hydrate()
    web.applySnapshot('issues', [{ id: 'j' } as never])
    web.applyChanges('issues', [{ id: 'k' } as never], ['i'])
    await web.flush()
    expect(get.mock.calls.map(([key]) => key)).not.toContain('podium.replica.issues.v1')
    expect(hydrated.issues).toEqual([])
    expect(hydrated.issueProjections).toMatchObject([{ id: 'i', title: 'normalized' }])
    expect(hydrated.cursor).toBe(8)
    expect(hydrated.schemaReset).toBe(false)
    expect(web.rows('issues')).toEqual([])
    expect(notified).not.toHaveBeenCalled()
  })

  it('drops bootstrap staging and buffered old rows while advancing past their sequences', async () => {
    const replica = createReplica({ storage: memoryStorage(), dropLegacyIssues: true })
    const snapshot = vi.spyOn(replica, 'applySnapshot')
    const delta = vi.spyOn(replica, 'applyChanges')
    const bootstrap = new BootstrapSession(replica, { feedId: 'f', epoch: 'e', seq: 10 })
    await bootstrap.install({
      changes: [
        { seq: 1, entity: 'issue', id: 'i', op: 'upsert', value: { id: 'i' } },
        { seq: 1, entity: 'issueProjection', id: 'i', op: 'upsert', value: { id: 'i' } },
      ] as never,
    })
    expect(
      bootstrap.bufferDelta(12, [
        { seq: 11, entity: 'issue', id: 'i', op: 'remove' },
        { seq: 12, entity: 'issue', id: 'i', op: 'upsert', value: { id: 'i' } },
      ] as never),
    ).toBe(true)
    bootstrap.commit()
    expect(snapshot.mock.calls.map(([kind]) => kind)).not.toContain('issues')
    expect(delta).not.toHaveBeenCalled()
    expect(replica.rows('issues')).toEqual([])
    expect(replica.rows('issueProjections')).toMatchObject([{ id: 'i' }])
    expect(replica.getFeedCursor().seq).toBe(12)
  })

  it('keeps old rows out of facade arrays, addressed reads and delta notifications', async () => {
    const old = { entity: 'issue', entityId: 'i', value: { id: 'i' }, provenance: { seq: 1 } }
    const projection = { ...old, entity: 'issueProjection' }
    const cache = {
      readCursor: () => ({ seq: 1 }),
      readEntities: () => [old, projection],
      read: (entity: string) => (entity === 'issue' ? old : projection),
      durability: () => 'durable' as const,
    }
    const side = createSideCache({ storage: memoryStorage() })
    expect(createKernelReplica({ cache, side }).rows('issues')).toHaveLength(1)
    const web = createKernelReplica({ cache, side, dropLegacyIssues: true })
    const notified = vi.fn()
    web.subscribeRowBatch?.(notified)
    expect((await web.hydrate()).issues).toEqual([])
    expect(web.rows('issueProjections')).toHaveLength(1)
    expect(web.row?.('issues', 'i')).toBeUndefined()
    web.onKernelEvent({ type: 'upserted', record: old, readmitted: false })
    expect(notified).not.toHaveBeenCalled()
    expect(web.rows('issues')).toEqual([])
  })
})
