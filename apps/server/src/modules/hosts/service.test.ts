import type { HostMetricsWire, SessionId } from '@podium/model'
import { asMachineId, asSessionId } from '@podium/model'
import { PodiumSettings } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogs } from '../../test-support/capture-logs'
import { EventBus } from '../bus'
import { type HostSessionView, type HostsDeps, HostsService } from './service'

const NOW = new Date('2026-07-17T12:00:00.000Z').getTime()
const HOUR = 60 * 60_000

function session(sessionId: SessionId, overrides: Partial<HostSessionView> = {}): HostSessionView {
  return {
    sessionId,
    machineId: asMachineId('local'),
    status: 'live',
    agentKind: 'claude-code',
    resume: { kind: 'claude-session', value: sessionId },
    agentState: {
      phase: 'idle',
      since: new Date(NOW - HOUR).toISOString(),
      nativeSubagentCount: 0,
      idle: { kind: 'done' },
    },
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    lastResumedAtMs: 0,
    lastInputAtMs: 0,
    lastOutputAtMs: 0,
    ...overrides,
  }
}

/** Unobserved harness agent: phase stays unknown (hooks never installed). */
function unobserved(
  sessionId: SessionId,
  overrides: Partial<HostSessionView> = {},
): HostSessionView {
  return session(sessionId, {
    agentState: {
      phase: 'unknown',
      since: new Date(NOW - 5 * HOUR).toISOString(),
      nativeSubagentCount: 0,
    },
    lastActiveAt: new Date(NOW - 5 * HOUR).toISOString(),
    lastInputAtMs: NOW - 5 * HOUR,
    lastOutputAtMs: NOW - 5 * HOUR,
    ...overrides,
  })
}

function shell(sessionId: SessionId, overrides: Partial<HostSessionView> = {}): HostSessionView {
  return session(sessionId, {
    agentKind: 'shell',
    resume: undefined,
    agentState: undefined,
    lastActiveAt: new Date(NOW - 5 * HOUR).toISOString(),
    lastInputAtMs: NOW - 5 * HOUR,
    lastOutputAtMs: NOW - 5 * HOUR,
    ...overrides,
  })
}

function sample(
  usedPct: number,
  load?: { one: number; cpuCount: number },
): Omit<HostMetricsWire, 'machineId' | 'name'> {
  return {
    hostname: 'box',
    sampledAt: new Date(Date.now()).toISOString(),
    memory: {
      totalBytes: 100,
      availableBytes: 100 - usedPct,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    },
    ...(load
      ? {
          load: {
            one: load.one,
            five: load.one,
            fifteen: load.one,
            cpuCount: load.cpuCount,
          },
        }
      : {}),
  }
}

/**
 * THE FAKES RESOLVE, THEY DO NOT RETURN (POD-3263).
 *
 * Every port these stand in for is a durable read now. A synchronous fake
 * satisfies BOTH the awaited and the un-awaited spelling of its call site, so it
 * cannot fail on a dropped await — the value simply arrives early. Returning
 * promises is what makes a missing `await` show up as a `Promise` where a value
 * was expected, which is the only thing that distinguishes a converted call site
 * from one that merely compiles.
 */
