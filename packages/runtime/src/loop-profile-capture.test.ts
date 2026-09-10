import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopMinute } from './loop-accounting'
import {
  createProfileCapture,
  type LoopProfileEnvelope,
  PROFILE_KEEP_CLEAR_MIN_MS,
  PROFILE_MAX_FILES,
  profileDir,
  profileRequestPath,
  type SamplingProfilerApi,
  takeProfileRequest,
  writeProfileRequest,
} from './loop-profile-capture'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loop-profile-capture-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * A stand-in for Bun's sampler that reproduces the two behaviours the real one
 * was measured to have: `samplingProfilerStackTraces` DRAINS (each call returns
 * only what accrued since the last), and `startSamplingProfiler` does NOT clear
 * anything. `feed()` is the test's stand-in for the loop being busy.
 */
function fakeJsc() {
  let buffered: number[] = []
  let next = 0
  const starts = vi.fn()
  const drains = vi.fn()
  const api: SamplingProfilerApi = {
    startSamplingProfiler() {
      starts()
    },
    samplingProfilerStackTraces() {
      drains()
      const traces = buffered.map((id) => ({ id, frames: [{ name: `f${id}` }] }))
      buffered = []
      return { interval: 0.001, traces, sources: [{ sourceID: 1, url: 'x' }] }
    },
  }
  return {
    api,
    starts,
    drains,
    feed(count: number) {
      for (let i = 0; i < count; i += 1) buffered.push(next++)
    },
    get buffered() {
      return buffered.length
    },
  }
}

/**
 * A monotonic clock that advances by `costMs()` across each drain: `discard`
 * reads it once before and once after, so this makes one drain cost exactly
 * what the test says it costs.
 */
function drainClock(costMs: () => number) {
  let at = 0
  let inDrain = false
  return () => {
    if (inDrain) {
      at += costMs()
      inDrain = false
    } else {
      inDrain = true
    }
    return at
  }
}

/**
 * A sampler whose traces are the size production's are: a real server trace
 * measured about 2 KB (50-odd frames with a name, a source URL and a location
 * each), which is what turns 15 000 traces into a 30 MB file.
 */
function fatJsc(bytesPerTrace = 2048) {
  let buffered = 0
  const frame = { name: 'x'.repeat(bytesPerTrace - 64), sourceURL: 'packages/runtime/src/x.ts' }
  const api: SamplingProfilerApi = {
    startSamplingProfiler() {},
    samplingProfilerStackTraces() {
      const traces = Array.from({ length: buffered }, (_, id) => ({
        timestamp: id,
        frames: [frame],
      }))
      buffered = 0
      return { interval: 0.01, traces, sources: [{ sourceID: 1, url: 'x' }] }
    },
  }
  return {
    api,
    feed(count: number) {
      buffered += count
    },
  }
}

/**
 * A sampler period somebody chose. Arming is refused on JSC's unstated 1 ms
 * default (POD-3834), so every test that expects a capture has to say that this
 * process was started with a period, the same as production does.
 */
const SLOW_SAMPLER = { us: 10_000, stated: true } as const

/** A clock the test advances by hand, so the rate-limit window is deterministic. */
function fakeClock(startMs = Date.parse('2026-09-10T12:00:00.000Z')) {
  let value = startMs
  return {
    now: () => value,
    advance(ms: number) {
      value += ms
    },
  }
}

function minute(over: Partial<LoopMinute> = {}): LoopMinute {
  return {
    at: '2026-09-10T12:00:00.000Z',
    component: 'server',
    level: 'attribution',
    blockedPct: 4,
    stalls: 2,
    stallP50Ms: 120,
    stallP99Ms: 340,
    stallMaxMs: 340,
    heapUsedBytes: 1,
    rssBytes: 2,
    selfCostPct: 0.01,
    ...over,
  }
}

function readEnvelope(path: string): LoopProfileEnvelope {
  return JSON.parse(readFileSync(path, 'utf8')) as LoopProfileEnvelope
}

/** Immediate `sleep`, so a 10 s window costs the test nothing. */
const noWait = async (): Promise<void> => {}

