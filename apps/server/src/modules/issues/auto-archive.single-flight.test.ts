import type { IssueWire } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  AUTO_ARCHIVE_BOOT_DELAY_MS,
  AUTO_ARCHIVE_INTERVAL_MS,
  IssueAutoArchive,
} from './auto-archive'

/** See the note in `../automations/scheduler.single-flight.test.ts`: the second
 *  tick is fired from inside the first, which is the overlap an awaited store
 *  call will produce once the pass yields. */
describe('IssueAutoArchive single-flight (POD-3258)', () => {
  const noIssues: IssueWire[] = []

  it('skips a tick that lands on a sweep already running', () => {
    vi.useFakeTimers()
    try {
      let sweeps = 0
      let reentered = false
      let armed = false
      const archive = new IssueAutoArchive({
        sweepAutoArchive: () => {
          sweeps += 1
          // Re-enter exactly once, from inside a pass the interval drives.
          if (armed && !reentered) {
            reentered = true
            vi.advanceTimersByTime(AUTO_ARCHIVE_INTERVAL_MS)
          }
          return noIssues
        },
      })
      archive.start()
      // Past the boot one-shot FIRST. `start` assigns the interval only after
      // the boot pass returns, so re-entering from inside that pass would have
      // nothing to fire and the test would pass vacuously.
      vi.advanceTimersByTime(AUTO_ARCHIVE_BOOT_DELAY_MS)
      expect(sweeps).toBe(1)
      armed = true

      vi.advanceTimersByTime(AUTO_ARCHIVE_INTERVAL_MS)
      archive.dispose()

      expect(reentered).toBe(true)
      expect(sweeps).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the fence when a sweep throws', () => {
    vi.useFakeTimers()
    try {
      let sweeps = 0
      const archive = new IssueAutoArchive({
        sweepAutoArchive: () => {
          sweeps += 1
          throw new Error('boom')
        },
      })
      archive.start()
      vi.advanceTimersByTime(AUTO_ARCHIVE_BOOT_DELAY_MS)
      vi.advanceTimersByTime(AUTO_ARCHIVE_INTERVAL_MS)
      archive.dispose()

      expect(sweeps).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
