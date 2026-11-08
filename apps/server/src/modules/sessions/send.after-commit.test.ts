/**
 * A CHAT SEND DELIVERS AFTER THE COMMIT, NEVER INSIDE IT (POD-6349).
 *
 * `sessions.sendText` / `sessions.resumeAndSend` store a message row and then
 * hand it to the agent's machine. The row is the database write; the hand-on is
 * a daemon round trip (and, for a parked session, a wake). Once the command runs
 * inside one unit of work (POD-6241 Task 10), a hand-on made from inside it
 * would type into an agent a message the unit of work can still roll back.
 *
 * Inside a unit of work the send therefore replies "queued" and the delivery is
 * an after-commit effect. With no unit of work open it is unchanged. These tests
 * open the unit of work themselves, through the real router:
 *
 *  - a rollback stores nothing and sends nothing to the daemon;
 *  - a commit sends exactly one hand-on, after the commit;
 *  - a delivery lost between the commit and the hand-on is recovered by the
 *    boot reconcile of stored rows.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asSessionId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { OPERATOR } from '../../test-support/capabilities'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { sessionCommandCtx } from './command-ctx'
import { dispatchSessionCommand } from './command-plane'
import { disposeOracles, makeOracle } from './oracle-support'

afterEach(() => disposeOracles())

type Oracle = Awaited<ReturnType<typeof makeOracle>>

async function liveSession(o: Oracle): Promise<SessionId> {
  const { sessionId } = await o.reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/w',
  })
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/w',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId: asSessionId(sessionId),
    resume: { kind: 'claude-session', value: 'native-1' },
  })
  return sessionId
}

/** One host across the simulated restart, as relay.outbox.test.ts pins it. */
const TEST_MACHINE = asMachineId('machine-under-test')

const bind = (sessionId: SessionId) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/w',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  }) as const

const handOns = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter((m) => m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId)

const newMessageId = () => `msg_${randomUUID()}`

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/**
 * The delivery attempt, observed. A hand-on reaches the daemon through the
 * session's drain, which runs a turn later on every path, so counting frames
 * inside the unit of work cannot tell an attempt made there from one made
 * after it. The attempt itself can: it is what talks to the machine.
 */
function watchDeliveryAttempts(o: Oracle) {
  const messages = o.reg.modules.messages as unknown as {
    attemptDelivery: (...args: unknown[]) => Promise<unknown>
  }
  return vi.spyOn(messages, 'attemptDelivery')
}

/**
 * The send through the command plane, the way the sync write entry point's
 * handler runs it (POD-6350). The tRPC route is now an adapter onto the entry
 * point, which opens its own unit of work and refuses to run inside a caller's,
 * so these tests open the unit themselves around the plane.
 */
async function planeSend(
  o: Oracle,
  key: 'sendText' | 'resumeAndSend',
  input: { sessionId: SessionId; text: string; mutationId?: string },
): Promise<unknown> {
  return await dispatchSessionCommand(
    await sessionCommandCtx(o.reg.modules, OPERATOR, false, 'trpc'),
    key,
    input,
  )
}

