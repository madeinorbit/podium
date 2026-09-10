import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatControlCosts, startLoopAttribution } from './loop-attribution'

describe('formatControlCosts', () => {
  it('orders control types by synchronous wall cost and reports count and heap pressure', () => {
    const costs = new Map([
      ['resize', { count: 20, wallMs: 12.4, heapBytes: 512 * 1024 }],
      ['reattach', { count: 2, wallMs: 140.6, heapBytes: 8 * 1024 * 1024 }],
    ])

    expect(formatControlCosts(costs)).toBe('reattach:2/141ms/+8.0MB,resize:20/12ms/+0.5MB')
  })
})

/**
 * The attribution module under a STATED level.
 *
 * `timeTask`, `beginControlTurn` and the runtime's `measureTask` all read the
 * level at IMPORT, and a test run resolves `off` (POD-3827) — so reading whatever
 * this runner happens to carry would assert the environment rather than the
 * wiring. `loop-accounting` is re-imported alongside, because `vi.resetModules`
 * gives the fresh graph its own bucket registry and a spy registered in the old
 * one would never be called.
 */
async function attributing() {
  process.env.PODIUM_LOOP_PROFILE = 'attribution'
  vi.resetModules()
  const accounting = await import('@podium/runtime/loop-accounting')
  const subject = await import('./loop-attribution')
  const buckets: [string, number][] = []
  accounting.addLoopAccounting({ attribute: (bucket, wallMs) => buckets.push([bucket, wallMs]) })
  return { ...subject, buckets }
}

/** Save and restore the level, so one test's statement cannot leak into the next. */
function withStatedLevel(): void {
  let prior: string | undefined
  beforeEach(() => {
    prior = process.env.PODIUM_LOOP_PROFILE
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.PODIUM_LOOP_PROFILE
    else process.env.PODIUM_LOOP_PROFILE = prior
    vi.resetModules()
  })
}

/**
 * Daemon parity (§6.3). The daemon had the counters and the per-stall line; what
 * it did not have is the scheduler patch, the cost buckets, or any way to read its
 * own totals out of a live process. These pin each of those.
 */
describe('daemon bucket attribution', () => {
  withStatedLevel()

  it('bills each daemon seam label to its own bucket', async () => {
    const { timeTask, buckets } = await attributing()
    timeTask('controlParse', () => undefined)
    timeTask('controlDispatch(input)', () => undefined)
    timeTask('tailBatch(4)', () => undefined)
    timeTask('publishConv(2)', () => undefined)
    // `sql` is the bucket the daemon must NEVER fill: it runs no statements, and
    // an absent bucket is how a reader tells that apart from "zero SQL today".
    expect(buckets.map(([bucket]) => bucket)).toEqual(['control', 'control', 'tails', 'worker'])
    expect(buckets.map(([, wallMs]) => wallMs >= 0)).toEqual([true, true, true, true])
  })

  it('returns the timed value and still reports the cost', async () => {
    const { timeTask, buckets } = await attributing()
    expect(timeTask('controlParse', () => 'decoded')).toBe('decoded')
    expect(buckets).toHaveLength(1)
  })

  it('bills a control turn ONCE, through its dispatch regions and not the turn', async () => {
    const { timeTask, beginControlTurn, buckets } = await attributing()
    // A real turn: the finisher wraps the parse and dispatch that `timeTask`
    // already bills. If `beginControlTurn` fed the bucket too, the same
    // milliseconds would land in `control` twice and coverage would climb past 1
    // with nothing declared nested to explain it.
    const finish = beginControlTurn()
    timeTask('controlParse', () => undefined)
    timeTask('controlDispatch(resize)', () => undefined)
    finish('resize')
    expect(buckets.map(([bucket]) => bucket)).toEqual(['control', 'control'])
  })
})

describe('startLoopAttribution', () => {
  it('installs nothing when the level is below attribution', () => {
    const scheduler = globalThis.setTimeout
    const stop = startLoopAttribution(false)
    expect(globalThis.setTimeout).toBe(scheduler)
    stop()
  })

  it('patches the schedulers, and puts them back', () => {
    const scheduler = globalThis.setTimeout
    const stop = startLoopAttribution(true)
    // The patch is what the daemon was missing entirely: a timer created before
    // it goes on is never measured, however long its callback blocks for.
    expect(globalThis.setTimeout).not.toBe(scheduler)
    stop()
    expect(globalThis.setTimeout).toBe(scheduler)
  })

  it('registers NO signal handler — the composition root owns the one SIGUSR2 slot', () => {
    // `SIGUSR2` is one process-wide slot that two dumps share: the profile
    // capture POD-3819 registers in host-runtime.ts, and the totals dump called
    // from inside that same callback. A second `process.on` would not replace the
    // first, it would run alongside it, and a reader could not tell the two dumps
    // apart — so the root holds the single listener and this module holds none.
    const listeners = process.listeners('SIGUSR2').length
    const stop = startLoopAttribution(true)
    expect(process.listeners('SIGUSR2')).toHaveLength(listeners)
    stop()
  })
})

describe('dumpLoopTotals', () => {
  withStatedLevel()

  it('logs the task totals and the control-type costs', async () => {
    const { timeTask, beginControlTurn, dumpLoopTotals } = await attributing()
    const warn = vi.fn()
    timeTask('controlParse', () => undefined)
    const finish = beginControlTurn()
    finish('dumpProbe')
    dumpLoopTotals({ warn })
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'task totals',
      'control type costs',
    ])
    const [, taskFields] = warn.mock.calls[0] ?? []
    expect((taskFields?.totals as string[]).join(' ')).toContain('controlParse')
    const [, controlFields] = warn.mock.calls[1] ?? []
    // The LIFETIME map, which is the point of a dump: it answers "since boot",
    // where the per-second window only describes the second that stalled.
    expect(controlFields?.types).toContain('dumpProbe:1/')
  })

  it('survives a dump before anything has been recorded', async () => {
    const { dumpLoopTotals } = await attributing()
    const warn = vi.fn()
    expect(() => dumpLoopTotals({ warn })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
