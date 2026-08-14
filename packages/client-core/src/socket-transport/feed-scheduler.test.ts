import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeedTaskScheduler } from './feed-scheduler'

/**
 * A real macrotask turn, taken through a channel of the test's own — so it keeps
 * working with every timer frozen, which is exactly the condition these tests
 * put the scheduler under. Captured before any stubbing, because one test takes
 * `MessageChannel` away from the platform.
 */
const RealMessageChannel = globalThis.MessageChannel

function macrotaskTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new RealMessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(0)
  })
}

/** Enough turns for the scheduler to have run `count` tasks, plus slack. */
async function macrotaskTurns(count: number): Promise<void> {
  for (let i = 0; i < count + 1; i += 1) await macrotaskTurn()
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createFeedTaskScheduler', () => {
  it('runs a scheduled task with every timer frozen', async () => {
    vi.useFakeTimers()
    const scheduler = createFeedTaskScheduler()
    const ran: string[] = []

    scheduler.schedule(() => ran.push('a'))
    expect(ran).toEqual([])

    await macrotaskTurns(1)

    expect(ran).toEqual(['a'])
    scheduler.dispose()
  })

  it('runs one task per turn, in the order they were scheduled', async () => {
    vi.useFakeTimers()
    const scheduler = createFeedTaskScheduler()
    const ran: string[] = []

    scheduler.schedule(() => ran.push('a'))
    scheduler.schedule(() => ran.push('b'))
    scheduler.schedule(() => ran.push('c'))
    await macrotaskTurns(3)

    expect(ran).toEqual(['a', 'b', 'c'])
    scheduler.dispose()
  })

  it('falls back to a timer where the platform has no MessageChannel', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('MessageChannel', undefined)
    const scheduler = createFeedTaskScheduler()
    const ran: string[] = []

    scheduler.schedule(() => ran.push('a'))
    await macrotaskTurns(1)
    expect(ran).toEqual([])

    vi.advanceTimersByTime(0)

    expect(ran).toEqual(['a'])
    scheduler.dispose()
  })

  it('drops pending tasks once disposed', async () => {
    vi.useFakeTimers()
    const scheduler = createFeedTaskScheduler()
    const ran: string[] = []

    scheduler.schedule(() => ran.push('a'))
    scheduler.dispose()
    await macrotaskTurns(1)

    expect(ran).toEqual([])
  })

  it('keeps scheduling after a dispose-free lull, with a fresh channel per scheduler', async () => {
    vi.useFakeTimers()
    const first = createFeedTaskScheduler()
    const second = createFeedTaskScheduler()
    const ran: string[] = []

    first.schedule(() => ran.push('first'))
    await macrotaskTurns(1)
    first.dispose()
    second.schedule(() => ran.push('second'))
    await macrotaskTurns(1)

    expect(ran).toEqual(['first', 'second'])
    second.dispose()
  })
})
