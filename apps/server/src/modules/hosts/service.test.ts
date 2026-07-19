import type { HostMetricsWire } from '@podium/protocol'
import { PodiumSettings } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../bus'
import { type HostSessionView, type HostsDeps, HostsService } from './service'

const NOW = new Date('2026-07-17T12:00:00.000Z').getTime()
const HOUR = 60 * 60_000

function session(sessionId: string, overrides: Partial<HostSessionView> = {}): HostSessionView {
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
    daemonRequest: vi.fn() as HostsDeps['daemonRequest'],
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
      session('old-activity-recent-input', {
        lastActiveAt: new Date(NOW - 3 * HOUR).toISOString(),
        lastInputAtMs: NOW - 40 * 60_000,
      }),
      session('old-effective-idle', {
        lastActiveAt: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      session('newest', {
        lastActiveAt: new Date(NOW - HOUR).toISOString(),
      }),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 2 })

    service.onHostMetrics('local', sample(10))

    expect(parked).toEqual(['old-effective-idle'])
  })

  it('allows zero and re-evaluates after every successful hibernation', () => {
    const sessions = [session('one'), session('two'), session('three')]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics('local', sample(10))

    expect(parked).toEqual(['one', 'two', 'three'])
    expect(sessions.every((item) => item.status === 'hibernated')).toBe(true)
  })

  it('uses a separate conservative burst and refill budget per machine', () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(`s${index}`))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics('local', sample(10))
    expect(parked).toHaveLength(4)

    service.onHostMetrics('local', sample(10))
    expect(parked).toHaveLength(4)

    vi.advanceTimersByTime(15_000)
    service.onHostMetrics('local', sample(10))
    expect(parked).toHaveLength(5)
  })

  it('keeps memory pressure independent of the count target and its limiter', () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(`s${index}`))
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics('local', sample(10))
    expect(parked).toHaveLength(4)

    // Count pressure has exhausted its burst, but memory has its own budget.
    service.onHostMetrics('local', sample(90))
    expect(parked).toHaveLength(5)
  })

  it('hibernates for memory pressure even when the idle count is below its target', () => {
    const sessions = [session('one'), session('two')]
    const { service, parked } = harness({ sessions, maxIdleSessions: 10 })

    service.onHostMetrics('local', sample(90))

    expect(parked).toEqual(['one'])
  })

  it('refuses legacy or unfenced sessions without a terminal proof', () => {
    const sessions = [session('legacy'), session('proven')]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: 1,
      proven: new Set(['proven']),
    })

    service.onHostMetrics('local', sample(10))

    expect(parked).toEqual(['proven'])
    expect(sessions[0]?.status).toBe('live')
  })

  it('runs count pressure even when the memory sample cannot produce a percentage', () => {
    const sessions = [session('one'), session('two')]
    const { service, parked } = harness({ sessions, maxIdleSessions: 1 })
    const invalidMemory = sample(10)
    invalidMemory.memory.totalBytes = 0
    invalidMemory.memory.availableBytes = 0

    service.onHostMetrics('local', invalidMemory)

    expect(parked).toEqual(['one'])
  })
  it('retries memory pressure after a race without spending the cooldown', () => {
    const failures = new Set(['raced'])
    const sessions = [session('raced'), session('next'), session('later')]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: null,
      fail: failures,
    })

    service.onHostMetrics('local', sample(90))
    expect(parked).toEqual(['next'])

    failures.clear()
    service.onHostMetrics('local', sample(90))
    expect(parked).toEqual(['next'])
  })

  it('keeps count-pressure burst budgets independent per machine', () => {
    const sessions = [
      ...Array.from({ length: 5 }, (_, index) => session(`a${index}`, { machineId: 'a' })),
      ...Array.from({ length: 5 }, (_, index) => session(`b${index}`, { machineId: 'b' })),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics('a', sample(10))
    service.onHostMetrics('b', sample(10))

    expect(parked.filter((id) => id.startsWith('a'))).toHaveLength(4)
    expect(parked.filter((id) => id.startsWith('b'))).toHaveLength(4)
  })

  it('tries another eligible candidate after a hibernation race', () => {
    const sessions = [session('raced'), session('next')]
    const { service, parked } = harness({
      sessions,
      maxIdleSessions: 1,
      fail: new Set(['raced']),
    })

    service.onHostMetrics('local', sample(10))

    expect(parked).toEqual(['next'])
  })

  it('reports the remaining overage when protected sessions prevent convergence', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const sessions = [
      session('parkable'),
      session('no-resume', { resume: undefined }),
      session('recent', { lastActiveAt: new Date(NOW - 5 * 60_000).toISOString() }),
      session('question', {
        agentState: {
          phase: 'needs_user',
          since: new Date(NOW - HOUR).toISOString(),
          nativeSubagentCount: 0,
        },
      }),
    ]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0 })

    service.onHostMetrics('local', sample(10))

    expect(parked).toEqual(['parkable'])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('cap unmet: 3 protected/ineligible'))
    expect(service.hostMetricsMessage()).toMatchObject({ hosts: [{ idleCapUnmet: 3 }] })
  })

  it('disables both memory and count pressure when hibernation is disabled', () => {
    const sessions = [session('one'), session('two')]
    const { service, parked } = harness({ sessions, maxIdleSessions: 0, enabled: false })

    service.onHostMetrics('local', sample(90))

    expect(parked).toEqual([])
  })

  it('leaves count pressure off when the target is unlimited', () => {
    const sessions = [session('one'), session('two')]
    const { service, parked } = harness({ sessions, maxIdleSessions: null })

    service.onHostMetrics('local', sample(10))

    expect(parked).toEqual([])
  })
})
