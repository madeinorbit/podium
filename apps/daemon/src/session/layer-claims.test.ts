/**
 * THE LAYERS PAGE'S NEVER / ONLY / ALWAYS CLAIMS, DAEMON HALF (POD-4616,
 * REVIEW-4438 §6).
 *
 * Each `describe` below pins one sentence the design states and no test
 * settled before. They are characterization tests: they describe the code as
 * it is at bf592da92, and each one was shown red by breaking exactly the rule
 * it names (the mutation and the red run are in VERIFY-4616.md on the issue).
 * Every "never" is paired with the arm where the thing DOES happen, so a
 * fixture that cannot observe the event at all fails the control arm instead
 * of passing the claim.
 *
 * Hermetic: stub attachments, stub handles, a stand-in durable process. No
 * pty, no podium-host, no server.
 */

import type { AgentSessionHandle, RuntimeEventBody } from '@podium/harness/driver/host'
import { withDeliveryQueue } from '@podium/harness/driver/host'
import { asSessionId, type SessionId } from '@podium/model'
import type { DurableAttachment, DurableProcess } from '@podium/process/durable'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { stopSessionProcess, wireBridge } from '../control/session'
import { runtimeHandlers } from '../runtime/handlers'
import type { ServerReapIo } from '../runtime/server-reap'
import { driverSlotsOver } from './driver-slots.js'
import { testSessions } from './testing.js'

const SESSION = asSessionId('s-layer-claims')

/** Let every queued microtask and one macrotask turn run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function sentOf<T extends DaemonMessage['type']>(sent: DaemonMessage[], type: T) {
  return sent.filter((msg): msg is Extract<DaemonMessage, { type: T }> => msg.type === type)
}

// ---------------------------------------------------------------------------
// Claim 4 — control/session.ts `wireBridge` onExit
// ---------------------------------------------------------------------------

describe('the attach CLIENT exiting is NOT the AGENT exiting', () => {
  /** An attachment whose exit the test fires by hand. */
  function attachment(): DurableAttachment & { exit(code: number): void } {
    let onExit: ((code: number) => void) | undefined
    return {
      pid: 4321,
      onFrame: () => () => {},
      onTitle: () => () => {},
      onExit: (cb: (code: number) => void) => {
        onExit = cb
        return () => {
          onExit = undefined
        }
      },
      write: () => {},
      writeBytes: () => {},
      resize: () => {},
      redraw: () => {},
      geometry: () => ({ cols: 80, rows: 24 }),
      dispose: () => {},
      exit: (code: number) => onExit?.(code),
    } as unknown as DurableAttachment & { exit(code: number): void }
  }

  /** A daemon whose durable host answers `has(label)` with `hostAlive`. */
  function bridged(hostAlive: boolean) {
    const sent: DaemonMessage[] = []
    // Holds only THIS session's label: a check that asked about the wrong
    // label would read as a vanished host and report the exit.
    const has = vi.fn(async (label: string) => hostAlive && label === 'podium-s-layer-claims')
    const ctx = {
      backend: 'host',
      durable: { has } as unknown as DurableProcess,
      settingsDir: join(tmpdir(), 'podium-layer-claims'),
      sessions: testSessions(),
      // Upload removal is fenced; a fence that runs nothing keeps this test
      // off the real state dir. What is asserted is the agentExit frame.
      portableStateFence: { runSync: () => {} },
      composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
      outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {} },
      observers: { clearSession: () => {} },
      sessionCwdTracker: { clear: () => {} },
      primeInjector: { reset: () => {} },
      send: (msg: DaemonMessage) => void sent.push(msg),
    } as unknown as DaemonContext
    const client = attachment()
    wireBridge(ctx, SESSION, client, 'codex', 'podium-s-layer-claims', { cols: 80, rows: 24 })
    return { ctx, sent, has, client }
  }

  it('a client exit with the durable host still holding the label reports NO agentExit', async () => {
    const { sent, has, client } = bridged(true)

    client.exit(137) // SIGKILLed attach client: a redeploy, a detach, a client crash
    await settle()
    await settle()

    expect(sentOf(sent, 'agentExit')).toEqual([])
    // Silence because the host was ASKED and answered, not because nothing ran.
    expect(has).toHaveBeenCalledWith('podium-s-layer-claims')
  })

  it('…and the same exit with the host GONE is the agent exiting: agentExit, once, with the code', async () => {
    // The control arm. Without it the claim above would pass on a fixture
    // that could never observe an agentExit at all.
    const { sent, client } = bridged(false)

    client.exit(0)
    await vi.waitFor(() => expect(sentOf(sent, 'agentExit')).toHaveLength(1))

    expect(sentOf(sent, 'agentExit')[0]).toMatchObject({ sessionId: SESSION, code: 0 })
  })
})

