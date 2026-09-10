import { LoopMinuteWire, LoopProfileLevelWire, LoopWindowWire } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOOP_PROFILE_LEVELS } from './config'
import {
  LOOP_NESTED_BUCKETS,
  type LoopAccountingOptions,
  type LoopMinute,
  MINUTE_RING,
  parseProcStat,
  startLoopAccounting,
  WINDOW_RING,
} from './loop-accounting'

/** USER_HZ: the same 100 the module assumes, stated so the math is readable. */
const TICKS = 100
const SAMPLE_MS = 1000
const PROBE_MS = 20

/**
 * A driven loop. Time only moves when a test says so, and it moves in probe-sized
 * steps so the probe sees the lateness a healthy loop would (a single 1000 ms jump
 * would fire the probe once, 980 ms late, and manufacture a stall in every test).
 *
 * `now` also creeps by a hundredth of a millisecond per CALL, which is what makes
 * `selfCostMs` measurable here: the module's own cost is the wall time between two
 * of its `now()` calls, and a clock that only moves on command reports it as zero.
 */
function harness(over: Partial<LoopAccountingOptions> = {}) {
  let clock = 0
  const readAt = () => {
    clock += 0.01
    return clock
  }
  let cpuTicks = 0
  let waitNs = 0
  const minutes: LoopMinute[] = []
  const handle = startLoopAccounting({
    component: 'server',
    level: 'attribution',
    sampleMs: SAMPLE_MS,
    longTickMs: 100,
    now: readAt,
    wallClockNow: () => 1_800_000_000_000 + clock,
    readMainThreadCpu: () => ({ utimeTicks: cpuTicks, stimeTicks: 0 }),
    readSchedstat: () => `100 ${waitNs} 7`,
    memoryUsage: () => ({ heapUsed: 111, rss: 222 }),
    clockTicksPerSecond: TICKS,
    sink: { write: (minute) => minutes.push(minute) },
    ...over,
  })
  return {
    handle,
    minutes,
    /** Burn `ms` of main-thread CPU over the coming advances. */
    burnCpu(ms: number) {
      cpuTicks += (ms / 1000) * TICKS
    },
    waitOnRunqueue(ms: number) {
      waitNs += ms * 1e6
    },
    /** Advance `ms` in probe-sized steps: a loop that is never blocked. */
    idle(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += PROBE_MS) {
        clock += PROBE_MS
        vi.advanceTimersByTime(PROBE_MS)
      }
    },
    /** Block the loop for `ms`: the probe fires once, that late. */
    block(ms: number) {
      clock += ms
      vi.advanceTimersByTime(ms)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('startLoopAccounting at level off', () => {
  it('registers no timer, reads no /proc, and measures nothing', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval')
    const readMainThreadCpu = vi.fn()
    const readSchedstat = vi.fn(() => '0 0 0')
    const handle = startLoopAccounting({
      component: 'daemon',
      level: 'off',
      readMainThreadCpu,
      readSchedstat,
      sink: {
        write: () => {
          throw new Error('level off must not write a minute')
        },
      },
    })
    try {
      expect(setInterval).not.toHaveBeenCalled()
      expect(readMainThreadCpu).not.toHaveBeenCalled()
      expect(readSchedstat).not.toHaveBeenCalled()
      expect(handle.snapshot()).toEqual({
        level: 'off',
        component: 'daemon',
        windows: [],
        minutes: [],
      })
      expect(handle.latestMinute()).toBeUndefined()
      expect(handle.latestWindow()).toBeUndefined()
      // The inert handle still answers, so a caller needs no level branch.
      handle.attribute('sql', 5)
      handle.stop()
    } finally {
      setInterval.mockRestore()
    }
  })
})

describe('per-second windows', () => {
  it('derives utilization from the main thread CPU delta, not from wall time', () => {
    const h = harness()
    h.burnCpu(400)
    h.idle(SAMPLE_MS)
    const window = h.handle.latestWindow()
    expect(window?.utilizationPct).toBeCloseTo(40, 0)
    expect(window?.heapUsedBytes).toBe(111)
    expect(window?.rssBytes).toBe(222)
    h.handle.stop()
  })

  it('reports runqueue wait as its own share of the window', () => {
    const h = harness()
    h.waitOnRunqueue(250)
    h.idle(SAMPLE_MS)
    expect(h.handle.latestWindow()?.runqueueWaitPct).toBeCloseTo(25, 0)
    h.handle.stop()
  })

  it('omits utilization entirely where /proc cannot answer', () => {
    const h = harness({ readMainThreadCpu: () => undefined })
    h.idle(SAMPLE_MS)
    const window = h.handle.latestWindow()
    expect(window).toBeDefined()
    expect(window && 'utilizationPct' in window).toBe(false)
    h.handle.stop()
  })

  it('sums probe lateness over 5 ms as blocked time, and counts the long ticks', () => {
    const h = harness()
    h.idle(200)
    h.block(300)
    h.idle(200)
    h.block(150)
    h.idle(SAMPLE_MS)
    const windows = h.handle.snapshot().windows
    const blocked = windows.reduce((sum, w) => sum + w.blockedMs, 0)
    const stalls = windows.reduce((sum, w) => sum + w.stalls, 0)
    const stallMax = Math.max(...windows.map((w) => w.stallMaxMs))
    // 300 - 20 and 150 - 20: the probe's lateness is measured against its own
    // interval, so a 300 ms block is a 280 ms late fire.
    expect(blocked).toBeCloseTo(280 + 130, 0)
    expect(stalls).toBe(2)
    expect(stallMax).toBeCloseTo(280, 0)
    h.handle.stop()
  })

  it('measures its own cost and puts it on the window it belongs to', () => {
    const h = harness()
    h.idle(SAMPLE_MS * 2)
    expect(h.handle.latestWindow()?.selfCostMs).toBeGreaterThan(0)
    h.handle.stop()
  })

  it('keeps 120 windows and drops the oldest', () => {
    const h = harness()
    h.idle(SAMPLE_MS * (WINDOW_RING + 5))
    const windows = h.handle.snapshot().windows
    expect(windows).toHaveLength(WINDOW_RING)
    // Newest last, oldest first — and strictly increasing, so the ring was read
    // from the wrap point rather than from index zero.
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]?.at).toBeGreaterThan(windows[i - 1]?.at ?? 0)
    }
    h.handle.stop()
  })
})

