import { describe, expect, it } from 'vitest'
import {
  parseByteSize,
  parseTaskCount,
  resolveScopeBudget,
  resolveSessionsSliceHigh,
  scopeBudgetProperties,
  sliceBudgetArgv,
} from './scope.js'

const GIB = 1024 ** 3
/** A 16 GiB host, so the derived per-session share is inside the clamp. */
const HOST = 16 * GIB

describe('scope budgets', () => {
  it('derives a per-session memory budget from host RAM, with the high band under the max', () => {
    const budget = resolveScopeBudget('session', {}, HOST)
    expect(budget.memoryMaxBytes).toBe(8 * GIB)
    // The band is NARROW on purpose: `MemoryHigh` throttles reclaim rather than
    // killing, so a low one turns a runaway into a permanent crawl (measured:
    // ~1000 throttle events in four seconds with no progress).
    expect(budget.memoryHighBytes).toBe(Math.floor(8 * GIB * 0.9))
    expect(budget.memoryHighBytes as number).toBeLessThan(budget.memoryMaxBytes as number)
  })

  it('bounds swap as well as memory — a cap the kernel can page around is not a cap', () => {
    // The host this was written on carries 40 GiB of swap. MemoryMax alone lets
    // a runaway page into it and take the machine down without one OOM kill.
    expect(resolveScopeBudget('session', {}, HOST).memorySwapMaxBytes).toBe(8 * GIB)
  })

  it('clamps the derived budget so a tiny VPS and a huge workstation both get a usable one', () => {
    expect(resolveScopeBudget('session', {}, 1 * GIB).memoryMaxBytes).toBe(2 * GIB)
    expect(resolveScopeBudget('session', {}, 256 * GIB).memoryMaxBytes).toBe(16 * GIB)
  })

  it('gives an attach scope a client-sized budget, never the session knob', () => {
    // A client terminal is reclaimed FIRST under pressure; inheriting several
    // gigabytes from the session knob would defeat the point.
    const attach = resolveScopeBudget('attach', { PODIUM_SESSION_MEMORY_MAX: '8G' }, HOST)
    expect(attach.memoryMaxBytes).toBe(1 * GIB)
    expect(attach.tasksMax).toBe(256)
  })

  it('lets an operator raise, lower, or lift each limit', () => {
    const raised = resolveScopeBudget(
      'session',
      { PODIUM_SESSION_MEMORY_MAX: '40G', PODIUM_SESSION_TASKS_MAX: '99' },
      HOST,
    )
    expect(raised.memoryMaxBytes).toBe(40 * GIB)
    expect(raised.tasksMax).toBe(99)
    // `infinity` is an ANSWER, not an unparseable value falling back to the
    // default: an operator who needs a 40 GiB build must be able to say so.
    const lifted = resolveScopeBudget('session', { PODIUM_SESSION_MEMORY_MAX: 'infinity' }, HOST)
    expect(lifted).not.toHaveProperty('memoryMaxBytes')
    // And the derived high band goes with it: a warning band under a limit that
    // no longer exists is the throttle-without-a-kill trap on purpose.
    expect(lifted).not.toHaveProperty('memoryHighBytes')
  })

  it('drops every limit under PODIUM_NO_SESSION_BUDGET but keeps the hierarchy', () => {
    expect(resolveScopeBudget('session', { PODIUM_NO_SESSION_BUDGET: '1' }, HOST)).toEqual({})
    expect(resolveSessionsSliceHigh({ PODIUM_NO_SESSION_BUDGET: '1' }, HOST)).toBeUndefined()
  })

  it('throttles the sessions slice as a group and never kills it', () => {
    // No `MemoryMax` here, ever: a Max on the slice is collective OOM death,
    // which is the one thing the hierarchy exists to prevent.
    const high = resolveSessionsSliceHigh({}, HOST)
    expect(high).toBe(Math.floor(HOST * 0.75))
    expect(sliceBudgetArgv('podium-sessions.slice', high as number)).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'podium-sessions.slice',
      `MemoryHigh=${high}`,
    ])
  })

  it('always carries OOMPolicy=continue, so one killed child is not a killed session', () => {
    // Verified against a live user manager: the kernel killed the child (137),
    // the parent kept running, and the scope stayed active.
    expect(scopeBudgetProperties({})).toEqual(['--property=OOMPolicy=continue'])
    expect(scopeBudgetProperties({ memoryMaxBytes: 42 })).toContain('--property=MemoryMax=42')
  })
})

describe('size parsing', () => {
  it('reads systemd-style sizes and separates "unset" from "unbounded"', () => {
    expect(parseByteSize('6G')).toBe(6 * GIB)
    expect(parseByteSize('512M')).toBe(512 * 1024 ** 2)
    expect(parseByteSize('1048576')).toBe(1048576)
    expect(parseByteSize(undefined)).toBeUndefined()
    expect(parseByteSize('infinity')).toBeNull()
    // Garbage reads as "not configured" rather than as zero: a typo must not
    // silently give a session a budget of nothing.
    expect(parseByteSize('lots')).toBeUndefined()
    expect(parseTaskCount('64')).toBe(64)
    expect(parseTaskCount('off')).toBeNull()
    expect(parseTaskCount('-3')).toBeUndefined()
  })
})
