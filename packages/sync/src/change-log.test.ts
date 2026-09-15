import { describe, expect, it, vi } from 'vitest'
import { ChangeRangeBootstrapRequired, readChangesRange, type ChangeLogStore } from './change-log'
import type { ChangeLogReadRow } from './authority/change-lifecycle'
import { Authority } from './authority/authority'
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
    latestChangeStates: async () => [],
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
    expect(f.store.minChangeSeq).toHaveBeenCalledTimes(1)
    expect(f.store.changesInRange).toHaveBeenCalledTimes(3)
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

  it('checks retention once and rejects pruned, empty retained, and future ranges', async () => {
    for (const rows of [[], [row(3)]]) {
      const f = fixture()
      f.rows.splice(0, f.rows.length, ...rows)
      await expect(collect(readChangesRange(f.store, 0, 3, 1))).rejects.toBeInstanceOf(
        ChangeRangeBootstrapRequired,
      )
      expect(f.store.minChangeSeq).toHaveBeenCalledTimes(1)
      expect(f.store.changesInRange).not.toHaveBeenCalled()
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
