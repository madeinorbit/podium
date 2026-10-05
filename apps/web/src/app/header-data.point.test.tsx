// @vitest-environment happy-dom

import type { HeaderRows } from '@podium/client-graph/header-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { MobxPool as Pool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { MachineId } from '@podium/model/browser'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePoolPanelMetric } from './header-data'

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

it('asks for only the default or named metric and suspends all closed hook demand at 1x/4x', () => {
  const samples = []
  for (const scale of [1, 4]) {
    const pool = new Pool({ selectedIssueId: null, coarseNow: 0 })
    state.pool = pool
    const rows = Array.from(
      { length: 128 * scale },
      (_, index) =>
        ({
          machineId: `m${index}` as MachineId,
          hostname: `Host ${index}`,
          sampledAt: '2026-10-05T07:00:00Z',
        }) as HeaderRows['hostMetric'],
    )
    pool.header.apply(rows.map((value, index) => ({ kind: 'hostMetric', id: `m${index}`, value })))
    pool.header.order(
      'hostMetric',
      rows.map((_, index) => `m${index}`),
    )
    const all = vi.spyOn(pool.headerViews, 'ids')
    const row = vi.spyOn(pool, 'row')
    const view = renderHook(({ id }: { id?: MachineId }) => usePoolPanelMetric(id), {
      initialProps: {},
    })
    try {
      expect(view.result.current).toBe(rows[0])
      const first = row.mock.calls.length
      row.mockClear()
      view.rerender({ id: 'm1' as MachineId })
      expect(view.result.current).toBe(rows[1])
      const addressed = row.mock.calls.length
      row.mockClear()
      act(() =>
        pool.header.apply([
          { kind: 'hostMetric', id: 'm2', value: { ...rows[2]!, hostname: 'Unrelated' } },
        ]),
      )
      expect(view.result.current).toBe(rows[1])
      expect(row).not.toHaveBeenCalled()
      const updated = { ...rows[1]!, hostname: 'Selected' }
      act(() => pool.header.apply([{ kind: 'hostMetric', id: 'm1', value: updated }]))
      expect(view.result.current).toBe(updated)
      const changed = row.mock.calls.length
      row.mockClear()
      view.rerender({ id: 'missing' as MachineId })
      expect(view.result.current).toBeUndefined()
      const missing = row.mock.calls.length
      expect(all).not.toHaveBeenCalled()
      view.unmount()
      row.mockClear()
      act(() =>
        pool.header.apply([
          {
            kind: 'hostMetric',
            id: 'missing',
            value: { ...rows[0]!, machineId: 'missing' as MachineId },
          },
        ]),
      )
      expect(row).not.toHaveBeenCalled()
      samples.push({ scale, first, addressed, changed, missing })
    } finally {
      view.unmount()
      row.mockRestore()
      all.mockRestore()
      pool.dispose()
    }
  }
  expect(samples[0]).toEqual({ scale: 1, first: 1, addressed: 1, changed: 1, missing: 1 })
  expect(samples[1]).toEqual({ ...samples[0], scale: 4 })
  console.info('[web panel metric row reads1x4x]', JSON.stringify(samples))
})
