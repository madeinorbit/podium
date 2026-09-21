import type { HostMetricsWire, SessionId } from '@podium/model'
import { asMachineId, asSessionId } from '@podium/model'
import { PodiumSettings } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../bus'
import { type HostSessionView, type HostsDeps, HostsService } from './service'

const NOW = new Date('2026-07-17T12:00:00.000Z').getTime()

function shell(sessionId: SessionId, quietMs: number): HostSessionView {
  return {
    sessionId,
    machineId: asMachineId('local'),
    status: 'live',
    agentKind: 'shell',
    resume: undefined,
    agentState: undefined,
    lastActiveAt: new Date(NOW - quietMs).toISOString(),
    lastResumedAtMs: 0,
    lastInputAtMs: NOW - quietMs,
    lastOutputAtMs: NOW - quietMs,
    // Touched (typed quietMs ago), open issue, never seen held: the dock
    // shell at its prompt this guard was written for.
    hasInput: true,
    heldByTab: false,
    watched: false,
    purpose: 'shell',
    lastHeldAtMs: undefined,
  }
}

function sample(): Omit<HostMetricsWire, 'machineId' | 'name'> {
  return {
    hostname: 'box',
    sampledAt: new Date(Date.now()).toISOString(),
    memory: {
      totalBytes: 100,
      availableBytes: 90,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    },
  }
}

/**
 * POD-4429 regression guard: the idle-shell default is 60 minutes, so an open
 * dock shell sitting at its prompt is not parked one minute after the last
 * keystroke. The harness below deliberately OMITS idleShellMinutes so the
 * default applies — on the base (default 1) the 59-minute shell is parked.
 */
function harness(sessions: HostSessionView[]) {
  const settings = PodiumSettings.parse({
    hibernation: {
      enabled: true,
      memoryPct: 80,
      idleMinutes: 30,
      maxIdleSessions: null,
      backstopMinutes: null,
    },
  })
  const shellParked: string[] = []
  const deps: HostsDeps = {
    getSettings: async () => settings,
    transferFenceActive: () => false,
    clients: () => [],
    machineName: async (id) => id,
    sessions: async () => sessions,
    hibernateSession: async () => ({ ok: false, reason: 'not a shell path' }),
    killShellSession: async () => {
      throw new Error('no shell should reach the kill verb in these tests')
    },
    hasScheduledWakeup: async () => false,
    parkShellSession: async ({ sessionId }) => {
      const target = sessions.find((item) => item.sessionId === sessionId)
      if (target?.status !== 'live') return { ok: false, reason: 'not running' }
      if (target.agentKind !== 'shell') return { ok: false, reason: 'not a shell session' }
      target.status = 'hibernated'
      shellParked.push(sessionId)
      return { ok: true }
    },
    hasValidTerminalProof: async () => true,
    terminalProofMissing: async () => false,
    daemonRequest: {
      request: vi.fn(),
      settle: vi.fn(),
      nextRequestId: vi.fn(),
    } as unknown as HostsDeps['daemonRequest'],
    toMachine: () => {},
  }
  return {
    service: new HostsService(deps, new EventBus()),
    shellParked,
  }
}

describe('POD-4429 idle-shell default', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('defaults idleShellMinutes to 60', () => {
    const settings = PodiumSettings.parse({})
    expect(settings.hibernation.idleShellMinutes).toBe(60)
  })

  it('leaves a dock shell quiet for 59 minutes live under the default', async () => {
    const sessions = [shell(asSessionId('dock-59'), 59 * 60_000)]
    const { service, shellParked } = harness(sessions)

    await service.onHostMetrics(asMachineId('local'), sample())

    expect(shellParked).toEqual([])
    expect(sessions[0]?.status).toBe('live')
  })

  it('parks a dock shell quiet for 61 minutes under the default', async () => {
    // SUPERSEDED BY POD-4435: quiet time no longer parks shells at all. A
    // touched shell with an open issue is durable — it stays, where the old
    // timer parked it. Kept as the guard's second half: the default still
    // moves (60, asserted above) AND still does not touch a used shell.
    const sessions = [shell(asSessionId('dock-61'), 61 * 60_000)]
    const { service, shellParked } = harness(sessions)

    await service.onHostMetrics(asMachineId('local'), sample())

    expect(shellParked).toEqual([])
    expect(sessions[0]?.status).toBe('live')
  })
})
