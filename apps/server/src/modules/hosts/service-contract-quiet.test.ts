import type { HostMetricsWire, SessionId } from '@podium/model'
import { asMachineId, asSessionId } from '@podium/model'
import { PodiumSettings } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../bus'
import { type HostSessionView, type HostsDeps, HostsService } from './service'

/** Family-specific quiet policy selects candidates; host-owned proof authorizes parking.
 * Synthetic proof in these policy tests does not imply a contract driver produces it.
 * Production drivers without causal proof remain live, including unknown-phase sessions.
 */

const NOW = new Date('2026-07-17T12:00:00.000Z').getTime()
const HOUR = 60 * 60_000

/** A codex-app-server session as relay.ts projects it: resumed, never on a PTY. */
function contractSession(sessionId: SessionId, overrides: Partial<HostSessionView> = {}): HostSessionView {
  return {
    sessionId,
    machineId: asMachineId('local'),
    status: 'live',
    agentKind: 'codex',
    resume: { kind: 'codex-thread', value: `thread-${sessionId}` },
    agentState: {
      phase: 'idle',
      since: new Date(NOW - HOUR).toISOString(),
      nativeSubagentCount: 0,
      idle: { kind: 'done' },
    },
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    // Never moved: no PTY, so no ptyOutput / PTY input / resume-activity.
    lastResumedAtMs: 0,
    lastInputAtMs: 0,
    lastOutputAtMs: 0,
    // THE SHELL POLICY'S INPUTS (POD-4435): contract agents never reach the
    // table — present only because the projection is total.
    hasInput: false,
    heldByTab: false,
    watched: false,
    purpose: 'shell',
    lastHeldAtMs: undefined,
    ...overrides,
  }
}

/** Same session before any state signal: phase unknown, last event hours old. */
function unobservedContract(
  sessionId: SessionId,
  overrides: Partial<HostSessionView> = {},
): HostSessionView {
  return contractSession(sessionId, {
    agentState: {
      phase: 'unknown',
      since: new Date(NOW - 5 * HOUR).toISOString(),
      nativeSubagentCount: 0,
    },
    lastActiveAt: new Date(NOW - 5 * HOUR).toISOString(),
    ...overrides,
  })
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
  proven?: Set<string>
}) {
  const settings = PodiumSettings.parse({
    hibernation: {
      enabled: true,
      memoryPct: 80,
      idleMinutes: 30,
      maxIdleSessions: 0,
      idleShellMinutes: null,
      backstopMinutes: null,
    },
  })
  const parked: string[] = []
  const hibernateRequireProof: Array<{ sessionId: string; requireTerminalProof?: boolean }> = []
  const deps: HostsDeps = {
    getSettings: async () => settings,
    transferFenceActive: () => false,
    clients: () => [],
    machineName: async (id) => id,
    sessions: async () => input.sessions,
    hibernateSession: async ({ sessionId, requireTerminalProof }) => {
      hibernateRequireProof.push({ sessionId, requireTerminalProof })
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (target?.status !== 'live') return { ok: false, reason: 'not running' }
      if (!target.resume)
        return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
      target.status = 'hibernated'
      parked.push(sessionId)
      return { ok: true }
    },
    parkShellSession: async () => ({ ok: false, reason: 'not a shell session' }),
    killShellSession: async () => {
      throw new Error('no shell should reach the kill verb in these tests')
    },
    hasScheduledWakeup: async () => false,
    hasValidTerminalProof: async (sessionId) => input.proven?.has(sessionId) ?? false,
    terminalProofMissing: async (sessionId) => !(input.proven?.has(sessionId) ?? false),
    daemonRequest: {
      request: vi.fn(),
      settle: vi.fn(),
      nextRequestId: vi.fn(),
    } as unknown as HostsDeps['daemonRequest'],
    toMachine: () => {},
  }
  return {
    service: new HostsService(deps, new EventBus()),
    parked,
    hibernateRequireProof,
  }
}

