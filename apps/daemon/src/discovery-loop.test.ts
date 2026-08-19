import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiscoveryLoop } from './discovery-loop'
import type { DiscoveryWorkerClient } from './worker-client'

const empty = { changed: [], removed: [], diagnostics: [] }

describe('discovery loop idle cadence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the configured freshness cadence after unchanged passes', async () => {
    const runJob = vi.fn(async () => empty)
    const loop = createDiscoveryLoop({
      workerClient: { runJob } as unknown as DiscoveryWorkerClient,
      send: vi.fn(),
      background: true,
      intervalMs: 100,
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runJob).toHaveBeenCalledTimes(1) // connect-time full snapshot

    await vi.advanceTimersByTimeAsync(100)
    expect(runJob).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(runJob).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(100)
    expect(runJob).toHaveBeenCalledTimes(4)
    loop.stop()
  })
})