describe('long ticks', () => {
  it('reports the first stall of a window, with the last window utilization', () => {
    const stalls: Array<{ durationMs: number; utilizationPct?: number }> = []
    const h = harness({ onLongTick: (stall) => stalls.push(stall) })
    h.burnCpu(600)
    h.idle(SAMPLE_MS)
    h.block(300)
    h.block(400)
    expect(stalls).toHaveLength(1)
    expect(stalls[0]?.durationMs).toBeCloseTo(280, 0)
    expect(stalls[0]?.utilizationPct).toBeCloseTo(60, 0)
    // The next window can report again.
    h.idle(SAMPLE_MS)
    h.block(300)
    expect(stalls).toHaveLength(2)
    h.handle.stop()
  })

  it('says nothing about a tick under the threshold', () => {
    const stalls: unknown[] = []
    const h = harness({ longTickMs: 100, onLongTick: (stall) => stalls.push(stall) })
    h.block(90)
    h.idle(SAMPLE_MS)
    expect(stalls).toEqual([])
    expect(h.handle.snapshot().windows[0]?.stalls).toBe(0)
    h.handle.stop()
  })
})

describe('per-minute rollup', () => {
  const minuteOf = (h: ReturnType<typeof harness>): LoopMinute => {
    const minute = h.minutes[0]
    if (!minute) throw new Error('no minute was written')
    return minute
  }

  it('writes exactly one record per 60 windows, to the sink and to the ring', () => {
    const h = harness()
    h.idle(SAMPLE_MS * 59)
    expect(h.minutes).toHaveLength(0)
    h.idle(SAMPLE_MS)
    expect(h.minutes).toHaveLength(1)
    expect(h.handle.latestMinute()).toEqual(h.minutes[0])
    expect(h.handle.snapshot().minutes).toEqual(h.minutes)
    h.handle.stop()
  })

  it('folds utilization from summed CPU, and keeps the worst second', () => {
    const h = harness()
    for (let second = 0; second < 60; second += 1) {
      h.burnCpu(second === 10 ? 900 : 100)
      h.idle(SAMPLE_MS)
    }
    const minute = minuteOf(h)
    // 59 seconds at 100 ms plus one at 900 ms, over 60 seconds of wall.
    expect(minute.utilizationPct).toBeCloseTo(((59 * 100 + 900) / 60_000) * 100, 0)
    expect(minute.utilizationMaxPct).toBeCloseTo(90, 0)
    h.handle.stop()
  })

  it('reports stall percentiles from the minute reservoir, and blocked share', () => {
    const h = harness()
    for (let second = 0; second < 59; second += 1) {
      if (second < 5) h.block(200 + second * 100)
      h.idle(SAMPLE_MS)
    }
    h.idle(SAMPLE_MS)
    const minute = minuteOf(h)
    expect(minute.stalls).toBe(5)
    // Lateness of the five blocks: 180, 280, 380, 480, 580.
    expect(minute.stallMaxMs).toBeCloseTo(580, 0)
    expect(minute.stallP50Ms).toBeCloseTo(380, 0)
    expect(minute.stallP99Ms).toBeCloseTo(580, 0)
    expect(minute.blockedPct).toBeCloseTo(((180 + 280 + 380 + 480 + 580) / 60_000) * 100, 1)
    h.handle.stop()
  })

  it('keeps an hour of minutes and drops the oldest', () => {
    const h = harness()
    h.idle(SAMPLE_MS * 60 * (MINUTE_RING + 2))
    expect(h.minutes).toHaveLength(MINUTE_RING + 2)
    const kept = h.handle.snapshot().minutes
    expect(kept).toHaveLength(MINUTE_RING)
    expect(kept[kept.length - 1]).toEqual(h.minutes[h.minutes.length - 1])
    h.handle.stop()
  })

  it('writes a flat minute too — silence is evidence', () => {
    const h = harness()
    h.idle(SAMPLE_MS * 60)
    const minute = minuteOf(h)
    expect(minute.stalls).toBe(0)
    expect(minute.blockedPct).toBe(0)
    expect(minute.utilizationPct).toBe(0)
    h.handle.stop()
  })

  it('carries no undefined-valued key, and stamps the minute boundary', () => {
    const h = harness()
    h.idle(SAMPLE_MS * 60)
    const minute = minuteOf(h)
    for (const [key, value] of Object.entries(minute)) {
      expect(value, `${key} is present but undefined`).toBeDefined()
    }
    expect(minute.at).toMatch(/:00\.000Z$/)
    expect(minute.component).toBe('server')
    expect(minute.level).toBe('attribution')
    expect(minute.selfCostPct).toBeGreaterThan(0)
    expect(minute.selfCostPct).toBeLessThan(1)
    h.handle.stop()
  })
})

