/**
 * THE ABANDONMENT REPORT, END TO END (POD-2132, POD-2202).
 *
 * Every other test of this path stops at a seam: the daemon's tests end at the
 * frame it hands its host, and the message service's tests call
 * `onQueueDrainAbandoned` by hand. Between those two lies the wiring that
 * actually has to hold — mux routing, the session-ownership check, the
 * lifecycle port, the composition-root hook — and a receipt correction that is
 * only ever driven from one end of it can be broken in the middle without a
 * single test noticing.
 *
 * So these drive a REAL `runtimeQueueDrainAbandoned` frame in at the daemon
 * socket and read the durable row back OUT of the store, never through the
 * service that wrote it.
 *
 * COMPANION, NOT DUPLICATE: `relay.test.ts` has POD-2202's composed test for the
 * teardown reason with its report acknowledged. What is here is the rest of the
 * matrix that one case cannot speak for — the DEADLINE reason, an at-least-once
 * REPLAY landing one transition rather than two, and a machine that does not own
 * the session being refused.
 *
 * WHICH TURNS THE FRAME STILL ENDS (cfb9924a7 POD-4661, 99ef2c33b POD-3742,
 * ceb56a21f POD-4669). These used to queue a message for a not-yet-live SHELL
 * session and report it by message id. Since cfb9924a7 the server never holds
 * a send: a shell's text is typed at once and the row is delivered before any
 * report could name it. An agent's ordinary send is a durable row handed on as
 * a `runtimeDurableSendRequest` keyed by the ROW id, and a teardown report
 * naming that row discards the daemon's custody, not the durable work
 * (relay.test.ts, "a teardown report naming a durable row leaves it queued for
 * the next owner"); its delivery failure settles through the driver's
 * `delivery` event instead (4bd403fed). What
 * the frame still ends is a DIRECT turn, keyed by its message id: an interrupt
 * goes straight to the driver as a `runtimeSendRequest` (cfb9924a7), the driver
 * answers `queued` because it parked the turn in its own FIFO (POD-2291/2297),
 * and the row stays queued — until the driver reports it will never deliver it.
 * That is the receipt these tests drive to its terminal state.
 */

import {
  actorAgent,
  asAgentIdentityId,
  asMachineId,
  firstAdminMemberId,
  type SessionId,
} from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { fixtureInventory } from './test-support/daemon-inventory'
import { confirmingRetirement } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const MACHINE = 'm1'
const OTHER_MACHINE = 'm2'

const INVENTORY = JSON.stringify({
  os: 'linux',
  arch: 'x64',
  agents: [
    { kind: 'shell', installed: true, login: { state: 'in' } },
    { kind: 'claude-code', installed: true, login: { state: 'in' } },
  ],
  tools: [],
})

