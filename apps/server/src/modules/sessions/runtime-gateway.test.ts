/**
 * THE SERVER'S HALF OF THE CONTRACT (POD-1761 W3).
 *
 * One thing is decided on this side of the socket and it is the whole reason
 * this module exists: `queue` is DURABLE, so it completes here, from the table
 * that survives a daemon restart. Everything else is a forward. These tests pin
 * that split, and pin that the `steer` downgrade is reported rather than
 * swallowed on the way through.
 */

import type { MachineId, SessionId } from '@podium/model'
import type { TurnDelivery, TurnReceipt } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  type RuntimeDaemonRpcPort,
  type RuntimeDurableQueuePort,
  SessionRuntimeGateway,
} from './runtime-gateway'

const SESSION = 'session-1' as SessionId
const MACHINE = 'machine-1' as MachineId

function makeGateway(
  overrides: {
    machineOf?: (sessionId: SessionId) => MachineId | undefined
    queue?: Partial<RuntimeDurableQueuePort>
    forwarded?: { delivery: TurnDelivery }[]
  } = {},
): { gateway: SessionRuntimeGateway; forwarded: { delivery: TurnDelivery }[] } {
  const forwarded = overrides.forwarded ?? []
  const rpc: RuntimeDaemonRpcPort = {
    runtimeSend: async (input) => {
      forwarded.push({ delivery: input.delivery })
      return {
        outcome: 'accepted',
        turnEpoch: 1,
        deliveredAs: input.delivery,
        provenBy: 'transcript-echo',
        at: '2026-08-14T00:00:00.000Z',
      } satisfies TurnReceipt
    },
    runtimeInterrupt: async () => ({ result: { ok: true } }),
    runtimeAnswer: async () => ({ ok: true }),
    runtimeLifecycle: async () => ({ result: { ok: true } }),
  }
  const queue: RuntimeDurableQueuePort = {
    enqueue: overrides.queue?.enqueue ?? (() => ({ ok: true, position: 3 })),
  }
  return {
    gateway: new SessionRuntimeGateway({
      rpc,
      queue,
      machineOf: overrides.machineOf ?? (() => MACHINE),
      now: () => Date.UTC(2026, 7, 14),
    }),
    forwarded,
  }
}

describe('send', () => {
  it('completes `queue` from the durable table and never forwards it', async () => {
    const { gateway, forwarded } = makeGateway()
    const receipt = await gateway.send({
      sessionId: SESSION,
      text: 'later',
      origin: 'mail',
      delivery: 'queue',
    })
    expect(receipt).toMatchObject({ outcome: 'queued', position: 3, deliveredAs: 'queue' })
    // Forwarding it would move a promise about SURVIVING a restart to the one
    // place that cannot keep it.
    expect(forwarded).toEqual([])
  })

  it('degrades `steer` to the queue and SAYS SO', async () => {
    const { gateway, forwarded } = makeGateway()
    const receipt = await gateway.send({
      sessionId: SESSION,
      text: 'and this too',
      origin: 'mail',
      delivery: 'steer',
    })
    expect(receipt.outcome).toBe('queued')
    if (receipt.outcome !== 'queued') return
    // The caller asked to steer and learns it did not. That difference is what
    // separates a degraded delivery from a lie.
    expect(receipt.deliveredAs).toBe('queue')
    expect(forwarded).toEqual([])
  })

  it('forwards the deliveries only a driver can perform', async () => {
    const { gateway, forwarded } = makeGateway()
    await gateway.send({ sessionId: SESSION, text: 'now', origin: 'human', delivery: 'when-ready' })
    await gateway.send({ sessionId: SESSION, text: 'stop', origin: 'human', delivery: 'interrupt' })
    expect(forwarded.map((f) => f.delivery)).toEqual(['when-ready', 'interrupt'])
  })

  it('refuses rather than forwarding into a socket that is not there', async () => {
    const { gateway, forwarded } = makeGateway({ machineOf: () => undefined })
    const receipt = await gateway.send({
      sessionId: SESSION,
      text: 'anyone?',
      origin: 'steward',
      delivery: 'when-ready',
    })
    expect(receipt).toEqual({
      outcome: 'refused',
      refusal: { reason: 'not_running', detail: 'no machine' },
    })
    expect(forwarded).toEqual([])
  })

  it('reports a queue refusal as a refusal, not as a queued turn nobody holds', async () => {
    const { gateway } = makeGateway({
      queue: { enqueue: () => ({ ok: false, reason: 'no_resume_ref', detail: 'no resume ref' }) },
    })
    const receipt = await gateway.send({
      sessionId: SESSION,
      text: 'wake up',
      origin: 'mail',
      delivery: 'queue',
    })
    expect(receipt).toMatchObject({ outcome: 'refused', refusal: { reason: 'no_resume_ref' } })
  })
})

describe('the event sink', () => {
  it('fans out to subscribers and lets them leave', () => {
    const { gateway } = makeGateway()
    const seen: string[] = []
    const stop = gateway.onEvent((_sessionId, event) => seen.push(event.t))
    const event = {
      t: 'state' as const,
      change: { kind: 'activity' },
      at: '2026-08-14T00:00:00.000Z',
      provenance: 'live' as const,
      cursor: { segmentId: 'seg', components: { seq: 1 } },
      observerGeneration: 1,
      turnEpoch: 1,
    }
    gateway.record(MACHINE, { sessionId: SESSION, event })
    stop()
    gateway.record(MACHINE, { sessionId: SESSION, event })
    // A consumer that went away must not keep receiving into the next one's
    // fan-out.
    expect(seen).toEqual(['state'])
    expect(gateway.recentEvents(SESSION)).toHaveLength(2)
  })

  it('bounds the retained tail rather than pretending to be durable', () => {
    const { gateway } = makeGateway()
    for (let i = 0; i < 200; i++) {
      gateway.record(MACHINE, {
        sessionId: SESSION,
        event: {
          t: 'state',
          change: { kind: 'activity' },
          at: '2026-08-14T00:00:00.000Z',
          provenance: 'live',
          cursor: { segmentId: 'seg', components: { seq: i } },
          observerGeneration: 1,
          turnEpoch: 1,
        },
      })
    }
    // A large buffer here would LOOK like a durability guarantee. Recovery is
    // `snapshot()` plus a cursor — which is the whole reason the envelope exists.
    expect(gateway.recentEvents(SESSION)).toHaveLength(64)
    expect(gateway.recentEvents(SESSION).at(-1)?.cursor.components.seq).toBe(199)
  })
})
