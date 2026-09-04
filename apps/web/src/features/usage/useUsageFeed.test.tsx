// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { resetUsageCache, useUsageFeed } from './useUsageFeed'

const FIRST = '2026-08-21T06:00:00.000Z'
const SECOND = '2026-08-21T06:03:00.000Z'

describe('useUsageFeed scan history', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetUsageCache()
  })

  afterEach(() => {
    cleanup()
    resetUsageCache()
    vi.useRealTimers()
  })

  it('advances only when the daemon returns a fresh scan', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ hostname: 'test', sampledAt: FIRST, buckets: [] })
      .mockResolvedValueOnce({ hostname: 'test', sampledAt: FIRST, buckets: [] })
      .mockResolvedValueOnce({ hostname: 'test', sampledAt: SECOND, buckets: [] })
    const trpc = { usage: { summary: { query } } } as unknown as Trpc
    const { result } = renderHook(() => useUsageFeed(trpc))

    await act(async () => {})
    expect(result.current.scans.map((scan) => scan.sampledAt)).toEqual([Date.parse(FIRST)])

    await act(() => vi.advanceTimersByTimeAsync(90_000))
    expect(result.current.scans.map((scan) => scan.sampledAt)).toEqual([Date.parse(FIRST)])

    await act(() => vi.advanceTimersByTimeAsync(90_000))
    expect(result.current.scans.map((scan) => scan.sampledAt)).toEqual([
      Date.parse(FIRST),
      Date.parse(SECOND),
    ])
  })
})
