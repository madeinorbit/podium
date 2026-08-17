import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionBroadcastCoordinator } from './broadcast'

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionBroadcastCoordinator sliced publication [POD-2322]', () => {
  it('drains one slice per scheduled turn and re-arms instead of recursing', () => {
    let remaining = 80
    const turns: Array<() => void> = []
    const drainVolatileSlice = vi.fn(() => {
      remaining = Math.max(0, remaining - 32)
      return { remaining }
    })
    const flushDeltas = vi.fn()
    let coordinator: SessionBroadcastCoordinator
    coordinator = new SessionBroadcastCoordinator({
      hasPendingVolatile: () => remaining > 0,
      scheduleVolatileCapture: () => turns.push(() => coordinator.runScheduled()),
      drainVolatileSlice,
      flushVolatileCaptures: vi.fn(() => {
        remaining = 0
      }),
      flushDeltas,
    })

    coordinator.broadcast()
    expect(drainVolatileSlice).not.toHaveBeenCalled()
    expect(turns).toHaveLength(1)

    turns.shift()!()
    expect(drainVolatileSlice).toHaveBeenCalledTimes(1)
    expect(remaining).toBe(48)
    expect(turns).toHaveLength(1)
    expect(flushDeltas).toHaveBeenCalledTimes(1)

    turns.shift()!()
    expect(drainVolatileSlice).toHaveBeenCalledTimes(2)
    expect(remaining).toBe(16)
    expect(turns).toHaveLength(1)
    expect(flushDeltas).toHaveBeenCalledTimes(2)
  })

  it('flush remains a synchronous full-drain barrier', () => {
    vi.useFakeTimers()
    let remaining = 80
    const drainVolatileSlice = vi.fn(() => ({ remaining }))
    const flushVolatileCaptures = vi.fn(() => {
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

    coordinator.flush()

    expect(flushVolatileCaptures).toHaveBeenCalledTimes(1)
    expect(drainVolatileSlice).not.toHaveBeenCalled()
    expect(remaining).toBe(0)
    expect(flushDeltas).toHaveBeenCalledTimes(1)
  })
})
