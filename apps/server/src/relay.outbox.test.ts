import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actorAgent,
  asAgentIdentityId,
  asMachineId,
  asMutationId,
  asSessionId,
  firstAdminMemberId,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import {
  asDelegationRef,
  CLIENT_WIRE_VERSION,
  type MetadataChange,
  type ServerMessage,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'

/** One host across the simulated restart: storeA writes rows under this id and storeB
 *  re-opens the same file as the same machine, which is what a real reboot is. Without
 *  pinning it each store would mint its own (POD-318) and the restart would look like
 *  a different computer. */
const TEST_MACHINE = asMachineId('machine-under-test')

import { userCommandPrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import { attachTestClient } from './test-support/client-transport'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

// Outbox write path at the registry seam (docs/spec/outbox-write-path.md §2.1-2.2):
// queueText wake + durable delivery, restart survival, FIFO + spacing, the
// withMutation idempotency wrapper, failed-drain row retention, and the
// queuedMessageCount surfacing on the wire (snapshot meta + P2 delta stream).
// There is no settle heuristic any more (cfb9924a7); relay.test.ts's
// 'queueText drain' describe pins that rows are handed on at once.

const G = { cols: 80, rows: 24 }
const bind = (sessionId: SessionId) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/',
    agentKind: 'claude-code',
    geometry: G,
  }) as const

const decodedInputs = (daemon: ControlMessage[]): string[] =>
  daemon
    .filter((m) => m.type === 'input')
    .map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())

const pastesContaining = (daemon: ControlMessage[], text: string): string[] =>
  decodedInputs(daemon).filter((t) => t.includes(text))

/** live claude session with a resume ref, parked via hibernate. */
async function hibernatedSession(reg: SessionRegistry): Promise<string> {
  const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: 'abc-123' },
  })
  expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  return sessionId
}

/** Drive the readiness engine to 'settled' after a bind: harness output followed
 * by the runtime-state observation that proves a resumed process is ready. */
async function settle(reg: SessionRegistry, sessionId: string): Promise<void> {
  let seq = 0
  for (let i = 0; i < 5; i += 1) {
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentFrame',
      sessionId: asSessionId(sessionId),
      seq: seq++,
      data: 'eA==',
    })
    await vi.advanceTimersByTimeAsync(200)
  }
  // A resumed CLI is ready when its harness reports state for THIS process, not
  // merely when its boot paint goes quiet (POD-1100). The real harness reports
  // runtime state after it has rehydrated; mirror that post-bind observation so
  // this fixture exercises the delivery path rather than the silent-CLI grace
  // period.
  const observedAt = new Date().toISOString()
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId: asSessionId(sessionId),
    state: {
      phase: 'idle',
      since: observedAt,
      nativeSubagentCount: 0,
      stateObservedAt: observedAt,
    },
  })
  await vi.advanceTimersByTimeAsync(1400)
}

/**
 * THE DURABLE SEND, AS THE DAEMON SEES IT (358ad0ffb / 81460a99b POD-4427 /
 * POD-4279; cfb9924a7 POD-4661; 4bd403fed; 99ef2c33b).
 *
 * This file used to pin the server TYPING a queued row into a claude-code
 * composer once a readiness window had passed, holding it until a user turn
 * echoed in the transcript (POD-2842, POD-2116), and spacing the next row
 * behind it. 358ad0ffb deleted that machine and cfb9924a7 deleted every hold
 * on the server's view of the agent. What the server does now, and what these
 * cases pin:
 *   - a queued row is handed on as ONE `runtimeDurableSendRequest` keyed by
 *     the row (`rowId`), from admission for a session with no transcript yet,
 *     even while it is still starting (4bd403fed); readiness is the daemon's
 *     delivery queue (apps/daemon/src/runtime/terminal-driver.test.ts describe
 *     "the queue drain");
 *   - rows go FIFO, the next only after the daemon's custody receipt
 *     (`runtimeSendResult`) for the one before it;
 *   - a bind is a new owner: it is handed the remaining rows again as
 *     RECOVERIES (`deliveryRecovery: true`), which a daemon confirms or fails
 *     and never retypes (POD-4360);
 *   - custody is not delivery: the row stays durable and counted until the
 *     driver's `delivery` runtime event settles it.
 * The wake, the restart survival and the counts on the wire are unchanged.
 */
