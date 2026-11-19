/**
 * POD-7159 — the disk layer: what a disk load costs the readers, and the
 * index's own transaction discipline. The adapters' obligations (index with
 * its rows, kills at chunk boundaries, reopening from disk offline) are in the
 * collection conformance suite, which runs on every adapter.
 */
import { describe, expect, it } from 'vitest'
import {
  CollectionServer,
  issue,
  session,
  WORLD_NOW,
  WORLD_POLICY,
} from '../conformance/collection-server'
import { inMemoryInstantiation } from '../conformance/in-memory'
import { instanceKey } from './cache-state'
import { bucketKeysAfter, bucketOf, DiskIndex, DiskIndexDraft, indexChanges } from './disk-index'
import { DISK_INSTALL_ROWS, Replica } from './replica'
import type { EntityRecord, InstanceRecord, InstanceSpec, ReplicaEvent } from './types'

const ISSUE = 'issueProjection'
const tree = (root: string): InstanceSpec => ({
  collection: 'issueProjection.tree',
  args: { root },
  part: 'main',
})

const ticks = async (count = 5): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a disk load (POD-7159)', () => {
  it('puts N rows in memory in at most ceil(N / chunk) bursts, each told to the readers once', async () => {
    const members = 2 * DISK_INSTALL_ROWS + 500
    const server = new CollectionServer()
    server.policy = { ...WORLD_POLICY, cacheCap: 100_000 }
    server.chunkRows = 500
    server.put(ISSUE, 'R', issue('R', { stage: 'done', closedReason: 'completed' }))
    for (let n = 1; n < members; n += 1)
      server.put(
        ISSUE,
        `M${n}`,
        issue(`M${n}`, { stage: 'done', closedReason: 'completed', parentId: 'R' }),
      )
    const storage = await inMemoryInstantiation.open()
    const { cache } = storage.viewFor('u-ada')
    // A burst is one reader notification (the app's `batch`); count those that put rows in memory.
    let inBurst: ReplicaEvent[] | null = null
    const rowBursts: number[] = []
    const replica = new Replica({
      store: cache,
      authority: server,
      now: () => WORLD_NOW,
      onEvent: (event) => {
        inBurst?.push(event)
      },
      batchEvents: (emitAll) => {
        const events: ReplicaEvent[] = []
        inBurst = events
        try {
          emitAll()
        } finally {
          inBurst = null
        }
        const rows = events.filter((event) => event.type === 'upserted').length
        if (rows > 0) rowBursts.push(rows)
      },
    })
    replica.connect()
    await replica.settled()
    await ticks()
    await replica.settled()
    await replica.load([tree('R')])
    await replica.settled()
    const key = instanceKey(tree('R'))
    expect([...cache.readDiskIndex().membersOf(key)].length).toBe(members)
    const before = cache.readEntities().length
    await replica.unload(key)
    expect(cache.read(ISSUE, 'M1')).toBeUndefined()
    // Every member left memory but the root, which what its children come with holds.
    const left = before - cache.readEntities().length
    expect(left).toBeGreaterThanOrEqual(members - 1)
    const fetched = server.fetches.length
    rowBursts.length = 0
    await replica.load([tree('R')])
    await replica.settled()
    expect(server.fetches.length, 'no server request').toBe(fetched)
    expect(replica.isComplete(tree('R'))).toBeDefined()
    expect(rowBursts.reduce((sum, rows) => sum + rows, 0)).toBe(left)
    expect(rowBursts.length).toBeLessThanOrEqual(Math.ceil(left / DISK_INSTALL_ROWS))
  })
})

describe('the trim and the disk (POD-7159)', () => {
  it('never drops a marker whose rows are only on disk: an unloaded screen comes back with no fetch', async () => {
    const server = new CollectionServer()
    server.policy = { ...WORLD_POLICY, cacheCap: 0 }
    server.answerComesWith = true
    server.put(ISSUE, 'R', issue('R', { stage: 'done', closedReason: 'completed' }))
    for (let n = 1; n <= 3; n += 1) {
      server.put(
        ISSUE,
        `M${n}`,
        issue(`M${n}`, { stage: 'done', closedReason: 'completed', parentId: 'R' }),
      )
      server.put('session', `S${n}`, session(`S${n}`, { issueId: `M${n}`, status: 'ended' }))
    }
    const storage = await inMemoryInstantiation.open()
    const { cache } = storage.viewFor('u-ada')
    const replica = new Replica({ store: cache, authority: server, now: () => WORLD_NOW })
    replica.connect()
    await replica.settled()
    await ticks()
    await replica.settled()
    const release = replica.hold(tree('R'))
    await replica.load([tree('R')])
    await replica.settled()
    const policy = new Set(
      WORLD_POLICY.steps.flatMap((step) =>
        step.collections.map((id) =>
          instanceKey({ collection: id, part: id === 'issueProjection.stubs' ? 'stub' : 'main' }),
        ),
      ),
    )
    const screen = [...cache.readInstances().keys()].filter(
      (key) => !policy.has(key) && cache.readDiskIndex().inMemory(key),
    )
    expect(screen).toContain(instanceKey(tree('R')))
    await replica.unload(screen)
    // The cap is 0: a trim now can only see the policy's rows in memory.
    await replica.trim()
    for (const key of screen) expect(cache.readInstances().has(key), key).toBe(true)
    // What the tree's records come with stays recorded on them.
    expect(cache.readDiskIndex().record(`${ISSUE}\u0000M1`)?.cw.length).toBeGreaterThan(0)
    const fetched = server.fetches.length
    await replica.load([tree('R')])
    await replica.settled()
    await ticks()
    await replica.settled()
    expect(server.fetches.length, 'no server request').toBe(fetched)
    for (const key of screen) expect(cache.readDiskIndex().inMemory(key), key).toBe(true)
    for (let n = 1; n <= 3; n += 1) expect(cache.read('session', `S${n}`), `S${n}`).toBeDefined()
    release()
  })
})

