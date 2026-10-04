import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, screen } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCoarseNow } from './hooks'
import { renderWithMobileStore } from './test-support'
import type { MobileTrpc } from './trpc'

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
  storeStats.enable(false)
  storeStats.reset()
  vi.restoreAllMocks()
})

it('paints forward ticks and rewinds of the shared pool clock with zero legacy selectors', async () => {
  const now = Date.parse('2026-10-03T08:00:00Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  state.pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  let runtime!: ClientRuntime<MobileTrpc>
  function Clock() {
    runtime = useStoreHandle<MobileTrpc>() as ClientRuntime<MobileTrpc>
    return <span data-testid="phone-clock">{useCoarseNow()}</span>
  }
  storeStats.enable()
  storeStats.reset()
  await renderWithMobileStore(<Clock />, { attachRuntime: () => () => {} })
  expect(screen.getByTestId('phone-clock').textContent).toBe(String(now))
  console.info(
    '[phone clock reader]',
    JSON.stringify({
      selectorRuns: readRuntimeStoreStats(runtime)?.selectorRuns,
      rowBuilds: readRuntimeStoreStats(runtime)?.rowBuilds,
    }),
  )
  for (const next of [now + 60_000, now + 120_000, now - 60_000]) {
    act(() =>
      state.pool!.applyLocals({ selectedIssueId: null, coarseNow: next }, new Set(['coarseNow'])),
    )
    expect(screen.getByTestId('phone-clock').textContent).toBe(String(next))
  }
  expect(readRuntimeStoreStats(runtime)?.selectorRuns).toBe(0)
  expect(readRuntimeStoreStats(runtime)?.rowBuilds).toBe(0)
})
