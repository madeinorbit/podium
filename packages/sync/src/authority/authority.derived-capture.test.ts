/**
 * DERIVED CHANGE CAPTURE (POD-6253 design §3, POD-6920), unit-tested on the
 * kernel alone: the "database" is a map of model rows the test writes, every
 * write that changes a row is captured as a database trigger would capture it,
 * the record source drains that capture and builds from the map, and
 * `transact` rolls the map, the capture and the change log back on a throw.
 *
 * What is held here: a commit names nothing. Its changes are exactly the
 * records the capture reached, each built once after the write, and a write
 * that changed no row appends nothing. (Ported from the compare-at-save tests
 * of POD-6769.)
 */

import { asMutationId, type ChangeProvenanceFields, OWNERSHIP_MATRIX } from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { ChangeLogStore } from '../change-log'
import { DeviceGradeNoAnchors, DeviceGradeUnscopedPolicy } from '../feed/visibility'
import { Authority } from './authority'
import type { ChangeLogReadRow } from './change-lifecycle'
import type { RecordSourcePort } from './ports'

const KINDS: readonly MetadataEntityKind[] = ['userLayout', 'pin', 'workflowRun']

function world(provenance?: () => ChangeProvenanceFields | undefined) {
  let log: ChangeLogReadRow[] = []
  let nextSeq = 1
  /** The model tables: kind → id → the row's wire value. */
  let tables = new Map<string, Map<string, unknown>>()
  /** The capture, as the triggers fill it: kind → ids, in order. */
  let captured: [MetadataEntityKind, string][] = []
  const builds: { kind: string; ids: readonly string[] }[] = []
  const drains: number[] = []

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
  }
  const transact = async <T>(fn: () => Promise<T>): Promise<T> => {
    const savedLog = log.slice()
    const savedSeq = nextSeq
    const savedTables = new Map([...tables].map(([k, rows]) => [k, new Map(rows)]))
    const savedCapture = captured.slice()
    try {
      return await fn()
    } catch (err) {
      log = savedLog
      nextSeq = savedSeq
      tables = savedTables
      captured = savedCapture
      throw err
    }
  }
  const records: RecordSourcePort = {
    drainCapture: async () => {
      drains.push(builds.length)
      const out = new Map<MetadataEntityKind, string[]>()
      for (const [kind, id] of captured) {
        const ids = out.get(kind) ?? []
        if (!ids.includes(id)) ids.push(id)
        out.set(kind, ids)
      }
      captured = []
      return out
    },
    build: async (kind, ids) => {
      builds.push({ kind, ids })
      const rows = tables.get(kind)
      return ids.flatMap((id) => (rows?.has(id) ? [{ id, value: rows.get(id) }] : []))
    },
    async *buildMany(idsByKind) {
      for (const [entity, ids] of idsByKind)
        yield { entity, records: await this.build(entity, ids) }
    },
    kinds: () => [...KINDS],
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
    drains,
    get log() {
      return log
    },
    get captured() {
      return captured
    },
    /** Write a row; a value that does not change fires no trigger. */
    set: (kind: MetadataEntityKind, id: string, value: unknown) => {
      const rows = tables.get(kind) ?? new Map<string, unknown>()
      if (rows.has(id) && JSON.stringify(rows.get(id)) === JSON.stringify(value)) return
      rows.set(id, value)
      tables.set(kind, rows)
      captured.push([kind, id])
    },
    /** Delete a row; deleting nothing fires no trigger. */
    drop: (kind: MetadataEntityKind, id: string) => {
      if (tables.get(kind)?.delete(id)) captured.push([kind, id])
    },
    /** A row the kind reads that is not the record's own (a joined table). */
    touch: (kind: MetadataEntityKind, id: string) => {
      captured.push([kind, id])
    },
  }
}

async function committed<T>(result: Promise<{ outcome: string; changes?: readonly T[] }>) {
  const outcome = await result
  if (outcome.outcome !== 'committed') throw new Error('not committed')
  return outcome.changes as readonly T[]
}

const ids = (changes: readonly unknown[]) =>
  changes.map((c) => `${(c as { entity: string }).entity}:${(c as { entityId: string }).entityId}`)

