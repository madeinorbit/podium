import { asMutationId, asRepoId, shipLaneId, type ShipLaneProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { BootstrapSession, snapshotToChunks } from './bootstrap'
import { createReplica, memoryStorage } from './replica'

const repoId = asRepoId('repo-a')
const lane: ShipLaneProjection = {
  id: shipLaneId(repoId, 'local:main'), repoId, destination: 'local:main',
  trains: [{ orderIds: ['ship-a' as never] }], blockedOrderIds: [],
}

describe('shipping lane replica compatibility', () => {
  it('loads an older cache without lanes, persists new lanes and isolates principals', async () => {
    const storage = memoryStorage()
    const old = createReplica({ storage, keyPrefix: 'shipping.alice' })
    old.applySnapshot('shipOrders', [{
      id: 'ship-a' as never, issueId: 'issue-a' as never, repoId, destination: 'main', targetBranch: 'main',
      state: 'queued', humanState: 'waiting', activity: 'waiting', queueRank: 3,
      queuedAt: '2026-10-01T12:00:00.000Z', stateChangedAt: '2026-10-01T12:00:00.000Z',
    }])
    await old.flush()
    // Simulate the collection's absence in a cache written before O3.
    for (const key of storage.keys()) if (key.includes('shipLanes')) storage.removeItem(key)
    const current = createReplica({ storage, keyPrefix: 'shipping.alice' })
    const before = await current.hydrate()
    expect(before.shipLanes).toEqual([])
    expect(before.shipOrders.map((row) => [row.id, row.queueRank])).toEqual([['ship-a', 3]])
    expect(before.schemaReset).toBe(false)
    current.applySnapshot('shipLanes', [lane])
    await current.flush()
    const reopened = createReplica({ storage, keyPrefix: 'shipping.alice' })
    expect((await reopened.hydrate()).shipLanes).toMatchObject([lane])
    const other = createReplica({ storage, keyPrefix: 'shipping.bob' })
    expect((await other.hydrate()).shipLanes).toEqual([])
    expect(other.rows('shipOrders')).toEqual([])
    reopened.applyChanges('shipLanes', [], [lane.id])
    expect(reopened.rows('shipLanes')).toEqual([])
    reopened.applyChanges('shipLanes', [lane], [])
    expect(reopened.rows('shipLanes')).toMatchObject([lane])
  })

  it('stages lane snapshots atomically, applies buffered lane deltas and empties lanes on rescope', async () => {
    const replica = createReplica({ storage: memoryStorage() })
    const prior = { ...lane, trains: [], blockedOrderIds: ['ship-a' as never] }
    replica.applySnapshot('shipLanes', [prior])
    const pending = { mutationId: asMutationId('mut-a'), kind: 'issue.create', input: { title: 'Keep my work' }, queuedAt: 1 }
    replica.outboxStorage().save([pending])
    const cursor = { feedId: 'feed-a', epoch: 'epoch-a', seq: 5 }
    const staged = new BootstrapSession(replica, cursor, { yieldToLoop: () => Promise.resolve() })
    for (const chunk of snapshotToChunks({ shipLanes: [lane] })) await staged.install(chunk)
    expect(replica.rows('shipLanes')).toMatchObject([prior])
    const changed = { ...lane, trains: [{ orderIds: ['hidden' as never] }, ...lane.trains] }
    expect(staged.bufferDelta(6, [{ seq: 6, entity: 'shipLane', id: lane.id, op: 'upsert', value: changed }])).toBe(true)
    const seen: ShipLaneProjection[][] = []
    replica.subscribeRows('shipLanes', () => seen.push(replica.rows('shipLanes')))
    staged.commit()
    expect(seen).toMatchObject([[changed]])
    expect(replica.getCursor()).toBe(6)
    const aborted = new BootstrapSession(replica, { ...cursor, seq: 7 })
    for (const chunk of snapshotToChunks({ shipLanes: [] })) await aborted.install(chunk)
    aborted.abort()
    expect(replica.rows('shipLanes')).toMatchObject([changed])
    const rescope = new BootstrapSession(replica, { ...cursor, epoch: 'epoch-b', seq: 8 })
    for (const chunk of snapshotToChunks({})) await rescope.install(chunk)
    rescope.commit()
    expect(replica.rows('shipLanes')).toEqual([])
    expect(replica.outboxStorage().load()).toEqual([pending])
  })
})
