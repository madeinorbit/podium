import { headerEntities } from '@podium/client-graph/header-entities'
import { headerView } from '@podium/client-graph/header-views'
import '@podium/client-graph/synced-models'
import { liveFixture, seedFixtureMachines } from '@podium/client-graph/live-fixture'
// @vitest-environment happy-dom

import type { MobxPool } from '@podium/client-graph/pool'
import { MobxPool as Pool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { HostMetricsWire, MachineId } from '@podium/model/browser'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePoolOfflineMachines, usePoolPanelMetric } from './header-data'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('./store-worklist-pool', () => ({
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const view = useMemo(() => createPoolProjection(state.pool!, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('the actual offline indicator hook reads only displayed machines and releases hidden rows at 1x/4x', () => {
  const samples = []
  const now = Date.parse('2026-10-05T12:00:00Z'),
    week = 7 * 86_400_000
  for (const scale of [1, 4]) {
    const pool = new Pool({ selectedIssueId: null, coarseNow: now })
    state.pool = pool
    // A machine as the app receives it (POD-6644): its record (with my access
    // row) in the pool, its presence on the LiveStore.
    const machine = (id: string, online: boolean, seen: number) => ({
      id: id as MachineId,
      name: id,
      hostname: id,
      online,
      lastSeenAt: new Date(seen).toISOString(),
    })
    const place = (values: ReturnType<typeof machine>[]) =>
      headerEntities(pool).apply(seedFixtureMachines(pool, values) as never)
    const names = (answer: readonly { name: string }[]) => answer.map((value) => value.name)
    const online = Array.from({ length: 128 * scale }, (_, at) =>
      machine(`online-${at}`, true, now),
    )
    const history = Array.from({ length: 128 * scale }, (_, at) =>
      machine(`history-${at}`, false, now - 2 * week),
    )
    const target = machine('target', false, now - week + 1000)
    place([...online, ...history])
    const row = vi.spyOn(pool, 'row'),
      all = vi.spyOn(headerView(pool), 'ids')
    const view = renderHook(() => usePoolOfflineMachines())
    try {
      expect(view.result.current).toEqual([])
      expect(row).not.toHaveBeenCalled()
      act(() => place([target]))
      expect(names(view.result.current)).toEqual(['target'])
      const first = row.mock.calls.length
      // Only the displayed machine's row is read.
      expect(row.mock.calls.every(([kind, id]) => kind === 'machine' && id === 'target')).toBe(true)
      row.mockClear()
      act(() => place([{ ...history[17]!, name: 'Changed history' }]))
      expect(row).not.toHaveBeenCalled()
      act(() => pool.clock.advance(now + 1001))
      expect(view.result.current).toEqual([])
      expect(row).not.toHaveBeenCalled()
      act(() => place([{ ...target, name: 'Expired target' }]))
      expect(row).not.toHaveBeenCalled()
      act(() => pool.clock.advance(now))
      expect(names(view.result.current)).toEqual(['Expired target'])
      const restored = row.mock.calls.length
      expect(row.mock.calls.every(([kind, id]) => kind === 'machine' && id === 'target')).toBe(true)
      expect(all).not.toHaveBeenCalled()
      view.unmount()
      row.mockClear()
      act(() => {
        place([target])
        pool.clock.advance(now + 2000)
      })
      expect(row).not.toHaveBeenCalled()
      samples.push({ scale, first, restored })
    } finally {
      view.unmount()
      row.mockRestore()
      all.mockRestore()
      pool.dispose()
    }
  }
  expect(samples[1]).toEqual({ ...samples[0], scale: 4 })
  console.info('[actual offline indicator hook row reads1x4x]', JSON.stringify(samples))
})

it('asks for only the default or named live metric and releases closed hook demand at 1x/4x', () => {
  const samples = []
  for (const scale of [1, 4]) {
    const pool = new Pool({ selectedIssueId: null, coarseNow: 0 })
    state.pool = pool
    // POD-5798: samples are LiveStore readings, read through the machine model.
    const live = liveFixture(pool)
    const ids = Array.from({ length: 128 * scale }, (_, index) => `m${index}` as MachineId)
    const rows = ids.map(
      (id, index) =>
        ({
          machineId: id,
          hostname: `Host ${index}`,
          sampledAt: '2026-10-05T07:00:00Z',
        }) as HostMetricsWire,
    )
    // My fleet: machine records with my access row (POD-6644).
    act(() => {
      headerEntities(pool).apply(
        seedFixtureMachines(
          pool,
          ids.map((id) => ({ id, name: id, hostname: id, online: true, lastSeenAt: '2026-10-05T07:00:00Z' })),
        ) as never,
      )
      headerEntities(pool).order('machine', ids)
    })
    for (const [index, id] of ids.entries()) live.metric(id, rows[index])
    const row = vi.spyOn(pool, 'row')
    const view = renderHook(({ id }: { id?: MachineId }) => usePoolPanelMetric(id), {
      initialProps: {},
    })
    try {
      expect(view.result.current).toBe(rows[0])
      expect(live.live.watchedMetrics).toEqual(['m0'])
      const first = row.mock.calls.length
      row.mockClear()
      view.rerender({ id: 'm1' as MachineId })
      expect(view.result.current).toBe(rows[1])
      expect(live.live.watchedMetrics).toEqual(['m1'])
      const addressed = row.mock.calls.length
      row.mockClear()
      act(() => live.metric('m2', { ...rows[2]!, hostname: 'Unrelated' }))
      expect(view.result.current).toBe(rows[1])
      expect(row).not.toHaveBeenCalled()
      const updated = { ...rows[1]!, hostname: 'Selected' }
      act(() => live.metric('m1', updated))
      expect(view.result.current).toBe(updated)
      const changed = row.mock.calls.length
      row.mockClear()
      view.rerender({ id: 'missing' as MachineId })
      expect(view.result.current).toBeUndefined()
      const missing = row.mock.calls.length
      view.unmount()
      expect(live.live.watchedMetrics).toEqual([])
      row.mockClear()
      act(() => live.metric('missing', { ...rows[0]!, machineId: 'missing' as MachineId }))
      expect(row).not.toHaveBeenCalled()
      samples.push({ scale, first, addressed, changed, missing })
    } finally {
      view.unmount()
      row.mockRestore()
      pool.dispose()
    }
  }
  expect(samples[1]).toEqual({ ...samples[0], scale: 4 })
  console.info('[web panel metric row reads1x4x]', JSON.stringify(samples))
})
