import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTrailingWriter } from './trailing-writer'

describe('createTrailingWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the latest value once after the delay', () => {
    const writes: number[] = []
    const writer = createTrailingWriter<number>((v) => writes.push(v), 1000)
    writer.schedule(1)
    writer.schedule(2)
    writer.schedule(3)
    expect(writes).toEqual([])
    vi.advanceTimersByTime(999)
    expect(writes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(writes).toEqual([3])
  })

  it('does not starve under a steady stream: at most one write per delay, latest value', () => {
    const writes: number[] = []
    const writer = createTrailingWriter<number>((v) => writes.push(v), 1000)
    // A delta every 100ms for 3s — a debounce that re-arms per call would
    // never write; the trailing throttle writes ~once per second.
    for (let t = 0; t < 30; t++) {
      writer.schedule(t)
      vi.advanceTimersByTime(100)
    }
    expect(writes.length).toBe(3)
    // Each write carried the newest value at fire time, in order.
    expect(writes).toEqual([9, 19, 29])
  })

  it('flush writes the pending value immediately and disarms the timer', () => {
    const writes: number[] = []
    const writer = createTrailingWriter<number>((v) => writes.push(v), 1000)
    writer.schedule(7)
    writer.flush()
    expect(writes).toEqual([7])
    // The timer must not fire a second, duplicate write.
    vi.advanceTimersByTime(5000)
    expect(writes).toEqual([7])
  })

  it('flush with nothing pending writes nothing', () => {
    const writes: number[] = []
    const writer = createTrailingWriter<number>((v) => writes.push(v), 1000)
    writer.flush()
    expect(writes).toEqual([])
    // After a fire, a second flush is also a no-op.
    writer.schedule(1)
    vi.advanceTimersByTime(1000)
    writer.flush()
    expect(writes).toEqual([1])
  })

  it('cancel drops the pending value without writing', () => {
    const writes: number[] = []
    const writer = createTrailingWriter<number>((v) => writes.push(v), 1000)
    writer.schedule(5)
    writer.cancel()
    vi.advanceTimersByTime(5000)
    writer.flush()
    expect(writes).toEqual([])
  })

  it('re-arms cleanly after a fire', () => {
    const writes: number[] = []
    const writer = createTrailingWriter<number>((v) => writes.push(v), 1000)
    writer.schedule(1)
    vi.advanceTimersByTime(1000)
    writer.schedule(2)
    vi.advanceTimersByTime(1000)
    expect(writes).toEqual([1, 2])
  })
})