type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>
const durableSends = (daemon: ControlMessage[], sessionId: string): DurableSendRequest[] =>
  daemon.filter(
    (message): message is DurableSendRequest =>
      message.type === 'runtimeDurableSendRequest' && message.sessionId === sessionId,
  )
/** The FIRST write of each row. A recovery re-hands a row already written. */
const freshSends = (daemon: ControlMessage[], sessionId: string): DurableSendRequest[] =>
  durableSends(daemon, sessionId).filter((send) => !send.deliveryRecovery)

/** The daemon takes custody of one durable send (`queued`), as a real one does. Not delivery. */
const grantCustody = async (reg: SessionRegistry, send: DurableSendRequest): Promise<void> =>
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'runtimeSendResult',
    requestId: send.requestId,
    sessionId: send.sessionId,
    receipt: {
      outcome: 'queued',
      position: 1,
      deliveredAs: 'queue',
      at: '2026-01-01T00:00:00.000Z',
    },
  })

/** A daemon transport that takes custody of every durable send at once, as a real daemon's delivery queue does. */
const custodyGranting =
  (reg: SessionRegistry, daemon: ControlMessage[]) =>
  (message: ControlMessage): void => {
    daemon.push(message)
    if (message.type === 'runtimeDurableSendRequest') void grantCustody(reg, message)
  }

/** The observer generation of the session's current process: its latest spawn. */
const currentGeneration = (daemon: ControlMessage[], sessionId: string): number => {
  const spawn = daemon
    .filter(
      (message): message is Extract<ControlMessage, { type: 'spawn' }> =>
        message.type === 'spawn' && message.sessionId === sessionId,
    )
    .at(-1)
  if (spawn?.observationGeneration === undefined) throw new Error('spawn was not fenced')
  return spawn.observationGeneration
}

/**
 * Settle rows the way the driver does. A woken or restarted process is a
 * REPLACEMENT observer generation, and the runtime event gate admits nothing
 * live on it until a bootstrap snapshot opens it; then one `delivery` event
 * per row.
 */
async function deliverRows(
  reg: SessionRegistry,
  daemon: ControlMessage[],
  sessionId: string,
  rowIds: readonly string[],
): Promise<void> {
  const observerGeneration = currentGeneration(daemon, sessionId)
  const cursor = (seq: number) => ({ segmentId: `delivery-${sessionId}`, components: { seq } })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'runtimeEvent',
    deliveryId: `bootstrap-${sessionId}-${observerGeneration}`,
    sessionId: asSessionId(sessionId),
    event: {
      t: 'state',
      change: {
        kind: 'state_snapshot',
        state: { phase: 'idle', since: '2026-01-01T00:00:00.000Z', nativeSubagentCount: 0 },
      },
      at: '2026-01-01T00:00:00.500Z',
      provenance: 'bootstrap',
      cursor: cursor(1),
      observerGeneration,
      turnEpoch: 0,
    },
  })
  for (const [index, rowId] of rowIds.entries()) {
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: `delivery-${rowId}`,
      sessionId: asSessionId(sessionId),
      event: {
        t: 'delivery',
        rowId,
        outcome: 'delivered',
        at: '2026-01-01T00:00:01.000Z',
        provenance: 'live',
        cursor: cursor(index + 2),
        observerGeneration,
        turnEpoch: 0,
      },
    })
  }
}

/** The durable rows this session still holds. */
const queuedRows = async (reg: SessionRegistry, sessionId: string) =>
  await reg.sessionStore.sync.listQueuedMessages(asSessionId(sessionId))