describe('chat send delivers after the commit (POD-6349)', () => {
  it('with no unit of work open, a send attempts delivery before it replies (unchanged)', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    const attempts = watchDeliveryAttempts(o)

    const reply = await planeSend(o, 'sendText', { sessionId, text: 'inline' })

    expect(reply).toMatchObject({ ok: true })
    expect(attempts).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(handOns(o.daemon, sessionId)).toHaveLength(1))
  })

  it('the tRPC route runs the send in the entry point\'s unit: it replies queued and hands on once', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)

    const reply = await o.call.sessions.sendText({ sessionId, text: 'through the entry point' })

    expect(reply).toEqual({ ok: true, queued: true, disposition: 'queued' })
    await vi.waitFor(() => expect(handOns(o.daemon, sessionId)).toHaveLength(1))
    await settle()
    expect(handOns(o.daemon, sessionId)).toHaveLength(1)
  })

  it('a rolled-back send stores no row, attempts nothing and sends nothing to the daemon', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    const attempts = watchDeliveryAttempts(o)

    const mutationId = newMessageId()
    await expect(
      o.store.transact(async () => {
        await planeSend(o, 'sendText', { sessionId, text: 'never', mutationId })
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    await settle()

    expect(attempts).not.toHaveBeenCalled()
    expect(handOns(o.daemon, sessionId)).toHaveLength(0)
    expect(await o.store.messages.getMessage(mutationId)).toBeNull()
  })

  it('a committed send replies queued and hands its row on exactly once, after the commit', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    const attempts = watchDeliveryAttempts(o)

    let reply: unknown
    let attemptsInsideTheUnitOfWork = -1
    await o.store.transact(async () => {
      reply = await planeSend(o, 'sendText', { sessionId, text: 'after commit' })
      attemptsInsideTheUnitOfWork = attempts.mock.calls.length
    })

    expect(reply).toEqual({ ok: true, queued: true, disposition: 'queued' })
    expect(attemptsInsideTheUnitOfWork).toBe(0)
    await vi.waitFor(() => expect(handOns(o.daemon, sessionId)).toHaveLength(1))
    await settle()
    expect(attempts).toHaveBeenCalledTimes(1)
    expect(handOns(o.daemon, sessionId)).toHaveLength(1)
  })

  it('resumeAndSend inside a unit of work also waits for the commit', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    const attempts = watchDeliveryAttempts(o)

    let attemptsInsideTheUnitOfWork = -1
    await o.store.transact(async () => {
      await planeSend(o, 'resumeAndSend', { sessionId, text: 'wake and send' })
      attemptsInsideTheUnitOfWork = attempts.mock.calls.length
    })

    expect(attemptsInsideTheUnitOfWork).toBe(0)
    await vi.waitFor(() => expect(handOns(o.daemon, sessionId)).toHaveLength(1))
  })

  it('an attempt lost after the commit is retried by the delivery scheduler', async () => {
    const o = await makeOracle()
    const sessionId = await liveSession(o)
    const lost = watchDeliveryAttempts(o).mockImplementationOnce(
      async () => await Promise.reject(new Error('attempt lost')),
    )

    const mutationId = newMessageId()
    await o.store.transact(async () => {
      await planeSend(o, 'sendText', { sessionId, text: 'retried', mutationId })
    })

    // The send's own session write queued a delivery pass for the session,
    // and that pass finds the row still stored.
    await vi.waitFor(() => expect(handOns(o.daemon, sessionId)).toHaveLength(1), { timeout: 5000 })
    expect(lost.mock.calls.length).toBeGreaterThanOrEqual(2)
    await settle()
    expect(handOns(o.daemon, sessionId)).toHaveLength(1)
  })

  it('a server that dies between the commit and the hand-on delivers the row after restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-6349-send-')), 'podium.db')
    const storeA = await openTestStore(file, TEST_MACHINE)
    const regA = await SessionRegistry.create(storeA, undefined, { instanceId: 'default' })
    const daemonA: ControlMessage[] = []
    await attachHostDaemon(regA, (m) => daemonA.push(m))
    const { sessionId } = await regA.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    await regA.gateway.routeDaemonFrame(storeA.hostMachineId, bind(sessionId))
    // The crash: every piece of in-process work after the commit is lost —
    // the after-commit attempt and the delivery passes alike.
    const messagesA = regA.modules.messages as unknown as {
      attemptDelivery: (...args: unknown[]) => Promise<unknown>
      queueDeliveryTarget: (...args: unknown[]) => void
    }
    vi.spyOn(messagesA, 'attemptDelivery').mockImplementation(
      async () => await new Promise(() => {}),
    )
    vi.spyOn(messagesA, 'queueDeliveryTarget').mockImplementation(() => {})
    const mutationId = newMessageId()
    await storeA.transact(async () => {
      await dispatchSessionCommand(
        await sessionCommandCtx(regA.modules, OPERATOR, false, 'trpc'),
        'sendText',
        {
          sessionId,
          text: 'survives a crash',
          mutationId,
        },
      )
    })
    expect((await storeA.messages.getMessage(mutationId))?.deliveryStatus).toBe('stored')
    expect(handOns(daemonA, sessionId)).toHaveLength(0)
    await regA.dispose()
    await storeA.close()

    const storeB = await openTestStore(file, TEST_MACHINE)
    const regB = await SessionRegistry.create(storeB, undefined, { instanceId: 'default' })
    try {
      const daemonB: ControlMessage[] = []
      await attachHostDaemon(regB, (m) => daemonB.push(m))
      await regB.gateway.routeDaemonFrame(storeB.hostMachineId, bind(sessionId))

      await vi.waitFor(
        () =>
          expect(
            handOns(daemonB, sessionId).filter(
              (m) => (m as { text?: string }).text === 'survives a crash',
            ),
          ).toHaveLength(1),
        { timeout: 5000 },
      )
    } finally {
      await regB.dispose()
      await storeB.close()
    }
  })
})
