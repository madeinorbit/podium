import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSharedStatTick } from './stat-tick'

afterEach(() => {
  vi.useRealTimers()
})

describe('shared stat tick', () => {
  it('fans every watcher out from one 700ms interval and stops it with the last watcher', () => {
    vi.useFakeTimers()
    const tick = createSharedStatTick()
    const first = vi.fn()
    const second = vi.fn()

    const stopFirst = tick.subscribe(first)
    const stopSecond = tick.subscribe(second)

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(699)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    stopFirst()
    expect(vi.getTimerCount()).toBe(1)
    stopSecond()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses a snapshot so watcher removal does not skip the rest of a batch', () => {
    vi.useFakeTimers()
    const tick = createSharedStatTick()
    const calls: string[] = []
    let stopSecond = (): void => {}
    tick.subscribe(() => {
      calls.push('first')
      stopSecond()
    })
    stopSecond = tick.subscribe(() => calls.push('second'))

    vi.advanceTimersByTime(700)

    expect(calls).toEqual(['first', 'second'])
  })
})
