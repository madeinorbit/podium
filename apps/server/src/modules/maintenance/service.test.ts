import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import {
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_BATCH_ROWS,
  changeLogPruneRunKey,
  connectScanRunKey,
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
  sessionAutoArchiveRunKey,
  stewardPollRunKey,
  worktreeGcRunKey,
} from '@podium/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type MessageRow, SessionStore } from '../../store'
import { MaintenanceService } from './service'

const baseMessage = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'msg_1',
  threadId: 'thread_1',
  inReplyTo: null,
  fromKind: 'agent',
  fromSession: asSessionId('sess_sender'),
  fromName: null,
  fromIssue: asIssueId('issue_sender'),
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
      deliveredTo: asSessionId('sess_previous'),
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
    const tryAutoArchiveObserved = vi.fn((): 'applied' | 'precondition' | 'not-due' => 'applied')
    service = new MaintenanceService(
      store,
      {
        run<T>({ write }: { authorize?: () => void; write: () => T }): T {
          funnelWrites += 1
          return write()
        },
      },
      {
        now: () => nowMs,
        leaseTtlMs: 90_000,
        issues: {
          tryAutoArchiveObserved,
          tryWorktreeGcObserved: vi.fn(async () => ({ outcome: 'proposed' as const })),
        },
      },
    )
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const observed = {
      issueId: asIssueId('iss_1'),
      stage: 'done',
      closedReason: null,
      readerUserId: FIRST_ADMIN_USER_ID,
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
    expect(tryAutoArchiveObserved).toHaveBeenCalledWith(
      observed,
      nowMs,
      expect.objectContaining({ kind: 'system', job: 'expiry' }),
    )
    expect(await service.apply(command)).toMatchObject({ status: 'already-applied' })
    tryAutoArchiveObserved.mockReturnValueOnce('not-due')
    const second = {
      ...observed,
      issueId: asIssueId('iss_2'),
    }
    expect(
      await service.apply({
        ...command,
        observed: second,
        runKey: issueAutoArchiveRunKey(second),
      }),
    ).toMatchObject({ status: 'stale', reason: 'not-due' })
  })

  it('[spec:SP-6144] stopped-session auto-archive revalidates via sessions seam', async () => {
    const tryAutoArchiveStoppedObserved = vi.fn(
      (): 'applied' | 'precondition' | 'not-due' => 'applied',
    )
    service = new MaintenanceService(
      store,
      { run: <T>({ write }: { write: () => T }): T => write() },
      { now: () => nowMs, sessions: { tryAutoArchiveStoppedObserved } },
    )
    const lease = handshake('gen_session_archive')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const observed = {
      sessionId: asSessionId('ses_done'),
      issueId: null,
      stoppedAt: '2026-07-01T00:00:00.000Z',
      readerUserId: FIRST_ADMIN_USER_ID,
      archived: false as const,
    }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'session-auto-archive' as const,
      runKey: sessionAutoArchiveRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    }
    expect(await service.apply(command)).toMatchObject({ status: 'applied' })
    expect(tryAutoArchiveStoppedObserved).toHaveBeenCalledWith(observed, nowMs)
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

  it('[POD-925 B2] steward-poll rechecks fence after side effects before recording', async () => {
    let release!: () => void
    const paused = new Promise<void>((r) => {
      release = r
    })
    let stewardCalls = 0
    service = new MaintenanceService(
      store,
      {
        run<T>({ write }: { authorize?: () => void; write: () => T }): T {
          funnelWrites += 1
          return write()
        },
      },
      {
        now: () => nowMs,
        leaseTtlMs: 90_000,
        stewardTick: async () => {
          stewardCalls += 1
          await paused
        },
      },
    )
    const lease1 = handshake('gen_a')
    if (lease1.status !== 'ready') throw new Error('expected lease')
    const observed = { fromCursor: 0, toEventId: 1 }
    const command = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'steward-poll' as const,
      runKey: stewardPollRunKey(observed),
      fencingToken: lease1.fencingToken,
      observed,
    }
    const flight = service.apply(command)
    // Expire gen_a and hand the fence to gen_b while the tick is mid-flight.
    nowMs += 91_000
    const lease2 = handshake('gen_b')
    if (lease2.status !== 'ready') throw new Error('expected successor')
    release()
    const reply = await flight
    expect(reply).toMatchObject({ status: 'stale', reason: 'fenced' })
    expect(stewardCalls).toBe(1)
    expect(store.maintenance.getCommand('steward-poll', command.runKey)).toBeUndefined()
  })

  it('[POD-925 B2] connect-scan applies when lastSeenAt matches even if older than 5m', async () => {
    const scans: string[] = []
    // Freeze "now" for upsert so lastSeenAt is controlled.
    const oldSeenMs = nowMs - 6 * 60_000
    const oldSeen = new Date(oldSeenMs).toISOString()
    vi.useFakeTimers()
    vi.setSystemTime(oldSeenMs)
    try {
      store.machines.upsertMachine({
        id: 'remote',
        name: 'remote',
        hostname: 'remote',
        tokenHash: 'x',
        ownerUserId: 'user:sole',
      })
    } finally {
      vi.useRealTimers()
    }
    expect(store.machines.getMachine('remote')?.lastSeenAt).toBe(oldSeen)
    service = new MaintenanceService(
      store,
      {
        run<T>({ write }: { authorize?: () => void; write: () => T }): T {
          return write()
        },
      },
      {
        now: () => nowMs,
        leaseTtlMs: 90_000,
        connectScan: (id) => {
          scans.push(id)
        },
        localMachineId: 'local',
      },
    )
    const lease = handshake('gen_a')
    if (lease.status !== 'ready') throw new Error('expected lease')
    const observed = {
      machineId: 'remote',
      lastSeenAt: oldSeen,
      deep: false as const,
    }
    const reply = await service.apply({
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'connect-scan',
      runKey: connectScanRunKey(observed),
      fencingToken: lease.fencingToken,
      observed,
    })
    expect(reply).toMatchObject({ status: 'applied' })
    expect(scans).toEqual(['remote'])
  })
})

