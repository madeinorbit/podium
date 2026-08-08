import type { HostMetricsWire, SessionId } from '@podium/model'
import { asMachineId, asSessionId } from '@podium/model'
import { PodiumSettings } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../bus'
import { type HostSessionView, type HostsDeps, HostsService } from './service'

const NOW = new Date('2026-07-17T12:00:00.000Z').getTime()
const HOUR = 60 * 60_000

function session(sessionId: SessionId, overrides: Partial<HostSessionView> = {}): HostSessionView {
  return {
    sessionId,
    machineId: 'local',
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

function harness(input: {
  sessions: HostSessionView[]
  maxIdleSessions: number | null
  enabled?: boolean
  loadPerCore?: number | null
  idleShellHours?: number | null
  fail?: Set<string>
  proven?: Set<string>
}) {
  const settings = PodiumSettings.parse({
    hibernation: {
      enabled: input.enabled ?? true,
      memoryPct: 80,
      idleMinutes: 30,
      maxIdleSessions: input.maxIdleSessions,
      ...(input.loadPerCore !== undefined ? { loadPerCore: input.loadPerCore } : {}),
      ...(input.idleShellHours !== undefined ? { idleShellHours: input.idleShellHours } : {}),
    },
  })
  const parked: string[] = []
  const shellParked: string[] = []
  const hibernateRequireProof: Array<{ sessionId: string; requireTerminalProof?: boolean }> = []
  const deps: HostsDeps = {
    getSettings: () => settings,
    clients: () => [],
    machineName: (id) => id,
    sessions: () => input.sessions,
    hibernateSession: ({ sessionId, requireTerminalProof }) => {
      hibernateRequireProof.push({ sessionId, requireTerminalProof })
      if (input.fail?.has(sessionId)) return { ok: false, reason: 'raced' }
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (target?.status !== 'live') return { ok: false, reason: 'not running' }
      if (!target.resume) return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
      target.status = 'hibernated'
      parked.push(sessionId)
      return { ok: true }
    },
    parkShellSession: ({ sessionId }) => {
      if (input.fail?.has(sessionId)) return { ok: false, reason: 'raced' }
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (target?.status !== 'live') return { ok: false, reason: 'not running' }
      if (target.agentKind !== 'shell') return { ok: false, reason: 'not a shell session' }
      target.status = 'hibernated'
      shellParked.push(sessionId)
      return { ok: true }
    },
    hasValidTerminalProof: (sessionId) => input.proven?.has(sessionId) ?? true,
    terminalProofMissing: (sessionId) => !(input.proven?.has(sessionId) ?? true),
    // The auto-hibernate sweep makes no daemon round-trip, so an inert
    // correlator is enough here — a call to one would be the failure.
    daemonRequest: {
      request: vi.fn(),
      settle: vi.fn(),
      nextRequestId: vi.fn(),
    } as unknown as HostsDeps['daemonRequest'],
  }
  return {
    service: new HostsService(deps, new EventBus()),
    parked,
    shellParked,
    hibernateRequireProof,
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

  it('converges below the cap without memory pressure, oldest effective idle first', () => {
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

    service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['old-effective-idle'])
  })

  it('allows zero and re-evaluates after every successful hibernation', () => {
    const sessions = [
      session(asSessionId('one')),
      session(asSessionId('two')),
      session(asSessionId('three')),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['one', 'two', 'three'])
    expect(sessions.every((item) => item.status === 'hibernated')).toBe(true)
  })

  it('uses a separate conservative burst and refill budget per machine', () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(asSessionId(`s${index}`)))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    vi.advanceTimersByTime(15_000)
    service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(5)
  })

  it('keeps memory pressure independent of the count target and its limiter', () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(asSessionId(`s${index}`)))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    // Count pressure has exhausted its burst, but memory has its own budget.
    service.onHostMetrics(asMachineId('local'), sample(90))
    expect(parked).toHaveLength(5)
  })

  it('hibernates for memory pressure even when the idle count is below its target', () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 10 })

    service.onHostMetrics(asMachineId('local'), sample(90))

    expect(parked).toEqual(['one'])
  })

  it('hibernates for load pressure using load1/cores (not load5) at the default threshold', () => {
    // POD-526-shaped host: load1 14 on 8 cores = 1.75× ≥ default 1.5×.
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 10 })

    service.onHostMetrics(asMachineId('local'), sample(10, { one: 14, cpuCount: 8 }))

    expect(parked).toEqual(['one'])
  })

  it('ignores load pressure when loadPerCore is null (off)', () => {
    const sessions = [session(asSessionId('one'))]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: null,
      loadPerCore: null,
    })

    service.onHostMetrics(asMachineId('local'), sample(10, { one: 100, cpuCount: 1 }))

    expect(parked).toEqual([])
  })

  it('ignores a sample with no load field (pre-field daemon)', () => {
    const sessions = [session(asSessionId('one'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: null })

    service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual([])
  })

  it('keeps load pressure independent of the count target and its limiter', () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(asSessionId(`s${index}`)))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toHaveLength(4)

    // Count pressure has exhausted its burst, but load has its own budget
    // (shared with memory via the per-machine cooldown map).
    service.onHostMetrics(asMachineId('local'), sample(10, { one: 20, cpuCount: 8 }))
    expect(parked).toHaveLength(5)
  })

  it('shares the memory cooldown map so dual pressure parks once per window', () => {
    const sessions = [
      session(asSessionId('first')),
      session(asSessionId('second')),
      session(asSessionId('third')),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: null })

    // Memory parks first and spends the shared cooldown; load must not double-park.
    service.onHostMetrics(asMachineId('local'), sample(90, { one: 20, cpuCount: 8 }))
    expect(parked).toEqual(['first'])

    service.onHostMetrics(asMachineId('local'), sample(90, { one: 20, cpuCount: 8 }))
    expect(parked).toEqual(['first'])
  })

  it('refuses legacy or unfenced sessions without a terminal proof', () => {
    const sessions = [session(asSessionId('legacy')), session(asSessionId('proven'))]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: 1,
      proven: new Set(['proven']),
    })

    service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['proven'])
    expect(sessions[0]?.status).toBe('live')
  })

  it('logs a mixed-version terminal rejected solely for missing proof once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sessions = [session(asSessionId('legacy'))]
    const { service } = harness({
      sessions,
      maxIdleSessions: null,
      proven: new Set(),
    })

    service.onHostMetrics(asMachineId('local'), sample(90))
    service.onHostMetrics(asMachineId('local'), sample(90))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy: missing durable terminal proof'),
    )
  })

  it('runs count pressure even when the memory sample cannot produce a percentage', () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 1 })
    const invalidMemory = sample(10)
    invalidMemory.memory.totalBytes = 0
    invalidMemory.memory.availableBytes = 0

    service.onHostMetrics(asMachineId('local'), invalidMemory)

    expect(parked).toEqual(['one'])
  })
  it('retries memory pressure after a race without spending the cooldown', () => {
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

    service.onHostMetrics(asMachineId('local'), sample(90))
    expect(parked).toEqual(['next'])

    failures.clear()
    service.onHostMetrics(asMachineId('local'), sample(90))
    expect(parked).toEqual(['next'])
  })

  it('keeps count-pressure burst budgets independent per machine', () => {
    const sessions = [
      ...Array.from({ length: 5 }, (_, index) =>
        session(asSessionId(`a${index}`), { machineId: 'a' }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        session(asSessionId(`b${index}`), { machineId: 'b' }),
      ),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics(asMachineId('a'), sample(10))
    service.onHostMetrics(asMachineId('b'), sample(10))

    expect(parked.filter((id) => id.startsWith('a'))).toHaveLength(4)
    expect(parked.filter((id) => id.startsWith('b'))).toHaveLength(4)
  })

  it('tries another eligible candidate after a hibernation race', () => {
    const sessions = [session(asSessionId('raced')), session(asSessionId('next'))]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: 1,
      fail: new Set(['raced']),
    })

    service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['next'])
  })

  it('reports the remaining overage when protected sessions prevent convergence', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
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

    service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['parkable'])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('cap unmet: 3 protected/ineligible'))
    expect(service.hostMetricsMessage()).toMatchObject({ hosts: [{ idleCapUnmet: 3 }] })
  })

  it('disables both memory and count pressure when hibernation is disabled', () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0, enabled: false })

    service.onHostMetrics(asMachineId('local'), sample(90))

    expect(parked).toEqual([])
  })

  it('leaves count pressure off when the target is unlimited', () => {
    const sessions = [session(asSessionId('one')), session(asSessionId('two'))]
    const { service, parked } = harness({ sessions, maxIdleSessions: null })

    service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual([])
  })

  // POD-568. Finished work is reaped first, and that is ALL the lifecycle tier
  // does — every case below keeps the safety gates deciding who may be parked.
  describe('lifecycle ordering', () => {
    it('reaps closed work first, then unbound sessions, then open work', () => {
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

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['closed', 'unbound', 'open'])
    })

    it('still breaks ties inside a tier by effective idle age', () => {
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

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['closed-older'])
    })

    // THE CASE THE OPERATOR RULED ON. An agent that marked its issue done and
    // kept writing must not be parked ahead of live work — being first in the
    // queue is not permission to skip the gates.
    it('refuses a closed-issue session that is still producing output', () => {
      const sessions = [
        session(asSessionId('closed-but-writing'), {
          issueClosed: true,
          lastOutputAtMs: NOW - 10_000,
        }),
        session(asSessionId('open-and-quiet'), { issueClosed: false }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['open-and-quiet'])
    })

    it('refuses a closed-issue session that has not been idle long enough', () => {
      const sessions = [
        session(asSessionId('closed-but-active'), {
          issueClosed: true,
          lastActiveAt: new Date(NOW - 5 * 60_000).toISOString(),
        }),
        session(asSessionId('open-and-idle'), { issueClosed: false }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['open-and-idle'])
    })

    it('refuses a closed-issue session with no resume ref rather than killing it', () => {
      const sessions = [
        session(asSessionId('closed-no-resume'), { issueClosed: true, resume: undefined }),
        session(asSessionId('open-resumable'), { issueClosed: false }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['open-resumable'])
    })

    it('orders memory-pressure candidates the same way', () => {
      const sessions = [
        session(asSessionId('open'), {
          issueClosed: false,
          lastActiveAt: new Date(NOW - 5 * HOUR).toISOString(),
        }),
        session(asSessionId('closed'), { issueClosed: true }),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: null })

      service.onHostMetrics(asMachineId('local'), sample(90))

      expect(parked).toEqual(['closed'])
    })
  })

  // POD-565. Unobserved sessions (phase unknown / no agentState) were invisible
  // to every pressure source. Count them after a long quiet window; act only
  // when a resume ref exists; shells get a separate opt-in policy.
  describe('unobserved phase (POD-565)', () => {
    it('counts a quiet unobserved agent that HAS a resume ref — it pays its own overage', () => {
      // Cap 1: one known idle + one long-quiet unobserved holding a resume ref →
      // overage 1, and the unobserved session is itself eligible to pay it.
      const sessions = [
        session(asSessionId('known-idle')),
        unobserved(asSessionId('hookless-resumable')),
      ]
      const { service, parked } = harness({ sessions, maxIdleSessions: 1 })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toHaveLength(1)
    })

    it('does NOT count an unobserved session nothing can park, so no observed agent pays', () => {
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

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(sessions[0]?.status).toBe('live')
      expect(sessions[1]?.status).toBe('live')
    })

    it('does not count a recently-active unobserved session', () => {
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

      service.onHostMetrics(asMachineId('local'), sample(10))

      // Only known-idle is in the idle-live set → under the cap of 1.
      expect(parked).toEqual([])
    })

    it('logs when unobserved quiet sessions enter the idle-live set', () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const sessions = [
        unobserved(asSessionId('hookless-a'), { resume: undefined }),
        unobserved(asSessionId('hookless-b'), { resume: undefined }),
      ]
      const { service } = harness({ sessions, maxIdleSessions: 0 })

      service.onHostMetrics(asMachineId('local'), sample(10))
      service.onHostMetrics(asMachineId('local'), sample(10))

      const lines = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('counting') && line.includes('unobserved'))
      expect(lines).toHaveLength(1)
      // BOTH numbers. Neither of these two can be parked (no resume ref), so the
      // cap counts none of them — but the log still has to name all 2, because
      // making this tail visible is what POD-565 is for. Reporting only the
      // counted number would re-hide it.
      expect(lines[0]).toContain('counting 0 of 2 unobserved quiet session')
      expect(lines[0]).toContain('cannot be parked by any policy that is on')
    })

    it('hibernates a long-quiet unobserved agent that has a resume ref without terminal proof', () => {
      const sessions = [unobserved(asSessionId('hookless-resumable'))]
      const { service, parked, hibernateRequireProof } = harness({
        sessions,
        maxIdleSessions: 0,
        // No terminal proof — unobserved agents never produce one.
        proven: new Set(),
      })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual(['hookless-resumable'])
      expect(hibernateRequireProof).toEqual([
        { sessionId: 'hookless-resumable', requireTerminalProof: false },
      ])
    })

    it('never routes an unobserved session without a resume ref into hibernateSession', () => {
      const sessions = [unobserved(asSessionId('no-resume'), { resume: undefined })]
      const { service, parked, hibernateRequireProof } = harness({
        sessions,
        maxIdleSessions: 0,
      })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(hibernateRequireProof).toEqual([])
      expect(sessions[0]?.status).toBe('live')
    })

    it('a quiet shell does not inflate the cap while idleShellHours is off', () => {
      // With the shell policy off, applyShellIdlePressure never runs, so nothing
      // on this host can park a shell. Counting it would make the known-idle
      // agent pay for a session no policy is acting on. The POD-526 host had a
      // shell quiet since Jul 21 sitting behind exactly this.
      const sessions = [session(asSessionId('known-idle')), shell(asSessionId('old-shell'))]
      const { service, parked, shellParked } = harness({
        sessions,
        maxIdleSessions: 1,
        // Shell policy off — shell is neither counted nor parked.
      })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(parked).toEqual([])
      expect(shellParked).toEqual([])
      expect(sessions[0]?.status).toBe('live')
      expect(sessions[1]?.status).toBe('live')
    })

    it('the same shell DOES count once idleShellHours turns the policy on', () => {
      // The predicate follows the policy rather than a constant: switch shell
      // reaping on and the shell becomes both parkable and countable in the same
      // breath. Cap 1 with two sessions is an overage of 1; the shell is quiet
      // past the threshold, so the shell path takes it and the agent is spared.
      const sessions = [session(asSessionId('known-idle')), shell(asSessionId('old-shell'))]
      const { service, shellParked } = harness({
        sessions,
        maxIdleSessions: 1,
        idleShellHours: 1,
      })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual(['old-shell'])
    })

    it('parks a quiet shell when idleShellHours is set', () => {
      const sessions = [
        shell(asSessionId('old-shell'), {
          lastActiveAt: new Date(NOW - 48 * HOUR).toISOString(),
          lastInputAtMs: NOW - 48 * HOUR,
          lastOutputAtMs: NOW - 48 * HOUR,
        }),
        shell(asSessionId('fresh-shell'), {
          lastActiveAt: new Date(NOW - HOUR).toISOString(),
          lastInputAtMs: NOW - HOUR,
          lastOutputAtMs: NOW - HOUR,
        }),
      ]
      const { service, parked, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellHours: 24,
      })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual(['old-shell'])
      expect(parked).toEqual([])
      expect(sessions[1]?.status).toBe('live')
    })

    it('leaves shells alone when idleShellHours is null (default off)', () => {
      const sessions = [shell(asSessionId('ancient-shell'))]
      const { service, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellHours: null,
      })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual([])
      expect(sessions[0]?.status).toBe('live')
    })

    it('parks the oldest quiet shell first under idleShellHours', () => {
      const sessions = [
        shell(asSessionId('newer'), {
          lastActiveAt: new Date(NOW - 30 * HOUR).toISOString(),
          lastInputAtMs: NOW - 30 * HOUR,
          lastOutputAtMs: NOW - 30 * HOUR,
        }),
        shell(asSessionId('older'), {
          lastActiveAt: new Date(NOW - 72 * HOUR).toISOString(),
          lastInputAtMs: NOW - 72 * HOUR,
          lastOutputAtMs: NOW - 72 * HOUR,
        }),
      ]
      const { service, shellParked } = harness({
        sessions,
        maxIdleSessions: null,
        idleShellHours: 24,
      })

      service.onHostMetrics(asMachineId('local'), sample(10))

      expect(shellParked).toEqual(['older'])
    })
  })
})