describe('attribution', () => {
  it('is a no-op below the attribution level', () => {
    const h = harness({ level: 'accounting' })
    h.handle.attribute('sql', 40)
    h.idle(SAMPLE_MS * 60)
    expect(h.handle.latestWindow()?.buckets).toBeUndefined()
    const minute = h.minutes[0]
    expect(minute?.buckets).toBeUndefined()
    expect(minute?.coverage).toBeUndefined()
    h.handle.stop()
  })

  it('records bucket cost per window and per minute, with coverage over busy time', () => {
    const h = harness()
    h.burnCpu(600)
    h.handle.attribute('sql', 120)
    h.handle.attribute('sql', 80)
    h.handle.attribute('rpc', 100)
    h.idle(SAMPLE_MS)
    const window = h.handle.latestWindow()
    expect(window?.buckets?.sql).toEqual({ wallMs: 200, count: 2 })
    expect(window?.buckets?.rpc).toEqual({ wallMs: 100, count: 1 })
    // The window's counters reset; the minute's do not.
    h.idle(SAMPLE_MS * 59)
    const minute = h.minutes[0]
    expect(minute?.buckets?.sql).toEqual({ wallMs: 200, count: 2 })
    // 100 ms of TOP-LEVEL cost against 600 ms of busy time: the 200 ms of sql ran
    // INSIDE the rpc handler, so counting it again would claim half the minute was
    // explained when one seam explains a sixth of it.
    expect(minute?.coverage).toBeCloseTo(100 / 600, 4)
    expect(minute?.nestedBuckets).toEqual(['sql'])
    expect(minute?.inclusive).toEqual(['rpc'])
    // Only what actually fired. A bucket this component has no seam for — and one
    // whose seam simply stayed quiet — is ABSENT, so a reader can tell "nothing ran
    // here" apart from "nothing measures this here" (§6.1).
    expect(Object.keys(minute?.buckets ?? {})).toEqual(['rpc', 'sql'])
    h.handle.stop()
  })

  it('counts a bucket in full when nothing nests inside it', () => {
    const h = harness()
    h.burnCpu(600)
    h.handle.attribute('timers', 200)
    h.handle.attribute('ws.client', 100)
    h.idle(SAMPLE_MS * 60)
    // No sql to subtract, so every named millisecond counts toward coverage.
    expect(h.minutes[0]?.coverage).toBeCloseTo(300 / 600, 4)
    h.handle.stop()
  })

  it('reports a coverage of zero when a busy minute attributed nothing', () => {
    const h = harness()
    h.burnCpu(600)
    h.idle(SAMPLE_MS * 60)
    const minute = h.minutes[0]
    // The empty map and the zero are the POINT, not noise to suppress: a busy
    // minute no seam could explain is exactly the missing-seam signal (§6.2), and
    // dropping `coverage` here would hide the worst reading the record can carry.
    expect(minute?.buckets).toEqual({})
    expect(minute?.coverage).toBe(0)
    h.handle.stop()
  })

  it('leaves coverage out when no busy number was measurable', () => {
    // Off Linux /proc answers no CPU, and a coverage against WALL time would read
    // as "the seams explain 0.5% of it" on an idle process rather than as absent.
    const h = harness({ readMainThreadCpu: () => undefined })
    h.handle.attribute('sql', 120)
    h.idle(SAMPLE_MS * 60)
    const minute = h.minutes[0]
    expect(minute?.buckets?.sql).toEqual({ wallMs: 120, count: 1 })
    expect(minute?.coverage).toBeUndefined()
    h.handle.stop()
  })
})

