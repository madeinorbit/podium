/**
 * THE ABANDONMENT REPORT, END TO END (POD-2132, POD-2202, POD-4795).
 *
 * Every other test of this path stops at a seam: the daemon's tests end at the
 * frame it hands its host, and the message service's tests call
 * `onQueueDrainAbandoned` by hand. Between those two lies the wiring that
 * actually has to hold — mux routing, the session-ownership check, the
 * lifecycle port, the composition-root hook, the acknowledgement — and it can
 * be broken in the middle without a single test noticing.
 *
 * So these drive a REAL `runtimeQueueDrainAbandoned` frame in at the daemon
 * socket and read the outcome back OUT of the store, never through the service
 * that handled it.
 *
 * WHAT THE FRAME NAMES NOW (POD-4795, 435ac2e70). This file used to hold an
 * interrupt as a DIRECT turn — a `runtimeSendRequest` keyed by the message id,
 * parked in the driver's own FIFO — and pin that each report reason ended it in
 * `dead_letter` with a notice to its sender. POD-4795 deleted that pipeline:
 * every agent send, the interrupt included, is one durable `queued_messages`
 * row under the message id, handed on as a `runtimeDurableSendRequest` whose
 * `turnId` is the row id, and interrupt is only that row's delivery MODE. The
 * daemon still files this frame (the terminal injection queue on never-live and
 * teardown, a server family's queue on a failed hand-off, a bind failure), and
 * the ids it names are those row ids. A report naming a durable row discards
 * the daemon's CUSTODY, not the durable work: the server acknowledges it, moves
 * nothing, and the next owner receives the row again as a recovery
 * (relay.test.ts "a teardown report naming a durable row leaves it queued for
 * the next owner" pins that for an ordinary send). A delivery failure settles
 * through the driver's `delivery` event instead (4bd403fed).
 *
 * So the cases here are the same matrix re-aimed at the current design: every
 * reason, for the send that used to be the one this frame dead-lettered; the
 * acknowledgement ordering; an at-least-once replay; and a machine that does
 * not own the session. The old "tells the sender what happened" case is gone
 * with the direct turn — no report reaches a dead letter any more, and the
 * never-typed notice wording is pinned where it is composed
 * (modules/messages/service.test.ts).
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

type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>

describe('a queue-drain abandonment crosses the wire and leaves durable work queued', () => {
  let store: SessionStore
  let registry: SessionRegistry
  let toDaemon: ControlMessage[]
  let toOther: ControlMessage[]

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
    toOther = []
    await registry.gateway.attachDaemon(
      MACHINE,
      confirmingRetirement(registry, MACHINE, (message) => toDaemon.push(message)),
    )
    await registry.gateway.attachDaemon(
      OTHER_MACHINE,
      confirmingRetirement(registry, OTHER_MACHINE, (message) => toOther.push(message)),
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

  const durableSends = (sessionId: SessionId): DurableSendRequest[] =>
    toDaemon.filter(
      (m): m is DurableSendRequest =>
        m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId,
    )

  /** Agent mail (enveloped, so the push alone never settles it). */
  const SUPERAGENT = {
    kind: 'superagent',
    attribution: {
      actor: actorAgent(asAgentIdentityId('superagent')),
      onBehalfOf: firstAdminMemberId(),
    },
    delegationRef: 'superagent',
  } as const

  const bind = (sessionId: SessionId) =>
    ({
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/w',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    }) as const

  /** A live agent this machine owns, bound to its terminal driver. */
  async function liveAgent(): Promise<SessionId> {
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      machineId: asMachineId(MACHINE),
    })
    await registry.gateway.routeDaemonFrame(MACHINE, bind(sessionId))
    return sessionId
  }

  /**
   * A live agent this machine owns, plus one INTERRUPT — the send this frame
   * used to dead-letter — handed on as a durable row the daemon now holds in
   * custody. The turn id on the wire is the row id, which is the message id:
   * that is the id a report names.
   */
  async function heldInterrupt(body: string): Promise<{ sessionId: SessionId; messageId: string }> {
    const sessionId = await liveAgent()
    const sent = await registry.modules.messages.send(SUPERAGENT, {
      to: { kind: 'session', id: sessionId },
      body,
      urgency: 'interrupt',
    })
    await vi.waitFor(() => expect(durableSends(sessionId)).toHaveLength(1))
    const [request] = durableSends(sessionId)
    expect(request).toMatchObject({
      rowId: sent.message.id,
      turnId: sent.message.id,
      delivery: 'interrupt',
      deliveryRecovery: false,
    })
    // No second pipeline: nothing went to the driver outside the durable row.
    expect(toDaemon.some((m) => m.type === 'runtimeSendRequest')).toBe(false)
    expect((await store.messages.getMessage(sent.message.id))?.deliveryStatus).toBe('dispatched')
    return { sessionId, messageId: sent.message.id }
  }

  /** The durable work is untouched: still pending, still queued, no dead letter
   *  (and so no sender notice, which is stored only with the dead letter). */
  async function expectStillQueued(sessionId: SessionId, messageId: string): Promise<void> {
    // Read straight from the store, not from the service that handled the frame.
    const row = await store.messages.getMessage(messageId)
    expect(row).toMatchObject({ deliveryStatus: 'dispatched', deadLetteredAt: null })
    expect(
      (await store.sync.listQueuedMessages(sessionId)).map((queued) => queued.sourceMessageId),
    ).toEqual([messageId])
    expect(
      (await store.events.listEventsSince(0, { kinds: ['message.dead_letter'] })).filter(
        (e) => e.subject === messageId,
      ),
    ).toEqual([])
  }

  it('acknowledges only after the report has been handled', async () => {
    const { sessionId, messageId } = await heldInterrupt('wait for the handling')
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    // Handling a report starts by reading each named message; hold that read
    // until the test lets it go.
    const original = store.messages.getMessage.bind(store.messages)
    const read = vi.spyOn(store.messages, 'getMessage').mockImplementation(async (id) => {
      if (id === messageId) await pending
      return await original(id)
    })
    const delivery = registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      reportId: 'delayed-report',
      sessionId,
      turnIds: [messageId],
      reason: 'teardown',
    })
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith(messageId))
      // An ack now would let the daemon drop a report the server has not handled.
      expect(acksFor('delayed-report')).toHaveLength(0)
    } finally {
      release()
      await delivery
      read.mockRestore()
    }
    expect(acksFor('delayed-report')).toHaveLength(1)
    await expectStillQueued(sessionId, messageId)
  })

  it.each([
    'never-live',
    'teardown',
    // POD-2297's arm: a server-family driver took the turn off its own queue and
    // the hand-off failed. It reaches this path through the same frame the
    // terminal family uses; its failure settles through the `delivery` event.
    'delivery-failed',
  ] as const)(
    'a %s report from the owning machine keeps the interrupt row for the next owner',
    async (reason) => {
      const { sessionId, messageId } = await heldInterrupt(`reported ${reason}`)

      await registry.gateway.routeDaemonFrame(MACHINE, {
        type: 'runtimeQueueDrainAbandoned',
        reportId: `report-${reason}`,
        sessionId,
        turnIds: [messageId],
        reason,
      })

      expect(acksFor(`report-${reason}`)).toHaveLength(1)
      await expectStillQueued(sessionId, messageId)
      // The next owner receives the same row again — as a recovery, with its
      // interrupt mode, never as a fresh write.
      await registry.gateway.routeDaemonFrame(MACHINE, bind(sessionId))
      await vi.waitFor(() => expect(durableSends(sessionId)).toHaveLength(2))
      expect(durableSends(sessionId)[1]).toMatchObject({
        rowId: messageId,
        delivery: 'interrupt',
        deliveryRecovery: true,
      })
    },
  )

  it('an at-least-once replay is re-acked every time and still moves nothing', async () => {
    const { sessionId, messageId } = await heldInterrupt('reported twice')
    // The daemon's outbox replays a report until the server acks it, so the
    // SAME reportId arrives again — and the duplicated turn id inside one report
    // is the other way a consumer hears a turn twice.
    const report = (): DaemonMessage => ({
      type: 'runtimeQueueDrainAbandoned',
      reportId: 'report-replayed',
      sessionId,
      turnIds: [messageId, messageId],
      reason: 'never-live',
    })

    await registry.gateway.routeDaemonFrame(MACHINE, report())
    await registry.gateway.routeDaemonFrame(MACHINE, report())

    await expectStillQueued(sessionId, messageId)
    // Deduping must not swallow the ACK: a replay the server quietly ignores is
    // a report the daemon replays forever.
    expect(acksFor('report-replayed')).toHaveLength(2)
  })

  it('a report from a machine that does not own the session is refused, not acknowledged', async () => {
    const { sessionId, messageId } = await heldInterrupt('not yours to report')
    await registry.gateway.routeDaemonFrame(OTHER_MACHINE, {
      type: 'runtimeQueueDrainAbandoned',
      reportId: 'report-from-stranger',
      sessionId,
      turnIds: [messageId],
      reason: 'never-live',
    })

    // The ownership check stops one machine speaking for another machine's
    // session: the report is not handled, so it is not acknowledged either.
    expect(
      toOther.filter(
        (m) => m.type === 'runtimeQueueDrainAbandonedAck' && m.reportId === 'report-from-stranger',
      ),
    ).toEqual([])
    expect(acksFor('report-from-stranger')).toEqual([])
    await expectStillQueued(sessionId, messageId)
  })
})
