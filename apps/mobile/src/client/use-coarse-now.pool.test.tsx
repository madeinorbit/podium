import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, screen } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { measureWork } from '../../../../packages/worklist-proto/harness/src/work-meter'
import { useCoarseNow } from './hooks'
import { renderWithMobileStore } from './test-support'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('./mobile-pool', async (original) => ({
  ...(await original<typeof import('./mobile-pool')>()),
  useMobilePoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const projection = useMemo(() => createPoolProjection(state.pool!, read), [read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  vi.restoreAllMocks()
})

it('paints forward ticks and rewinds of the shared pool clock without reading rows', async () => {
  const now = Date.parse('2026-10-03T08:00:00Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  state.pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  function Clock() {
    return <span data-testid="phone-clock">{useCoarseNow()}</span>
  }
  const pool = state.pool
  const ids = vi.spyOn(pool.queries, 'ids')
  const samples = []
  const startup = await measureWork(
    () => renderWithMobileStore(<Clock />, { attachRuntime: () => () => {} }),
    { pool },
  )
  expect(screen.getByTestId('phone-clock').textContent).toBe(String(now))
  expect(startup.work.rows).toBe(0)
  samples.push(startup.work)
  for (const next of [now + 60_000, now + 120_000, now - 60_000]) {
    const tick = await measureWork(
      async () => {
        act(() =>
          pool.applyLocals({ selectedIssueId: null, coarseNow: next }, new Set(['coarseNow'])),
        )
      },
      { pool },
    )
    expect(screen.getByTestId('phone-clock').textContent).toBe(String(next))
    expect(tick.work.rows).toBe(0)
    samples.push(tick.work)
  }
  expect(ids).not.toHaveBeenCalled()
  console.info('[phone clock pool work]', JSON.stringify(samples))
})
