import type { ConversationSummaryWire } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiscoveryLoop } from './discovery-loop'
import type { DiscoveryWorkerClient } from './worker-client'

const empty = { changed: [], removed: [], diagnostics: [] }

describe('discovery loop idle cadence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('backs whole-corpus scans off after unchanged passes', async () => {
    const runJob = vi.fn(async () => empty)
    const loop = createDiscoveryLoop({
      workerClient: { runJob } as unknown as DiscoveryWorkerClient,
      send: vi.fn(),
      background: true,
      intervalMs: 100,
      maxIntervalMs: 400,
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runJob).toHaveBeenCalledTimes(1) // connect-time full snapshot

    await vi.advanceTimersByTimeAsync(100)
    expect(runJob).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(runJob).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(runJob).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(399)
    expect(runJob).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(runJob).toHaveBeenCalledTimes(4)
    loop.stop()
  })

  it('returns to the fast cadence when a safety-net scan finds a change', async () => {
    const changed = {
      changed: [{ id: 'external' } as ConversationSummaryWire],
      removed: [],
      diagnostics: [],
    }
    const runJob = vi
      .fn<() => Promise<typeof empty | typeof changed>>()
      .mockResolvedValueOnce(empty) // connect-time snapshot
      .mockResolvedValueOnce(empty) // first periodic pass: back off to 200 ms
      .mockResolvedValueOnce(changed) // external conversation: reset to 100 ms
      .mockResolvedValue(empty)
    const loop = createDiscoveryLoop({
      workerClient: { runJob } as unknown as DiscoveryWorkerClient,
      send: vi.fn(),
      background: true,
      intervalMs: 100,
      maxIntervalMs: 400,
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(runJob).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(99)
    expect(runJob).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(runJob).toHaveBeenCalledTimes(4)
    loop.stop()
  })
})
