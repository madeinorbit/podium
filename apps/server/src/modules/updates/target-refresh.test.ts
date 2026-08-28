import type { UpdateChannel } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  initialRefreshDelayMs,
  REFRESH_INITIAL_JITTER_MS,
  REFRESH_INITIAL_MIN_MS,
  REFRESH_INTERVAL_MS,
  REFRESH_RETRY_INTERVAL_MS,
  startTargetRefresh,
} from './target-refresh'

/**
 * The schedule is DRIVEN, not waited on: the test holds the armed callback and
 * fires it. A `setTimeout` before an assertion is a bug in this lane, and a
 * 24-hour cadence is not something a clock can be asked to reach.
 */
function fakeSchedule() {
  const armed: { run: () => void; ms: number; canceled: boolean }[] = []
  const schedule = (run: () => void, ms: number): (() => void) => {
    const entry = { run, ms, canceled: false }
    armed.push(entry)
    return () => {
      entry.canceled = true
    }
  }
  return {
    schedule,
    armed,
    /** Fire the most recently armed callback and settle its async work. */
    fire: async (): Promise<void> => {
      const entry = armed.at(-1)
      if (!entry) throw new Error('nothing armed')
      if (entry.canceled) throw new Error('the armed callback was canceled')
      const before = armed.length
      entry.run()
      for (let turn = 0; turn < 10 && armed.length === before; turn += 1) {
        await Promise.resolve()
      }
      if (armed.length === before) throw new Error('the scheduled callback did not settle')
    },
  }
}

describe('startTargetRefresh', () => {
  const build = (
    opts: {
      refresh?: (channel: UpdateChannel) => Promise<boolean | void>
      operationActive?: (channel: UpdateChannel) => boolean
    } = {},
  ) => {
    const clock = fakeSchedule()
    const refreshed: UpdateChannel[] = []
    const handle = startTargetRefresh({
      refresh: async (channel) => {
        refreshed.push(channel)
        return opts.refresh?.(channel)
      },
      operationActive: opts.operationActive ?? (() => false),
      schedule: clock.schedule,
      initialDelayMs: 120_000,
    })
    return { ...clock, refreshed, handle }
  }

  it('arms the first tick a few minutes after boot rather than refreshing immediately', () => {
    const { armed, refreshed } = build()
    expect(refreshed).toEqual([])
    expect(armed).toHaveLength(1)
    expect(armed[0]?.ms).toBe(120_000)
  })

  it('refreshes EVERY channel on a tick and re-arms for a day later', async () => {
    const { fire, armed, refreshed } = build()

    await fire()

    // `dev` is in this list now (spec §1): it is a pulled feed like the other
    // two, so excluding it would leave the one channel exercised many times a
    // day as the one channel whose refresh path nothing ran.
    expect(refreshed).toEqual(['dev', 'edge', 'stable'])
    expect(armed).toHaveLength(2)
    expect(armed[1]?.ms).toBe(REFRESH_INTERVAL_MS)
  })

  it('keeps refreshing day after day', async () => {
    const { fire, refreshed } = build()

    await fire()
    await fire()
    await fire()

    expect(refreshed).toEqual([
      'dev',
      'edge',
      'stable',
      'dev',
      'edge',
      'stable',
      'dev',
      'edge',
      'stable',
    ])
  })

  /** Never yank a target out from under a machine that is mid-grant on it. */
  it('skips a channel with a wave in flight and still refreshes the other', async () => {
    const { fire, refreshed } = build({ operationActive: (channel) => channel === 'dev' })

    await fire()

    // The dev channel obeys the same skip rule as the other two, which is what
    // keeps a mid-operation publish from being spliced into a running wave:
    // it is queued as `nextTarget` and picked up on the retry cadence instead.
    expect(refreshed).toEqual(['edge', 'stable'])
  })

  it('re-arms after a skipped tick, so a wave does not end the schedule', async () => {
    const { fire, armed } = build({ operationActive: () => true })

    await fire()

    expect(armed).toHaveLength(2)
    expect(armed[1]?.ms).toBe(REFRESH_RETRY_INTERVAL_MS)
  })

  it('retries soon when a publication is temporarily incomplete', async () => {
    let incomplete = true
    const { fire, armed } = build({
      refresh: async (channel) => (channel === 'edge' && incomplete ? false : true),
    })

    await fire()
    expect(armed.at(-1)?.ms).toBe(REFRESH_RETRY_INTERVAL_MS)

    incomplete = false
    await fire()
    expect(armed.at(-1)?.ms).toBe(REFRESH_INTERVAL_MS)
  })

  /**
   * A rejected refresh must not leave the loop unarmed: a schedule that dies on
   * one bad day is the exact failure this module was written to remove.
   */
  it('survives a refresh that rejects and still re-arms', async () => {
    const { fire, armed, refreshed } = build({
      refresh: async (channel) => {
        if (channel === 'edge') throw new Error('feed exploded')
      },
    })

    await fire()

    expect(refreshed).toEqual(['dev', 'edge', 'stable'])
    expect(armed).toHaveLength(2)
    expect(armed[1]?.ms).toBe(REFRESH_RETRY_INTERVAL_MS)
  })

  it('stop() cancels the armed tick and arms nothing further', async () => {
    const { fire, armed, handle, refreshed } = build()
    await fire()
    handle.stop()

    expect(armed.at(-1)?.canceled).toBe(true)
    expect(refreshed).toEqual(['dev', 'edge', 'stable'])
  })

  it('stop() is idempotent', () => {
    const { handle } = build()
    handle.stop()
    expect(() => handle.stop()).not.toThrow()
  })

  it('jitters the first delay across the stated window so restarted fleets do not synchronise', () => {
    expect(initialRefreshDelayMs(() => 0)).toBe(REFRESH_INITIAL_MIN_MS)
    expect(initialRefreshDelayMs(() => 0.5)).toBe(
      REFRESH_INITIAL_MIN_MS + REFRESH_INITIAL_JITTER_MS / 2,
    )
    // `Math.random()` is exclusive of 1, so the delay stays inside the window.
    expect(initialRefreshDelayMs(() => 0.999_999)).toBeLessThan(
      REFRESH_INITIAL_MIN_MS + REFRESH_INITIAL_JITTER_MS,
    )
  })

  it('uses the jittered delay when none is stated', () => {
    const clock = fakeSchedule()
    startTargetRefresh({
      refresh: vi.fn(async () => {}),
      operationActive: () => false,
      schedule: clock.schedule,
      random: () => 0,
    })
    expect(clock.armed[0]?.ms).toBe(REFRESH_INITIAL_MIN_MS)
  })
})
