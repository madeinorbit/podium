/**
 * COMPARE AT SAVE (POD-6253 design §3, POD-6769), unit-tested on the kernel
 * alone: the "database" is a map of model rows the test writes, the record
 * source builds from that map, and `transact` rolls both the map and the
 * change log back on a throw.
 *
 * What is held here: a moved kind's changes come from the two builds around
 * the write and from nothing else. The stored copy of the last published value
 * is not read, so a record whose copy is missing or stale is still decided by
 * what the write did.
 */

import { asMutationId, type ChangeProvenanceFields } from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { ChangeLogStore } from '../change-log'
import { installedWorldOver } from '../conformance/installed-reads'
import { DeviceGradeNoAnchors, DeviceGradeUnscopedPolicy } from '../feed/visibility'
import { Authority, ChangeDetectionPathMismatch } from './authority'
import type { ChangeLogReadRow } from './change-lifecycle'
import type { RecordSourcePort } from './ports'

/** The kinds this file treats as moved. `session` stays on the old compare. */
const MOVED: readonly MetadataEntityKind[] = ['userLayout', 'pin', 'workflowRun']
/** The closed list of kinds whose writer may name records after the write. */
const NAMED_AFTER: readonly MetadataEntityKind[] = ['workflowRun']

function world(provenance?: () => ChangeProvenanceFields | undefined) {
  let log: ChangeLogReadRow[] = []
  let nextSeq = 1
  /** The model tables: kind → id → the row's wire value. */
  let tables = new Map<string, Map<string, unknown>>()
  const builds: { kind: string; ids: readonly string[] }[] = []
  const installedReads: unknown[] = []

  const world = installedWorldOver(async () => {
    const latest = new Map<string, ChangeLogReadRow>()
    for (const r of log) latest.set(`${r.entity}/${r.entityId}`, r)
    return [...latest.values()]
  })
  const store: ChangeLogStore = {
    async appendChanges(batch) {
      const seqs: number[] = []
      for (const r of batch) {
        log.push({ seq: nextSeq, ...r })
        seqs.push(nextSeq)
        nextSeq += 1
      }
      return seqs
    },
    maxChangeSeq: async () => nextSeq - 1,
    minChangeSeq: async () => log[0]?.seq ?? null,
    changesSince: async (cursor) => log.filter((r) => r.seq > cursor),
    changesInRange: async (from, through, limit) =>
      log.filter((r) => r.seq > from && r.seq <= through).slice(0, limit),
    planChangePrune: async () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: async () => 0,
    ...world,
    installedStates: async (keys) => {
      installedReads.push(keys)
      return await world.installedStates(keys)
    },
  }
  const transact = async <T>(fn: () => Promise<T>): Promise<T> => {
    const savedLog = log.slice()
    const savedSeq = nextSeq
    const savedTables = new Map([...tables].map(([k, rows]) => [k, new Map(rows)]))
    try {
      return await fn()
    } catch (err) {
      log = savedLog
      nextSeq = savedSeq
      tables = savedTables
      throw err
    }
  }
  const records: RecordSourcePort = {
    comparesAtSave: (kind) => MOVED.includes(kind),
    namedAfterWrite: (kind) => NAMED_AFTER.includes(kind),
    build: async (kind, ids) => {
      builds.push({ kind, ids })
      const rows = tables.get(kind)
      return ids.flatMap((id) => (rows?.has(id) ? [{ id, value: rows.get(id) }] : []))
    },
    async *buildMany(idsByKind) {
      for (const [entity, ids] of idsByKind)
        yield { entity, records: await this.build(entity, ids) }
    },
    kinds: () => [...MOVED],
    async *streamAll(kind) {
      yield [...(tables.get(kind) ?? [])].map(([id, value]) => ({ id, value }))
    },
    async *streamAllKinds() {
      for (const entity of this.kinds()) {
        for await (const records of this.streamAll(entity)) yield { entity, records }
      }
    },
  }
  const authority = new Authority({
    store,
    now: () => 1000,
    transact,
    visibility: new DeviceGradeUnscopedPolicy(),
    anchors: new DeviceGradeNoAnchors(),
    records,
    ...(provenance === undefined ? {} : { provenance: { current: provenance } }),
  })
  return {
    authority,
    builds,
    installedReads,
    get log() {
      return log
    },
    set: (kind: string, id: string, value: unknown) => {
      const rows = tables.get(kind) ?? new Map<string, unknown>()
      rows.set(id, value)
      tables.set(kind, rows)
    },
    drop: (kind: string, id: string) => {
      tables.get(kind)?.delete(id)
    },
  }
}