describe('the disk index draft', () => {
  const row = (id: string, seq: number, part?: 'stub'): EntityRecord => ({
    entity: ISSUE,
    entityId: id,
    value: issue(id),
    provenance: { seq },
    ...(part === undefined ? {} : { part }),
  })
  const marker = (key: string): InstanceRecord => ({
    key,
    collection: 'issueProjection.tree',
    args: { root: 'A' },
    part: 'main',
    completeAt: { feedId: 'f', epoch: 'e', seq: 1 },
  })

  it('changes nothing until it is published, and then the members follow the holders', () => {
    const index = new DiskIndex()
    const draft = new DiskIndexDraft(index)
    draft.row('issueProjection\u0000A', row('A', 1))
    draft.row('issueProjection\u0000B', row('B', 2))
    draft.mark(marker('T'), ['issueProjection\u0000A', 'issueProjection\u0000B'], 5)
    expect(index.recordCount).toBe(0)
    expect(draft.record('issueProjection\u0000A')?.holders).toEqual(['T'])
    index.publish(draft)
    expect([...index.membersOf('T')].sort()).toEqual([
      'issueProjection\u0000A',
      'issueProjection\u0000B',
    ])
    expect(index.inMemory('T')).toBe(true)
    expect(index.instance('T')).toEqual({ lastReadAt: 5, stale: false, indexed: true })
    // A stub has no holders: it leaves every instance's members.
    const next = new DiskIndexDraft(index)
    next.row('issueProjection\u0000B', row('B', 3, 'stub'))
    next.row('issueProjection\u0000A', null)
    index.publish(next)
    expect([...index.membersOf('T')]).toEqual([])
    expect(index.record('issueProjection\u0000B')).toMatchObject({ level: 'stub', seq: 3 })
    expect(index.recordCount).toBe(1)
  })

  it('rewrites each touched bucket once, after the clear that came last', () => {
    const index = new DiskIndex()
    const draft = new DiskIndexDraft(index)
    draft.row('issueProjection\u0000A', row('A', 1))
    draft.row('issueProjection\u0000A', row('A', 2))
    draft.clearAll()
    draft.row('issueProjection\u0000B', row('B', 3))
    const changes = indexChanges(draft)
    expect(changes.clearAll).toBe(true)
    expect([...changes.buckets]).toEqual([bucketOf('issueProjection\u0000B')])
    expect(bucketKeysAfter(draft, index, bucketOf('issueProjection\u0000B'))).toEqual([
      'issueProjection\u0000B',
    ])
  })

  it('records what a record comes with on the record: its rows carry it, and its vias', () => {
    const index = new DiskIndex()
    const draft = new DiskIndexDraft(index)
    draft.row('issueProjection\u0000X', row('X', 1))
    draft.row('session\u0000S', { ...row('S', 1), entity: 'session' })
    draft.addHolder('session\u0000S', '^issueProjection\u0000X')
    draft.setComesWith('issueProjection\u0000X', ['issueProjection'])
    index.publish(draft)
    expect([...index.membersOf('^issueProjection\u0000X')]).toEqual(['session\u0000S'])
    expect(index.record('issueProjection\u0000X')?.cw).toEqual(['issueProjection'])
    // A change of the row keeps what it came with; a stub has none of it.
    const next = new DiskIndexDraft(index)
    next.row('session\u0000S', { ...row('S', 2), entity: 'session' }, [])
    next.row('issueProjection\u0000X', row('X', 2, 'stub'))
    index.publish(next)
    expect(index.record('session\u0000S')?.holders).toEqual(['^issueProjection\u0000X'])
    expect(index.record('issueProjection\u0000X')?.cw).toEqual([])
  })
})
