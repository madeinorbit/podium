import { asMutationId, asRepoId, shipLaneId, type ShipLaneProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { BootstrapSession, snapshotToChunks } from './bootstrap'
import { memoryStorage } from './contract'
import { createReplicaFixture } from '@podium/client-core/test-support/replica'

const repoId = asRepoId('repo-a')
const lane: ShipLaneProjection = {
  id: shipLaneId(repoId, 'local:main'),
  repoId,
  destination: 'local:main',
  trains: [{ orderIds: ['ship-a' as never] }],
  blockedOrderIds: [],
}

describe('shipping lane replica compatibility', () => {
  it('stages lane snapshots atomically, applies buffered lane deltas and empties lanes on rescope', async () => {
    const replica = createReplicaFixture({ storage: memoryStorage() })
    const prior = { ...lane, trains: [], blockedOrderIds: ['ship-a' as never] }
    replica.applySnapshot('shipLanes', [prior])
    const pending = {
      mutationId: asMutationId('mut-a'),
      kind: 'issue.create',
      input: { title: 'Keep my work' },
      queuedAt: 1,
    }
    replica.outboxStorage().save([pending])
    const cursor = { feedId: 'feed-a', epoch: 'epoch-a', seq: 5 }
    const staged = new BootstrapSession(replica, cursor, { yieldToLoop: () => Promise.resolve() })
    for (const chunk of snapshotToChunks({ shipLanes: [lane] })) await staged.install(chunk)
    expect(replica.rows('shipLanes')).toMatchObject([prior])
    const changed = { ...lane, trains: [{ orderIds: ['hidden' as never] }, ...lane.trains] }
    expect(
      staged.bufferDelta(6, [
        { seq: 6, entity: 'shipLane', id: lane.id, op: 'upsert', value: changed },
      ]),
    ).toBe(true)
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
