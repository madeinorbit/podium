import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  messageExpiryRunKey,
} from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { SessionStore, type MessageRow } from '../../store'
import { MaintenanceService } from './service'

const baseMessage = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'msg_1',
  threadId: 'thread_1',
  inReplyTo: null,
  fromKind: 'agent',
  fromSession: 'sess_sender',
  fromName: null,
  fromIssue: 'issue_sender',
  toKind: 'issue',
  toId: 'issue_target',
  kind: 'message',
  urgency: 'fyi',
  lifecycle: 'wait',
  body: 'hello',
  expiresAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  status: 'queued',
  deliveredAt: null,
  deliveredTo: null,
  ackedBy: null,
  hop: 0,
  clampedFrom: null,
  remindedAt: null,
  factKey: null,
  factTarget: null,
  expectsResponse: false,
  ...over,
})

describe('MaintenanceService [spec:SP-c29e]', () => {
  let nowMs: number
  let store: SessionStore
  let service: MaintenanceService
  let funnelWrites: number

  beforeEach(() => {
    nowMs = Date.parse('2026-07-18T00:00:00.000Z')
    store = new SessionStore(':memory:')
    funnelWrites = 0
    service = new MaintenanceService(
      store,
      {
        run<T>({ write }: { authorize?: () => void; write: () => T }): T {
          funnelWrites += 1
          return write()
        },
      },
      { now: () => nowMs, leaseTtlMs: 90_000 },
    )
  })

  const handshake = (generationId: string) =>
    service.handshake({
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      generationId,
    })

  it('renews one generation without changing its fence and advances after lease expiry', () => {
    const first = handshake('gen_a')
    expect(first).toMatchObject({ status: 'ready', fencingToken: 1 })
    nowMs += 10_000
    expect(handshake('gen_a')).toMatchObject({ status: 'ready', fencingToken: 1 })
    expect(handshake('gen_b')).toMatchObject({ status: 'busy' })
    nowMs += 91_000
    expect(handshake('gen_b')).toMatchObject({ status: 'ready', fencingToken: 2 })
  })

  it('does not issue or renew a lease across protocol/schema incompatibility', () => {
    expect(
      service.handshake({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION + 1,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        generationId: 'gen_old',
      }),
    ).toMatchObject({ status: 'incompatible' })
    expect(handshake('gen_current')).toMatchObject({ status: 'ready', fencingToken: 1 })
  })

  it('expires through one atomic idempotent command and emits one durable transition', () => {
    const message = baseMessage()
    store.messages.addMessage(message)
    const lease = handshake('gen_a')
    expect(lease.status).toBe('ready')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const observed = {
      messageId: message.id,
      status: 'queued' as const,
      lifecycle: message.lifecycle,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
    }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'message-expiry' as const,
      runKey: messageExpiryRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    }

    expect(service.apply(command)).toMatchObject({ status: 'applied' })
    expect(store.messages.getMessage(message.id)?.status).toBe('expired')
    expect(service.apply(command)).toMatchObject({ status: 'already-applied' })
    expect(
      store.events.listEventsSince(0).filter((event) => event.kind === 'message.expired'),
    ).toHaveLength(1)
    expect(funnelWrites).toBe(3)
  })

  it('returns stale for a superseded fence, changed facts, and not-yet-due work', () => {
    const explicit = baseMessage({ expiresAt: '2026-07-19T00:00:00.000Z' })
    store.messages.addMessage(explicit)
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const observed = {
      messageId: explicit.id,
      status: 'queued' as const,
      lifecycle: explicit.lifecycle,
      createdAt: explicit.createdAt,
      expiresAt: explicit.expiresAt,
    }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'message-expiry' as const,
      runKey: messageExpiryRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    }
    expect(service.apply(command)).toMatchObject({ status: 'stale', reason: 'not-due' })

    expect(
      service.apply({ ...command, observed: { ...observed, createdAt: 'changed' } }),
    ).toMatchObject({
      status: 'stale',
      reason: 'invalid-run-key',
    })

    nowMs = Date.parse('2026-07-19T00:00:00.001Z')
    nowMs += 91_000
    const next = handshake('gen_b')
    if (next.status !== 'ready') throw new Error('expected successor lease')
    expect(service.apply(command)).toMatchObject({ status: 'stale', reason: 'fenced' })
    expect(service.apply({ ...command, fencingToken: next.fencingToken })).toMatchObject({
      status: 'applied',
    })
  })
})