describe('delaySnapshot', () => {
  it('reports loop delay percentiles from the probe, not from a histogram', () => {
    const h = harness()
    h.idle(SAMPLE_MS)
    h.block(300)
    h.idle(SAMPLE_MS)
    const delay = h.handle.delaySnapshot()
    expect(delay.max).toBeCloseTo(280, 0)
    // A quiet loop's median fire is on time to within the clock's own creep.
    expect(delay.p50).toBeLessThan(1)
    h.handle.stop()
  })
})

describe('parseProcStat', () => {
  it('reads utime and stime past a comm containing spaces and a bracket', () => {
    const row =
      '2225619 (podium se) r) S 1 2225619 2225619 0 -1 4194560 90 0 0 0 1234 567 0 0 20 0 21 0 999'
    expect(parseProcStat(row)).toEqual({ utimeTicks: 1234, stimeTicks: 567 })
  })

  it('is undefined on a row it cannot read', () => {
    expect(parseProcStat('')).toBeUndefined()
    expect(parseProcStat('2225619 (podium) S 1 2')).toBeUndefined()
  })
})

/**
 * THE WIRE CONTRACT, PINNED AGAINST A REAL RECORD (loop design §7.1/§7.2).
 *
 * `LoopMinuteWire` / `LoopWindowWire` in @podium/model are a HAND-WRITTEN mirror
 * of the interfaces above, and the model package deliberately does not import
 * this module (it is a leaf of Zod schemas that a browser bundle parses; this
 * module reads `/proc`). A mirror is only safe if something proves the two still
 * agree, and the failure it prevents is silent and remote: a field added or
 * retyped here, a daemon that starts sending it, and a server that refuses the
 * whole `hostMetrics` frame — dropping the memory and load samples with it.
 *
 * So the fixture is not hand-written: these parse the records the module ACTUALLY
 * produced, with every optional field populated.
 */
