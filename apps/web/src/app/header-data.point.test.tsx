// @vitest-environment happy-dom

import type { HeaderRows } from '@podium/client-graph/header-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { MobxPool as Pool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { MachineId } from '@podium/model/browser'
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
    const machine = (id: string, online: boolean, seen: number): HeaderRows['machine'] => ({
      id: id as MachineId,
      name: id,
      hostname: id,
      online,
      lastSeenAt: new Date(seen).toISOString(),
    })
    const online = Array.from({ length: 128 * scale }, (_, at) =>
      machine(`online-${at}`, true, now),
    )
    const history = Array.from({ length: 128 * scale }, (_, at) =>
      machine(`history-${at}`, false, now - 2 * week),
    )
    const target = machine('target', false, now - week + 1000)
    pool.header.apply(
      [...online, ...history].map((value) => ({ kind: 'machine', id: value.id, value })),
    )
    const row = vi.spyOn(pool, 'row'),
      all = vi.spyOn(pool.headerViews, 'ids')
    const view = renderHook(() => usePoolOfflineMachines())
    try {
      expect(view.result.current).toEqual([])
      expect(row).not.toHaveBeenCalled()
      act(() => pool.header.apply([{ kind: 'machine', id: 'target', value: target }]))
      expect(view.result.current).toEqual([target])
      const first = row.mock.calls.length
      expect(row.mock.calls).toEqual([['machine', 'target']])
      row.mockClear()
      act(() =>
        pool.header.apply([
          {
            kind: 'machine',
            id: history[17]!.id,
            value: { ...history[17]!, name: 'Changed history' },
          },
        ]),
      )
      expect(row).not.toHaveBeenCalled()
      act(() => pool.clock.advance(now + 1001))
      expect(view.result.current).toEqual([])
      expect(row).not.toHaveBeenCalled()
      act(() =>
        pool.header.apply([
          { kind: 'machine', id: 'target', value: { ...target, name: 'Expired target' } },
        ]),
      )
      expect(row).not.toHaveBeenCalled()
      act(() => pool.clock.advance(now))
      expect(view.result.current.map((value) => value.name)).toEqual(['Expired target'])
      const restored = row.mock.calls.length
      expect(row.mock.calls).toEqual([['machine', 'target']])
      expect(all).not.toHaveBeenCalled()
      view.unmount()
      row.mockClear()
      act(() => {
        pool.header.apply([{ kind: 'machine', id: 'target', value: target }])
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