describe('worktree-gc is the janitor asking, never deciding [POD-564]', () => {
  let store: SessionStore
  let nowMs: number
  let service: MaintenanceService
  let policy: { mode: 'off' | 'propose' | 'auto'; afterDays: number }
  let tryWorktreeGcObserved: ReturnType<typeof vi.fn>

  const observed = {
    issueId: asIssueId('iss_gc'),
    worktreePath: '/r/.worktrees/issue-gc',
    stage: 'done',
    closedReason: null,
    closedAt: '2026-07-01T00:00:00.000Z',
    deletedAt: null as null,
    mode: 'propose' as const,
    afterDays: 14,
  }

  beforeEach(() => {
    nowMs = Date.parse('2026-07-18T00:00:00.000Z')
    store = new SessionStore(':memory:')
    policy = { mode: 'propose', afterDays: 14 }
    tryWorktreeGcObserved = vi.fn(async () => ({ outcome: 'proposed' as const }))
    service = new MaintenanceService(
      store,
      {
        run<T>({ write }: { authorize?: () => void; write: () => T }): T {
          return write()
        },
      },
      {
        now: () => nowMs,
        leaseTtlMs: 90_000,
        issues: {
          tryAutoArchiveObserved: vi.fn(() => 'applied' as const),
          tryWorktreeGcObserved: tryWorktreeGcObserved as never,
        },
        worktreeGcPolicy: () => policy,
      },
    )
  })

  const lease = () => {
    const reply = service.handshake({
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      generationId: 'gen_gc',
    })
    if (reply.status !== 'ready') throw new Error('expected lease')
    return reply
  }

  const command = (over: Partial<typeof observed> = {}) => {
    const o = { ...observed, ...over }
    return {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'worktree-gc' as const,
      runKey: worktreeGcRunKey(o),
      fencingToken: lease().fencingToken,
      observed: o,
    }
  }

  it('hands the policy out with the lease, so a settings flip reaches the next handshake', () => {
    expect(lease()).toMatchObject({ worktreeGcMode: 'propose', worktreeGcAfterDays: 14 })
    policy = { mode: 'auto', afterDays: 30 }
    nowMs += 10_000
    expect(lease()).toMatchObject({ worktreeGcMode: 'auto', worktreeGcAfterDays: 30 })
  })

  it('reads `off` as a policy the janitor is told, not one this service silently applies', () => {
    policy = { mode: 'off', afterDays: 14 }
    expect(lease()).toMatchObject({ worktreeGcMode: 'off' })
  })

  it('revalidates through the issues seam and records the occurrence once', async () => {
    const cmd = command()
    expect(await service.apply(cmd)).toMatchObject({ status: 'applied' })
    expect(tryWorktreeGcObserved).toHaveBeenCalledWith(
      cmd.observed,
      nowMs,
      expect.objectContaining({ kind: 'system', job: 'expiry' }),
    )
    expect(await service.apply(cmd)).toMatchObject({ status: 'already-applied' })
  })

  it('a worktree freed between propose and apply is `precondition`, not an error', async () => {
    tryWorktreeGcObserved.mockResolvedValueOnce({ outcome: 'precondition' })
    expect(await service.apply(command({ worktreePath: '/r/.worktrees/gone' }))).toMatchObject({
      status: 'stale',
      reason: 'precondition',
    })
  })

  it('says not-due when the close is younger than the window', async () => {
    tryWorktreeGcObserved.mockResolvedValueOnce({ outcome: 'not-due' })
    expect(await service.apply(command({ closedAt: '2026-07-17T00:00:00.000Z' }))).toMatchObject({
      status: 'stale',
      reason: 'not-due',
    })
  })

  it('records a REFUSAL as applied, so a dirty tree is not re-asked every 30 seconds', async () => {
    // The occurrence is the ATTEMPT, not the removal: the directory stays, the
    // refusal is in the log once, and the next sweep re-asks after the command
    // row ages out of retention. Retrying each tick would emit a refusal event
    // twice a minute for as long as the work is uncommitted.
    tryWorktreeGcObserved.mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'worktree has unsaved changes',
    })
    const cmd = command()
    expect(await service.apply(cmd)).toMatchObject({ status: 'applied' })
    expect(await service.apply(cmd)).toMatchObject({ status: 'already-applied' })
  })

  it('refuses a run key that does not describe its own observation', async () => {
    expect(
      await service.apply({ ...command(), runKey: 'worktree-gc/somebody-elses-key' }),
    ).toMatchObject({ status: 'stale', reason: 'invalid-run-key' })
    expect(tryWorktreeGcObserved).not.toHaveBeenCalled()
  })

  it('refuses when no issues seam is wired at all', async () => {
    service = new MaintenanceService(
      store,
      {
        run<T>({ write }: { authorize?: () => void; write: () => T }): T {
          return write()
        },
      },
      { now: () => nowMs, leaseTtlMs: 90_000, worktreeGcPolicy: () => policy },
    )
    expect(await service.apply(command())).toMatchObject({
      status: 'stale',
      reason: 'precondition',
    })
  })
})
