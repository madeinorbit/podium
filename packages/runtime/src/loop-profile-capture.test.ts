import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopMinute } from './loop-accounting'
import {
  createProfileCapture,
  type LoopProfileEnvelope,
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

    it('reports the main-thread time it has spent keeping the buffer clear', async () => {
      const jsc = fakeJsc()
      const capture = createProfileCapture({
        component: 'server',
        level: 'attribution',
        dir: root,
        jsc: jsc.api,
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
