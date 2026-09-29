/**
 * POD-4802: a send queued during a running turn must settle delivered, never
 * as a duplicate bubble.
 *
 * Lowest-layer reproduction of the F16 (claude) chat duplicates: an operator
 * send made while a turn runs is held (queued custody), typed after the
 * turn, and — when the daemon cannot prove the write (`unverified`) — was
 * dead-lettered "delivery failed" even though the agent answered. The chat
 * then showed the transcript echo in place plus the failed bubble at the
 * bottom, forever (durable on both sides). The ambiguous failure now leaves
 * the ledger queued and the turn boundary confirms it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { SessionId } from '@podium/model'
import { legacyMessageStatus } from '../../store/messages'
import type { MessageRow } from '../../store/types'
import { disposeOracles, makeOracle, waitFor } from './oracle-support'

/** The ledger row's status in the words these tests were written in: the
 *  delivery status mapped the way the store maps it for older readers. */
const statusOf = (row: MessageRow | undefined | null): string | undefined =>
  row ? legacyMessageStatus(row.deliveryStatus, row.readAt != null) : undefined

afterEach(() => disposeOracles())

type Oracle = Awaited<ReturnType<typeof makeOracle>>
type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>

async function durableSendsOnceHandedOn(
  o: Oracle,
  sessionId: SessionId,
  count: number,
): Promise<DurableSendRequest[]> {
  await waitFor(
    () =>
      o.daemon.filter(
        (m): m is DurableSendRequest =>
          m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId,
      ).length >= count,
    `${count} durable send(s) to be handed on`,
  )
  return o.daemon.filter(
    (m): m is DurableSendRequest =>
      m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId,
  )
}

async function goLive(o: Oracle, sessionId: SessionId, phase: 'idle' | 'working'): Promise<void> {
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: 'native-1' },
    confidence: 'exact',
  })
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId,
    state: { phase, since: new Date().toISOString(), nativeSubagentCount: 0 },
  })
}

