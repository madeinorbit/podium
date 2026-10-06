import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import type { MachineId } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import type { HeaderRows } from './header-schema'
import { MobxPool } from './pool'

it('maintains the fleet idle cap scalar with flat first-use and per-host update work at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const metrics = Array.from(
      { length: 128 * scale },
      (_, index) =>
        ({
          machineId: `m${index}` as MachineId,
          hostname: `Host ${index}`,
          sampledAt: '2026-10-05T07:00:00Z',
          idleCapUnmet: index === 0 ? 2 : 0,
        }) as HeaderRows['hostMetric'],
    )
    headerEntities(pool).apply(
      metrics.map((value, index) => ({ kind: 'hostMetric', id: `m${index}`, value })),
    )
    const measure = (action: () => void) =>
      measureWork(async () => insideReader('hibernation cap scalar', () => runInAction(action)), {
        pool,
      })
    let value = -1,
      paints = 0,
      stop = () => {}
    try {
      const first = await measure(() => {
        stop = autorun(() => {
          value = headerView(pool).idleCapUnmetCount()
          paints++
        })
      })
      expect(value).toBe(2)
      const repeat = await measure(() => {
        expect(headerView(pool).idleCapUnmetCount()).toBe(2)
      })
      const before = paints
      const unchanged = await measure(() =>
        headerEntities(pool).apply([
          { kind: 'hostMetric', id: 'm2', value: { ...metrics[2]!, hostname: 'Unrelated sample' } },
        ]),
      )
      expect(paints).toBe(before)
      const changed = await measure(() =>
        headerEntities(pool).apply([
          { kind: 'hostMetric', id: 'm0', value: { ...metrics[0]!, idleCapUnmet: 4 } },
        ]),
      )
      expect(value).toBe(4)
      expect(paints).toBe(before + 1)
      const removed = await measure(() =>
        headerEntities(pool).apply([{ kind: 'hostMetric', id: 'm0', value: undefined }]),
      )
      expect(value).toBe(0)
      const returned = await measure(() =>
        headerEntities(pool).apply([{ kind: 'hostMetric', id: 'm0', value: metrics[0] }]),
      )
      expect(value).toBe(2)
      const noCount = await measure(() =>
        headerEntities(pool).apply([
          { kind: 'hostMetric', id: 'm0', value: { ...metrics[0]!, idleCapUnmet: undefined } },
        ]),
      )
      expect(value).toBe(0)
      stop()
      const closed = await measure(() =>
        headerEntities(pool).apply([{ kind: 'hostMetric', id: 'm0', value: metrics[0] }]),
      )
      const reopen = await measure(() => {
        expect(headerView(pool).idleCapUnmetCount()).toBe(2)
      })
      const control = await measure(() => {
        expect(
          headerView(pool).metrics().reduce((sum, host) => sum + (host.idleCapUnmet ?? 0), 0),
        ).toBe(2)
      })
      expect(control.work.rows).toBe(128 * scale)
      const actions = {
        first,
        repeat,
        unchanged,
        changed,
        removed,
        returned,
        noCount,
        closed,
        reopen,
      }
      for (const result of Object.values(actions)) expect(result.work.rows).toBe(0)
      samples.push({ scale, actions, control })
      runInAction(() => headerEntities(pool).clear())
      expect(headerView(pool).idleCapUnmetCount()).toBe(0)
    } finally {
      stop()
      pool.dispose()
    }
  }
  expect(samples[1]!.actions).toEqual(samples[0]!.actions)
  expect(samples[1]!.control.work.rows).toBe(samples[0]!.control.work.rows! * 4)
  console.log('[hibernation idle cap work1x4x]', JSON.stringify(samples))
})

it('keeps replacement, missing samples, repeated IDs and atomic contribution moves correct', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const metric = (count?: number) =>
    ({ hostname: 'host', idleCapUnmet: count }) as HeaderRows['hostMetric']
  try {
    headerEntities(pool).apply([
      { kind: 'hostMetric', id: 'a', value: metric(2) },
      { kind: 'hostMetric', id: 'b', value: metric(3) },
      { kind: 'hostMetric', id: 'no-count', value: metric() },
    ])
    expect(headerView(pool).idleCapUnmetCount()).toBe(5)
    const values: number[] = []
    const stop = autorun(() => values.push(headerView(pool).idleCapUnmetCount()))
    try {
      headerEntities(pool).apply([
        { kind: 'hostMetric', id: 'a', value: undefined },
        { kind: 'hostMetric', id: 'new-a', value: metric(2) },
        { kind: 'hostMetric', id: 'b', value: metric(1) },
        { kind: 'hostMetric', id: 'b', value: metric(4) },
      ])
      expect(values).toEqual([5, 6])
      headerEntities(pool).apply([{ kind: 'hostMetric', id: 'missing', value: undefined }])
      expect(values).toEqual([5, 6])
      runInAction(() => headerEntities(pool).clear())
      expect(values).toEqual([5, 6, 0])
    } finally {
      stop()
    }
  } finally {
    pool.dispose()
  }
})
