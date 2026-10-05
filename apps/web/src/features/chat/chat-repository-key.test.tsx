// @vitest-environment happy-dom
import { createChatContextReader } from '@podium/client-graph/chat-context'
import type { HeaderRows } from '@podium/client-graph/header-schema'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { measureWork } from '../../../../../packages/worklist-proto/harness/src/work-meter'
import { useChatRepositoryKey } from './use-chat-context'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const view = useMemo(() => createPoolProjection(state.pool!, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('bounds the actual always-mounted repository change hook at first use and updates at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    state.pool = pool
    const rows = Array.from(
      { length: 128 * scale },
      (_, index) =>
        ({
          path: `/repo/${index}`,
          kind: 'repository',
          branch: 'main',
          worktrees: [],
        }) as HeaderRows['repository'],
    )
    pool.header.apply(rows.map((value, index) => ({ kind: 'repository', id: `r${index}`, value })))
    const reader = createChatContextReader(pool)
    pool.sources.register(['chatContextReader'], { read: () => reader, dispose() {} })
    const row = vi.spyOn(pool, 'row')
    const measure = (action: () => void) =>
      measureWork(
        async () => {
          act(action)
          await act(async () => {})
        },
        { pool },
      )
    let view: ReturnType<typeof renderHook<string, unknown>> | undefined
    try {
      const first = await measure(() => {
        view = renderHook(() => useChatRepositoryKey())
      })
      expect(view!.result.current).toBe('1')
      const metadata = await measure(() =>
        pool.header.apply([
          { kind: 'repository', id: 'r2', value: { ...rows[2]!, branch: 'other' } },
        ]),
      )
      expect(view!.result.current).toBe('1')
      const path = await measure(() =>
        pool.header.apply([
          { kind: 'repository', id: 'r0', value: { ...rows[0]!, path: '/changed' } },
        ]),
      )
      expect(view!.result.current).toBe('2')
      const move = await measure(() =>
        pool.header.apply([
          { kind: 'repository', id: 'r0', value: undefined },
          { kind: 'repository', id: 'new-r0', value: { ...rows[0]!, path: '/changed' } },
        ]),
      )
      expect(view!.result.current).toBe('2')
      view!.unmount()
      const detached = await measure(() =>
        pool.header.apply([
          { kind: 'repository', id: 'new-r0', value: { ...rows[0]!, path: '/hidden' } },
        ]),
      )
      expect(row.mock.calls.some(([kind]) => String(kind) === 'repository')).toBe(false)
      expect(first.work.rows).toBe(1)
      expect(path.work.rows).toBe(1)
      for (const result of [metadata, move, detached]) {
        expect(result.work.rows).toBe(0)
        expect(result.work.derivations).toBe(0)
      }
      samples.push({ scale, actions: { first, metadata, path, move, detached } })
    } finally {
      view?.unmount()
      pool.dispose()
    }
  }
  expect(samples[1]!.actions).toEqual(samples[0]!.actions)
  console.log('[actual repository change hook work1x4x]', JSON.stringify(samples))
})
