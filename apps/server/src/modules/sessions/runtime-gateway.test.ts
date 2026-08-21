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
import { asUserId } from '@podium/model'
import type {
  TurnDelivery,
  TurnReceipt,
} from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { SYSTEM_INBOX_PRINCIPAL } from './inbox'
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
    forwarded?: Parameters<RuntimeDaemonRpcPort['runtimeSend']>[0][]
  } = {},
): {
  gateway: SessionRuntimeGateway
  forwarded: Parameters<RuntimeDaemonRpcPort['runtimeSend']>[0][]
  staged: Parameters<RuntimeDaemonRpcPort['runtimeStageAttachment']>[0][]
  enqueued: Parameters<RuntimeDurableQueuePort['enqueue']>[0][]
} {
  const forwarded = overrides.forwarded ?? []
  const staged: Parameters<RuntimeDaemonRpcPort['runtimeStageAttachment']>[0][] = []
  const rpc: RuntimeDaemonRpcPort = {
    runtimeSend: async (input) => {
      forwarded.push(input)
      return {
        outcome: 'accepted',
        turnEpoch: 1,
        deliveredAs: input.delivery,
        provenBy: 'transcript-echo',
        at: '2026-08-14T00:00:00.000Z',
      } satisfies TurnReceipt
    },
    runtimeStageAttachment: async (input) => {
      staged.push(input)
      return {
        result: {
          id: 'attachment-1',
          path: '/tmp/attachment-1.png',
          filename: input.source.filename,
          mediaType: input.source.mediaType,
          kind: 'image',
        },
      }
    },
    runtimeInterrupt: async () => ({ result: { ok: true } }),
    runtimeAnswer: async () => ({ ok: true }),
    runtimeLifecycle: async () => ({ result: { ok: true } }),
  }
  const enqueued: Parameters<RuntimeDurableQueuePort['enqueue']>[0][] = []
  const queue: RuntimeDurableQueuePort = {
    enqueue:
      overrides.queue?.enqueue ??
      ((input) => {
        enqueued.push(input)
        return { ok: true, position: 3 }
      }),
  }
  const durableEvents: import('@podium/protocol').RuntimeEvent[] = []
  return {
    gateway: new SessionRuntimeGateway({
      rpc,
      queue,
      machineOf: overrides.machineOf ?? (() => MACHINE),
      systemPrincipal: () => SYSTEM_INBOX_PRINCIPAL,
      now: () => Date.UTC(2026, 7, 14),
      events: {
        record: (_sessionId, event) => {
          durableEvents.push(event)
          if (durableEvents.length > 64) durableEvents.splice(0, durableEvents.length - 64)
          return { kind: 'accepted', eventId: durableEvents.length }
        },
        ready: () => durableEvents.length > 0,
        recent: () => durableEvents,
        replayBoardProjection: async () => {},
      },
    }),
    forwarded,
    staged,
    enqueued,
  }
}

describe('attachment staging', () => {
  it('routes bytes to the owning machine and returns the staged ref', async () => {
    const { gateway, staged } = makeGateway()
    const result = await gateway.stageAttachment({
      sessionId: SESSION,
      source: {
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'diagram.png',
        mediaType: 'image/png',
      },
    })
    expect(staged).toHaveLength(1)
    expect(result).toMatchObject({ filename: 'diagram.png', kind: 'image' })
  })

  it('returns not_running before sending bytes when no machine owns the session', async () => {
    const { gateway, staged } = makeGateway({ machineOf: () => undefined })
    await expect(
      gateway.stageAttachment({
        sessionId: SESSION,
        source: { bytes: new Uint8Array([1]), filename: 'x.png', mediaType: 'image/png' },
      }),
    ).resolves.toEqual({ reason: 'not_running', detail: 'no machine' })
    expect(staged).toEqual([])
  })
})

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

  it('forwards attachment refs on direct sends and refuses lossy queueing', async () => {
    const { gateway, forwarded, enqueued } = makeGateway()
    const attachment = {
      id: 'attachment-1',
      path: '/tmp/attachment-1.png',
      filename: 'diagram.png',
      mediaType: 'image/png',
      kind: 'image' as const,
    }
    await gateway.send({
      sessionId: SESSION,
      text: 'look',
      origin: 'human',
      delivery: 'when-ready',
      attachments: [attachment],
    })
    expect(forwarded[0]?.attachments).toEqual([attachment])
    await expect(
      gateway.send({
        sessionId: SESSION,
        text: 'later',
        origin: 'human',
        delivery: 'queue',
        attachments: [attachment],
      }),
    ).resolves.toMatchObject({ outcome: 'refused', refusal: { reason: 'unsupported' } })
    expect(enqueued).toEqual([])
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

describe('the acting principal', () => {
  it('carries the sender into the durable row rather than defaulting it', async () => {
    const { gateway, enqueued } = makeGateway()
    const sender = {
      kind: 'user' as const,
      attribution: {
        actor: { kind: 'user' as const, id: asUserId('user:alice') },
        onBehalfOf: null,
      },
      principalRef: 'user:alice',
      delegation: null,
    }
    await gateway.send({
      sessionId: SESSION,
      text: 'mine',
      origin: 'human',
      delivery: 'queue',
      principal: sender,
    })
    // `SessionInbox.drain` re-authorizes with exactly this value immediately
    // before the bytes cross to the daemon. A row that forgot its sender can
    // only be drained as somebody else — which is a privilege escalation, not a
    // missing label.
    expect(enqueued[0]?.principal).toBe(sender)
  })

  it("falls back to the composition root's system principal, never to a local guess", async () => {
    const { gateway, enqueued } = makeGateway()
    await gateway.send({
      sessionId: SESSION,
      text: 'unattributed',
      origin: 'mail',
      delivery: 'queue',
    })
    // The fallback is a PORT, so "who does an unattributed turn act as" is
    // answered in one visible place — and W4 can watch it stop being reached.
    expect(enqueued[0]?.principal).toBe(SYSTEM_INBOX_PRINCIPAL)
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

  it('reads the bounded diagnostic window from the durable event port', () => {
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
    // The gateway owns no memory tail; this window is supplied by the durable
    // repository port and remains available to a replacement gateway process.
    expect(gateway.recentEvents(SESSION)).toHaveLength(64)
    expect(gateway.recentEvents(SESSION).at(-1)?.cursor.components.seq).toBe(199)
  })

  it('declares fine delivery receiver-only until POD-2293 wires watch activation', () => {
    const { gateway } = makeGateway()
    expect(gateway.fineWatchAvailability()).toEqual({
      kind: 'deferred',
      prerequisite: 'POD-2293',
      activation: 'not-wired',
    })
  })
})
