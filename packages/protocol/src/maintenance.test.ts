import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  eventLogPruneRunKey,
  IssueAutoArchiveObservation,
  issueAutoArchiveRunKey,
  MAINTENANCE_SCHEMA_VERSION,
  MaintenanceCommand,
  MaintenanceCommandReply,
  MaintenanceHandshake,
  MaintenanceHandshakeReply,
  messageExpiryRunKey,
  sessionAutoArchiveRunKey,
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

  it('bumps compatibility for the indexed expiry-reader schema', () => {
    expect(MAINTENANCE_SCHEMA_VERSION).toBe('maintenance-v2')
  })

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
      fromId: 1,
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
      issueId: asIssueId('iss_1'),
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

/**
 * SessionAutoArchiveObservation is a VALIDATION GATE over an untrusted
 * cross-process payload, not a projection of the session entity — and until
 * POD-366 it had no test at all, so that claim was prose nothing enforced.
 *
 * The janitor is a separate process; its command arrives as an HTTP body that
 * `apps/server/src/modules/maintenance/route.ts` runs through
 * `MaintenanceCommand.safeParse`. These tests go through that same union rather
 * than the leaf schema, so they exercise the gate the server actually uses.
 *
 * Why it matters for the session vocabulary (inventory §2.1 #23): every
 * divergence from the canonical session fields is load-bearing, so this shape is
 * a DECLARED-LEGITIMATE divergence that must stay hand-written:
 *   - `archived: z.literal(false)` is a PRECONDITION about observed state.
 *     Composed from the aggregate it becomes `boolean`, and the gate whose whole
 *     purpose is to refuse an auto-archive command for an ALREADY-archived
 *     session would accept exactly that payload. Fail-open.
 *   - `.min(1).max(256)` are input bounds on an untrusted id, not field types.
 *   - `.datetime()` is stricter than the entity's plain string.
 *
 * Each test mutates exactly ONE constraint of an otherwise-valid payload, and
 * the valid payload is asserted FIRST as the counterfactual — without it, a
 * refusal proves only that the parse rejects something. Per-constraint mutants
 * are deliberate: POD-367 found that a COMPOUND mutant (two preconditions
 * composed away at once) can mask a per-constraint kill and read as a survivor,
 * because a second broken field keeps the payload failing for the wrong reason.
 */
describe('session-auto-archive is a gate, not a projection [POD-366]', () => {
  const valid = {
    sessionId: asSessionId('ses_1'),
    issueId: asIssueId('iss_1'),
    stoppedAt: '2026-07-01T00:00:00.000Z',
    readAt: '2026-07-01T00:00:00.000Z',
    archived: false as const,
  }
  const command = (observed: unknown) => ({
    protocolVersion: 2,
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    jobKind: 'session-auto-archive' as const,
    runKey: sessionAutoArchiveRunKey(valid),
    fencingToken: 1,
    observed,
  })

  it('accepts a well-formed observation — the counterfactual for every refusal below', () => {
    expect(MaintenanceCommand.parse(command(valid)).jobKind).toBe('session-auto-archive')
    expect(sessionAutoArchiveRunKey(valid)).toContain('session-auto-archive')
  })

  it('accepts a null issueId — an unbound session is a legitimate observation', () => {
    expect(() => MaintenanceCommand.parse(command({ ...valid, issueId: null }))).not.toThrow()
  })

  it('REFUSES archived: true — the precondition composing would destroy', () => {
    // This is the one that matters. If `archived` ever widens to boolean, this
    // test is the only thing standing between the server and an auto-archive
    // command for a session that is already archived.
    expect(() => MaintenanceCommand.parse(command({ ...valid, archived: true }))).toThrow()
  })

  it('refuses an empty sessionId, and one past the 256-char input bound', () => {
    expect(() =>
      MaintenanceCommand.parse(command({ ...valid, sessionId: asSessionId('') })),
    ).toThrow()
    expect(() =>
      MaintenanceCommand.parse(command({ ...valid, sessionId: asSessionId('x').repeat(257) })),
    ).toThrow()
    // 256 exactly is the boundary and must still be accepted, so the bound is
    // pinned from both sides rather than only from outside.
    expect(() =>
      MaintenanceCommand.parse(command({ ...valid, sessionId: asSessionId('x').repeat(256) })),
    ).not.toThrow()
  })

  it('refuses an empty issueId even though the field is nullable', () => {
    // nullable and min(1) are different constraints: absent is fine, blank is not.
    expect(() => MaintenanceCommand.parse(command({ ...valid, issueId: '' }))).toThrow()
  })

  it('refuses timestamps that are strings but not datetimes', () => {
    expect(() => MaintenanceCommand.parse(command({ ...valid, stoppedAt: 'yesterday' }))).toThrow()
    expect(() => MaintenanceCommand.parse(command({ ...valid, readAt: '2026-07-01' }))).toThrow()
  })
})