describe('queueText (durable outbox sends)', () => {
  /**
   * A new session's rows are handed to the daemon from admission (4bd403fed),
   * so this row is already in the daemon's custody when the human is revoked.
   * Revocation cannot erase an owner's work behind its back: the drain asks the
   * daemon to CANCEL the row (`runtimeInterruptRequest` with `cancelRowId`) and
   * rejects it only once the cancel is granted. A real daemon's delivery queue
   * answers that cancel (it drops the row); a transport that only records frames
   * never does, and the row then stays — correctly, since the daemon may still
   * hold it. So this daemon answers the cancel the way the real one does.
   */
  it('rejects an offline queued agent write when its human is revoked before drain', async () => {
    vi.useFakeTimers()
    try {
      const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      await attachHostDaemon(reg, (message) => {
        daemon.push(message)
        if (message.type === 'runtimeInterruptRequest' && message.cancelRowId !== undefined) {
          void reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
            type: 'runtimeLifecycleResult',
            requestId: message.requestId,
            sessionId: message.sessionId,
            result: { ok: true },
          })
        }
      })

      const source = (await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/source',
      })).sessionId
      const target = (await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/target',
        spawnedBy: `session:${source}`,
      })).sessionId
      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(target))
      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'sessionResumeRef',
        sessionId: target,
        resume: { kind: 'claude-session', value: 'revocation-proof' },
      })
      expect(await reg.modules.sessions.hibernateSession({ sessionId: target })).toEqual({ ok: true })
      daemon.length = 0

      const principal = {
        kind: 'agent' as const,
        principalRef: source,
        delegation: asDelegationRef(source),
        attribution: {
          actor: actorAgent(asAgentIdentityId(source)),
          onBehalfOf: firstAdminMemberId(),
        },
      }
      expect(
        (await reg.modules.sessions.queueText({
          sessionId: target,
          text: 'must not cross revocation',
          mutationId: asMutationId('revoke-before-drain'),
          principal,
        })),
      ).toEqual({ ok: true, queued: true })

      await vi.waitFor(() =>
        expect(daemon).toContainEqual(
          expect.objectContaining({ type: 'spawn', sessionId: target }),
        ),
      )
      // User lifecycle writes intentionally have no repository API yet.
      // @ts-expect-error test-only revocation through SessionStore's private connection
      await reg.sessionStore.db
        .prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
        .run('2026-08-01T00:00:00.000Z', firstAdminMemberId())

      const handedOnBeforeRevocation = daemon.filter(
        (message) => message.type === 'runtimeDurableSendRequest' && message.rowId === 'revoke-before-drain',
      ).length
      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(target))
      await settle(reg, target)

      // The drain asked the daemon to give the row back...
      expect(daemon).toContainEqual(
        expect.objectContaining({ type: 'runtimeInterruptRequest', sessionId: target, cancelRowId: 'revoke-before-drain' }),
      )
      // ...never handed it on again after the revocation, never typed it...
      expect(
        daemon.filter(
          (message) => message.type === 'runtimeDurableSendRequest' && message.rowId === 'revoke-before-drain',
        ),
      ).toHaveLength(handedOnBeforeRevocation)
      expect(pastesContaining(daemon, 'must not cross revocation')).toEqual([])
      // ...and rejected it: the durable row is gone and nothing is counted.
      expect(await reg.sessionStore.sync.listQueuedMessages(target)).toEqual([])
      expect(
        (await reg.modules.sessions.listSessions(undefined, 'rpc')).find((session) => session.sessionId === target)
          ?.queuedMessageCount,
      ).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it('wakes a hibernated resumable session, shows the count, hands the row on once, and settles it only on its delivery event', async () => {
    vi.useFakeTimers()
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const daemon: ControlMessage[] = []
      await attachHostDaemon(reg, custodyGranting(reg, daemon))
      const sessionId = await hibernatedSession(reg)
      daemon.length = 0

      expect(
        (await reg.modules.sessions.queueText({ sessionId: asSessionId(sessionId), text: 'wake-up-msg' })),
      ).toEqual({
        ok: true,
        queued: true,
      })

      // The wake follows async worktree/instruction preparation.
      await vi.waitFor(() =>
        expect(daemon).toContainEqual(
          expect.objectContaining({
            type: 'spawn',
            sessionId,
            resume: { kind: 'claude-session', value: 'abc-123' },
          }),
        ),
      )
      // The queued count rides the session meta while the message waits.
      expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBe(1)

      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(asSessionId(sessionId)))
      await vi.waitFor(() => expect(durableSends(daemon, sessionId).length).toBeGreaterThan(0))
      // ONE write of the text, keyed by the row. Any further hand-on of the same
      // row is a recovery to the new owner, never a second write.
      const [write] = freshSends(daemon, sessionId)
      expect(freshSends(daemon, sessionId)).toHaveLength(1)
      expect(write).toMatchObject({ text: 'wake-up-msg', origin: 'controller' })
      for (const send of durableSends(daemon, sessionId).filter((s) => s.deliveryRecovery)) {
        expect(send).toMatchObject({ rowId: write!.rowId, text: 'wake-up-msg' })
      }
      // CUSTODY IS NOT DELIVERY. The daemon holds the row and it is still the
      // operator's: counted, durable, and visible in the meta.
      expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBe(1)
      expect(await queuedRows(reg, sessionId)).toHaveLength(1)

      await deliverRows(reg, daemon, sessionId, [write!.rowId])
      await vi.waitFor(async () => expect(await queuedRows(reg, sessionId)).toEqual([]))

      // Delivered: the count leaves the meta and the durable row is gone.
      expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBeUndefined()
      // Still exactly one write, and nothing ever typed.
      expect(freshSends(daemon, sessionId)).toHaveLength(1)
      expect(decodedInputs(daemon)).toEqual([])
    } finally {
      await reg.dispose()
      vi.useRealTimers()
    }
  })
  it('reconstructs a lost wake from the durable queue after server restart and process-gone proof', async () => {
    vi.useFakeTimers()
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'podium-dead-send-reconcile-')), 'podium.db')
      const storeA = await openTestStore(file, TEST_MACHINE)
      const regA = await SessionRegistry.create(storeA, undefined, { instanceId: 'default' })
      await attachHostDaemon(regA, () => {})
      // The lost wake is admitted while the process is live, then the process
      // dies before a wake can be reconstructed. A bare bind after hibernation
      // does not resume a parked row (Session.markLive deliberately preserves it).
      const { sessionId } = await regA.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
      await regA.gateway.routeDaemonFrame(regA.sessionStore.hostMachineId, bind(sessionId))
      await regA.gateway.routeDaemonFrame(regA.sessionStore.hostMachineId, {
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: 'claude-session', value: 'abc-123' },
      })
      expect(
        (await regA.modules.sessions.queueText({
          sessionId: asSessionId(sessionId),
          text: 'wake',
          mutationId: asMutationId('restart-wake'),
        })),
      ).toEqual({ ok: true, queued: true })
      await regA.gateway.routeDaemonFrame(regA.sessionStore.hostMachineId, {
        type: 'agentExit',
        sessionId: asSessionId(sessionId),
        code: 137,
      })
      await vi.advanceTimersByTimeAsync(0)
      await regA.dispose()
      await storeA.close()

      const storeB = await openTestStore(file, TEST_MACHINE)
      const regB = await SessionRegistry.create(storeB, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      await attachHostDaemon(regB, custodyGranting(regB, daemon))
      expect(
        (await regB.modules.sessions.listSessions(undefined, 'rpc')).find((session) => session.sessionId === sessionId),
      ).toMatchObject({ status: 'exited', queuedMessageCount: 1 })

      await regB.gateway.routeDaemonFrame(regB.sessionStore.hostMachineId, {
        type: 'reattachFailed',
        sessionId: asSessionId(sessionId),
        reason: 'process gone',
      })
      await vi.waitFor(() =>
        expect(daemon.filter((message) => message.type === 'spawn')).toHaveLength(1),
      )

      await regB.gateway.routeDaemonFrame(regB.sessionStore.hostMachineId, bind(asSessionId(sessionId)))
      await vi.waitFor(() => expect(durableSends(daemon, sessionId).length).toBeGreaterThan(0))
      // The woken process is handed the row the dead one was holding, by its
      // durable id and text — and only that row.
      expect(
        durableSends(daemon, sessionId).every(
          (send) => send.rowId === 'restart-wake' && send.text === 'wake',
        ),
      ).toBe(true)
      await deliverRows(regB, daemon, sessionId, ['restart-wake'])
      await vi.waitFor(async () =>
        expect(await storeB.sync.listQueuedMessages(asSessionId(sessionId))).toEqual([]),
      )
      expect(decodedInputs(daemon)).toEqual([])
      await regB.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a due one-off wakes a hibernated target and hands its message on exactly once', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T22:00:00.000Z'))
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const daemon: ControlMessage[] = []
      await attachHostDaemon(reg, custodyGranting(reg, daemon))
      const sessionId = await hibernatedSession(reg)
      daemon.length = 0
      const runAt = '2026-07-16T22:02:00.000Z'
      const automation = await reg.modules.automations.create(
        {
          name: 'Night quota wake',
          scheduleKind: 'once',
          runAt,
          targetSessionId: asSessionId(sessionId),
          repoPath: '/w',
          agentKind: 'claude-code',
          prompt: 'continue-night-work',
          enabled: true,
          sessionMode: 'resume',
        },
        userCommandPrincipal(firstAdminMemberId(), 'admin'),
      )

      vi.setSystemTime(new Date('2026-07-16T22:02:01.000Z'))

      await reg.modules.automations.tick()
      await vi.waitFor(() =>
        expect(daemon).toContainEqual(
          expect.objectContaining({
            type: 'spawn',
            sessionId,
            resume: { kind: 'claude-session', value: 'abc-123' },
          }),
        ),
      )

      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(asSessionId(sessionId)))
      await vi.waitFor(() => expect(freshSends(daemon, sessionId)).toHaveLength(1))
      expect(freshSends(daemon, sessionId)[0]?.text).toBe('continue-night-work')
      await deliverRows(reg, daemon, sessionId, [freshSends(daemon, sessionId)[0]!.rowId])
      await vi.waitFor(async () => expect(await queuedRows(reg, sessionId)).toEqual([]))

      expect(await reg.modules.automations.runs(automation.id)).toEqual([
        expect.objectContaining({ outcome: 'spawned', sessionId }),
      ])
      expect((await reg.modules.automations.list())[0]).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastRunAt: runAt,
      })

      // A one-off runs once: a later tick neither records a run nor writes again.
      await reg.modules.automations.tick()
      expect(await reg.modules.automations.runs(automation.id)).toHaveLength(1)
      expect(freshSends(daemon, sessionId)).toHaveLength(1)
      expect(decodedInputs(daemon)).toEqual([])
    } finally {
      await reg.dispose()
      vi.useRealTimers()
    }
  })

  it('refuses a parked agent with no resume ref and queues NOTHING', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const daemon: ControlMessage[] = []
    await attachHostDaemon(reg, (m) => daemon.push(m))
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 1,
    })
    daemon.length = 0

    expect((await reg.modules.sessions.queueText({ sessionId, text: 'into-the-void' }))).toEqual({
      ok: false,
      reason: 'no resume ref',
    })
    // No durable row, no count on the meta, no wake attempt.
    expect(await reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBeUndefined()
    expect(daemon.filter((m) => m.type === 'spawn')).toEqual([])
  })

  it('survives a server restart: count re-seeds from the table and the row is handed to the woken process', async () => {
    vi.useFakeTimers()
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'podium-outbox-relay-')), 'podium.db')
      const storeA = await openTestStore(file, TEST_MACHINE)
      const regA = await SessionRegistry.create(storeA, undefined, { instanceId: 'default' })
      const daemonA: ControlMessage[] = []
      await attachHostDaemon(regA, (m) => daemonA.push(m))
      const sessionId = await hibernatedSession(regA)
      expect(
        (await regA.modules.sessions.queueText({
          sessionId: asSessionId(sessionId),
          text: 'survive-restart',
        })),
      ).toEqual({
        ok: true,
        queued: true,
      })

      await vi.waitFor(() => expect(daemonA.some((message) => message.type === 'spawn')).toBe(true))
      await vi.advanceTimersByTimeAsync(0)
      await regA.dispose()
      await storeA.close()

      // Restart: fresh store + registry over the same DB file.
      const storeB = await openTestStore(file, TEST_MACHINE)
      const regB = await SessionRegistry.create(storeB, undefined, { instanceId: 'default' })
      expect(
        (await regB.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)
          ?.queuedMessageCount,
      ).toBe(1)
      const [row] = await queuedRows(regB, sessionId)
      expect(row?.text).toBe('survive-restart')

      const daemonB: ControlMessage[] = []
      await attachHostDaemon(regB, custodyGranting(regB, daemonB))
      await regB.gateway.routeDaemonFrame(regB.sessionStore.hostMachineId, bind(asSessionId(sessionId)))
      await vi.waitFor(() => expect(durableSends(daemonB, sessionId).length).toBeGreaterThan(0))
      // The NEW process is handed the row the old one queued — that row, by its
      // durable id, and nothing else.
      expect(
        durableSends(daemonB, sessionId).every(
          (send) => send.rowId === row!.id && send.text === 'survive-restart',
        ),
      ).toBe(true)
      // Custody is not delivery: still counted across the restart until the
      // driver reports it delivered.
      expect(await queuedRows(regB, sessionId)).toHaveLength(1)

      // The woken process was spawned before the restart; its generation is on
      // that spawn.
      await deliverRows(regB, [...daemonA, ...daemonB], sessionId, [row!.id])
      await vi.waitFor(async () => expect(await queuedRows(regB, sessionId)).toEqual([]))
      expect(
        (await regB.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)
          ?.queuedMessageCount,
      ).toBeUndefined()
      expect(decodedInputs(daemonA)).toEqual([])
      expect(decodedInputs(daemonB)).toEqual([])
      await regB.dispose()
      await storeB.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands two queued messages on FIFO, each as its own durable send, the second only after custody of the first', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const daemon: ControlMessage[] = []
      await attachHostDaemon(reg, (m) => daemon.push(m))
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))

      await reg.modules.sessions.queueText({ sessionId, text: 'first-msg' })
      await reg.modules.sessions.queueText({ sessionId, text: 'second-msg' })
      expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBe(2)

      await vi.waitFor(() => expect(durableSends(daemon, sessionId)).toHaveLength(1))
      const [first] = durableSends(daemon, sessionId)
      expect(first).toMatchObject({ text: 'first-msg', deliveryRecovery: false })
      // THE ORDERING IS CUSTODY, not a timer: the second row waits for the
      // daemon to take the first, however long that takes.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(durableSends(daemon, sessionId)).toHaveLength(1)

      await grantCustody(reg, first!)
      await vi.waitFor(() => expect(durableSends(daemon, sessionId)).toHaveLength(2))
      const [, second] = durableSends(daemon, sessionId)
      expect(second).toMatchObject({ text: 'second-msg', deliveryRecovery: false })
      expect(second!.rowId).not.toBe(first!.rowId)
      await grantCustody(reg, second!)
      // Custody is not delivery: both are still the operator's.
      expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBe(2)

      await deliverRows(reg, daemon, sessionId, [first!.rowId, second!.rowId])
      await vi.waitFor(async () => expect(await queuedRows(reg, sessionId)).toEqual([]))
      expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBeUndefined()
      // Each its own write, in enqueue order; nothing typed.
      expect(durableSends(daemon, sessionId).map((send) => send.text)).toEqual([
        'first-msg',
        'second-msg',
      ])
      expect(decodedInputs(daemon)).toEqual([])
    } finally {
      await reg.dispose()
    }
  })

  it('a row whose session never binds stays queued however long it waits; the bind re-hands it and its delivery event settles it', async () => {
    vi.useFakeTimers()
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const daemon: ControlMessage[] = []
      await attachHostDaemon(reg, custodyGranting(reg, daemon))
      // No bind: the session sits in 'starting' well past the 25 s drain
      // deadline the old readiness window gave up at.
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      await reg.modules.sessions.queueText({ sessionId, text: 'patient-msg' })
      // A new session's row is handed on from admission (4bd403fed).
      await vi.waitFor(() => expect(freshSends(daemon, sessionId)).toHaveLength(1))
      const [write] = freshSends(daemon, sessionId)

      await vi.advanceTimersByTimeAsync(26_000)
      // Nothing gave up and nothing was dropped: the row is durable and counted.
      expect(await reg.sessionStore.sync.listQueuedMessages(sessionId)).toHaveLength(1)
      expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.queuedMessageCount).toBe(1)

      // The PTY finally binds: the new owner gets the same row as a recovery.
      const before = durableSends(daemon, sessionId).length
      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
      await vi.waitFor(() => expect(durableSends(daemon, sessionId).length).toBeGreaterThan(before))
      expect(durableSends(daemon, sessionId).slice(before)).toEqual([
        expect.objectContaining({
          rowId: write!.rowId,
          text: 'patient-msg',
          deliveryRecovery: true,
        }),
      ])

      await deliverRows(reg, daemon, sessionId, [write!.rowId])
      await vi.waitFor(async () =>
        expect(await reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([]),
      )
      expect(freshSends(daemon, sessionId)).toHaveLength(1)
      expect(decodedInputs(daemon)).toEqual([])
    } finally {
      await reg.dispose()
      vi.useRealTimers()
    }
  })

  it('surfaces the queued count on the P2 delta stream (session upsert with queuedMessageCount 1)', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    await attachHostDaemon(reg, () => {})
    const sessionId = await hibernatedSession(reg)

    const inbox: ServerMessage[] = []
    const clientId = attachTestClient(reg.clientGateway, (m) => inbox.push(m))
    // The current client's hello (a06b74998 moved the wire to
    // CLIENT_WIRE_VERSION 3 with `sync.http.v1`; a version-2 hello is refused
    // and never reaches `feedResume`).
    await reg.clientGateway.routeClientFrame(clientId, {
      type: 'hello',
      wireVersion: CLIENT_WIRE_VERSION,
      clientId,
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['sync.http.v1'],
    })
    await expect.poll(() => inbox.some((m) => m.type === 'feedResume')).toBe(true)
    const before = inbox.length

    await reg.modules.sessions.queueText({
      sessionId: asSessionId(sessionId),
      text: 'queued-while-parked',
    })
    await reg.modules.sessions.flushBroadcasts() // earlier setup broadcasts armed the coalescer — run the pending pipeline

    await expect.poll(() => inbox.slice(before).flatMap((m) => m.type === 'feedDelta' ? m.changes : [])
      .some((c) => c.entity === 'session' && (c.value as SessionMeta).queuedMessageCount === 1)).toBe(true)
    const changes = inbox.slice(before).flatMap((message) => {
      if (message.type === 'metadataDelta') return message.changes
      if (message.type !== 'feedDelta') return []
      return message.changes
        .filter((change) => change.op !== 'evict')
        .map((change) => ({ ...change, id: change.entityId }) as MetadataChange)
    })
    const upserts = changes.filter(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    )
    expect(upserts.length).toBeGreaterThanOrEqual(1)
    expect(upserts.some((c) => (c.value as SessionMeta).queuedMessageCount === 1)).toBe(true)
  })

  it('clears an existing snooze when a message is queued (fresh user intent)', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    await attachHostDaemon(reg, () => {})
    const sessionId = await hibernatedSession(reg)
    await reg.modules.sessions.setSnooze({
      userId: firstAdminMemberId(),
      sessionId: asSessionId(sessionId),
      until: null,
    })
    expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.snoozedUntil).toBeNull()

    await reg.modules.sessions.queueText({ sessionId: asSessionId(sessionId), text: 'un-snooze' })
    expect('snoozedUntil' in ((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0] ?? {})).toBe(false)
    expect(await reg.sessionStore.sessions.listSnoozes(firstAdminMemberId())).toEqual({})
  })
})