describe('createProfileCapture', () => {
  it('writes an envelope carrying the trigger, the stall, the minute and Bun stacks', async () => {
    const jsc = fakeJsc()
    const clock = fakeClock()
    const capture = createProfileCapture({
      component: 'server',
      level: 'attribution',
      dir: root,
      now: clock.now,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      sleep: async (ms) => {
        // The window is where the traces accrue: feed the buffer during it, and
        // advance the clock so `endedAt` is a real duration later.
        jsc.feed(7)
        clock.advance(ms)
      },
    })

    const result = await capture.request('stall', 10, { stallMs: 342, minute: minute() })

    expect(result.suppressed).toBe(false)
    if (result.suppressed) throw new Error('unreachable')
    const envelope = readEnvelope(result.path)
    expect(envelope).toMatchObject({
      component: 'server',
      level: 'attribution',
      trigger: 'stall',
      seconds: 10,
      stallMs: 342,
      startedAt: '2026-09-10T12:00:00.000Z',
      endedAt: '2026-09-10T12:00:10.000Z',
      interval: 0.001,
      traceCount: 7,
    })
    expect(envelope.minute?.stallMaxMs).toBe(340)
    expect((envelope.stacks as { traces: unknown[] }).traces).toHaveLength(7)
    expect(result.traceCount).toBe(7)
    // The filename is component, sortable stamp and trigger — no colons.
    expect(result.path.endsWith('/server-2026-09-10T12-00-00.000Z-stall.json')).toBe(true)
  })

  it('clamps the requested window into 1–60 s', async () => {
    const jsc = fakeJsc()
    const slept: number[] = []
    const capture = createProfileCapture({
      component: 'daemon',
      level: 'full',
      dir: root,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      minIntervalMs: 0,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    await capture.request('signal', 900)
    await capture.request('signal', 0)

    expect(slept).toEqual([60_000, 1000])
  })

  it('refuses a second capture while one is in flight', async () => {
    const jsc = fakeJsc()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const capture = createProfileCapture({
      component: 'server',
      level: 'attribution',
      dir: root,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      sleep: () => gate,
    })

    const first = capture.request('signal', 10)
    // The first is parked inside its window; the second must not start one.
    const second = await capture.request('stall', 10, { stallMs: 500 })

    expect(second).toEqual({ suppressed: true, reason: 'running' })
    release()
    await first
    expect(readdirSync(profileDir(root))).toHaveLength(1)
  })

  it('refuses a second capture inside the five-minute window, and allows one after it', async () => {
    const jsc = fakeJsc()
    const clock = fakeClock()
    const capture = createProfileCapture({
      component: 'server',
      level: 'attribution',
      dir: root,
      now: clock.now,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      sleep: noWait,
    })

    expect((await capture.request('signal', 10)).suppressed).toBe(false)

    clock.advance(4 * 60_000 + 59_000)
    expect(await capture.request('stall', 10)).toEqual({
      suppressed: true,
      reason: 'rate-limited',
    })

    clock.advance(2000)
    expect((await capture.request('stall', 10)).suppressed).toBe(false)
    expect(readdirSync(profileDir(root))).toHaveLength(2)
  })

  it('keeps at most 20 of its own profiles and never deletes the other component', async () => {
    const jsc = fakeJsc()
    const clock = fakeClock()
    const dir = profileDir(root)
    const capture = createProfileCapture({
      component: 'server',
      level: 'attribution',
      dir: root,
      now: clock.now,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      minIntervalMs: 0,
      sleep: noWait,
    })

    // One extra beyond the cap, each a minute apart so the stamps differ.
    for (let i = 0; i < PROFILE_MAX_FILES + 5; i += 1) {
      await capture.request('signal', 10)
      clock.advance(60_000)
      if (i === 0) writeFileSync(join(dir, 'daemon-2026-09-10T11-00-00.000Z-stall.json'), '{}')
    }

    const names = readdirSync(dir).sort()
    expect(names.filter((n) => n.startsWith('server-'))).toHaveLength(PROFILE_MAX_FILES)
    // The daemon's file is older than every surviving server file and still there.
    expect(names).toContain('daemon-2026-09-10T11-00-00.000Z-stall.json')
    // The ones kept are the NEWEST: the first five stamps are gone.
    expect(names).not.toContain('server-2026-09-10T12-00-00.000Z-signal.json')
    expect(names).toContain('server-2026-09-10T12-24-00.000Z-signal.json')
  })

  it('refuses with a record when the runtime has no sampling profiler', async () => {
    const capture = createProfileCapture({
      component: 'daemon',
      level: 'attribution',
      dir: root,
      jsc: null,
      sleep: noWait,
    })

    const result = await capture.request('signal', 10, { stallMs: 800 })

    expect(result.suppressed).toBe(true)
    if (!result.suppressed) throw new Error('unreachable')
    expect(result.reason).toBe('unavailable')
    expect(result.path).toBeDefined()
    const envelope = readEnvelope(result.path as string)
    expect(envelope.refused).toMatch(/bun:jsc/)
    expect(envelope.stacks).toBeUndefined()
    expect(envelope.stallMs).toBe(800)
  })

  it('captures nothing below attribution and opens no directory', async () => {
    for (const level of ['off', 'accounting'] as const) {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level,
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        sleep: noWait,
      })
      expect(await capture.request('signal', 10)).toEqual({ suppressed: true, reason: 'level' })
      expect(jsc.starts).not.toHaveBeenCalled()
    }
    expect(existsSync(profileDir(root))).toBe(false)
  })

  it('does not arm the sampler until the first request', async () => {
    const jsc = fakeJsc()
    const capture = createProfileCapture({
      component: 'server',
      level: 'attribution',
      dir: root,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      sleep: noWait,
    })

    expect(jsc.starts).not.toHaveBeenCalled()
    await capture.request('signal', 10)
    expect(jsc.starts).toHaveBeenCalledTimes(1)
    capture.stop()
  })

  it('opens the capture window on an empty buffer', async () => {
    const jsc = fakeJsc()
    const capture = createProfileCapture({
      component: 'server',
      level: 'attribution',
      dir: root,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      minIntervalMs: 0,
      sleep: async () => {
        jsc.feed(3)
      },
    })

    // Traces from BEFORE the trigger: they are not this capture's window.
    jsc.feed(50)
    const result = await capture.request('stall', 10)

    if (result.suppressed) throw new Error('unreachable')
    expect(result.traceCount).toBe(3)
  })

  it('refuses a request after stop, and does not resurrect the keep-clear timer', async () => {
    const jsc = fakeJsc()
    const capture = createProfileCapture({
      component: 'server',
      level: 'attribution',
      dir: root,
      jsc: jsc.api,
      effectiveSample: SLOW_SAMPLER,
      minIntervalMs: 0,
      sleep: noWait,
    })

    await capture.request('signal', 10)
    capture.stop()

    // A stopped capture that still served requests would re-arm the drain timer
    // it was just asked to give up — the daemon's signal handler can outlive
    // close, and this is the second line of defence against that.
    expect(await capture.request('signal', 10)).toEqual({ suppressed: true, reason: 'stopped' })
    jsc.feed(400)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(jsc.buffered).toBe(400)
  })

  describe('keep-clear timer', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    /**
     * The measured hazard this timer exists for: Bun's sampler cannot be stopped
     * and its buffer grows about 1.6 MB per second of busy loop, so after the
     * first capture something has to keep draining it.
     */
    it('drains the sampler between captures once armed', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        keepClearMs: 1000,
        sleep: noWait,
      })

      await capture.request('signal', 10)
      jsc.feed(400)
      expect(jsc.buffered).toBe(400)

      await vi.advanceTimersByTimeAsync(1000)
      expect(jsc.buffered).toBe(0)

      jsc.feed(400)
      await vi.advanceTimersByTimeAsync(1000)
      expect(jsc.buffered).toBe(0)

      capture.stop()
      jsc.feed(400)
      await vi.advanceTimersByTimeAsync(5000)
      expect(jsc.buffered).toBe(400)
    })

    it('does not drain during a capture window', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        keepClearMs: 1000,
        minIntervalMs: 0,
        // A window long enough that the keep-clear would tick several times if
        // it were still running — the traces it drained would be the profile.
        sleep: async (ms) => {
          jsc.feed(10)
          await vi.advanceTimersByTimeAsync(ms)
          jsc.feed(10)
        },
      })

      await capture.request('signal', 10)
      const second = await capture.request('signal', 10)

      if (second.suppressed) throw new Error('unreachable')
      expect(second.traceCount).toBe(20)
      capture.stop()
    })

    /**
     * The measurement that decides what this timer can and cannot do (POD-3834):
     * total drain cost per busy second was 5.2 ms at a 1000 ms drain interval and
     * 5.9 ms at 250 ms, interleaved. Draining more often does not buy back cost —
     * cost is set by the SAMPLE rate — it only makes each drain shorter. So the
     * timer's job is to keep one drain off the stall ledger, and that is what
     * this pins.
     */
    it('shortens its interval when one drain runs long, and lets it back out again', async () => {
      const jsc = fakeJsc()
      let drainCostMs = 40
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        keepClearMs: 1000,
        keepClearTargetMs: 5,
        monotonic: drainClock(() => drainCostMs),
        sleep: noWait,
      })

      await capture.request('signal', 10)
      expect(capture.keepClearIntervalMs).toBe(1000)

      // 40 ms against a 5 ms target: the next drain has to come 8x sooner.
      await vi.advanceTimersByTimeAsync(1000)
      expect(capture.keepClearIntervalMs).toBe(125)

      // Cheap again: it climbs back, and never past the interval it was given.
      drainCostMs = 0
      for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1000)
      expect(capture.keepClearIntervalMs).toBe(1000)
      capture.stop()
    })

    it('never drains more often than the floor, however long a drain takes', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        keepClearMs: 1000,
        keepClearTargetMs: 5,
        monotonic: drainClock(() => 100_000),
        sleep: noWait,
      })

      await capture.request('signal', 10)
      await vi.advanceTimersByTimeAsync(1000)
      expect(capture.keepClearIntervalMs).toBe(PROFILE_KEEP_CLEAR_MIN_MS)
      capture.stop()
    })

    it('reports the main-thread time it has spent keeping the buffer clear', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        keepClearMs: 1000,
        sleep: noWait,
      })

      await capture.request('signal', 10)
      await vi.advanceTimersByTimeAsync(3000)

      expect(capture.keepClearMs).toBeGreaterThanOrEqual(0)
      expect(jsc.drains.mock.calls.length).toBeGreaterThanOrEqual(4)
      capture.stop()
    })
  })

  describe('the sample-period guard', () => {
    /**
     * The bound the whole issue is about. Arming is irreversible — Bun has no
     * stop — so at JSC's 1 ms default the process buys a drain cost it can never
     * put down, measured at 4.05 percent of wall on the reference server against
     * a 0.5 percent budget. A period nobody stated is an accident, and this
     * refuses it rather than paying for it.
     */
    it('refuses to arm on a fast period nobody asked for, and says what to set', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: { us: 1000, stated: false },
        sleep: noWait,
      })

      const result = await capture.request('signal', 10)

      expect(result).toMatchObject({ suppressed: true, reason: 'sample-rate' })
      if (!result.suppressed || !result.path) throw new Error('unreachable')
      const envelope = readEnvelope(result.path)
      // The record is the whole point of refusing: an operator who sent SIGUSR2
      // gets a file naming the variable to set, not silence.
      expect(envelope.refused).toContain('BUN_JSC_sampleInterval')
      expect(envelope.sampleIntervalUs).toBe(1000)
      expect(jsc.starts).not.toHaveBeenCalled()
    })

    it('arms on a fast period somebody did ask for', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        // An operator who writes the variable has said what they are buying.
        effectiveSample: { us: 1000, stated: true },
        sleep: noWait,
      })

      const result = await capture.request('signal', 10)

      expect(result.suppressed).toBe(false)
      expect(jsc.starts).toHaveBeenCalledTimes(1)
    })

    it('records the period the sampler is running at, so a reader can size it', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        sleep: noWait,
      })

      const result = await capture.request('signal', 10)

      if (result.suppressed) throw new Error('unreachable')
      expect(readEnvelope(result.path).sampleIntervalUs).toBe(10_000)
    })

    it('keeps draining a sampler that was armed before the guard could refuse', async () => {
      // Arming is per PROCESS, not per request: once the period is paid for, a
      // later refusal would leave the buffer growing with nobody draining it.
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: { us: 1000, stated: true },
        minIntervalMs: 0,
        sleep: noWait,
      })

      await capture.request('signal', 10)
      const second = await capture.request('signal', 10)

      expect(second.suppressed).toBe(false)
      expect(jsc.starts).toHaveBeenCalledTimes(1)
      capture.stop()
    })
  })

  describe('the byte caps', () => {
    it('keeps a profile under the file cap by dropping traces, and says how many', async () => {
      const jsc = fatJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        maxBytes: 256 * 1024,
        sleep: async () => {
          // 16 000 traces at 2 KB is the 30 MB file the daemon actually wrote.
          jsc.feed(16_000)
        },
      })

      const result = await capture.request('stall', 10, { stallMs: 4000 })

      expect(result.suppressed).toBe(false)
      if (result.suppressed) throw new Error('unreachable')
      expect(result.bytes).toBeLessThanOrEqual(256 * 1024)
      expect(statSync(result.path).size).toBeLessThanOrEqual(256 * 1024)
      const envelope = readEnvelope(result.path)
      expect(envelope.tracesSampled).toBe(16_000)
      expect(envelope.traceCount).toBeLessThan(16_000)
      expect(envelope.tracesDropped).toBe(16_000 - (envelope.traceCount ?? 0))
      // What is kept has to be spread across the whole window, not the first
      // slice of it: a profile of the first 200 ms of a 10 s stall names the
      // wrong function. The stride keeps the last trace as well as the first.
      const traces = (envelope.stacks as { traces: { timestamp: number }[] }).traces
      expect(traces.length).toBeGreaterThan(1)
      expect(traces[0]?.timestamp).toBe(0)
      expect(traces.at(-1)?.timestamp).toBeGreaterThan(15_000)
    })

    it('leaves a profile that already fits completely alone', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        maxBytes: 4 * 1024 * 1024,
        sleep: async () => jsc.feed(9),
      })

      const result = await capture.request('signal', 10)

      if (result.suppressed) throw new Error('unreachable')
      const envelope = readEnvelope(result.path)
      expect(envelope.traceCount).toBe(9)
      expect(envelope.tracesDropped).toBeUndefined()
      expect(envelope.tracesSampled).toBeUndefined()
    })

    it('holds its own profiles under the directory cap, and never the other component', async () => {
      const jsc = fatJsc()
      const clock = fakeClock()
      mkdirSync(profileDir(root), { recursive: true })
      writeFileSync(join(profileDir(root), 'daemon-keep.json'), 'x'.repeat(400 * 1024))
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        now: clock.now,
        jsc: jsc.api,
        effectiveSample: SLOW_SAMPLER,
        minIntervalMs: 0,
        maxBytes: 128 * 1024,
        maxComponentBytes: 300 * 1024,
        sleep: async () => jsc.feed(400),
      })

      for (let i = 0; i < 6; i += 1) {
        await capture.request('signal', 10)
        clock.advance(60_000)
      }

      const dir = profileDir(root)
      const mine = readdirSync(dir).filter((name) => name.startsWith('server-'))
      const bytes = mine.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
      expect(bytes).toBeLessThanOrEqual(300 * 1024)
      expect(mine.length).toBeGreaterThan(0)
      // The oldest went, the newest stayed.
      expect(mine.sort().at(-1)).toContain('2026-09-10T12-05-00')
      expect(existsSync(join(dir, 'daemon-keep.json'))).toBe(true)
    })
  })
})

describe('the profile-request side channel', () => {
  it('carries a duration from the requester to the handler, once', () => {
    writeProfileRequest(root, 30)
    expect(existsSync(profileRequestPath(root))).toBe(true)

    expect(takeProfileRequest(root)).toBe(30)
    // Consumed: a file left behind would silently re-apply its duration to every
    // later signal, including the ones sent by hand that should get the default.
    expect(existsSync(profileRequestPath(root))).toBe(false)
    expect(takeProfileRequest(root)).toBe(10)
  })

  it('falls back to the default for an absent, malformed or nonsensical request', () => {
    expect(takeProfileRequest(root, 7)).toBe(7)

    for (const body of [
      'not json',
      '{}',
      '{"seconds":"soon"}',
      '{"seconds":-4}',
      '{"seconds":0}',
    ]) {
      writeFileSync(profileRequestPath(root), body)
      expect(takeProfileRequest(root, 7)).toBe(7)
      // Dropped either way, so a corrupt file cannot wedge every later signal.
      expect(existsSync(profileRequestPath(root))).toBe(false)
    }
  })
})