describe('the model wire schemas accept what this module produces', () => {
  it('parses a real minute and a real window, unchanged', () => {
    const h = harness()
    for (let second = 0; second < 60; second += 1) {
      h.burnCpu(100)
      h.waitOnRunqueue(10)
      h.handle.attribute('sql', 2)
      h.handle.attribute('rpc', 3)
      if (second === 10) h.block(300)
      h.idle(SAMPLE_MS)
    }
    const minute = h.handle.latestMinute()
    const window = h.handle.latestWindow()
    h.handle.stop()

    // The optional fields have to be PRESENT or this proves nothing about them.
    expect(minute?.utilizationPct).toBeGreaterThan(0)
    expect(minute?.runqueueWaitPct).toBeGreaterThan(0)
    expect(minute?.buckets?.sql?.count).toBeGreaterThan(0)
    expect(minute?.nestedBuckets).toEqual(LOOP_NESTED_BUCKETS)
    expect(minute?.coverage).toBeGreaterThan(0)
    expect(window?.utilizationPct).toBeGreaterThan(0)
    expect(window?.buckets?.sql?.count).toBeGreaterThan(0)

    // Parsed, and IDENTICAL — a schema that silently stripped a field would pass
    // a bare `parse` and lose exactly what the record was sent to carry.
    expect(LoopMinuteWire.parse(minute)).toEqual(minute)
    expect(LoopWindowWire.parse(window)).toEqual(window)
  })

  /** A minute from a host with no `/proc` — the fields the schema must allow to
   *  be missing are missing, rather than sent as a zero that reads as an idle loop. */
  it('parses a minute from a host that could not measure utilization', () => {
    const h = harness({ readMainThreadCpu: () => undefined, readSchedstat: () => '' })
    h.idle(SAMPLE_MS * 60)
    const minute = h.handle.latestMinute()
    h.handle.stop()
    expect(minute).toBeDefined()
    expect(minute).not.toHaveProperty('utilizationPct')
    expect(minute).not.toHaveProperty('runqueueWaitPct')
    expect(LoopMinuteWire.parse(minute)).toEqual(minute)
  })

  /**
   * The profile-capture counters, ACROSS THE SAME SEAM. They are written only at
   * `attribution` and only when a capture was refused or a drain was paid, so
   * the round-trip above never carries them — the guard exists but is unarmed
   * for exactly the two newest fields. This arms it.
   */
  it('carries the profile capture counters across the wire unchanged', () => {
    const h = harness()
    h.handle.noteProfileSuppressed()
    h.handle.noteProfilerCost(22.07)
    h.idle(SAMPLE_MS * 60)
    const minute = h.handle.latestMinute()
    h.handle.stop()

    // Present, or this proves nothing about them.
    expect(minute?.profileSuppressed).toBe(1)
    expect(minute?.profilerCostMs).toBeCloseTo(22.07)
    expect(LoopMinuteWire.parse(minute)).toEqual(minute)
  })

  /**
   * THE LEVEL NAMES, ON BOTH SIDES.
   *
   * `LOOP_PROFILE_LEVELS` here is ordered — `atLeast` compares indices — and
   * `LoopProfileLevelWire` restates the same four names as the set a record may
   * carry. Equal as ARRAYS, not as sets: a reordering here changes what every
   * gate means, and this is the cheapest place that notices.
   */
  it('states the same four levels as the wire enum, in the same order', () => {
    expect(LoopProfileLevelWire.options).toEqual([...LOOP_PROFILE_LEVELS])
  })
})

describe('profile capture counters on the minute record', () => {
  it('counts suppressed profile requests and the profiler drain cost', () => {
    const h = harness()

    h.handle.noteProfileSuppressed()
    h.handle.noteProfileSuppressed()
    h.handle.noteProfilerCost(6.75)
    h.handle.noteProfilerCost(3.25)
    h.idle(60_000)

    const minute = h.minutes.at(-1) as LoopMinute
    expect(minute.profileSuppressed).toBe(2)
    expect(minute.profilerCostMs).toBeCloseTo(10)
    // The drain is NOT folded into the accounting timer's own cost: they are
    // paid at different levels and by different code.
    expect(minute.selfCostPct).toBeLessThan(1)
    h.handle.stop()
  })

  it('resets both counters at the minute boundary', () => {
    const h = harness()

    h.handle.noteProfileSuppressed()
    h.handle.noteProfilerCost(5)
    h.idle(60_000)
    h.idle(60_000)

    expect(h.minutes).toHaveLength(2)
    expect(h.minutes[0]?.profileSuppressed).toBe(1)
    // A minute with neither is ABSENT rather than zero, like every other
    // optional field here: "nothing suppressed" and "not measured" stay apart.
    expect(h.minutes[1]).not.toHaveProperty('profileSuppressed')
    expect(h.minutes[1]).not.toHaveProperty('profilerCostMs')
    h.handle.stop()
  })

  it('ignores both below attribution, where no capture can run', () => {
    const h = harness({ level: 'accounting' })

    h.handle.noteProfileSuppressed()
    h.handle.noteProfilerCost(9)
    h.idle(60_000)

    expect(h.minutes[0]).not.toHaveProperty('profileSuppressed')
    expect(h.minutes[0]).not.toHaveProperty('profilerCostMs')
    h.handle.stop()
  })

  it('ignores a cost that is not a positive number', () => {
    const h = harness()

    h.handle.noteProfilerCost(Number.NaN)
    h.handle.noteProfilerCost(-4)
    h.handle.noteProfilerCost(0)
    h.idle(60_000)

    expect(h.minutes[0]).not.toHaveProperty('profilerCostMs')
    h.handle.stop()
  })
})