/**
 * FRAMEWORK IDEMPOTENCY as the REGISTRY exposes it (POD-382).
 *
 * These cases were written against `SessionLifecycle.withMutation` and now run
 * against `modules.mutations` — `@podium/sync`'s `MutationLedger`, the one
 * implementation — over the SAME durable table. Renamed rather than duplicated:
 * a case left wearing the old name would claim a wrapper that no longer exists.
 *
 * The ledger's own semantics are unit-tested in
 * packages/sync/src/mutation-ledger.test.ts; what these add is that the wiring in
 * the composition root reaches it, and that a replay through it does not
 * double-type into a real PTY.
 */
describe('framework idempotency (modules.mutations)', () => {
  it('runs once per id; a replay returns the recorded result without re-running', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    let runs = 0
    const first = await reg.modules.mutations.once(asMutationId('m-1'), 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['a', 'b'] }
    })
    const replay = await reg.modules.mutations.once(asMutationId('m-1'), 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['DIFFERENT'] }
    })
    expect(runs).toBe(1)
    expect(first).toEqual({ ok: true, ids: ['a', 'b'] })
    expect(replay).toEqual(first) // deep-equal via the JSON round-trip

    // A different id runs again.
    const other = await reg.modules.mutations.once(asMutationId('m-2'), 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['c'] }
    })
    expect(runs).toBe(2)
    expect(other).toEqual({ ok: true, ids: ['c'] })

    // No id at all = today's behavior: always runs.
    await reg.modules.mutations.once(undefined, 'test.proc', () => {
      runs += 1
      return 1
    })
    await reg.modules.mutations.once(undefined, 'test.proc', () => {
      runs += 1
      return 1
    })
    expect(runs).toBe(4)
  })

  it('records the RESOLVED value of an async proc, not the pending Promise (issues.create shape)', async () => {
    // Regression guard: JSON.stringify(promise) === '{}', which would poison every
    // replay of an async proc with an empty object.
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    let runs = 0
    const fn = async () => {
      runs += 1
      return { id: 'issue-1', title: 'once' }
    }
    const first = await reg.modules.mutations.once(asMutationId('m-async'), 'issues.create', fn)
    const replay = await reg.modules.mutations.once(asMutationId('m-async'), 'issues.create', fn)
    expect(runs).toBe(1)
    expect(first).toEqual({ id: 'issue-1', title: 'once' })
    expect(replay).toEqual(first)
  })

  /**
   * RE-PINNED ON THE CONTRACT (358ad0ffb POD-4427, POD-4279). A replay must
   * never put a second copy in front of the agent. For an agent that means ONE
   * durable row handed on as ONE write; a plain shell (POD-4278) still types,
   * so there it means exactly one paste and one CR.
   */
  it('a replayed sendText writes exactly once (one durable send to an agent; one paste + CR into a shell)', async () => {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const daemon: ControlMessage[] = []
      await attachHostDaemon(reg, custodyGranting(reg, daemon))
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
      const { sessionId: shell } = await reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/w',
      })
      await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        ...bind(shell),
        cmd: 'bash',
        agentKind: 'shell',
      })

      const send = async (id: string, target: SessionId) =>
        await reg.modules.mutations.once(
          asMutationId(id),
          'sessions.sendText',
          async () => await reg.modules.sessions.sendText({ sessionId: target, text: 'only-once' }),
        )
      expect(await send('send-1', sessionId)).toEqual({ ok: true, queued: true })
      expect(await send('send-1', sessionId)).toEqual({ ok: true, queued: true }) // recorded result, fn not re-run
      await vi.waitFor(() => expect(durableSends(daemon, sessionId)).toHaveLength(1))
      expect(await queuedRows(reg, sessionId)).toHaveLength(1)
      // Give a second copy every chance to appear.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(durableSends(daemon, sessionId).map((s) => s.text)).toEqual(['only-once'])

      expect(await send('send-2', shell)).toEqual({ ok: true })
      expect(await send('send-2', shell)).toEqual({ ok: true })
      // One paste + one CR — nothing else went to the PTY.
      expect(decodedInputs(daemon)).toEqual(['\x1b[200~only-once\x1b[201~', '\r'])
    } finally {
      await reg.dispose()
    }
  })
})
