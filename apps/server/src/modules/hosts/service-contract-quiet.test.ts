import type { HostMetricsWire, SessionId } from '@podium/model'
import { asMachineId, asSessionId } from '@podium/model'
import { PodiumSettings } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../bus'
import { type HostSessionView, type HostsDeps, HostsService } from './service'

/**
 * CHARACTERIZATION for this issue (`POD-3994`, from POD-3740 audit Finding 7),
 * NOT a fix. Question: can a server-family contract session actually reach the
 * terminal-quiet park gate, given the audit's caveat that reaching it depends
 * on a resume ref being present?
 *
 * SHAPE. Each case below builds the HostSessionView exactly as relay.ts would
 * project a server-family contract session (codex-app-server: resume kind
 * `codex-thread` — apps/daemon/src/runtime/codex-driver.ts; same pattern for
 * opencode-session and grok-session):
 *   - `resume` PRESENT (server drivers report it at bind and the daemon stores
 *     it — daemon-lifecycle.ts `setResume`; it is durable on the row).
 *   - `phase` from driver state events (drivers re-send `state()` as legacy
 *     `agentState` at bind and on every state event — opencode-driver.ts).
 *   - `lastInputAtMs / lastOutputAtMs / lastResumedAtMs` all ZERO: a session
 *     with no PTY never receives `ptyOutput`, contract delivery
 *     (`forwardContractRows` → `contractDeliver`) never calls
 *     `recordInputActivity`, and `recordResumeActivity` fires only on a
 *     hibernation resume. relay.ts projects these stamps for EVERY session
 *     with no contract guard, so the gate reads never-moving zeros.
 *
 * Four cases, one per combination that matters:
 *   1. observed (idle) + proof → PARKED: the output-quiet overlay passes on
 *      epoch stamps, i.e. it contributes nothing for this shape.
 *   2. observed (idle) WITHOUT proof → live: the production mask. Contract
 *      sessions never hold terminal proof (no terminal observers ever confirm
 *      a fence; provider-`none` harnesses never even get a lease), so the
 *      observed path cannot fire for them in production.
 *   3. unobserved (unknown) + resume → PARKED with no proof consulted at all:
 *      the gate IS reachable. hibernateSession is entered with
 *      requireTerminalProof=false and succeeds on resume + non-working phase.
 *   4. unobserved WITHOUT resume → live, hibernateSession never entered: the
 *      audit's caveat holds — the resume ref is the ticket.
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
    parkStaleSession: async ({ sessionId }) => {
      const target = input.sessions.find((item) => item.sessionId === sessionId)
      if (!target || target.status !== 'live') return { ok: false, reason: 'not running' }
      target.status = target.resume ? 'hibernated' : 'exited'
      parked.push(sessionId)
      return { ok: true }
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

describe('contract-session quiet-gate reachability (characterization)', () => {
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

  it('parks a resumable unobserved contract-shaped session with no proof at all — the gate is reachable', async () => {
    // Phase unknown + resume ref + fully quiet past the 4 h floor: eligible
    // with NO terminal proof consulted. For this shape fullyQuietSinceMs is
    // just lastActiveAt (the PTY stamps are zeros), so "four hours terminal
    // quiet" is really "no contract event for four hours" — and the park
    // below kills the process on exactly that evidence.
    const sessions = [unobservedContract(asSessionId('contract-silent'))]
    const { service, parked, hibernateRequireProof } = harness({ sessions, proven: new Set() })

    await service.onHostMetrics(asMachineId('local'), sample(10))

    expect(parked).toEqual(['contract-silent'])
    expect(hibernateRequireProof).toEqual([
      { sessionId: 'contract-silent', requireTerminalProof: false },
    ])
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