describe('derived change capture', () => {
  it('appends an upsert of the record as the database holds it after the write', async () => {
    const w = world()
    const changes = await committed(
      w.authority.commit({ write: async () => w.set('userLayout', 'a', { key: 'a', value: 1 }) }),
    )
    expect(changes).toEqual([
      { seq: 1, entity: 'userLayout', entityId: 'a', op: 'upsert', value: { key: 'a', value: 1 } },
    ])
    expect(w.log.map((r) => r.payload)).toEqual(['{"key":"a","value":1}'])
  })

  it('appends nothing for a write that changed no row', async () => {
    const w = world()
    w.set('userLayout', 'a', { v: 1 })
    w.set('userLayout', 'b', { v: 1 })
    await w.authority.commit({ write: async () => undefined })
    const changes = await committed(
      w.authority.commit({
        write: async () => {
          w.set('userLayout', 'a', { v: 1 })
          w.set('userLayout', 'b', { v: 2 })
        },
      }),
    )
    expect(ids(changes)).toEqual(['userLayout:b'])
  })

  it('appends a remove for a record the write deleted, and nothing for one that was not there', async () => {
    const w = world()
    w.set('userLayout', 'a', { v: 1 })
    await w.authority.commit({ write: async () => undefined })
    const changes = await committed(
      w.authority.commit({
        write: async () => {
          w.drop('userLayout', 'a')
          w.drop('userLayout', 'ghost')
        },
      }),
    )
    expect(changes).toEqual([{ seq: 2, entity: 'userLayout', entityId: 'a', op: 'remove' }])
    expect(w.log.at(-1)?.payload).toBeNull()
  })

  it('a captured record that has no row now is removed, whatever it was before', async () => {
    const w = world()
    // A joined row changed for a record that does not exist (or no longer
    // does): there is no build before the write, so the remove is appended.
    const changes = await committed(
      w.authority.commit({ write: async () => w.touch('pin', 'p-joined') }),
    )
    expect(changes).toEqual([{ seq: 1, entity: 'pin', entityId: 'p-joined', op: 'remove' }])
  })

  it('a record reached through another row is appended whole, unchanged or not', async () => {
    const w = world()
    w.set('pin', 'p1', { v: 1 })
    await w.authority.commit({ write: async () => undefined })
    const changes = await committed(w.authority.commit({ write: async () => w.touch('pin', 'p1') }))
    expect(changes).toEqual([
      { seq: 2, entity: 'pin', entityId: 'p1', op: 'upsert', value: { v: 1 } },
    ])
  })

  it('builds once per kind, after the write, and nothing before it', async () => {
    const w = world()
    const order: string[] = []
    await w.authority.commit({
      authorize: async () => {
        order.push(`authorize:${w.builds.length}`)
      },
      write: async () => {
        order.push(`write:${w.builds.length}`)
        w.set('userLayout', 'a', 1)
        w.set('pin', 'p1', 1)
        w.set('userLayout', 'b', 1)
        w.set('userLayout', 'a', 2)
        w.set('pin', 'p2', 1)
      },
    })
    expect(order).toEqual(['authorize:0', 'write:0'])
    expect(w.drains).toEqual([0])
    expect(w.builds).toEqual([
      { kind: 'userLayout', ids: ['a', 'b'] },
      { kind: 'pin', ids: ['p1', 'p2'] },
    ])
    // Appended in the order the capture first reached each record.
    expect(ids(w.log.map((r) => ({ entity: r.entity, entityId: r.entityId })))).toEqual([
      'userLayout:a',
      'userLayout:b',
      'pin:p1',
      'pin:p2',
    ])
  })

  it('a write that captured nothing builds nothing', async () => {
    const w = world()
    const changes = await committed(w.authority.commit({ write: async () => 'result' }))
    expect(changes).toEqual([])
    expect(w.builds).toEqual([])
  })

  it('drains what the transaction wrote before the commit, too', async () => {
    const w = world()
    // A funnel that writes its rows and then commits in the same transaction
    // (an event append, a message transition): the commit drains them.
    const changes = await committed(
      (async () => {
        w.set('workflowRun', 'r1', { status: 'active' })
        return await w.authority.commit({ write: async () => undefined })
      })(),
    )
    expect(ids(changes)).toEqual(['workflowRun:r1'])
    expect(w.captured).toEqual([])
  })

  it('rolls the write, its capture and the append back together when the write throws', async () => {
    const w = world()
    w.set('userLayout', 'a', { v: 1 })
    await w.authority.commit({ write: async () => undefined })
    await expect(
      w.authority.commit({
        write: async () => {
          w.set('userLayout', 'a', { v: 2 })
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')
    expect(w.log).toHaveLength(1)
    expect(w.captured).toEqual([])
    const again = await committed(w.authority.commit({ write: async () => undefined }))
    expect(again).toEqual([])
  })

  it('a rejected arbitration writes nothing and drains nothing', async () => {
    const w = world()
    const row = OWNERSHIP_MATRIX.find((entry) => entry.conflict === 'exp-rev')
    if (row === undefined) throw new Error('the ownership matrix has no exp-rev row')
    const outcome = await w.authority.commit({
      arbitrate: {
        rowId: row.id,
        attempt: { expectedRevision: 1 },
        current: async () => ({ revision: 2 }),
      },
      write: async () => w.set('pin', 'p1', 1),
    })
    expect(outcome.outcome).toBe('rejected')
    expect(w.drains).toEqual([])
    expect(w.log).toEqual([])
  })

  it('stamps the ambient provenance on every appended row', async () => {
    const w = world(() => ({ mutationId: asMutationId('m-ambient') }))
    await w.authority.commit({
      write: async () => {
        w.set('userLayout', 'a', 1)
        w.set('userLayout', 'b', 1)
      },
    })
    expect(w.log.map((r) => [r.entityId, r.mutationId])).toEqual([
      ['a', 'm-ambient'],
      ['b', 'm-ambient'],
    ])
  })
})
