/**
 * POD-4802 reproduction (scratch): a send queued during a running turn,
 * delivered after the turn, must end `delivered` with no dead-letter.
 *
 * Models F16 (claude): operator sends while a turn runs, the daemon holds
 * (queued custody), types after the turn, reports delivered. The ledger row
 * must reach delivered — otherwise the chat renders the transcript echo in
 * place plus the stuck ledger bubble at the bottom, forever.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { SessionId } from '@podium/model'
import { disposeOracles, makeOracle, waitFor } from './oracle-support'

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

describe('pod-4802 repro: queued-during-turn send settles delivered', () => {
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
    expect((await o.store.messages.getMessage(ledgerId))?.status).toBe('queued')

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
    expect(row?.status).toBe('delivered')
    expect(row?.status).not.toBe('dead_letter')
  })
})
