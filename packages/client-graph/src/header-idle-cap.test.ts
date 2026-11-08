import type { HostMetricsWire, MachineId, MachineWire } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { liveFixture } from './live-fixture'
import { MobxPool } from './pool'

/**
 * The fleet's unmet idle cap is a sum over LIVE samples (POD-5798): each fleet
 * machine's `metrics` field reads the LiveStore, and the header total is one
 * memo over those fields. Samples are never rows, so a change reads no rows.
 */
function fleet(pool: MobxPool, count: number): MachineId[] {
  const ids = Array.from({ length: count }, (_, index) => `m${index}` as MachineId)
  runInAction(() => {
    headerEntities(pool).apply(
      ids.map((id) => ({
        kind: 'machine' as const,
        id,
        value: {
          id,
          name: id,
          hostname: id,
          online: true,
          lastSeenAt: '2026-10-05T07:00:00Z',
        } as MachineWire,
      })),
    )
    headerEntities(pool).order('machine', ids)
  })
  return ids
}

const sample = (id: string, idleCapUnmet?: number, hostname = `Host ${id}`) =>
  ({
    machineId: id as MachineId,
    hostname,
    sampledAt: '2026-10-05T07:00:00Z',
    idleCapUnmet,
  }) as HostMetricsWire

it('maintains the fleet idle cap from live samples at 1x/4x, with no row reads per change', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const live = liveFixture(pool)
    const ids = fleet(pool, 32 * scale)
    for (const [index, id] of ids.entries()) live.metric(id, sample(id, index === 0 ? 2 : 0))
    const measure = (action: () => void) =>
      measureWork(async () => insideReader('hibernation cap scalar', () => runInAction(action)), {
        pool,
      })
    let value = -1,
      paints = 0,
      stop = () => {}
    try {
      await measure(() => {
        stop = autorun(() => {
          value = headerView(pool).idleCapUnmetCount()
          paints++
        })
      })
      expect(value).toBe(2)
      const before = paints
      const unchanged = await measure(() => live.metric('m2', sample('m2', 0, 'Unrelated sample')))
      expect(paints).toBe(before)
      const changed = await measure(() => live.metric('m0', sample('m0', 4)))
      expect(value).toBe(4)
      expect(paints).toBe(before + 1)
      const removed = await measure(() => live.metric('m0', undefined))
      expect(value).toBe(0)
      const returned = await measure(() => live.metric('m0', sample('m0', 2)))
      expect(value).toBe(2)
      const noCount = await measure(() => live.metric('m0', sample('m0')))
      expect(value).toBe(0)
      const actions = { unchanged, changed, removed, returned, noCount }
      for (const result of Object.values(actions)) expect(result.work.rows).toBe(0)
      samples.push({ scale, actions })
    } finally {
      stop()
      pool.dispose()
    }
  }
  // Rows read per change stay zero at both scales. The total re-sums one
  // field per fleet machine (guide rule 5), so its element count grows with
  // the fleet; that is the design, not a regression.
  for (const sample of samples)
    for (const result of Object.values(sample.actions)) expect(result.work.rows).toBe(0)
})

it('counts only fleet machines, and an unknown sample counts as none', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const live = liveFixture(pool)
  try {
    fleet(pool, 3)
    live.metric('m0', sample('m0', 2))
    live.metric('m1', sample('m1', 3))
    live.metric('m2', sample('m2'))
    // A sample for a machine outside the fleet is not part of the total.
    live.metric('stranger', sample('stranger', 7))
    expect(headerView(pool).idleCapUnmetCount()).toBe(5)
    const values: number[] = []
    const stop = autorun(() => values.push(headerView(pool).idleCapUnmetCount()))
    try {
      live.metric('m0', undefined)
      live.metric('m1', sample('m1', 4))
      expect(values).toEqual([5, 3, 4])
      live.metric('missing', undefined)
      expect(values).toEqual([5, 3, 4])
      // The connection was declared lost: no current sample anywhere.
      runInAction(() => live.live.markAllUnknown(1))
      expect(values).toEqual([5, 3, 4, 0])
    } finally {
      stop()
    }
  } finally {
    pool.dispose()
  }
})
