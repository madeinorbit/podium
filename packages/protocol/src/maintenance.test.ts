import { describe, expect, it } from 'vitest'
import {
  eventLogPruneRunKey,
  issueAutoArchiveRunKey,
  MaintenanceCommand,
  MaintenanceCommandReply,
  MaintenanceHandshake,
  MaintenanceHandshakeReply,
  messageExpiryRunKey,
} from './maintenance'

describe('maintenance protocol [spec:SP-c29e]', () => {
  const observed = {
    messageId: 'msg_1',
    status: 'queued' as const,
    lifecycle: 'wait' as const,
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: null,
  }

  const readyShape = {
    status: 'ready' as const,
    fencingToken: 1,
    expiresAt: '2026-07-18T00:01:30.000Z',
    messageWaitTtlMs: 1,
    autoArchiveReadWindowMs: 1,
    eventRetentionMaxAgeDays: 14,
    eventRetentionMaxRows: 50_000,
    changeKeepRows: 20_000,
    changeMaxAgeMs: 1,
    maintenanceCommandMaxAgeMs: 1,
  }

  it('requires an exact compatibility claim before a lease can be issued', () => {
    expect(
      MaintenanceHandshake.parse({
        protocolVersion: 1,
        schemaVersion: 'maintenance-v1',
        generationId: 'gen_1',
      }),
    ).toEqual({
      protocolVersion: 1,
      schemaVersion: 'maintenance-v1',
      generationId: 'gen_1',
    })
    expect(() =>
      MaintenanceHandshake.parse({ protocolVersion: 1, schemaVersion: 'maintenance-v1' }),
    ).toThrow()
    expect(
      MaintenanceHandshakeReply.parse({
        status: 'incompatible',
        expectedProtocolVersion: 2,
        expectedSchemaVersion: 'maintenance-v2',
      }).status,
    ).toBe('incompatible')
    expect(MaintenanceHandshakeReply.parse(readyShape).status).toBe('ready')
  })

  it('requires job kind, deterministic run key, observed facts, and fencing token', () => {
    const runKey = messageExpiryRunKey(observed)
    expect(
      MaintenanceCommand.parse({
        protocolVersion: 1,
        schemaVersion: 'maintenance-v1',
        jobKind: 'message-expiry',
        runKey,
        fencingToken: 7,
        observed,
      }),
    ).toMatchObject({ jobKind: 'message-expiry', runKey, fencingToken: 7, observed })
    expect(() =>
      MaintenanceCommand.parse({
        protocolVersion: 1,
        schemaVersion: 'maintenance-v1',
        jobKind: 'message-expiry',
        runKey,
        observed,
      }),
    ).toThrow()
  })

  it('accepts batch-1 housekeeping job kinds with stable run keys', () => {
    const eventObs = {
      maxAgeDays: 14,
      maxRows: 50_000,
      cutoff: '2026-07-01T00:00:00.000Z',
      capThroughId: 10,
      batchSize: 500,
      batchIndex: 0,
    }
    expect(
      MaintenanceCommand.parse({
        protocolVersion: 1,
        schemaVersion: 'maintenance-v1',
        jobKind: 'event-log-prune',
        runKey: eventLogPruneRunKey(eventObs),
        fencingToken: 1,
        observed: eventObs,
      }).jobKind,
    ).toBe('event-log-prune')

    const archiveObs = {
      issueId: 'iss_1',
      stage: 'done',
      closedReason: null,
      readAt: '2026-07-01T00:00:00.000Z',
      archived: false as const,
      deletedAt: null,
    }
    expect(issueAutoArchiveRunKey(archiveObs)).toContain('issue-auto-archive')
    expect(
      MaintenanceCommand.parse({
        protocolVersion: 1,
        schemaVersion: 'maintenance-v1',
        jobKind: 'issue-auto-archive',
        runKey: issueAutoArchiveRunKey(archiveObs),
        fencingToken: 1,
        observed: archiveObs,
      }).jobKind,
    ).toBe('issue-auto-archive')
  })

  it('keeps the apply result vocabulary closed', () => {
    for (const status of ['applied', 'already-applied'] as const) {
      expect(
        MaintenanceCommandReply.parse({ status, jobKind: 'message-expiry', runKey: 'run_1' })
          .status,
      ).toBe(status)
    }
    expect(
      MaintenanceCommandReply.parse({
        status: 'applied',
        jobKind: 'event-log-prune',
        runKey: 'run_2',
        deleted: 12,
      }),
    ).toMatchObject({ deleted: 12 })
    expect(
      MaintenanceCommandReply.parse({
        status: 'stale',
        jobKind: 'message-expiry',
        runKey: 'run_1',
        reason: 'fenced',
      }).status,
    ).toBe('stale')
    expect(() =>
      MaintenanceCommandReply.parse({
        status: 'stale',
        jobKind: 'message-expiry',
        runKey: 'run_1',
      }),
    ).toThrow()
    expect(() =>
      MaintenanceCommandReply.parse({
        status: 'accepted',
        jobKind: 'message-expiry',
        runKey: 'run_1',
      }),
    ).toThrow()
  })

  it('derives the same key only from the occurrence facts', () => {
    expect(messageExpiryRunKey(observed)).toBe(messageExpiryRunKey({ ...observed }))
    expect(messageExpiryRunKey({ ...observed, messageId: 'msg_2' })).not.toBe(
      messageExpiryRunKey(observed),
    )
    expect(messageExpiryRunKey({ ...observed, expiresAt: '2026-07-20T00:00:00.000Z' })).not.toBe(
      messageExpiryRunKey(observed),
    )
  })
})
