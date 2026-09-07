import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATIONS_BOOT_DELAY_MS,
  AUTOMATIONS_INTERVAL_MS,
  AutomationScheduler,
} from './scheduler'

/**
 * Timer advancement must let the awaited pass settle before expecting the boot
 * callback to install its interval or the single-flight fence to clear. Passes
 * deliberately cross a real event-loop turn, as asynchronous store work can;
 * synchronous fake-clock advancement (or a microtask count) cannot drain that.
 */
describe('AutomationScheduler single-flight (POD-3258)', () => {
  let scheduler: AutomationScheduler

  beforeEach(() => {
    // Keep setImmediate real: it models work outside the scheduler's clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    scheduler?.dispose()
    vi.useRealTimers()
  })

  it('skips a tick that lands on a pass already running', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const tick = vi.fn(async () => {
      await setImmediate()
      if (tick.mock.calls.length === 2) await pending
    })
    scheduler = new AutomationScheduler({ tick })
    scheduler.start()

    try {
      await vi.advanceTimersByTimeAsync(AUTOMATIONS_BOOT_DELAY_MS)
      expect(tick).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount(), 'boot completed and installed the interval').toBe(1)

      await vi.advanceTimersByTimeAsync(AUTOMATIONS_INTERVAL_MS)
      expect(tick).toHaveBeenCalledTimes(2)

      // The interval exists and the second pass is held across actual timer
      // firings. These must be skipped, not queued for replay after release.
      await vi.advanceTimersByTimeAsync(2 * AUTOMATIONS_INTERVAL_MS)
      expect(tick).toHaveBeenCalledTimes(2)
      release()
      await setImmediate()
      expect(tick).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(AUTOMATIONS_INTERVAL_MS)
      expect(tick).toHaveBeenCalledTimes(3)
    } finally {
      release()
      await setImmediate()
    }
  })

  it('runs the next tick normally once the previous pass has finished', async () => {
    const tick = vi.fn(async () => { await setImmediate() })
    scheduler = new AutomationScheduler({ tick })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(AUTOMATIONS_BOOT_DELAY_MS)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AUTOMATIONS_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(AUTOMATIONS_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('releases the fence when a pass throws, so the timer is not wedged', async () => {
    const tick = vi.fn(async () => {
      await setImmediate()
      throw new Error('boom')
    })
    scheduler = new AutomationScheduler({ tick })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(AUTOMATIONS_BOOT_DELAY_MS)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AUTOMATIONS_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
