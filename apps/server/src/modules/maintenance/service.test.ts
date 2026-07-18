import {
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_BATCH_ROWS,
  changeLogPruneRunKey,
  EVENT_PRUNE_BATCH_ROWS,
  EVENT_RETENTION_MAX_AGE_DAYS,
  EVENT_RETENTION_MAX_ROWS,
  eventLogPruneRunKey,
  issueAutoArchiveRunKey,
  MAINTENANCE_COMMAND_MAX_AGE_MS,
  MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS,
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  maintenanceCommandsPruneRunKey,
  messageExpiryRunKey,
} from '@podium/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type MessageRow, SessionStore } from '../../store'
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

  it('renews one generation without changing its fence and advances after lease expiry', async () => {
    const first = handshake('gen_a')
    expect(first).toMatchObject({ status: 'ready', fencingToken: 1 })
    nowMs += 10_000
    expect(handshake('gen_a')).toMatchObject({ status: 'ready', fencingToken: 1 })
    expect(handshake('gen_b')).toMatchObject({ status: 'busy' })
    nowMs += 91_000
    expect(handshake('gen_b')).toMatchObject({ status: 'ready', fencingToken: 2 })
  })

  it('does not issue or renew a lease across protocol/schema incompatibility', async () => {
    expect(
      service.handshake({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION + 1,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        generationId: 'gen_old',
      }),
    ).toMatchObject({ status: 'incompatible' })
    expect(handshake('gen_current')).toMatchObject({ status: 'ready', fencingToken: 1 })
  })

  it('expires through one atomic idempotent command and emits one durable transition', async () => {
    const message = baseMessage({
      deliveredTo: 'sess_previous',
      hop: 2,
      clampedFrom: 'interrupt',
    })
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

    expect(await service.apply(command)).toMatchObject({ status: 'applied' })
    expect(store.messages.getMessage(message.id)?.status).toBe('expired')
    expect(await service.apply(command)).toMatchObject({ status: 'already-applied' })
    const events = store.events
      .listEventsSince(0)
      .filter((event) => event.kind === 'message.expired')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      deliveredTo: 'sess_previous',
      hop: 2,
      clampedFrom: 'interrupt',
    })
    expect(funnelWrites).toBe(3)
  })

  it('returns stale for a superseded fence, changed facts, and not-yet-due work', async () => {
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
    expect(await service.apply(command)).toMatchObject({ status: 'stale', reason: 'not-due' })

    expect(
      await service.apply({ ...command, observed: { ...observed, createdAt: 'changed' } }),
    ).toMatchObject({
      status: 'stale',
      reason: 'invalid-run-key',
    })

    nowMs = Date.parse('2026-07-19T00:00:00.001Z')
    nowMs += 91_000
    const next = handshake('gen_b')
    if (next.status !== 'ready') throw new Error('expected successor lease')
    expect(await service.apply(command)).toMatchObject({ status: 'stale', reason: 'fenced' })
    expect(await service.apply({ ...command, fencingToken: next.fencingToken })).toMatchObject({
      status: 'applied',
    })
  })

  it('[POD-925] event-log prune applies one bounded batch idempotently', async () => {
    for (let i = 0; i < 3; i++) {
      store.events.appendEvent({
        ts: '2026-06-01T00:00:00.000Z',
        kind: 'test.old',
        subject: `s${i}`,
      })
    }
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const plan = store.events.planEventPrune({
      maxAgeDays: EVENT_RETENTION_MAX_AGE_DAYS,
      maxRows: EVENT_RETENTION_MAX_ROWS,
    })
    const observed = {
      maxAgeDays: EVENT_RETENTION_MAX_AGE_DAYS,
      maxRows: EVENT_RETENTION_MAX_ROWS,
      cutoff: plan.cutoff,
      capThroughId: plan.capThroughId,
      batchSize: EVENT_PRUNE_BATCH_ROWS,
      fromId: 1,
    }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'event-log-prune' as const,
      runKey: eventLogPruneRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    }
    expect(await service.apply(command)).toMatchObject({ status: 'applied', deleted: 3 })
    expect(await service.apply(command)).toMatchObject({ status: 'already-applied' })
    expect(store.events.listEventsSince(0)).toHaveLength(0)
  })

  it('[POD-925] change-log prune applies one bounded batch under the plan', async () => {
    const now = nowMs
    for (let i = 0; i < 5; i++) {
      store.sync.appendChanges(
        [{ entity: 'issue', entityId: `i${i}`, op: 'upsert', payload: '{}' }],
        now - CHANGE_MAX_AGE_MS - 1_000,
      )
    }
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const plan = store.sync.planChangePrune({
      keepRows: CHANGE_KEEP_ROWS,
      maxAgeMs: CHANGE_MAX_AGE_MS,
      now: nowMs,
    })
    expect(plan.thresholdSeq).toBeGreaterThan(0)
    const observed = {
      keepRows: CHANGE_KEEP_ROWS,
      maxAgeMs: CHANGE_MAX_AGE_MS,
      thresholdSeq: plan.thresholdSeq,
      batchSize: CHANGE_PRUNE_BATCH_ROWS,
      fromSeq: 1,
    }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'change-log-prune' as const,
      runKey: changeLogPruneRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    }
    const reply = await service.apply(command)
    expect(reply).toMatchObject({ status: 'applied' })
    expect(reply.status === 'applied' && (reply.deleted ?? 0) > 0).toBe(true)
    expect(await service.apply(command)).toMatchObject({ status: 'already-applied' })
  })

  it('[POD-925] issue auto-archive revalidates via issues seam at apply', async () => {
    const tryAutoArchiveObserved = vi.fn(
      (): 'applied' | 'precondition' | 'not-due' => 'applied',
    )
    service = new MaintenanceService(
      store,
      {
        run<T>({ write }: { authorize?: () => void; write: () => T }): T {
          funnelWrites += 1
          return write()
        },
      },
      { now: () => nowMs, leaseTtlMs: 90_000, issues: { tryAutoArchiveObserved } },
    )
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const observed = {
      issueId: 'iss_1',
      stage: 'done',
      closedReason: null,
      readAt: '2026-07-01T00:00:00.000Z',
      archived: false as const,
      deletedAt: null,
    }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'issue-auto-archive' as const,
      runKey: issueAutoArchiveRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    }
    expect(await service.apply(command)).toMatchObject({ status: 'applied' })
    expect(tryAutoArchiveObserved).toHaveBeenCalledWith(observed, nowMs)
    expect(await service.apply(command)).toMatchObject({ status: 'already-applied' })
    tryAutoArchiveObserved.mockReturnValueOnce('not-due')
    const second = {
      ...observed,
      issueId: 'iss_2',
      readAt: '2026-07-17T00:00:00.000Z',
    }
    expect(
      await service.apply({
        ...command,
        observed: second,
        runKey: issueAutoArchiveRunKey(second),
      }),
    ).toMatchObject({ status: 'stale', reason: 'not-due' })
  })

  it('[POD-925] maintenance_commands prune deletes aged rows in batches', async () => {
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    // Seed applied commands with old applied_at via direct SQL.
    store.transact(() => {
      for (let i = 0; i < 3; i++) {
        store.maintenance.recordCommand(
          {
            status: 'applied',
            jobKind: 'message-expiry',
            runKey: `old/${i}`,
          },
          lease.fencingToken,
          '2026-06-01T00:00:00.000Z',
        )
      }
    })
    const observed = {
      maxAgeMs: MAINTENANCE_COMMAND_MAX_AGE_MS,
      cutoffAppliedAt: new Date(nowMs - MAINTENANCE_COMMAND_MAX_AGE_MS).toISOString(),
      batchSize: MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS,
      fromRowId: 1,
    }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'maintenance-commands-prune' as const,
      runKey: maintenanceCommandsPruneRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    }
    expect(await service.apply(command)).toMatchObject({ status: 'applied', deleted: 3 })
  })

  it('[POD-925 review] rejects maintenance-commands prune with a future/aggressive cutoff', async () => {
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    store.transact(() => {
      store.maintenance.recordCommand(
        { status: 'applied', jobKind: 'message-expiry', runKey: 'recent/1' },
        lease.fencingToken,
        new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(), // 1 day old — within 14d policy
      )
    })
    const observed = {
      maxAgeMs: MAINTENANCE_COMMAND_MAX_AGE_MS,
      cutoffAppliedAt: new Date(nowMs + 60_000).toISOString(), // future = more aggressive than policy
      batchSize: MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS,
      fromRowId: 1,
    }
    const reply = await service.apply({
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'maintenance-commands-prune',
      runKey: maintenanceCommandsPruneRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    })
    expect(reply).toMatchObject({ status: 'stale', reason: 'precondition' })
    expect(store.maintenance.getCommand('message-expiry', 'recent/1')).toBeDefined()
  })
})
