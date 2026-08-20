import { describe, expect, it } from 'vitest'
import {
  buildsSliceBudgetArgv,
  parseByteSize,
  parseTaskCount,
  resolveBuildBudget,
  resolveBuildsSliceBudget,
  resolveScopeBudget,
  resolveSessionsSliceHigh,
  scopeBudgetProperties,
  sliceBudgetArgv,
} from './scope.js'

const GIB = 1024 ** 3
/** A 16 GiB host, so the derived per-session share is inside the clamp. */
const HOST = 16 * GIB

describe('scope budgets', () => {
  it('derives a per-session memory ceiling from host RAM and sets NO high band', () => {
    const budget = resolveScopeBudget('session', {}, HOST)
    expect(budget.memoryMaxBytes).toBe(8 * GIB)
    /**
     * NO `MemoryHigh`, and that is the whole finding. It throttles reclaim
     * rather than killing, so ANY band below the ceiling can wedge a runaway
     * that never escapes the high line to reach the max line — measured with
     * swap off, a 90% band produced 1759 throttle events, zero kills, and a
     * workload still crawling when the arm ended. A wedged agent is worse than
     * a killed one because nothing reports it.
     */
    expect(budget).not.toHaveProperty('memoryHighBytes')
  })

  it('gives a session no swap, so the ceiling is the whole bound', () => {
    // MemoryMax alone lets a runaway page into this host's 40 GiB of swap and
    // take the machine down without one OOM kill — but swap is an INDEPENDENT
    // cgroup v2 limit, so an equal MemorySwapMax (the first cut) doubles the
    // real ceiling instead of fitting inside it.
    expect(resolveScopeBudget('session', {}, HOST).memorySwapMaxBytes).toBe(0)
  })

  it('takes an explicit swap allowance, including a literal zero', () => {
    expect(
      resolveScopeBudget('session', { PODIUM_SESSION_MEMORY_SWAP_MAX: '2G' }, HOST)
        .memorySwapMaxBytes,
    ).toBe(2 * GIB)
    // "No swap" must be expressible as the number it is, not only as a default.
    expect(
      resolveScopeBudget('session', { PODIUM_SESSION_MEMORY_SWAP_MAX: '0' }, HOST)
        .memorySwapMaxBytes,
    ).toBe(0)
    // …and unbounded is still its own answer.
    expect(
      resolveScopeBudget('session', { PODIUM_SESSION_MEMORY_SWAP_MAX: 'infinity' }, HOST),
    ).not.toHaveProperty('memorySwapMaxBytes')
  })

  it('honours an explicit high band as the reclaim-only policy it is', () => {
    // The knob stays for an operator who wants throttling instead of killing —
    // it is just never the default.
    expect(
      resolveScopeBudget('session', { PODIUM_SESSION_MEMORY_HIGH: '3G' }, HOST).memoryHighBytes,
    ).toBe(3 * GIB)
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

  it('never lets a session knob raise or lift an attach budget', () => {
    // Clamping the max alone left two holes: a high band taken from the session
    // knob can sit ABOVE the attach hard cap (a warning line the scope can
    // never reach), and `infinity` parses to "unbounded", which passed straight
    // through and left a client terminal with no limit at all.
    const attach = resolveScopeBudget(
      'attach',
      { PODIUM_SESSION_MEMORY_HIGH: '4G', PODIUM_SESSION_MEMORY_MAX: 'infinity' },
      HOST,
    )
    expect(attach.memoryMaxBytes).toBe(1 * GIB)
    expect(attach.memoryHighBytes as number).toBeLessThanOrEqual(attach.memoryMaxBytes as number)
    expect(attach.memorySwapMaxBytes).toBe(0)
    expect(resolveScopeBudget('attach', { PODIUM_SESSION_TASKS_MAX: 'off' }, HOST).tasksMax).toBe(
      256,
    )
    // Lowering still works: an operator shrinking sessions shrinks terminals.
    expect(
      resolveScopeBudget('attach', { PODIUM_SESSION_MEMORY_MAX: '256M' }, HOST).memoryMaxBytes,
    ).toBe(256 * 1024 ** 2)
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

describe('build budgets', () => {
  it('kills rather than throttles: a build scope carries no MemoryHigh at all', () => {
    // A `High` throttles reclaim, and a workload whose demand exceeds `Max`
    // never escapes the throttle to REACH `Max` — measured, a hog under a high
    // band survived two minutes while the same hog without one died in 507 ms.
    // A wedged build holds the update lock and reports nothing; a killed one
    // fails visibly. So: no band.
    const budget = resolveBuildBudget({}, HOST)
    expect(budget.memoryHighBytes).toBeUndefined()
    expect(scopeBudgetProperties(budget).some((p) => p.startsWith('--property=MemoryHigh='))).toBe(
      false,
    )
    expect(scopeBudgetProperties(budget)).toContain('--property=OOMPolicy=continue')
  })

  it('gives a build no swap, because a build is never idle', () => {
    // `MemoryMax` alone bounds nothing on a host with swap: the kernel pages the
    // excess out and the box stops responding without one OOM kill.
    expect(resolveBuildBudget({}, HOST).memorySwapMaxBytes).toBe(0)
    expect(scopeBudgetProperties(resolveBuildBudget({}, HOST))).toContain(
      '--property=MemorySwapMax=0',
    )
    // And an operator's explicit `0` must read as the value it is rather than
    // as a typo that quietly restores a default.
    expect(resolveBuildBudget({ PODIUM_BUILD_MEMORY_SWAP_MAX: '0' }, HOST).memorySwapMaxBytes).toBe(
      0,
    )
    expect(
      resolveBuildBudget({ PODIUM_BUILD_MEMORY_SWAP_MAX: '512M' }, HOST).memorySwapMaxBytes,
    ).toBe(512 * 1024 ** 2)
  })

  it('caps at a measured ceiling, and at a share of RAM where the box is smaller', () => {
    // A build's appetite does not scale with the host, so the default is the
    // measured peak with headroom rather than a share…
    expect(resolveBuildBudget({}, HOST).memoryMaxBytes).toBe(4 * GIB)
    // …but a ceiling above what the host has bounds nothing, so the share wins
    // on a small VPS and a build too big for the box fails fast.
    expect(resolveBuildBudget({}, 4 * GIB).memoryMaxBytes).toBe(2 * GIB)
  })

  it('takes its own knobs, never the session ones', () => {
    // An operator who raised the cap for one big AGENT did not thereby ask for
    // bigger builds.
    expect(resolveBuildBudget({ PODIUM_SESSION_MEMORY_MAX: '40G' }, HOST).memoryMaxBytes).toBe(
      4 * GIB,
    )
    expect(resolveBuildBudget({ PODIUM_BUILD_MEMORY_MAX: '40G' }, HOST).memoryMaxBytes).toBe(
      40 * GIB,
    )
    expect(
      resolveBuildBudget({ PODIUM_BUILD_MEMORY_MAX: 'infinity' }, HOST).memoryMaxBytes,
    ).toBeUndefined()
    expect(resolveBuildBudget({ PODIUM_BUILD_TASKS_MAX: '8' }, HOST).tasksMax).toBe(8)
    expect(resolveBuildBudget({ PODIUM_NO_SESSION_BUDGET: '1' }, HOST)).toEqual({})
  })

  it('caps the builds slice as a group, and MAY kill it', () => {
    // The opposite call from the sessions slice, and for a reason: three build
    // units can be live at once, so three per-scope caps are not a bound — and
    // collective death of builds costs a redeploy, not a conversation.
    const budget = resolveBuildsSliceBudget({}, HOST)
    expect(budget.memoryMaxBytes).toBe(Math.floor(HOST * 0.5))
    expect(buildsSliceBudgetArgv('podium-builds.slice', budget)).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'podium-builds.slice',
      `MemoryMax=${Math.floor(HOST * 0.5)}`,
      'MemorySwapMax=0',
    ])
    expect(buildsSliceBudgetArgv('podium-builds.slice', {})).toEqual([])
    expect(resolveBuildsSliceBudget({ PODIUM_NO_SESSION_BUDGET: '1' }, HOST)).toEqual({})
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
