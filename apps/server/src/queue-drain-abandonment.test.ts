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
 */

import { asMachineId, asUserId, type SessionId } from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

const MACHINE = 'm1'
const OTHER_MACHINE = 'm2'

const INVENTORY = JSON.stringify({
  os: 'linux',
  arch: 'x64',
  agents: [{ kind: 'shell', installed: true, login: { state: 'in' } }],
  tools: [],
})

describe('a queue-drain abandonment crosses the wire into the durable row', () => {
  let store: SessionStore
  let registry: SessionRegistry
  let toDaemon: ControlMessage[]

  beforeEach(() => {
    store = new SessionStore(':memory:')
    for (const id of [MACHINE, OTHER_MACHINE]) {
      store.machines.upsertMachine({
        id,
        name: id,
        hostname: id,
        tokenHash: `token-${id}`,
        ownerUserId: asUserId('user:sole'),
      })
      store.machines.setMachineInventory(id, INVENTORY)
    }
    registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    toDaemon = []
    registry.gateway.attachDaemon(MACHINE, (message) => toDaemon.push(message))
    registry.gateway.attachDaemon(OTHER_MACHINE, () => {})
    return () => registry.dispose()
  })

  const acksFor = (reportId: string): ControlMessage[] =>
    toDaemon.filter((m) => m.type === 'runtimeQueueDrainAbandonedAck' && m.reportId === reportId)

  /** A session this machine owns, plus one message durably queued for it. */
  function queuedMessageFor(body: string): { sessionId: SessionId; messageId: string } {
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
      machineId: asMachineId(MACHINE),
    })
    const sent = registry.modules.messages.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: sessionId }, body, urgency: 'next-turn' },
    )
    expect(store.messages.getMessage(sent.message.id)?.status).toBe('queued')
    return { sessionId, messageId: sent.message.id }
  }

  it.each([
    'never-live',
    'teardown',
    // POD-2297's arm: a server-family driver took the turn off its own queue and
    // the send failed. It reaches this path through the same frame the terminal
    // family has always used, which is the whole point of not inventing a second
    // one for the server drivers.
    'delivery-failed',
  ] as const)('a %s frame from the owning machine ends the queued receipt', (reason) => {
    const { sessionId, messageId } = queuedMessageFor(`abandoned by ${reason}`)

    registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      sessionId,
      turnIds: [messageId],
      reason,
    })

    // Read straight from the store, not from the service that wrote it.
    expect(store.messages.getMessage(messageId)).toMatchObject({
      status: 'dead_letter',
      deliveryDeferredReason: reason,
      deliveredTo: sessionId,
    })
    expect(store.messages.getMessage(messageId)?.deadLetteredAt).not.toBeNull()
  })

  it('an at-least-once replay corrects the same receipt once, and is re-acked', () => {
    const { sessionId, messageId } = queuedMessageFor('reported twice')
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

    registry.gateway.routeDaemonFrame(MACHINE, report())
    const firstStamp = store.messages.getMessage(messageId)?.deadLetteredAt
    registry.gateway.routeDaemonFrame(MACHINE, report())

    // The first report is the one that stands: no second stamp, no rewritten
    // reason, and exactly one terminal transition on the ledger.
    expect(store.messages.getMessage(messageId)).toMatchObject({
      status: 'dead_letter',
      deadLetteredAt: firstStamp,
      deliveryDeferredReason: 'never-live',
    })
    expect(
      store.events
        .listEventsSince(0, { kinds: ['message.dead_letter'] })
        .filter((e) => e.subject === messageId),
    ).toHaveLength(1)
    // Deduping must not swallow the ACK: a replay the server quietly ignores is
    // a report the daemon replays forever.
    expect(acksFor('report-replayed')).toHaveLength(2)
  })

  it('a frame from a machine that does not own the session moves nothing', () => {
    const { sessionId, messageId } = queuedMessageFor('not yours to abandon')

    registry.gateway.routeDaemonFrame(OTHER_MACHINE, {
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
    expect(store.messages.getMessage(messageId)?.status).toBe('queued')
  })

  it('tells the sender what happened, in words about their message', () => {
    /**
     * A dead-letter row nobody is told about is the original defect wearing a
     * durable status. `delivery-failed` gets its own sentence because the other
     * two would misdescribe it: nothing failed to START here, and nothing was
     * torn down — the session took the turn and then could not hand it on.
     */
    const { sessionId, messageId } = queuedMessageFor('tell me why')
    const sentBy = store.messages.getMessage(messageId)?.fromKind

    registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      sessionId,
      turnIds: [messageId],
      reason: 'delivery-failed',
    })

    const notice = store.messages
      .listQueued()
      .find((m) => m.kind === 'notification' && m.body.includes(messageId))
    expect(notice?.body).toContain('could not be delivered')
    expect(notice?.body).toContain('then failed to hand it to the agent')
    // Sent back to whoever sent the original, not broadcast at the session.
    expect(notice?.toKind).toBe(sentBy)
  })
})