describe('pod-4802: queued-during-turn send settles delivered', () => {
  it('delivers a send held through a running turn with no dead-letter', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, 'working')
    o.daemon.length = 0

    const sent = await o.call.sessions.sendText({ sessionId, text: 'mid-turn note' })
    expect(sent.ok).toBe(true)
    const [send] = await durableSendsOnceHandedOn(o, sessionId, 1)
    expect(send).toMatchObject({ text: 'mid-turn note' })

    // Daemon takes custody (queued) while the turn runs.
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'runtimeSendResult',
      requestId: send!.requestId,
      sessionId,
      receipt: {
        outcome: 'queued',
        position: 1,
        deliveredAs: 'queue',
        at: new Date().toISOString(),
      },
    })

    // Ledger + inbox rows stay queued (not dead-lettered) while held.
    const inboxBefore = await o.store.sync.listQueuedMessages(sessionId)
    expect(inboxBefore).toHaveLength(1)
    const ledgerId = inboxBefore[0]!.sourceMessageId!
    expect(statusOf(await o.store.messages.getMessage(ledgerId))).toBe('queued')

    // Turn ends; daemon types and reports delivered.
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    const spawn = o.daemon.find(
      (m): m is Extract<ControlMessage, { type: 'spawn' }> =>
        m.type === 'spawn' && m.sessionId === sessionId,
    )
    const generation = spawn?.observationGeneration ?? 1
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: `delivery-${send!.rowId}`,
      sessionId,
      event: {
        t: 'delivery',
        rowId: send!.rowId,
        outcome: 'delivered',
        at: new Date().toISOString(),
        provenance: 'live',
        cursor: { segmentId: `delivery-${sessionId}`, components: { seq: 1 } },
        observerGeneration: generation,
        turnEpoch: 0,
      },
    } as never)

    await waitFor(
      async () => (await o.store.sync.listQueuedMessages(sessionId)).length === 0,
      'the inbox row to settle on its delivery event',
    )
    const row = await o.store.messages.getMessage(ledgerId)
    expect(statusOf(row)).toBe('delivered')
    expect(statusOf(row)).not.toBe('dead_letter')
  })

  it('an ambiguous daemon failure leaves the ledger for the turn boundary, which delivers it', async () => {
    // F16: the daemon typed the bytes but could not prove it, reported
    // failed, and the server dead-lettered a delivered message. Now the
    // ambiguous failure keeps the ledger queued and the idle edge confirms it.
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, 'working')
    o.daemon.length = 0

    const sent = await o.call.sessions.sendText({ sessionId, text: 'mid-turn note' })
    expect(sent.ok).toBe(true)
    const [send] = await durableSendsOnceHandedOn(o, sessionId, 1)
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'runtimeSendResult',
      requestId: send!.requestId,
      sessionId,
      receipt: {
        outcome: 'queued',
        position: 1,
        deliveredAs: 'queue',
        at: new Date().toISOString(),
      },
    })
    const inboxBefore = await o.store.sync.listQueuedMessages(sessionId)
    expect(inboxBefore).toHaveLength(1)
    const ledgerId = inboxBefore[0]!.sourceMessageId!

    const spawn = o.daemon.find(
      (m): m is Extract<ControlMessage, { type: 'spawn' }> =>
        m.type === 'spawn' && m.sessionId === sessionId,
    )
    const generation = spawn?.observationGeneration ?? 1
    const delivery = (
      outcome: 'delivered' | 'failed',
      seq: number,
      reason?: string,
      cause?: string,
    ) =>
      ({
        type: 'runtimeEvent',
        deliveryId: `delivery-${send!.rowId}-${seq}`,
        sessionId,
        event: {
          t: 'delivery',
          rowId: send!.rowId,
          outcome,
          ...(reason ? { reason } : {}),
          ...(cause ? { cause } : {}),
          at: new Date().toISOString(),
          provenance: 'live',
          cursor: { segmentId: `delivery-${sessionId}`, components: { seq } },
          observerGeneration: generation,
          turnEpoch: 0,
        },
      }) as never
    // Typed but unproven: the daemon says `cause: 'unconfirmed'` (POD-4775),
    // so this must NOT dead-letter (POD-4802).
    await o.reg.gateway.routeDaemonFrame(
      o.reg.sessionStore.hostMachineId,
      delivery(
        'failed',
        1,
        'delivery could not be confirmed; check the transcript before retrying',
        'unconfirmed',
      ),
    )
    await waitFor(
      async () => (await o.store.sync.listQueuedMessages(sessionId)).length === 0,
      'the inbox row to leave on ambiguous failure',
    )
    const stuck = await o.store.messages.getMessage(ledgerId)
    expect(statusOf(stuck)).toBe('queued')
    expect(stuck?.injectedAt).not.toBeNull()
    expect(stuck?.deliveredTo).toBe(sessionId)

    // The turn ends (runtime state, the contract path — legacy agentState
    // frames are fenced once the runtime stream owns the session); the
    // boundary confirms what the daemon typed.
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: `state-${sessionId}-idle`,
      sessionId,
      event: {
        t: 'state',
        change: {
          kind: 'state_snapshot',
          state: { phase: 'idle', since: new Date(Date.now() + 60_000).toISOString(), nativeSubagentCount: 0 },
        },
        at: new Date().toISOString(),
        provenance: 'live',
        cursor: { segmentId: `delivery-${sessionId}`, components: { seq: 2 } },
        observerGeneration: generation,
        turnEpoch: 0,
      },
    } as never)
    await waitFor(
      async () => (await o.meta(sessionId)).agentState?.phase === 'idle',
      'the session to read idle',
    )
    await waitFor(
      async () => statusOf(await o.store.messages.getMessage(ledgerId)) === 'delivered',
      'the boundary to deliver the ambiguous row',
    )
    expect(statusOf(await o.store.messages.getMessage(ledgerId))).not.toBe('dead_letter')
  })

  it('a never-typed failure still ends visibly failed, never silently delivered', async () => {
    // The other half (POD-4802 review): when the bytes never left the daemon
    // (the agent never became ready, so the inner send never ran and there is
    // no `unconfirmed` cause), the row must dead-letter with the delivery-failed
    // wording and its retry affordance — the boundary must not confirm what
    // was never delivered, and the row must not linger pending forever.
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, 'working')
    o.daemon.length = 0

    const sent = await o.call.sessions.sendText({ sessionId, text: 'never typed' })
    expect(sent.ok).toBe(true)
    const [send] = await durableSendsOnceHandedOn(o, sessionId, 1)
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'runtimeSendResult',
      requestId: send!.requestId,
      sessionId,
      receipt: {
        outcome: 'queued',
        position: 1,
        deliveredAs: 'queue',
        at: new Date().toISOString(),
      },
    })
    const inboxBefore = await o.store.sync.listQueuedMessages(sessionId)
    expect(inboxBefore).toHaveLength(1)
    const ledgerId = inboxBefore[0]!.sourceMessageId!

    const spawn = o.daemon.find(
      (m): m is Extract<ControlMessage, { type: 'spawn' }> =>
        m.type === 'spawn' && m.sessionId === sessionId,
    )
    const generation = spawn?.observationGeneration ?? 1
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: `delivery-${send!.rowId}-lost`,
      sessionId,
      event: {
        t: 'delivery',
        rowId: send!.rowId,
        outcome: 'failed',
        reason: 'the agent did not become ready before the delivery deadline',
        at: new Date().toISOString(),
        provenance: 'live',
        cursor: { segmentId: `delivery-${sessionId}`, components: { seq: 1 } },
        observerGeneration: generation,
        turnEpoch: 0,
      },
    } as never)

    await waitFor(
      async () => statusOf(await o.store.messages.getMessage(ledgerId)) === 'dead_letter',
      'the never-typed row to dead-letter',
    )
    const row = await o.store.messages.getMessage(ledgerId)
    expect(row?.deliveryDeferredReason).toBe('delivery-failed')
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(0)
  })
})