// ---------------------------------------------------------------------------
// Claim 5 — control/session.ts `stopSessionProcessOnce`, daemon-session.ts `clear()`
// ---------------------------------------------------------------------------

describe('forgetting the driver slot cannot strand a teardown already under way', () => {
  it('a slow handle stop that outlives owned.clear() still completes and reports sessionKillResult', async () => {
    const sent: DaemonMessage[] = []
    const sessions = testSessions()
    // The production lookup: the server family's view over the session entry
    // (POD-4610). The handle is reachable ONLY through the entry's slot.
    const slots = driverSlotsOver(sessions)
    let alive = true
    let finishStop!: () => void
    const stopCalls: string[] = []
    const handle = {
      binding: { sessionId: SESSION, process: { key: 'podium-x-s-layer-claims', pid: 4321 } },
      stop: () => {
        stopCalls.push('stop')
        return new Promise<void>((resolve) => {
          finishStop = () => {
            alive = false
            resolve()
          }
        })
      },
      kill: async () => {
        stopCalls.push('kill')
      },
    } as unknown as AgentSessionHandle
    slots.set(SESSION, handle)
    const io: ServerReapIo = {
      pidAlive: () => alive,
      signal: () => {},
      pidInUnit: () => false,
      probeOpencode: async () => false,
      runSystemctl: async () => {},
      sleep: async () => {},
      canScope: () => false,
    }
    const ctx = {
      backend: 'none',
      settingsDir: join(tmpdir(), 'podium-layer-claims'),
      sessions,
      durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
      observers: { clearSession: () => {} },
      outputScheduler: { remove: () => {} },
      portableStateFence: { runSync: () => {} },
      serverReapIo: io,
      agentRuntime: {
        handleFor: (sessionId: SessionId) => slots.get(sessionId),
        serverHandleFor: (sessionId: SessionId) => slots.get(sessionId),
        journalledServerProcess: () => undefined,
        clearTerminal: () => {},
      },
      send: (msg: DaemonMessage) => void sent.push(msg),
    } as unknown as DaemonContext

    const retired = stopSessionProcess(ctx, { sessionId: SESSION })

    // The slot is forgotten while the stop is still running: the entry is
    // gone and no lookup reaches the handle any more…
    await vi.waitFor(() => expect(sessions.get(SESSION)).toBeUndefined())
    expect(slots.get(SESSION)).toBeUndefined()
    expect(stopCalls).toEqual(['stop'])
    expect(sentOf(sent, 'sessionKillResult')).toEqual([])

    // …and the teardown, holding its own reference, still finishes and says so.
    finishStop()
    await expect(retired).resolves.toBe(true)
    expect(sentOf(sent, 'sessionKillResult')).toEqual([
      expect.objectContaining({ sessionId: SESSION, killed: true, durableLabel: 'podium-x-s-layer-claims' }),
    ])
    expect(stopCalls).toEqual(['stop'])
  })
})

// ---------------------------------------------------------------------------
// Claim 6 — runtime/handlers.ts `runtimeSendRequest`, daemon-session.ts `BindFailureInput`
// ---------------------------------------------------------------------------

