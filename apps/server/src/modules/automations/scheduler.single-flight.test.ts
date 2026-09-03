import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATIONS_BOOT_DELAY_MS,
  AUTOMATIONS_INTERVAL_MS,
  AutomationScheduler,
} from './scheduler'

/**
 * THE OVERLAP IS REAL, NOT SIMULATED (POD-3258). The probe re-enters the timer
 * from inside the callback — `vi.advanceTimersByTime` fires the interval
 * synchronously, so the second tick begins while the first is still on the
 * stack. That is precisely the shape an awaited store call will create once the
 * pass yields, and it is the only way to produce it while the body is still
 * synchronous.
 */
describe('AutomationScheduler single-flight (POD-3258)', () => {
  it('skips a tick that lands on a pass already running', () => {
    vi.useFakeTimers()
    try {
      let passes = 0
      let reentered = false
      const scheduler = new AutomationScheduler({
        tick: () => {
          passes += 1
          // Re-enter exactly once, from inside the first pass.
          if (!reentered) {
            reentered = true
            vi.advanceTimersByTime(AUTOMATIONS_INTERVAL_MS)
          }
        },
      })
      scheduler.start()
      vi.advanceTimersByTime(AUTOMATIONS_BOOT_DELAY_MS)
      scheduler.dispose()

      expect(reentered).toBe(true)
      expect(passes).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the next tick normally once the previous pass has finished', () => {
    vi.useFakeTimers()
    try {
      let passes = 0
      const scheduler = new AutomationScheduler({
        tick: () => {
          passes += 1
        },
      })
      scheduler.start()
      vi.advanceTimersByTime(AUTOMATIONS_BOOT_DELAY_MS)
      vi.advanceTimersByTime(AUTOMATIONS_INTERVAL_MS)
      vi.advanceTimersByTime(AUTOMATIONS_INTERVAL_MS)
      scheduler.dispose()

      expect(passes).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the fence when a pass throws, so the timer is not wedged', () => {
    vi.useFakeTimers()
    try {
      let passes = 0
      const scheduler = new AutomationScheduler({
        tick: () => {
          passes += 1
          throw new Error('boom')
        },
      })
      scheduler.start()
      vi.advanceTimersByTime(AUTOMATIONS_BOOT_DELAY_MS)
      vi.advanceTimersByTime(AUTOMATIONS_INTERVAL_MS)
      scheduler.dispose()

      expect(passes).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