/**
 * The auto-archive observation is DECLARED LEGITIMATE against the representation
 * audit (POD-367, inventory #16): it must NOT be composed from the issue
 * aggregate, because its divergences are a validation gate over untrusted input
 * rather than a restatement of issue fields.
 *
 * Before these tests that exemption was prose and nothing enforced it — the
 * schema had NO coverage at all, so composing it away would have passed every
 * lane while converting a gate that refuses a bad payload into one that accepts
 * it. Each case below mutates exactly ONE field of a payload that is otherwise
 * valid, so what fails is the constraint the test names and not the fixture.
 */
describe('IssueAutoArchiveObservation refuses what it exists to refuse', () => {
  const valid = {
    issueId: asIssueId('iss_a'),
    stage: 'done',
    closedReason: 'shipped',
    readAt: '2026-07-30T00:00:00.000Z',
    archived: false as const,
    deletedAt: null,
  }

  it('accepts the valid observation (the counterfactual for every case below)', () => {
    expect(IssueAutoArchiveObservation.safeParse(valid).success).toBe(true)
  })

  it('refuses an ALREADY-ARCHIVED issue — archived is a precondition, not a field', () => {
    // The aggregate types this `boolean`. Composing it from there would accept
    // exactly the payload this schema exists to reject.
    expect(IssueAutoArchiveObservation.safeParse({ ...valid, archived: true }).success).toBe(false)
  })

  it('refuses a DELETED issue — deletedAt is a precondition, not an optional string', () => {
    expect(
      IssueAutoArchiveObservation.safeParse({ ...valid, deletedAt: '2026-07-30T00:00:00.000Z' })
        .success,
    ).toBe(false)
  })

  it('enforces input bounds on the untrusted ids and stage, from BOTH sides', () => {
    // The accepted side is asserted AT THE BOUNDARY, not just somewhere inside it.
    // Without it this test is satisfied by a parser that refuses everything — and
    // the valid fixture above does not rescue it, because its issueId is 5 chars,
    // so a bound wrongly tightened to .max(6) would pass every other case here.
    // (POD-366's general form: an "it refuses bad input" test needs the instrument
    // to be shown saying YES before its NO means anything.)
    expect(
      IssueAutoArchiveObservation.safeParse({ ...valid, issueId: 'i'.repeat(256) }).success,
    ).toBe(true)
    expect(IssueAutoArchiveObservation.safeParse({ ...valid, stage: 's'.repeat(64) }).success).toBe(
      true,
    )

    expect(IssueAutoArchiveObservation.safeParse({ ...valid, issueId: '' }).success).toBe(false)
    expect(
      IssueAutoArchiveObservation.safeParse({ ...valid, issueId: 'i'.repeat(257) }).success,
    ).toBe(false)
    expect(IssueAutoArchiveObservation.safeParse({ ...valid, stage: 's'.repeat(65) }).success).toBe(
      false,
    )
  })

  it('requires readAt to be a real timestamp, which is stricter than the entity string', () => {
    expect(IssueAutoArchiveObservation.safeParse({ ...valid, readAt: 'yesterday' }).success).toBe(
      false,
    )
  })
})