describe('contract-session parking authorization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('parks an observed contract-shaped session on epoch terminal stamps when proof is present — the output-quiet overlay is vacuous', async () => {
    // lastOutputAtMs is 0 (1970): `now - 0` dwarfs OUTPUT_QUIET_MS, so the
    // "terminal quiet for a minute" check passes for a terminal that never
    // existed. effectiveIdleSinceMs likewise reads only lastActiveAt.
    const sessions = [contractSession(asSessionId('contract-idle'))]
    const { service, parked } = harness({
      sessions,
      proven: new Set(['contract-idle']),
    })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['contract-idle'])
  })

  it('leaves the same observed shape live without proof — the production mask for contract sessions', async () => {
    // No terminal observers ever confirm a fence for a session with no PTY
    // (and provider-`none` harnesses never even get a lease), so in
    // production the observed path stops here rather than at the quiet check.
    const sessions = [contractSession(asSessionId('contract-idle'))]
    const { service, parked, hibernateRequireProof } = harness({ sessions, proven: new Set() })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual([])
    expect(hibernateRequireProof).toEqual([])
    expect(sessions[0]?.status).toBe('live')
  })

  it('keeps a long-quiet resumable contract session live without proof', async () => {
    const sessions = [unobservedContract(asSessionId('contract-silent'))]
    const { service, parked, hibernateRequireProof } = harness({ sessions, proven: new Set() })
    await service.onHostMetrics(asMachineId('local'), sample(10))
    expect(parked).toEqual([])
    expect(hibernateRequireProof).toEqual([])
    expect(sessions[0]?.status).toBe('live')
  })

  it('never routes an unobserved contract-shaped session without a resume ref into hibernateSession — the audit caveat holds', async () => {
    const sessions = [unobservedContract(asSessionId('contract-noresume'), { resume: undefined })]
    const { service, parked, hibernateRequireProof } = harness({ sessions, proven: new Set() })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual([])
    expect(hibernateRequireProof).toEqual([])
    expect(sessions[0]?.status).toBe('live')
  })
})

describe('contract facts gate (fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('ignores a fresh terminal stamp for an observed contract-backed session — the output-quiet overlay is PTY-only', async () => {
    // Phase idle for an hour with a resume ref and valid proof: the only thing
    // standing between this session and the park is a 10-second-old output
    // stamp on a session with no terminal. A contract-backed session must not
    // be kept alive by terminal bytes it can no longer produce.
    const sessions = [
      contractSession(asSessionId('contract-stale-stamp'), {
        driverFamily: 'server',
        lastOutputAtMs: NOW - 10_000,
      }),
    ]
    const { service, parked } = harness({
      sessions,
      proven: new Set(['contract-stale-stamp']),
    })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['contract-stale-stamp'])
  })

  it('reads unobserved contract quiet from event-time recency, not terminal stamps', async () => {
    // Last contract event five hours ago, but a 10-second-old output stamp
    // (stale PTY past from before the contract bind). The 4 h floor must be
    // measured against lastActiveAt — the contract-side recency fact — so this
    // parks; folding the stamp would call a silent session busy.
    const sessions = [
      unobservedContract(asSessionId('contract-stale-stamp'), {
        driverFamily: 'server',
        lastOutputAtMs: NOW - 10_000,
      }),
    ]
    const { service, parked } = harness({ sessions, proven: new Set(sessions.map((s) => s.sessionId)) })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['contract-stale-stamp'])
  })

  it('pin: a PTY-backed session with a fresh output stamp stays protected', async () => {
    const sessions = [
      unobservedContract(asSessionId('pty-busy'), {
        driverFamily: 'terminal',
        lastOutputAtMs: NOW - 10_000,
      }),
    ]
    const { service, parked } = harness({ sessions, proven: new Set(sessions.map((s) => s.sessionId)) })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual([])
    expect(sessions[0]?.status).toBe('live')
  })

  it('passes proof consumption through for a quiet contract-backed candidate', async () => {
    const sessions = [
      unobservedContract(asSessionId('contract-old'), { driverFamily: 'server' }),
    ]
    const { service, parked, hibernateRequireProof } = harness({
      sessions, proven: new Set(['contract-old']),
    })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['contract-old'])
    expect(hibernateRequireProof).toEqual([{ sessionId: 'contract-old', requireTerminalProof: true }])
  })
  it.each(['terminal', 'server'] as const)(
    'keeps the unknown-phase four-hour floor for %s even with proof', async (driverFamily) => {
      const sessions = [unobservedContract(asSessionId('recent'), {
        driverFamily,
        lastActiveAt: new Date(NOW - 3 * HOUR).toISOString(),
      })]
      const { service, parked, hibernateRequireProof } = harness({
        sessions, proven: new Set(['recent']),
      })
      await service.onHostMetrics(asMachineId('local'), sample(95))
      expect(parked).toEqual([])
      expect(hibernateRequireProof).toEqual([])
    },
  )

})