describe('custody of a turn lives in exactly one place: an unbound send is refused, never queued', () => {
  it('answers not_running with no handle, and the refused turn never reaches the driver that binds later', async () => {
    const sent: DaemonMessage[] = []
    let bound: AgentSessionHandle | undefined
    const delivered: string[] = []
    const handle = {
      binding: { sessionId: SESSION, driver: 'stub', harness: 'codex' },
      send: vi.fn(async (input: { id?: string }) => {
        delivered.push(input.id ?? '')
        return { outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready', provenBy: 'protocol-ack', at: '' }
      }),
    } as unknown as AgentSessionHandle
    const ctx = {
      agentRuntime: { handleFor: () => bound },
      send: (msg: DaemonMessage) => void sent.push(msg),
    } as unknown as DaemonContext
    const request = (turnId: string) =>
      ({
        type: 'runtimeSendRequest',
        requestId: `req-${turnId}`,
        turnId,
        sessionId: SESSION,
        text: turnId,
        origin: 'controller',
        delivery: 'when-ready',
      }) as never

    runtimeHandlers.runtimeSendRequest(ctx, request('before-bind'))
    expect(sentOf(sent, 'runtimeSendResult')).toEqual([
      expect.objectContaining({
        requestId: 'req-before-bind',
        receipt: { outcome: 'refused', refusal: expect.objectContaining({ reason: 'not_running' }) },
      }),
    ])

    // A driver binds. Had the daemon kept the refused turn anywhere, this is
    // where a second owner would deliver it.
    bound = handle
    await settle()
    await settle()
    runtimeHandlers.runtimeSendRequest(ctx, request('after-bind'))
    await vi.waitFor(() => expect(sentOf(sent, 'runtimeSendResult')).toHaveLength(2))
    await settle()

    // The after-bind turn proves the driver is reachable; the before-bind
    // turn never arrives, and was answered exactly once.
    expect(delivered).toEqual(['after-bind'])
    expect(sentOf(sent, 'runtimeSendResult').map((msg) => msg.requestId)).toEqual([
      'req-before-bind',
      'req-after-bind',
    ])
  })
})

// ---------------------------------------------------------------------------
// Claim 3, daemon half — runtime/handlers.ts → harness delivery-queue.ts
// ---------------------------------------------------------------------------

describe('a recovery forward of an unverified row is confirmed on the daemon, never retyped', () => {
  /** A real durable delivery queue over a stub driver that counts typings. */
  function daemon() {
    const sent: DaemonMessage[] = []
    const typed: string[] = []
    const outcomes: RuntimeEventBody[] = []
    const inner = {
      binding: { sessionId: SESSION, driver: 'stub', harness: 'codex' },
      state: async () => ({ phase: 'idle' }),
      send: async (input: { text: string }) => {
        typed.push(input.text)
        return { outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready', provenBy: 'protocol-ack', at: '' }
      },
    } as unknown as AgentSessionHandle
    const handle = withDeliveryQueue(inner, (event) => void outcomes.push(event))
    const ctx = {
      agentRuntime: { handleFor: () => handle },
      send: (msg: DaemonMessage) => void sent.push(msg),
    } as unknown as DaemonContext
    const forward = (deliveryRecovery: boolean) =>
      runtimeHandlers.runtimeSendRequest(ctx, {
        type: 'runtimeSendRequest',
        requestId: 'req-row',
        turnId: 'row-1',
        rowId: 'row-1',
        deliveryRecovery,
        sessionId: SESSION,
        text: 'the queued prompt',
        origin: 'controller',
        delivery: 'when-ready',
      } as never)
    return { sent, typed, outcomes, forward }
  }

  it('deliveryRecovery: the row settles failed for the transcript check, and nothing is typed', async () => {
    const d = daemon()

    d.forward(true)
    await vi.waitFor(() => expect(d.outcomes).toHaveLength(1))
    await settle()

    expect(d.typed).toEqual([])
    expect(d.outcomes).toEqual([
      expect.objectContaining({ t: 'delivery', rowId: 'row-1', outcome: 'failed' }),
    ])
  })

  it('…and the same row forwarded fresh IS typed, once (the control arm)', async () => {
    const d = daemon()

    d.forward(false)
    await vi.waitFor(() => expect(d.outcomes).toHaveLength(1))

    expect(d.typed).toEqual(['the queued prompt'])
    expect(d.outcomes).toEqual([
      expect.objectContaining({ t: 'delivery', rowId: 'row-1', outcome: 'delivered' }),
    ])
  })
})