function harness(input: {
  sessions: HostSessionView[]
  maxIdleSessions: number | null
  enabled?: boolean
  loadPerCore?: number | null
  idleShellMinutes?: number | null
  transferFenceActive?: () => boolean
  backstopMinutes?: number | null
  scheduledWakeups?: Set<string>
  fail?: Set<string>
  proven?: Set<string>
  daemonRequest?: HostsDeps['daemonRequest']
}) {
  const settings = PodiumSettings.parse({
    hibernation: {
      enabled: input.enabled ?? true,
      memoryPct: 80,
      idleMinutes: 30,
      maxIdleSessions: input.maxIdleSessions,
      ...(input.loadPerCore !== undefined ? { loadPerCore: input.loadPerCore } : {}),
      ...(input.idleShellMinutes !== undefined ? { idleShellMinutes: input.idleShellMinutes } : {}),
      ...(input.backstopMinutes !== undefined ? { backstopMinutes: input.backstopMinutes } : {}),
    },
  })
  const parked: string[] = []
  const shellParked: string[] = []
  const hibernateRequireProof: Array<{ sessionId: string; requireTerminalProof?: boolean }> = []
  const toMachine: Array<{ machineId: string; type: string }> = []
  const deps: HostsDeps = {
    getSettings: async () => settings,
    transferFenceActive: input.transferFenceActive ?? (() => false),
    clients: () => [],
    machineName: async (id) => id,
    sessions: async () => input.sessions,
    hibernateSession: async ({ sessionId, requireTerminalProof }) => {
      hibernateRequireProof.push({ sessionId, requireTerminalProof })
      if (input.fail?.has(sessionId)) return { ok: false, reason: 'raced' }
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (target?.status !== 'live') return { ok: false, reason: 'not running' }
      if (!target.resume)
        return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
      target.status = 'hibernated'
      parked.push(sessionId)
      return { ok: true }
    },
    parkStaleSession: async ({ sessionId }) => {
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (!target || target.status !== 'live') return { ok: false, reason: 'not running' }
      target.status = target.resume ? 'hibernated' : 'exited'
      parked.push(sessionId)
      return { ok: true }
    },
    hasScheduledWakeup: async (sessionId) => input.scheduledWakeups?.has(sessionId) ?? false,
    parkShellSession: async ({ sessionId }) => {
      if (input.fail?.has(sessionId)) return { ok: false, reason: 'raced' }
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (target?.status !== 'live') return { ok: false, reason: 'not running' }
      if (target.agentKind !== 'shell') return { ok: false, reason: 'not a shell session' }
      target.status = 'hibernated'
      shellParked.push(sessionId)
      return { ok: true }
    },
    hasValidTerminalProof: async (sessionId) => input.proven?.has(sessionId) ?? true,
    terminalProofMissing: async (sessionId) => !(input.proven?.has(sessionId) ?? true),
    // The auto-hibernate sweep makes no daemon round-trip, so an inert
    // correlator is enough here — a call to one would be the failure.
    daemonRequest:
      input.daemonRequest ??
      ({
        request: vi.fn(),
        settle: vi.fn(),
        nextRequestId: vi.fn(),
      } as unknown as HostsDeps['daemonRequest']),
    toMachine: (machineId, message) => {
      toMachine.push({ machineId, type: message.type })
    },
  }
  return {
    service: new HostsService(deps, new EventBus()),
    parked,
    shellParked,
    hibernateRequireProof,
    toMachine,
  }
}

