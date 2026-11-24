import { asMutationId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { ChangeLogReadRow } from './authority/change-lifecycle'
import { type ChangeLogStore, ChangeRangeBootstrapRequired, readChangesRange } from './change-log'
import { ModelAuthority as Authority } from './conformance/model-records'
import {
  DEVICE_GRADE_PRINCIPAL,
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
} from './feed/visibility'

const row = (seq: number): ChangeLogReadRow => ({
  seq,
  entity: 'session',
  entityId: `s${seq}`,
  op: 'upsert',
  payload: JSON.stringify({ n: seq }),
})
async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const page of pages) result.push(page)
  return result
}

function fixture(count = 3) {
  const rows = Array.from({ length: count }, (_, i) => row(i + 1))
  let afterRead = () => {}
  const store: ChangeLogStore = {
    appendChanges: async () => {
      throw new Error('unused')
    },
    maxChangeSeq: vi.fn(async () => rows.at(-1)?.seq ?? 0),
    minChangeSeq: vi.fn(async () => rows[0]?.seq ?? null),
    changesSince: async (from) => {
      const page = rows.filter((r) => r.seq > from)
      afterRead()
      return page
    },
    changesInRange: vi.fn(async (from, through, limit) => {
      const page = rows.filter((r) => r.seq > from && r.seq <= through).slice(0, limit)
      afterRead()
      return page
    }),

    planChangePrune: async () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: async () => 0,
  }
  const authority = new Authority({
    store,
    now: () => 0,
    transact: (fn) => fn(),
    visibility: new DeviceGradeUnscopedPolicy(),
    anchors: new DeviceGradeNoAnchors(),
  })
  return {
    rows,
    store,
    authority,
    appendDuringRead: () => {
      afterRead = () => {
        rows.push(row(rows.length + 1))
        afterRead = () => {}
      }
    },
  }
}

describe('bounded change-log ranges', () => {
  it('yields kernel rows: entityId, the value, and the provenance as stored', async () => {
    const f = fixture(2)
    f.rows[0] = { ...row(1), mutationId: asMutationId('m-1'), causationId: 'm-1', originId: 'peer' }
    f.rows[1] = { ...row(2), op: 'remove', payload: null }
    expect(await collect(readChangesRange(f.store, 0, 2, 10))).toEqual([
      [
        {
          seq: 1,
          entity: 'session',
          entityId: 's1',
          op: 'upsert',
          value: { n: 1 },
          mutationId: 'm-1',
          causationId: 'm-1',
          originId: 'peer',
        },
        { seq: 2, entity: 'session', entityId: 's2', op: 'remove' },
      ],
    ])
  })

  it('legacy changesSince never certifies a write appended after reading rows', async () => {
    const f = fixture()
    f.appendDuringRead()
    const delivery = await f.authority.changesSince(0, DEVICE_GRADE_PRINCIPAL)
    expect(f.rows).toHaveLength(4)
    expect(delivery?.throughSeq).toBe(3)
    expect(delivery?.kind === 'batch' && delivery.changes.map((c) => c.seq)).toEqual([1, 2, 3])
    expect(f.store.maxChangeSeq).toHaveBeenCalledTimes(1)
  })

  it('chains bounded pages to the pre-captured head despite an append between pages', async () => {
    const f = fixture()
    const target = await f.authority.captureHead()
    f.appendDuringRead()
    const pages = await collect(f.authority.changesRange(DEVICE_GRADE_PRINCIPAL, 0, target, 1))
    expect(f.rows).toHaveLength(4)
    expect(pages.map((p) => [p.fromSeq, p.throughSeq])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
    expect(pages.flatMap((p) => (p.kind === 'batch' ? p.changes.map((c) => c.seq) : []))).toEqual([
      1, 2, 3,
    ])
    // The floor is read after each page (POD-7589).
    expect(f.store.minChangeSeq).toHaveBeenCalledTimes(3)
    expect(f.store.changesInRange).toHaveBeenCalledTimes(3)
  })

  // POD-7589: a prune that commits between two pages deletes rows the second page
  // would have returned. The read must refuse that page, never yield it short.
  it('refuses the page a prune cut into, before yielding it', async () => {
    const f = fixture(4)
    let reads = 0
    const read = f.store.changesInRange
    f.store.changesInRange = vi.fn(async (from, through, limit) => {
      const page = await read(from, through, limit)
      // After the first page: the head prune deletes seqs 1 and 2.
      if (++reads === 1) f.rows.splice(0, 2)
      return page
    })
    const iterator = readChangesRange(f.store, 0, 4, 1)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject([{ seq: 1 }])
    // Without the check this page would be seq 3, and seq 2 would be lost.
    await expect(iterator.next()).rejects.toBeInstanceOf(ChangeRangeBootstrapRequired)
    const f2 = fixture(4)
    // A healed range above a prune that stays below it is still served.
    f2.rows.splice(0, 1)
    expect((await collect(readChangesRange(f2.store, 1, 4, 1))).flat().map((c) => c.seq)).toEqual([
      2, 3, 4,
    ])
  })

  it('certifies an empty range, including an empty log', async () => {
    const f = fixture(0)
    expect(await collect(f.authority.changesRange(DEVICE_GRADE_PRINCIPAL, 0, 0, 1))).toEqual([
      { kind: 'batch', fromSeq: 0, throughSeq: 0, changes: [] },
    ])
    expect(f.store.minChangeSeq).not.toHaveBeenCalled()
  })

  it('closes the final page at the target when the store exhausts below it', async () => {
    const f = fixture(2)
    const pages = await collect(f.authority.changesRange(DEVICE_GRADE_PRINCIPAL, 0, 3, 1))
    expect(pages.map((p) => [p.fromSeq, p.throughSeq])).toEqual([
      [0, 1],
      [1, 3],
    ])
  })

  it('rejects pruned, empty retained, and future ranges at the first page', async () => {
    for (const rows of [[], [row(3)]]) {
      const f = fixture()
      f.rows.splice(0, f.rows.length, ...rows)
      await expect(collect(readChangesRange(f.store, 0, 3, 1))).rejects.toBeInstanceOf(
        ChangeRangeBootstrapRequired,
      )
      // One page is read, then its floor refuses it (POD-7589).
      expect(f.store.minChangeSeq).toHaveBeenCalledTimes(1)
      expect(f.store.changesInRange).toHaveBeenCalledTimes(1)
    }
    const f = fixture()
    await expect(collect(readChangesRange(f.store, 4, 3, 1))).rejects.toBeInstanceOf(
      ChangeRangeBootstrapRequired,
    )
    expect(await f.authority.changesSince(4, DEVICE_GRADE_PRINCIPAL)).toBeNull()
  })

  it.each([
    null,
    '{broken',
  ])('fails with a typed error for corrupt payload %s after a valid page', async (payload) => {
    const f = fixture()
    f.rows[1] = { ...row(2), payload }
    const iterator = readChangesRange(f.store, 0, 3, 1)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject([{ seq: 1 }])
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'ChangeRangeBootstrapRequired',
      reason: 'corrupt-payload',
    })
    expect(await f.authority.changesSince(0, DEVICE_GRADE_PRINCIPAL)).toBeNull()
  })

  it.each([0, -1, 1.5, Infinity])('rejects invalid page size %s', async (size) => {
    await expect(collect(readChangesRange(fixture().store, 0, 3, size))).rejects.toBeInstanceOf(
      RangeError,
    )
  })
})
