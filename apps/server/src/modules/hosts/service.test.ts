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

function sample(usedPct: number): Omit<HostMetricsWire, 'machineId' | 'name'> {
  return {
    hostname: 'box',
    sampledAt: new Date(Date.now()).toISOString(),
    memory: {
      totalBytes: 100,
      availableBytes: 100 - usedPct,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    },
  }
}

function harness(input: {
  sessions: HostSessionView[]
  maxIdleSessions: number | null
  enabled?: boolean
  fail?: Set<string>
  proven?: Set<string>
}) {
  const settings = PodiumSettings.parse({
    hibernation: {
      enabled: input.enabled ?? true,
      memoryPct: 80,
      idleMinutes: 30,
      maxIdleSessions: input.maxIdleSessions,
    },
  })
  const parked: string[] = []
  const deps: HostsDeps = {
    getSettings: () => settings,
    clients: () => [],
    machineName: (id) => id,
    sessions: () => input.sessions,
    hibernateSession: ({ sessionId }) => {
      if (input.fail?.has(sessionId)) return { ok: false, reason: 'raced' }
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (target?.status !== 'live') return { ok: false, reason: 'not running' }
      target.status = 'hibernated'
      parked.push(sessionId)
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
  return { service: new HostsService(deps, new EventBus()), parked }
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
})
