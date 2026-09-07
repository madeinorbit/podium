import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionBroadcastCoordinator } from './broadcast'

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionBroadcastCoordinator sliced publication [POD-2322]', () => {
  it('drains one slice per scheduled turn and re-arms instead of recursing', async () => {
    let remaining = 80
    const turns: Array<() => Promise<void>> = []
    const drainVolatileSlice = vi.fn(async () => {
      remaining = Math.max(0, remaining - 32)
      return { remaining }
    })
    const flushDeltas = vi.fn()
    let coordinator: SessionBroadcastCoordinator
    coordinator = new SessionBroadcastCoordinator({
      hasPendingVolatile: () => remaining > 0,
      scheduleVolatileCapture: () => turns.push(() => coordinator.runScheduled()),
      drainVolatileSlice,
      flushVolatileCaptures: vi.fn(async () => {
        remaining = 0
      }),
      flushDeltas,
    })

    coordinator.broadcast()
    expect(drainVolatileSlice).not.toHaveBeenCalled()
    expect(turns).toHaveLength(1)

    await turns.shift()!()
    expect(drainVolatileSlice).toHaveBeenCalledTimes(1)
    expect(remaining).toBe(48)
    expect(turns).toHaveLength(1)
    expect(flushDeltas).toHaveBeenCalledTimes(1)

    await turns.shift()!()
    expect(drainVolatileSlice).toHaveBeenCalledTimes(2)
    expect(remaining).toBe(16)
    expect(turns).toHaveLength(1)
    expect(flushDeltas).toHaveBeenCalledTimes(2)
  })

  it('flush remains a full-drain barrier', async () => {
    vi.useFakeTimers()
    let remaining = 80
    const drainVolatileSlice = vi.fn(async () => ({ remaining }))
    const flushVolatileCaptures = vi.fn(async () => {
      remaining = 0
    })
    const flushDeltas = vi.fn()
    const coordinator = new SessionBroadcastCoordinator({
      hasPendingVolatile: () => remaining > 0,
      scheduleVolatileCapture: vi.fn(),
      drainVolatileSlice,
      flushVolatileCaptures,
      flushDeltas,
    })

    await coordinator.flush()

    expect(flushVolatileCaptures).toHaveBeenCalledTimes(1)
    expect(drainVolatileSlice).not.toHaveBeenCalled()
    expect(remaining).toBe(0)
    expect(flushDeltas).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight slice before the explicit drain and propagates its failure', async () => {
    let finish!: (value: { remaining: number }) => void
    const slice = new Promise<{ remaining: number }>((resolve) => { finish = resolve })
    const failure = new Error('capture failed')
    const flushVolatileCaptures = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue([])
    const flushDeltas = vi.fn()
    const coordinator = new SessionBroadcastCoordinator({
      hasPendingVolatile: () => true,
      scheduleVolatileCapture: vi.fn(),
      drainVolatileSlice: () => slice,
      flushVolatileCaptures,
      flushDeltas,
    })
    const scheduled = coordinator.runScheduled()
    const failed = expect(coordinator.flush()).rejects.toThrow('capture failed')
    expect(flushVolatileCaptures).not.toHaveBeenCalled()
    expect(flushDeltas).not.toHaveBeenCalled()
    finish({ remaining: 0 })
    await scheduled
    await failed
    expect(flushVolatileCaptures).toHaveBeenCalledTimes(1)
    expect(flushDeltas).toHaveBeenCalledTimes(1)
    await coordinator.flush()
    expect(flushVolatileCaptures).toHaveBeenCalledTimes(2)
    expect(flushDeltas).toHaveBeenCalledTimes(2)
  })

})