const layout = (id: string) => ({ entity: 'userLayout' as const, entityId: id })

async function committed<T>(result: Promise<{ outcome: string; changes?: readonly T[] }>) {
  const outcome = await result
  if (outcome.outcome !== 'committed') throw new Error('not committed')
  return outcome.changes as readonly T[]
}

describe('compare at save', () => {
  it('appends an upsert of the record as the database holds it after the write', async () => {
    const w = world()
    const changes = await committed(
      w.authority.commit({
        affects: [layout('a')],
        write: async () => w.set('userLayout', 'a', { key: 'a', value: 1 }),
      }),
    )
    expect(changes).toEqual([
      { seq: 1, entity: 'userLayout', entityId: 'a', op: 'upsert', value: { key: 'a', value: 1 } },
    ])
    expect(w.log.map((r) => r.payload)).toEqual(['{"key":"a","value":1}'])
  })

  it('appends nothing for a named record the write left as it was', async () => {
    const w = world()
    w.set('userLayout', 'a', { v: 1 })
    w.set('userLayout', 'b', { v: 1 })
    const changes = await committed(
      w.authority.commit({
        affects: [layout('a'), layout('b'), layout('never-existed')],
        write: async () => w.set('userLayout', 'b', { v: 2 }),
      }),
    )
    expect(changes.map((c) => (c as { entityId: string }).entityId)).toEqual(['b'])
  })

  it('appends a remove for a record the write deleted, and none for one that never existed', async () => {
    const w = world()
    w.set('userLayout', 'a', { v: 1 })
    const changes = await committed(
      w.authority.commit({
        affects: [layout('a'), layout('ghost')],
        write: async () => w.drop('userLayout', 'a'),
      }),
    )
    expect(changes).toEqual([{ seq: 1, entity: 'userLayout', entityId: 'a', op: 'remove' }])
    expect(w.log[0]?.payload).toBeNull()
  })

  it('decides from the two builds, not from the stored copy of the last value', async () => {
    const w = world()
    // The row exists in the database and was never published: no stored copy.
    w.set('userLayout', 'a', { v: 1 })
    const untouched = await committed(
      w.authority.commit({ affects: [layout('a')], write: async () => undefined }),
    )
    // The old compare would have appended it (the copy is missing). This write
    // changed nothing, so nothing is appended.
    expect(untouched).toEqual([])
    expect(w.installedReads).toEqual([])
  })

  it('builds each kind once before and once after, whatever the number of records', async () => {
    const w = world()
    await w.authority.commit({
      affects: [
        layout('a'),
        { entity: 'pin', entityId: 'p1' },
        layout('b'),
        layout('a'),
        { entity: 'pin', entityId: 'p2' },
      ],
      write: async () => undefined,
    })
    expect(w.builds).toEqual([
      { kind: 'userLayout', ids: ['a', 'b'] },
      { kind: 'pin', ids: ['p1', 'p2'] },
      { kind: 'userLayout', ids: ['a', 'b'] },
      { kind: 'pin', ids: ['p1', 'p2'] },
    ])
  })

  it('builds before the write, after arbitration, inside the span', async () => {
    const w = world()
    w.set('userLayout', 'a', { v: 1 })
    const order: string[] = []
    await w.authority.commit({
      authorize: async () => {
        order.push(`authorize:${w.builds.length}`)
      },
      affects: [layout('a')],
      write: async () => {
        order.push(`write:${w.builds.length}`)
        w.set('userLayout', 'a', { v: 2 })
      },
    })
    expect(order).toEqual(['authorize:0', 'write:1'])
    expect(w.builds).toHaveLength(2)
  })

  it('records the writer must read to name are named inside the span, before the build', async () => {
    const w = world()
    w.set('pin', 'p1', { v: 1 })
    const order: string[] = []
    const changes = await committed(
      w.authority.commit({
        authorize: async () => {
          order.push('authorize')
        },
        affects: async () => {
          order.push(`affects:${w.builds.length}`)
          return [{ entity: 'pin', entityId: 'p1' }]
        },
        write: async () => {
          order.push(`write:${w.builds.length}`)
          w.drop('pin', 'p1')
        },
      }),
    )
    expect(order).toEqual(['authorize', 'affects:0', 'write:1'])
    expect(changes).toEqual([{ seq: 1, entity: 'pin', entityId: 'p1', op: 'remove' }])
  })

  it('a record the write created is named after it and appended when it is there', async () => {
    const w = world()
    w.set('pin', 'old', { v: 1 })
    const changes = await committed(
      w.authority.commit({
        affects: [{ entity: 'pin', entityId: 'old' }],
        write: async () => {
          w.set('pin', 'new', { v: 2 })
          return 'new'
        },
        // The whole set after the write: `old` was named before and is
        // compared; `new` is the one that was created; `gone` is not there.
        creates: (id) => [
          { entity: 'pin', entityId: 'old' },
          { entity: 'pin', entityId: id },
          { entity: 'pin', entityId: 'gone' },
        ],
      }),
    )
    expect(changes).toEqual([
      { seq: 1, entity: 'pin', entityId: 'new', op: 'upsert', value: { v: 2 } },
    ])
    // One build before (the named record), one after (named and created).
    expect(w.builds).toEqual([
      { kind: 'pin', ids: ['old'] },
      { kind: 'pin', ids: ['old', 'new', 'gone'] },
    ])
  })

  it('rolls the write and the append back together when the write throws', async () => {
    const w = world()
    w.set('userLayout', 'a', { v: 1 })
    await expect(
      w.authority.commit({
        affects: [layout('a')],
        write: async () => {
          w.set('userLayout', 'a', { v: 2 })
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')
    expect(w.log).toEqual([])
    const again = await committed(
      w.authority.commit({ affects: [layout('a')], write: async () => undefined }),
    )
    expect(again).toEqual([])
  })

  it('stamps the ambient provenance, and a named record keeps its own', async () => {
    const w = world(() => ({ mutationId: asMutationId('m-ambient') }))
    await w.authority.commit({
      affects: [layout('a'), { ...layout('b'), originId: 'own-origin' }],
      write: async () => {
        w.set('userLayout', 'a', 1)
        w.set('userLayout', 'b', 1)
      },
    })
    expect(w.log.map((r) => [r.entityId, r.mutationId, r.originId])).toEqual([
      ['a', 'm-ambient', undefined],
      ['b', undefined, 'own-origin'],
    ])
  })

  it('a commit carries compared and declared changes together, compared first', async () => {
    const w = world()
    const changes = await committed(
      w.authority.commit({
        affects: [layout('a')],
        write: async () => w.set('userLayout', 'a', 1),
        changes: () => [{ entity: 'session', entityId: 's1', op: 'upsert', value: { id: 's1' } }],
      }),
    )
    expect(changes.map((c) => (c as { entity: string }).entity)).toEqual(['userLayout', 'session'])
  })
})

describe('records named after the write', () => {
  const run = (id: string) => ({ entity: 'workflowRun' as const, entityId: id })

  it('appends each as it is now, with no build before the write', async () => {
    const w = world()
    w.set('workflowRun', 'r1', { status: 'active' })
    const changes = await committed(
      w.authority.commit({
        write: async () => {
          w.set('workflowRun', 'r2', { status: 'active' })
        },
        // r1 was not changed: it is appended all the same. `gone` is not there.
        wrote: () => [run('r1'), run('r2'), run('gone')],
      }),
    )
    expect(changes.map((c) => (c as { entityId: string }).entityId)).toEqual(['r1', 'r2'])
    expect(w.builds).toEqual([{ kind: 'workflowRun', ids: ['r1', 'r2', 'gone'] }])
  })

  it('appends a remove only when the writer says the write removed the record', async () => {
    const w = world()
    const changes = await committed(
      w.authority.commit({
        write: async () => undefined,
        wrote: () => [run('never-there'), { ...run('tombstoned'), removed: true }],
      }),
    )
    expect(changes).toEqual([
      { seq: 1, entity: 'workflowRun', entityId: 'tombstoned', op: 'remove' },
    ])
  })

  it('a write that names nothing appends nothing and builds nothing', async () => {
    const w = world()
    const changes = await committed(
      w.authority.commit({ write: async () => undefined, wrote: () => [] }),
    )
    expect(changes).toEqual([])
    expect(w.builds).toEqual([])
  })

  it('a record also named before the write is compared, not repeated', async () => {
    const w = world()
    w.set('workflowRun', 'r1', { status: 'active' })
    const changes = await committed(
      w.authority.commit({
        affects: [run('r1')],
        write: async () => undefined,
        wrote: () => [run('r1')],
      }),
    )
    expect(changes).toEqual([])
  })

  it('a kind outside the closed list cannot be named after the write: the write rolls back', async () => {
    const w = world()
    w.set('pin', 'p1', { v: 1 })
    await expect(
      w.authority.commit({
        write: async () => w.set('pin', 'p1', { v: 2 }),
        wrote: () => [{ entity: 'pin', entityId: 'p1' }],
      }),
    ).rejects.toMatchObject({ name: 'ChangeDetectionPathMismatch', entity: 'pin', used: 'wrote' })
    expect(w.log).toEqual([])
    // The write is gone with it: nothing differs on the next commit.
    const again = await committed(
      w.authority.commit({
        affects: [{ entity: 'pin', entityId: 'p1' }],
        write: async () => undefined,
      }),
    )
    expect(again).toEqual([])
    // And not a kind that has not moved at all.
    await expect(
      w.authority.commit({
        write: async () => undefined,
        wrote: () => [{ entity: 'session', entityId: 's1' }],
      }),
    ).rejects.toBeInstanceOf(ChangeDetectionPathMismatch)
  })
})

describe('a kind uses one path', () => {
  it('refuses to name a record of a kind that has not moved, before anything runs', async () => {
    const w = world()
    let ran = false
    await expect(
      w.authority.commit({
        authorize: async () => {
          ran = true
        },
        affects: [{ entity: 'session', entityId: 's1' }],
        write: async () => {
          ran = true
        },
      }),
    ).rejects.toBeInstanceOf(ChangeDetectionPathMismatch)
    expect(ran).toBe(false)
  })

  it('refuses a declared change of a moved kind and rolls the write back', async () => {
    const w = world()
    await expect(
      w.authority.commit({
        write: async () => w.set('userLayout', 'a', 1),
        changes: () => [{ entity: 'userLayout', entityId: 'a', op: 'upsert', value: 1 }],
      }),
    ).rejects.toBeInstanceOf(ChangeDetectionPathMismatch)
    expect(w.log).toEqual([])
    expect(w.builds).toEqual([])
  })

  it('refuses a capture of a moved kind', async () => {
    const w = world()
    await expect(
      w.authority.capture([{ entity: 'pin', entityId: 'p', op: 'upsert', value: 1 }]),
    ).rejects.toBeInstanceOf(ChangeDetectionPathMismatch)
  })

  it('a kind that has not moved keeps the compare with the stored row', async () => {
    const w = world()
    const spec = { entity: 'session' as const, entityId: 's1', op: 'upsert' as const, value: 1 }
    expect(await w.authority.capture([spec])).toHaveLength(1)
    expect(await w.authority.capture([spec])).toHaveLength(0)
    expect(w.installedReads).toHaveLength(2)
    expect(w.builds).toEqual([])
  })

  it('reconcile still compares a moved kind with the stored rows', async () => {
    const w = world()
    expect(await w.authority.reconcile('userLayout', [{ id: 'a', value: 1 }])).toHaveLength(1)
    expect(await w.authority.reconcile('userLayout', [{ id: 'a', value: 1 }])).toHaveLength(0)
  })
})