describe('a queue-drain abandonment crosses the wire into the durable row', () => {
  let store: SessionStore
  let registry: SessionRegistry
  let toDaemon: ControlMessage[]

  beforeEach(async () => {
    store = await openTestStore(':memory:')
    for (const id of [MACHINE, OTHER_MACHINE]) {
      await store.machines.upsertMachine({
        id,
        name: id,
        hostname: id,
        tokenHash: `token-${id}`,
        ownerUserId: firstAdminMemberId(),
        assignment: { server: false, agentExecution: true },
      })
      await store.machines.setMachineInventory(id, INVENTORY)
    }
    registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    toDaemon = []
    await registry.gateway.attachDaemon(
      MACHINE,
      confirmingRetirement(registry, MACHINE, (message) => toDaemon.push(message)),
    )
    await registry.gateway.attachDaemon(
      OTHER_MACHINE,
      confirmingRetirement(registry, OTHER_MACHINE, () => {}),
    )
    // The report a real daemon files on attach; an agent spawn asks for the
    // headed terminal driver, which the machine must advertise.
    await registry.modules.machines.recordInventory(
      asMachineId(MACHINE),
      fixtureInventory({
        runtimeDrivers: [{ harness: 'claude-code', id: 'claude-pty', family: 'terminal' }],
      }),
    )
    return () => registry.dispose()
  })

  const acksFor = (reportId: string): ControlMessage[] =>
    toDaemon.filter((m) => m.type === 'runtimeQueueDrainAbandonedAck' && m.reportId === reportId)

  /** Agent mail (enveloped, so the push alone never settles it). */
  const SUPERAGENT = {
    kind: 'superagent',
    attribution: {
      actor: actorAgent(asAgentIdentityId('superagent')),
      onBehalfOf: firstAdminMemberId(),
    },
    delegationRef: 'superagent',
  } as const

  /** A live agent this machine owns, bound to its terminal driver. */
  async function liveAgent(): Promise<SessionId> {
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      machineId: asMachineId(MACHINE),
    })
    await registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/w',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    return sessionId
  }

  /**
   * A live agent this machine owns, plus one message whose turn the driver
   * holds in its own queue: a direct (interrupt) turn keyed by the message id,
   * answered `queued`. The receipt is still `queued` — exactly what an
   * abandonment report exists to end.
   */
  async function queuedMessageFor(
    body: string,
  ): Promise<{ sessionId: SessionId; messageId: string }> {
    const sessionId = await liveAgent()
    const sent = await registry.modules.messages.send(SUPERAGENT, {
      to: { kind: 'session', id: sessionId },
      body,
      urgency: 'interrupt',
    })
    const request = await vi.waitFor(() => {
      const found = toDaemon.find(
        (m): m is Extract<ControlMessage, { type: 'runtimeSendRequest' }> =>
          m.type === 'runtimeSendRequest' && m.sessionId === sessionId,
      )
      if (!found) throw new Error('no direct turn reached the daemon')
      return found
    })
    // The turn on the wire IS the message: the report will name this id.
    expect(request.turnId).toBe(sent.message.id)
    await registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'runtimeSendResult',
      requestId: request.requestId,
      sessionId,
      receipt: {
        outcome: 'queued',
        position: 1,
        deliveredAs: 'queue',
        at: '2026-01-01T00:00:00.000Z',
      },
    })
    expect((await store.messages.getMessage(sent.message.id))?.status).toBe('queued')
    return { sessionId, messageId: sent.message.id }
  }

  it('acknowledges only after the durable abandonment completes', async () => {
    const { sessionId, messageId } = await queuedMessageFor('wait for persistence')
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = store.messages.markDeliveryAbandoned.bind(store.messages)
    const write = vi
      .spyOn(store.messages, 'markDeliveryAbandoned')
      .mockImplementationOnce(async (...args) => {
        await pending
        return await original(...args)
      })
    const delivery = registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      reportId: 'delayed-report',
      sessionId,
      turnIds: [messageId],
      reason: 'teardown',
    })
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalled())
      expect(acksFor('delayed-report')).toHaveLength(0)
      expect((await store.messages.getMessage(messageId))?.status).toBe('queued')
    } finally {
      release()
      await delivery
      write.mockRestore()
    }
    expect(acksFor('delayed-report')).toHaveLength(1)
    expect((await store.messages.getMessage(messageId))?.status).toBe('dead_letter')
  })

  it.each([
    'never-live',
    'teardown',
    // POD-2297's arm: a server-family driver took the turn off its own queue and
    // the send failed. It reaches this path through the same frame the terminal
    // family has always used, which is the whole point of not inventing a second
    // one for the server drivers.
    'delivery-failed',
  ] as const)('a %s frame from the owning machine ends the queued receipt', async (reason) => {
    const { sessionId, messageId } = await queuedMessageFor(`abandoned by ${reason}`)

    await registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      sessionId,
      turnIds: [messageId],
      reason,
    })

    // Read straight from the store, not from the service that wrote it.
    expect(await store.messages.getMessage(messageId)).toMatchObject({
      status: 'dead_letter',
      deliveryDeferredReason: reason,
      deliveredTo: sessionId,
    })
    expect((await store.messages.getMessage(messageId))?.deadLetteredAt).not.toBeNull()
  })

  it('an at-least-once replay corrects the same receipt once, and is re-acked', async () => {
    const { sessionId, messageId } = await queuedMessageFor('reported twice')
    // The daemon's outbox replays a report until the server acks it, so the
    // SAME reportId arrives again — and the duplicated turn id inside one report
    // is the other way the port says a consumer will hear a turn twice.
    const report = (): DaemonMessage => ({
      type: 'runtimeQueueDrainAbandoned',
      reportId: 'report-replayed',
      sessionId,
      turnIds: [messageId, messageId],
      reason: 'never-live',
    })

    await registry.gateway.routeDaemonFrame(MACHINE, report())
    const firstStamp = (await store.messages.getMessage(messageId))?.deadLetteredAt
    await registry.gateway.routeDaemonFrame(MACHINE, report())

    // The first report is the one that stands: no second stamp, no rewritten
    // reason, and exactly one terminal transition on the ledger.
    expect(await store.messages.getMessage(messageId)).toMatchObject({
      status: 'dead_letter',
      deadLetteredAt: firstStamp,
      deliveryDeferredReason: 'never-live',
    })
    expect(
      (await store.events.listEventsSince(0, { kinds: ['message.dead_letter'] })).filter(
        (e) => e.subject === messageId,
      ),
    ).toHaveLength(1)
    // Deduping must not swallow the ACK: a replay the server quietly ignores is
    // a report the daemon replays forever.
    expect(acksFor('report-replayed')).toHaveLength(2)
  })

  it('a frame from a machine that does not own the session moves nothing', async () => {
    const { sessionId, messageId } = await queuedMessageFor('not yours to abandon')

    await registry.gateway.routeDaemonFrame(OTHER_MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      sessionId,
      turnIds: [messageId],
      reason: 'never-live',
    })

    // The ownership check is what stops a machine dead-lettering another
    // machine's mail — worth pinning here, because this is the only place the
    // check and the durable write are exercised in the same breath.
    //
    // READ THIS ONE HONESTLY: it is a negative, so unlike its neighbours it
    // still passes with the consumer wiring cut out entirely. It pins the
    // refusal, not the path. The cases above are what prove the path.
    expect((await store.messages.getMessage(messageId))?.status).toBe('queued')
  })

  it('tells the sender what happened, in words about their message', async () => {
    /**
     * A dead-letter row nobody is told about is the original defect wearing a
     * durable status. `delivery-failed` gets its own sentence because the other
     * two would misdescribe it: nothing failed to START here, and nothing was
     * torn down — the session took the turn and then could not hand it on.
     */
    const { sessionId, messageId } = await queuedMessageFor('tell me why')
    const original = await store.messages.getMessage(messageId)
    if (!original) throw new Error('the queued message is missing')
    // Whoever sent it is told: the service's own reply target for the original
    // (superagent mail has no mailbox of its own, so that is the operator it
    // acts for).
    const replyTo = await registry.modules.messages.replyTarget(original)

    await registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      sessionId,
      turnIds: [messageId],
      reason: 'delivery-failed',
    })

    const notice = (await store.messages.listQueued()).find(
      (m) => m.kind === 'notification' && m.body.includes(messageId),
    )
    expect(notice?.body).toContain('could not be delivered')
    expect(notice?.body).toContain('then failed to hand it to the agent')
    // Sent back to whoever sent the original, not broadcast at the session.
    expect(replyTo.kind).toBe('operator')
    expect(notice?.toKind).toBe(replyTo.kind)
    expect(notice?.toId ?? null).not.toBe(sessionId)
  })
})