describe('idle-session cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('converges below the cap without memory pressure, oldest effective idle first', async () => {
    const sessions = [
      session(asSessionId('old-activity-recent-input'), {
        lastActiveAt: new Date(NOW - 3 * HOUR).toISOString(),
        lastInputAtMs: NOW - 40 * 60_000,
      }),
      session(asSessionId('old-effective-idle'), {
        lastActiveAt: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      session(asSessionId('newest'), {
        lastActiveAt: new Date(NOW - HOUR).toISOString(),
      }),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 2 })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['old-effective-idle'])
  })

  it('allows zero and re-evaluates after every successful hibernation', async () => {
    const sessions = [
      session(asSessionId('one')),
      session(asSessionId('two')),
      session(asSessionId('three')),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['one', 'two', 'three'])
    expect(sessions.every((item) => item.status === 'hibernated')).toBe(true)
  })

  it('uses a separate conservative burst and refill budget per machine', async () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(asSessionId(`s${index}`)))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    await service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    await service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    vi.advanceTimersByTime(15_000)
    await service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(5)
  })

  it('keeps memory pressure independent of the count target and its limiter', async () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(asSessionId(`s${index}`)))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    await service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    // Count pressure has exhausted its burst, but memory has its own budget.
    await service.onHostMetrics(asMachineId('local'), sample(90))
    expect(parked).toHaveLength(5)
  })

  it('hibernates for memory pressure even when the idle count is below its target', async () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 10 })

    await service.onHostMetrics(asMachineId('local'), sample(90))

    expect(parked).toEqual(['one'])
  })

  /**
   * SPEC §5's RECLAIM ORDER. An attach terminal is a convenience someone opened
   * onto a session; the session is the work. Parking an agent while a warm
   * terminal — possibly the very thing that crossed the threshold — sits idle is
   * the inversion §5 rules out.
   */
  it('gives back client terminals BEFORE parking any agent under memory pressure', async () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked, toMachine } = harness({ sessions, maxIdleSessions: 10 })

    await service.onHostMetrics(asMachineId('local'), {
      ...sample(90),
      reclaimableAttachments: 2,
    })

    expect(toMachine).toEqual([{ machineId: 'local', type: 'reclaimAttachments' }])
    // INSTEAD OF, not before: this sample takes no session at all. The next one
    // re-reads real memory — if freeing the terminals was enough, no agent was
    // ever touched.
    expect(parked).toEqual([])
  })

  it('parks an agent on the NEXT sample when giving the terminals back was not enough', async () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked, toMachine } = harness({ sessions, maxIdleSessions: 10 })

    await service.onHostMetrics(asMachineId('local'), { ...sample(90), reclaimableAttachments: 1 })
    expect(parked).toEqual([])

    // The cooldown the reclaim spent has to pass, exactly as a park's would.
    vi.advanceTimersByTime(60_000)
    await service.onHostMetrics(asMachineId('local'), { ...sample(90), reclaimableAttachments: 0 })

    expect(toMachine).toHaveLength(1)
    expect(parked).toEqual(['one'])
  })

  it('parks as it always did for a daemon too old to report attachments', async () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked, toMachine } = harness({ sessions, maxIdleSessions: 10 })

    // `undefined`, not 0 — the field is absent from the sample entirely. A
    // mixed-version fleet must not stall its pressure relief waiting for a
    // machine that has nothing to give.
    await service.onHostMetrics(asMachineId('local'), sample(90))

    expect(toMachine).toEqual([])
    expect(parked).toEqual(['one'])
  })

  it('hibernates for load pressure using load1/cores (not load5) at the default threshold', async () => {
    // POD-526-shaped host: load1 14 on 8 cores = 1.75× ≥ default 1.5×.
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 10 })

    await service.onHostMetrics(asMachineId('local'), sample(10, { one: 14, cpuCount: 8 }))

    expect(parked).toEqual(['one'])
  })

  it('ignores load pressure when loadPerCore is null (off)', async () => {
    const sessions = [session(asSessionId('one'))]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: null,
      loadPerCore: null,
    })

    await service.onHostMetrics(asMachineId('local'), sample(10, { one: 100, cpuCount: 1 }))

    expect(parked).toEqual([])
  })

  it('ignores a sample with no load field (pre-field daemon)', async () => {
    const sessions = [session(asSessionId('one'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: null })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual([])
  })

  it('keeps load pressure independent of the count target and its limiter', async () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(asSessionId(`s${index}`)))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    await service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    // Count pressure has exhausted its burst, but load has its own budget
    // (shared with memory via the per-machine cooldown map).
    await service.onHostMetrics(asMachineId('local'), sample(10, { one: 20, cpuCount: 8 }))
    expect(parked).toHaveLength(5)
  })

  it('shares the memory cooldown map so dual pressure parks once per window', async () => {
    const sessions = [
      session(asSessionId('first')),
      session(asSessionId('second')),
      session(asSessionId('third')),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: null })

    // Memory parks first and spends the shared cooldown; load must not double-park.
    await service.onHostMetrics(asMachineId('local'), sample(90, { one: 20, cpuCount: 8 }))
    expect(parked).toEqual(['first'])

    await service.onHostMetrics(asMachineId('local'), sample(90, { one: 20, cpuCount: 8 }))
    expect(parked).toEqual(['first'])
  })

  it('refuses legacy or unfenced sessions without a terminal proof', async () => {
    const sessions = [session(asSessionId('legacy')), session(asSessionId('proven'))]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: 1,
      proven: new Set(['proven']),
    })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['proven'])
    expect(sessions[0]?.status).toBe('live')
  })

  it('logs a mixed-version terminal rejected solely for missing proof once', async () => {
    const logs = captureLogs()
    const sessions = [session(asSessionId('legacy'))]
    const { service } = harness({
      sessions,
      maxIdleSessions: null,
      proven: new Set(),
    })

    await service.onHostMetrics(asMachineId('local'), sample(90))
    await service.onHostMetrics(asMachineId('local'), sample(90))

    // ONCE, and about THIS session. `legacy` is the session id: it used to be
    // pinned by sitting next to the reason in the sentence, and is now its own
    // field, which says the same thing without depending on the wording.
    expect(logs.at('warn')).toHaveLength(1)
    expect(logs.at('warn')[0]).toMatchObject({
      msg: expect.stringContaining('missing durable terminal proof'),
      sessionId: 'legacy',
    })
    logs.restore()
  })

  it('runs count pressure even when the memory sample cannot produce a percentage', async () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 1 })
    const invalidMemory = sample(10)
    invalidMemory.memory.totalBytes = 0
    invalidMemory.memory.availableBytes = 0

    await service.onHostMetrics(asMachineId('local'), invalidMemory)

    expect(parked).toEqual(['one'])
  })
  it('retries memory pressure after a race without spending the cooldown', async () => {
    const failures = new Set(['raced'])
    const sessions = [
      session(asSessionId('raced')),
      session(asSessionId('next')),
      session(asSessionId('later')),
    ]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: null,
      fail: failures,
    })

    await service.onHostMetrics(asMachineId('local'), sample(90))
    expect(parked).toEqual(['next'])

    failures.clear()
    await service.onHostMetrics(asMachineId('local'), sample(90))
    expect(parked).toEqual(['next'])
  })

  it('keeps count-pressure burst budgets independent per machine', async () => {
    const sessions = [
      ...Array.from({ length: 5 }, (_, index) =>
        session(asSessionId(`a${index}`), { machineId: asMachineId('a') }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        session(asSessionId(`b${index}`), { machineId: asMachineId('b') }),
      ),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    await service.onHostMetrics(asMachineId('a'), sample(10))
    await service.onHostMetrics(asMachineId('b'), sample(10))

    expect(parked.filter((id) => id.startsWith('a'))).toHaveLength(4)
    expect(parked.filter((id) => id.startsWith('b'))).toHaveLength(4)
  })

  it('tries another eligible candidate after a hibernation race', async () => {
    const sessions = [session(asSessionId('raced')), session(asSessionId('next'))]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: 1,
      fail: new Set(['raced']),
    })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['next'])
  })

  it('reports the remaining overage when protected sessions prevent convergence', async () => {
    const logs = captureLogs()
    const sessions = [
      session(asSessionId('parkable')),
      session(asSessionId('no-resume'), { resume: undefined }),
      session(asSessionId('recent'), { lastActiveAt: new Date(NOW - 5 * 60_000).toISOString() }),
      session(asSessionId('question'), {
        agentState: {
          phase: 'needs_user',
          since: new Date(NOW - HOUR).toISOString(),
          nativeSubagentCount: 0,
        },
      }),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['parkable'])
    expect(logs.at('info')).toContainEqual(
      expect.objectContaining({ msg: expect.stringContaining('cap unmet'), overage: 3 }),
    )
    logs.restore()
    expect(service.hostMetricsMessage()).toMatchObject({ hosts: [{ idleCapUnmet: 3 }] })
  })

  it('disables both memory and count pressure when hibernation is disabled', async () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0, enabled: false })

    await service.onHostMetrics(asMachineId('local'), sample(90))

    expect(parked).toEqual([])
  })

  it('keeps metrics live but defers idle-shell parking until the transfer fence opens', async () => {
    let fenced = true
    const sessions = [shell(asSessionId('idle-shell'))]
    const { service, shellParked } = harness({
      sessions,
      maxIdleSessions: null,
      idleShellMinutes: 30,
      transferFenceActive: () => fenced,
    })

    await service.onHostMetrics(asMachineId('local'), sample(10))
    expect(service.hostMetricsMessage()).toMatchObject({
      hosts: [{ hostname: 'box', machineId: 'local' }],
    })
    expect(shellParked).toEqual([])
    expect(sessions[0]?.status).toBe('live')
    // A premature resume request remains write-free while SQLite is fenced.
    await service.resumeAfterTransferFence()
    expect(shellParked).toEqual([])

    fenced = false
    await service.resumeAfterTransferFence()
    expect(shellParked).toEqual(['idle-shell'])
    expect(sessions[0]?.status).toBe('hibernated')
  })

  it('leaves count pressure off when the target is unlimited', async () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: null })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual([])
  })

  // POD-568. Finished work is reaped first, and that is ALL the lifecycle tier
  // does — every case below keeps the safety gates deciding who may be parked.
  describe('lifecycle ordering', () => {
    it('reaps closed work first, then unbound sessions, then open work', async () => {
      // Idle age is deliberately INVERTED against the tiers: the open-issue
      // session is the oldest, so age alone would park it first.
      const sessions = [
        session(asSessionId('open'), {
          issueClosed: false,
          lastActiveAt: new Date(NOW - 5 * HOUR).toISOString(),
        }),
        session(asSessionId('unbound'), {
          lastActiveAt: new Date(NOW - 3 * HOUR).toISOString(),
        }),
        session(asSessionId('closed'), {
          issueClosed: true,
          lastActiveAt: new Date(NOW - HOUR).toISOString(),
        }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['closed', 'unbound', 'open'])
    })

    it('still breaks ties inside a tier by effective idle age', async () => {
      const sessions = [
        session(asSessionId('closed-newer'), {
          issueClosed: true,
          lastActiveAt: new Date(NOW - HOUR).toISOString(),
        }),
        session(asSessionId('closed-older'), {
          issueClosed: true,
          lastActiveAt: new Date(NOW - 4 * HOUR).toISOString(),
        }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['closed-older'])
    })

    // THE CASE THE OPERATOR RULED ON. An agent that marked its issue done and
    // kept writing must not be parked ahead of live work — being first in the
    // queue is not permission to skip the gates.
    it('refuses a closed-issue session that is still producing output', async () => {
      const sessions = [
        session(asSessionId('closed-but-writing'), {
          issueClosed: true,
          lastOutputAtMs: NOW - 10_000,
        }),
        session(asSessionId('open-and-quiet'), { issueClosed: false }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['open-and-quiet'])
    })

    it('refuses a closed-issue session that has not been idle long enough', async () => {
      const sessions = [
        session(asSessionId('closed-but-active'), {
          issueClosed: true,
          lastActiveAt: new Date(NOW - 5 * 60_000).toISOString(),
        }),
        session(asSessionId('open-and-idle'), { issueClosed: false }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['open-and-idle'])
    })

    it('refuses a closed-issue session with no resume ref rather than killing it', async () => {
      const sessions = [
        session(asSessionId('closed-no-resume'), { issueClosed: true, resume: undefined }),
        session(asSessionId('open-resumable'), { issueClosed: false }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['open-resumable'])
    })

    it('orders memory-pressure candidates the same way', async () => {
      const sessions = [
        session(asSessionId('open'), {
          issueClosed: false,
          lastActiveAt: new Date(NOW - 5 * HOUR).toISOString(),
        }),
        session(asSessionId('closed'), { issueClosed: true }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: null })

      await service.onHostMetrics(asMachineId('local'), sample(90))

      expect(parked).toEqual(['closed'])
    })
  })

  // POD-565. Unobserved sessions (phase unknown / no agentState) were invisible
  // to every pressure source. Count them after a long quiet window; act only
  // when a resume ref exists; shells get a separate opt-in policy.
  describe('unobserved phase (POD-565)', () => {
    it('counts a quiet unobserved agent that HAS a resume ref — it pays its own overage', async () => {
      // Cap 1: one known idle + one long-quiet unobserved holding a resume ref →
      // overage 1, and the unobserved session is itself eligible to pay it.
      const sessions = [
        session(asSessionId('known-idle')),
        unobserved(asSessionId('hookless-resumable')),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toHaveLength(1)
    })

    it('does NOT count an unobserved session nothing can park, so no observed agent pays', async () => {
      // THE REGRESSION THIS PINS. A session with no resume ref can never enter
      // hibernateSession, so counting it would raise an overage that only
      // OBSERVED agents could pay — a debt that never retires, leaving the loop
      // in cap-unmet forever. Cap 1, one known idle plus one unparkable
      // unobserved: the overage is 0 and nobody is parked.
      const sessions = [
        session(asSessionId('known-idle')),
        unobserved(asSessionId('hookless'), { resume: undefined }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(sessions[0]?.status).toBe('live')
      expect(sessions[1]?.status).toBe('live')
    })

    it('does not count a recently-active unobserved session', async () => {
      const sessions = [
        session(asSessionId('known-idle')),
        unobserved(asSessionId('still-noisy'), {
          resume: undefined,
          lastActiveAt: new Date(NOW - HOUR).toISOString(),
          lastInputAtMs: NOW - HOUR,
          lastOutputAtMs: NOW - HOUR,
        }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      // Only known-idle is in the idle-live set → under the cap of 1.
      expect(parked).toEqual([])
    })

    it('logs when unobserved quiet sessions enter the idle-live set', async () => {
      const logs = captureLogs()
      const sessions = [
        unobserved(asSessionId('hookless-a'), { resume: undefined }),
        unobserved(asSessionId('hookless-b'), { resume: undefined }),
      ]
      const { service } = harness({ sessions, maxIdleSessions: 0 })

      await service.onHostMetrics(asMachineId('local'), sample(10))
      await service.onHostMetrics(asMachineId('local'), sample(10))

      const lines = logs
        .at('info')
        .filter((r) => r.msg.includes('counting') && r.msg.includes('unobserved'))
      expect(lines).toHaveLength(1)
      // BOTH numbers. Neither of these two can be parked (no resume ref), so the
      // cap counts none of them — but the log still has to name all 2, because
      // making this tail visible is what POD-565 is for. Reporting only the
      // counted number would re-hide it. They are separate FIELDS now, so the
      // claim is on the numbers themselves rather than on a rendered sentence,
      // and `unparkable` states outright what the prose used to imply.
      expect(lines[0]).toMatchObject({ counted: 0, quiet: 2, unparkable: 2 })
      logs.restore()
    })

    it('hibernates a long-quiet unobserved agent that has a resume ref without terminal proof', async () => {
      const sessions = [unobserved(asSessionId('hookless-resumable'))]
      const { service, parked, hibernateRequireProof } = harness({
        sessions,
        maxIdleSessions: 0,
        // No terminal proof — unobserved agents never produce one.
        proven: new Set(),
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['hookless-resumable'])
      expect(hibernateRequireProof).toEqual([
        { sessionId: 'hookless-resumable', requireTerminalProof: false },
      ])
    })

    it('never routes an unobserved session without a resume ref into hibernateSession', async () => {
      const sessions = [unobserved(asSessionId('no-resume'), { resume: undefined })]
      const { service, parked, hibernateRequireProof } = harness({
        sessions,
        maxIdleSessions: 0,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(hibernateRequireProof).toEqual([])
      expect(sessions[0]?.status).toBe('live')
    })

    it('a quiet shell does not inflate the cap while idleShellMinutes is off', async () => {
      // With the shell policy off, applyShellIdlePressure never runs, so nothing
      // on this host can park a shell. Counting it would make the known-idle
      // agent pay for a session no policy is acting on. The POD-526 host had a
      // shell quiet since Jul 21 sitting behind exactly this.
      const sessions = [session(asSessionId('known-idle')), shell(asSessionId('old-shell'))]
      const { service, parked, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellMinutes: null,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(shellParked).toEqual([])
      expect(sessions[0]?.status).toBe('live')
      expect(sessions[1]?.status).toBe('live')
    })

    it('the same shell DOES count once idleShellMinutes turns the policy on', async () => {
      // The predicate follows the policy rather than a constant: switch shell
      // reaping on and the shell becomes both parkable and countable in the same
      // breath. Cap 1 with two sessions is an overage of 1; the shell is quiet
      // past the threshold, so the shell path takes it and the agent is spared.
      const sessions = [session(asSessionId('known-idle')), shell(asSessionId('old-shell'))]
      const { service, shellParked } = harness({
        sessions,
        maxIdleSessions: 1,
        idleShellMinutes: 1,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual(['old-shell'])
    })

    it('parks a quiet shell when idleShellMinutes is set', async () => {
      const sessions = [
        shell(asSessionId('old-shell'), {
          lastActiveAt: new Date(NOW - 48 * 60_000).toISOString(),
          lastInputAtMs: NOW - 48 * 60_000,
          lastOutputAtMs: NOW - 48 * 60_000,
        }),
        shell(asSessionId('fresh-shell'), {
          lastActiveAt: new Date(NOW - 60_000).toISOString(),
          lastInputAtMs: NOW - 60_000,
          lastOutputAtMs: NOW - 60_000,
        }),
      ]
      const { service, parked, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellMinutes: 24,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual(['old-shell'])
      expect(parked).toEqual([])
      expect(sessions[1]?.status).toBe('live')
    })

    it('never auto-parks a native login shell', async () => {
      const sessions = [
        shell(asSessionId('login-shell'), { autoHibernateProtected: true }),
        shell(asSessionId('ordinary-shell')),
      ]
      const { service, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellMinutes: 1,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual(['ordinary-shell'])
      expect(sessions[0]?.status).toBe('live')
    })

    it('does not make an idle agent pay for a protected login shell', async () => {
      const sessions = [
        session(asSessionId('known-idle')),
        shell(asSessionId('login-shell'), { autoHibernateProtected: true }),
      ]
      const { service, parked, shellParked } = harness({
        sessions,
        maxIdleSessions: 1,
        idleShellMinutes: 1,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(shellParked).toEqual([])
      expect(sessions.every((item) => item.status === 'live')).toBe(true)
    })

    it('leaves shells alone when idleShellMinutes is explicitly off', async () => {
      const sessions = [shell(asSessionId('ancient-shell'))]
      const { service, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellMinutes: null,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual([])
      expect(sessions[0]?.status).toBe('live')
    })

    it('parks the oldest quiet shell first under idleShellMinutes', async () => {
      const sessions = [
        shell(asSessionId('newer'), {
          lastActiveAt: new Date(NOW - 30 * 60_000).toISOString(),
          lastInputAtMs: NOW - 30 * 60_000,
          lastOutputAtMs: NOW - 30 * 60_000,
        }),
        shell(asSessionId('older'), {
          lastActiveAt: new Date(NOW - 72 * 60_000).toISOString(),
          lastInputAtMs: NOW - 72 * 60_000,
          lastOutputAtMs: NOW - 72 * 60_000,
        }),
      ]
      const { service, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellMinutes: 24,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual(['older'])
    })
  })

  /**
   * THE BACKSTOP HAD NO TEST AT ALL — `backstopMinutes` was `null` in every
   * harness, so `applyIdleBackstop` never ran (POD-3263). It is the one sweep
   * path whose predicate consumes `hasScheduledWakeup`, which is a durable read
   * now: handing an async callback to `.filter` there would have made the guard
   * silently permissive (a promise is always truthy) and parked a session with a
   * wake-up already scheduled. These two cover both answers of that guard.
   */
  describe('idle backstop', () => {
    const ancient = (sessionId: SessionId): HostSessionView =>
      session(sessionId, {
        agentState: undefined,
        lastActiveAt: new Date(NOW - 5 * 24 * HOUR).toISOString(),
        lastInputAtMs: NOW - 5 * 24 * HOUR,
        lastOutputAtMs: NOW - 5 * 24 * HOUR,
      })

    it('parks a session quiet past the backstop', async () => {
      const sessions = [ancient(asSessionId('forgotten'))]
      const { service, parked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellMinutes: null,
        backstopMinutes: 2 * 24 * 60,
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['forgotten'])
    })

    it('leaves a backstop-quiet session alone when a wake-up is already scheduled', async () => {
      const sessions = [ancient(asSessionId('forgotten'))]
      const { service, parked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellMinutes: null,
        backstopMinutes: 2 * 24 * 60,
        scheduledWakeups: new Set(['forgotten']),
      })

      await service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(sessions[0]?.status).toBe('live')
    })
  })
})

describe('reclaim disk estimate cache', () => {
  it('returns measuring immediately, then serves the completed bytes for the same path sets', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const request = vi.fn(async () => ({
      recoverableBytes: 7 * 1024 ** 3,
      measuredAt: '2026-08-23T12:00:00.000Z',
    }))
    const { service } = harness({
      sessions: [],
      maxIdleSessions: null,
      daemonRequest: {
        request,
        settle: vi.fn(),
        nextRequestId: vi.fn(),
      } as unknown as HostsDeps['daemonRequest'],
    })

    expect(
      await service.reclaimDiskEstimate(
        ['/r', '/r/.worktrees/a'],
        ['/r/.worktrees/a'],
        asMachineId('local'),
      ),
    ).toEqual({ status: 'measuring', recoverableBytes: null, measuredAt: null })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    expect(
      await service.reclaimDiskEstimate(
        ['/r/.worktrees/a', '/r'],
        ['/r/.worktrees/a'],
        asMachineId('local'),
      ),
    ).toEqual({
      status: 'ready',
      recoverableBytes: 7 * 1024 ** 3,
      measuredAt: '2026-08-23T12:00:00.000Z',
    })
    expect(request).toHaveBeenCalledTimes(1)

    now.mockReturnValue(5 * 60_000 + 1)
    expect(
      await service.reclaimDiskEstimate(
        ['/r/.worktrees/a', '/r'],
        ['/r/.worktrees/a'],
        asMachineId('local'),
      ),
    ).toEqual({
      status: 'measuring',
      recoverableBytes: null,
      measuredAt: null,
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    now.mockRestore()
  })
})
