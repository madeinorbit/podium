// @vitest-environment happy-dom
import { type LiveFixture, liveFixture } from '@podium/client-graph/live-fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUsageCache, useUsageFeed } from './useUsageFeed'

const pooled = vi.hoisted(() => ({
  pool: null as unknown as import('@podium/client-graph/pool').MobxPool,
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const view = useMemo(() => createPoolProjection(pooled.pool, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))

const FIRST = '2026-08-21T06:00:00.000Z'
const SECOND = '2026-08-21T06:03:00.000Z'

/** POD-5798: usage is pushed on account.quota and read from the LiveStore. */
describe('useUsageFeed', () => {
  let live: LiveFixture
  const push = (sampledAt: string | null) =>
    act(() => live.usage(sampledAt === null ? null : { hostname: 'test', sampledAt, buckets: [] }))

  beforeEach(() => {
    resetUsageCache()
    pooled.pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    live = liveFixture(pooled.pool)
  })

  afterEach(() => {
    cleanup()
    pooled.pool.dispose()
    resetUsageCache()
  })

  it('is cold and waiting until the first reading, with no request made', () => {
    const { result } = renderHook(() => useUsageFeed())
    expect(result.current).toMatchObject({ buckets: null, failed: false, waiting: true })
    expect(result.current.scans).toEqual([])
  })

  it('reports an answer without usage as failed, and recovers on the next push', () => {
    const { result } = renderHook(() => useUsageFeed())
    push(null)
    expect(result.current).toMatchObject({ buckets: null, failed: true, waiting: false })
    push(FIRST)
    expect(result.current).toMatchObject({ buckets: [], failed: false })
  })

  it('keeps the last reading when the connection is lost, and says it is not current', () => {
    const { result } = renderHook(() => useUsageFeed())
    push(FIRST)
    act(() => live.live.markAllUnknown(Date.parse(SECOND)))
    expect(result.current).toMatchObject({ buckets: [], failed: true, waiting: false })
    expect(result.current.fetchedAt).toBe(Date.parse(SECOND))
  })

  it('advances the scan history only when the daemon returns a fresh scan', () => {
    const { result } = renderHook(() => useUsageFeed())
    push(FIRST)
    expect(result.current.scans.map((scan) => scan.sampledAt)).toEqual([Date.parse(FIRST)])
    push(FIRST)
    expect(result.current.scans.map((scan) => scan.sampledAt)).toEqual([Date.parse(FIRST)])
    push(SECOND)
    expect(result.current.scans.map((scan) => scan.sampledAt)).toEqual([
      Date.parse(FIRST),
      Date.parse(SECOND),
    ])
  })
})
