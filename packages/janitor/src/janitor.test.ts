import { asIssueId, asSessionId, asUserId } from '@podium/model'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  type MaintenanceCommandReply,
  type MaintenanceHandshake,
  type MaintenanceHandshakeReply,
  type WorktreeGcObservation,
  worktreeGcRunKey,
} from '@podium/protocol'

/**
 * A member id, as a FIXTURE (A2). These tests open no instance, so
 * `firstAdminMemberId()` — which resolves the earliest admin member of one — has
 * no answer here. They never needed the real first admin: they need A person,
 * and naming one locally says so.
 */
const A_MEMBER = asUserId('mem_0ujtsYcgvSTl8PAuAdqWYSMnLOv')

import { describe, expect, it, vi } from 'vitest'
import {
  AppliedMutationsPrunePlanner,
  ChangeLogPrunePlanner,
  ConnectScanReader,
  createMaintenanceHttpClient,
  EventLogPrunePlanner,
  type ExpiryRow,
  handleTickError,
  type JanitorReadSource,
  type JanitorReads,
  JanitorService,
  MaintenanceCompatibilityError,
  MessageExpiryReader,
  QueuedMessagesExpiryReader,
  type RetentionJob,
  WorktreeGcReader,
} from './janitor'

/**
 * The read port with only the reads a case needs [POD-6993]. The SQL behind each read
 * is the server's (`apps/server/src/store/janitor-reads.ts`) and is tested there on
 * both engines; these cases test what the janitor does with the rows. Each scan counts.
 */
function portOf(reads: Partial<JanitorReads>): JanitorReadSource & { scans: number } {
  const port = {
    scans: 0,
    scan: async <T>(fn: (r: JanitorReads) => Promise<T>): Promise<T> => {
      port.scans += 1
      return await fn(reads as JanitorReads)
    },
  }
  return port
}

/** Keyset pages over sorted rows, as the server's walks return them. */
function pagesOver<Row, Key>(
  rows: Row[],
  keyOf: (row: Row) => Key,
  compare: (a: Key, b: Key) => number,
) {
  const sorted = [...rows].sort((a, b) => compare(keyOf(a), keyOf(b)))
  return (limit: number, after?: Key): Row[] =>
    sorted.filter((row) => after === undefined || compare(keyOf(row), after) > 0).slice(0, limit)
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const readyLease = (
  over: Partial<{
    fencingToken: number
    expiresAt: string
    worktreeGcMode: 'off' | 'propose' | 'auto'
    worktreeGcAfterDays: number
  }> = {},
): Extract<MaintenanceHandshakeReply, { status: 'ready' }> => ({
  status: 'ready',
  fencingToken: over.fencingToken ?? 1,
  expiresAt: over.expiresAt ?? '2026-07-18T00:01:30.000Z',
  messageWaitTtlMs: 7 * 24 * 60 * 60_000,
  autoArchiveReadWindowMs: 7 * 24 * 60 * 60 * 1000,
  eventRetentionMaxAgeDays: 14,
  eventRetentionMaxRows: 50_000,
  changeKeepRows: 500_000,
  changeMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maintenanceCommandMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
  appliedMutationMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  queuedMessageMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
  worktreeGcMode: over.worktreeGcMode ?? 'propose',
  worktreeGcAfterDays: over.worktreeGcAfterDays ?? 14,
})

describe('JanitorService [spec:SP-c29e]', () => {
  it('exposes progress and queue/coalescing/failure counters without mistaking a hung tick for progress', async () => {
    let finishHandshake: ((reply: MaintenanceHandshakeReply) => void) | undefined
    const handshake = vi.fn(
      () =>
        new Promise<MaintenanceHandshakeReply>((resolve) => {
          finishHandshake = resolve
        }),
    )
    const service = new JanitorService({
      generationId: 'gen_metrics',
      handshake,
      readExpiryCandidates: () => [],
      apply: vi.fn(),
    })

    const first = service.tick()
    const startedProgress = service.progressVersion()
    const coalesced = service.tick()
    expect(coalesced).toBe(first)
    expect(service.progressVersion()).toBe(startedProgress)
    expect(service.metrics()).toMatchObject({
      queueDepth: 1,
      coalescedJobs: 1,
      supersededJobs: 0,
      completedJobs: 0,
      failures: 0,
    })

    finishHandshake?.({
      ...readyLease({ expiresAt: '2099-01-01T00:00:00.000Z' }),
      messageWaitTtlMs: 60_000,
    })
    await first
    expect(service.progressVersion()).toBeGreaterThan(startedProgress)
    expect(service.metrics()).toMatchObject({ queueDepth: 0, failures: 0 })
    expect(service.metrics().maxJobAgeMs).toBeGreaterThanOrEqual(0)
    expect(service.metrics().maxUninterruptedSliceMs).toBeGreaterThanOrEqual(0)
  })

  it('aborts a wedged maintenance request so a later tick can retry', async () => {
    let signal: AbortSignal | undefined
    let requests = 0
    const client = createMaintenanceHttpClient(
      'http://localhost:18787',
      'secret',
      ((_url: string, init?: RequestInit) => {
        requests += 1
        signal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
        })
      }) as typeof fetch,
      5,
    )
    const service = new JanitorService({
      generationId: 'gen_timeout',
      handshake: client.handshake,
      readExpiryCandidates: () => [],
      apply: client.apply,
    })

    await expect(service.tick()).rejects.toBeDefined()
    await expect(service.tick()).rejects.toBeDefined()
    expect(signal?.aborted).toBe(true)
    expect(requests).toBe(2)
  })

  it('composes shutdown cancellation with the per-request timeout', async () => {
    const shutdown = new AbortController()
    let requestSignal: AbortSignal | undefined
    const client = createMaintenanceHttpClient(
      'http://localhost:18787',
      'secret',
      ((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
            once: true,
          })
        })
      }) as typeof fetch,
      60_000,
      shutdown.signal,
    )

    const pending = client.handshake({
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      generationId: 'gen_shutdown',
    })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    shutdown.abort(new Error('janitor shutting down'))
    await expect(pending).rejects.toThrow('janitor shutting down')
    expect(requestSignal?.aborted).toBe(true)
  })

  it('handshakes before reading durable candidates and sends the fenced deterministic command', async () => {
    const calls: string[] = []
    let command: MaintenanceCommand | undefined
    const service = new JanitorService({
      generationId: 'gen_a',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async (request: MaintenanceHandshake): Promise<MaintenanceHandshakeReply> => {
        calls.push(`handshake:${request.protocolVersion}:${request.schemaVersion}`)
        return readyLease({ fencingToken: 9, expiresAt: '2026-07-18T00:01:30.000Z' })
      },
      readExpiryCandidates: (input) => {
        calls.push(`read:${input.limit}`)
        return [
          {
            messageId: 'msg_1',
            deliveryStatus: 'stored',
            lifecycle: 'wait',
            createdAt: '2026-07-01T00:00:00.000Z',
            expiresAt: null,
          },
        ]
      },
      apply: async (request: MaintenanceCommand): Promise<MaintenanceCommandReply> => {
        command = request
        calls.push('apply')
        return { status: 'applied', jobKind: request.jobKind, runKey: request.runKey }
      },
    })

    await service.tick()

    expect(calls).toEqual([
      `handshake:${MAINTENANCE_PROTOCOL_VERSION}:${MAINTENANCE_SCHEMA_VERSION}`,
      'read:100',
      'apply',
    ])
    expect(command).toMatchObject({
      jobKind: 'message-expiry',
      fencingToken: 9,
      observed: { messageId: 'msg_1' },
    })
  })

  it('never reads or applies while another generation owns the lease', async () => {
    const readExpiryCandidates = vi.fn(() => [])
    const apply = vi.fn()
    const service = new JanitorService({
      generationId: 'gen_b',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async () => ({ status: 'busy', retryAt: '2026-07-18T00:01:30.000Z' }),
      readExpiryCandidates,
      apply,
    })

    await service.tick()

    expect(readExpiryCandidates).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('drops its lease immediately when the server fences a command', async () => {
    let handshakes = 0
    const service = new JanitorService({
      generationId: 'gen_a',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async () => {
        handshakes += 1
        return readyLease({ fencingToken: handshakes, expiresAt: '2026-07-18T00:01:30.000Z' })
      },
      readExpiryCandidates: () => [
        {
          messageId: 'msg_1',
          deliveryStatus: 'stored',
          lifecycle: 'wait',
          createdAt: '2026-07-01T00:00:00.000Z',
          expiresAt: null,
        },
      ],
      apply: async (request) => ({
        status: 'stale',
        jobKind: request.jobKind,
        runKey: request.runKey,
        reason: 'fenced',
      }),
    })

    await service.tick()
    await service.tick()

    expect(handshakes).toBe(2)
  })

  it('reads both expiry walks in bounded, interleaved pages inside one scan', async () => {
    const implicit: ExpiryRow[] = []
    const explicit: ExpiryRow[] = []
    for (let index = 0; index < 31; index += 1) {
      const suffix = index.toString().padStart(2, '0')
      implicit.push({
        id: `msg_wait_${suffix}`,
        lifecycle: 'wait',
        createdAt: '2026-07-01T00:00:00.000Z',
        expiresAt: null,
      })
      explicit.push({
        id: `msg_explicit_${suffix}`,
        lifecycle: 'wake',
        createdAt: '2026-07-17T00:00:00.000Z',
        expiresAt: '2026-07-18T00:00:00.000Z',
      })
    }
    const implicitPages = pagesOver(implicit, (row) => `${row.createdAt}|${row.id}`, byText)
    const explicitPages = pagesOver(explicit, (row) => `${row.expiresAt}|${row.id}`, byText)
    const pageCalls: string[] = []
    const port = portOf({
      implicitExpiryPage: async ({ cutoff, limit, after }) => {
        expect(cutoff).toBe('2026-07-11T00:00:00.000Z')
        pageCalls.push(`implicit:${limit}`)
        return implicitPages(limit, after && `${after.createdAt}|${after.id}`)
      },
      explicitExpiryPage: async ({ now, limit, after }) => {
        expect(now).toBe('2026-07-18T00:00:00.000Z')
        pageCalls.push(`explicit:${limit}`)
        return explicitPages(limit, after && `${after.expiresAt}|${after.id}`)
      },
    })
    const reader = new MessageExpiryReader(port)
    const input = {
      now: '2026-07-18T00:00:00.000Z',
      waitImplicitCutoff: '2026-07-11T00:00:00.000Z',
      limit: 100,
    }
    const paged = await reader.read(input)
    expect(paged).toHaveLength(62)
    expect(new Set(paged.map((row) => row.messageId)).size).toBe(62)
    // Pages of 25 at most, the two walks taking turns.
    expect(pageCalls.slice(0, 4)).toEqual([
      'implicit:25',
      'explicit:25',
      'implicit:25',
      'explicit:25',
    ])
    expect(paged.every((row) => row.deliveryStatus === 'stored')).toBe(true)
    // One read session for the whole walk.
    expect(port.scans).toBe(1)

    const bounded = await reader.read({ ...input, limit: 1 })
    expect(bounded).toHaveLength(1)
  })

  it('[POD-925] runs housekeeping planners and applies fenced batch commands once', async () => {
    const applies: string[] = []
    const service = new JanitorService({
      generationId: 'gen_house',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async () => readyLease({ fencingToken: 3 }),
      readExpiryCandidates: () => [],
      planEventLogPrune: async () => [
        {
          maxAgeDays: 14,
          maxRows: 50_000,
          cutoff: '2026-07-04T00:00:00.000Z',
          capThroughId: 0,
          batchSize: 500,
          fromId: 1,
        },
      ],
      planChangeLogPrune: async () => [
        {
          tenantId: 'local',
          keepRows: 500_000,
          maxAgeMs: 30 * 24 * 60 * 60 * 1000,
          thresholdSeq: 9,
          batchSize: 100,
          fromSeq: 1,
        },
      ],
      planMaintenanceCommandsPrune: async () => [],
      readAutoArchiveCandidates: async () => [
        {
          issueId: asIssueId('iss_1'),
          stage: 'done',
          closedReason: null,
          readerUserId: A_MEMBER,
          archived: false,
          deletedAt: null,
        },
      ],
      readSessionAutoArchiveCandidates: async () => [
        {
          sessionId: asSessionId('ses_1'),
          issueId: null,
          stoppedAt: '2026-07-01T00:00:00.000Z',
          readerUserId: A_MEMBER,
          archived: false,
        },
      ],
      apply: async (request) => {
        applies.push(request.jobKind)
        return {
          status: 'applied',
          jobKind: request.jobKind,
          runKey: request.runKey,
          deleted: request.jobKind.endsWith('prune') ? 1 : undefined,
        }
      },
    })

    await service.tick()
    expect(applies).toEqual([
      'event-log-prune',
      'change-log-prune',
      'issue-auto-archive',
      'session-auto-archive',
    ])
    const counters = service.snapshotCounters()
    expect(counters.applied).toBe(4)
    expect(counters.ticks).toBe(1)
    expect(counters.applies).toBe(4)
    expect(counters.stale).toBe(0)
    expect(counters.failures).toBe(0)
    expect(counters.maxBatchDeleted).toBe(1)
    expect(counters.lastProgressAt).not.toBeNull()
    expect(counters.jobAgeMs['event-log-prune']).toBeDefined()
  })

  it('[POD-925 review] snapshotCounters.failures increments when a tick rejects', async () => {
    let reads = 0
    const service = new JanitorService({
      generationId: 'gen_fail',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async () => readyLease({ fencingToken: 1 }),
      readExpiryCandidates: () => {
        reads += 1
        if (reads > 1) throw new Error('server-down')
        return []
      },
      apply: async (request) => ({
        status: 'applied',
        jobKind: request.jobKind,
        runKey: request.runKey,
      }),
    })
    await service.tick()
    expect(service.snapshotCounters().failures).toBe(0)
    await expect(service.tick()).rejects.toThrow(/server-down/)
    // flight rejection path increments failures
    await new Promise((r) => setTimeout(r, 0))
    expect(service.snapshotCounters()).toMatchObject({ ticks: 2, failures: 1 })
  })

  it('[POD-925] EventLogPrunePlanner emits one observation per bounded batch', async () => {
    const port = portOf({
      eventCapThroughId: async (maxRows) => {
        expect(maxRows).toBe(50_000)
        return undefined
      },
      eventPruneHead: async ({ cutoff, capThroughId }) => {
        expect(cutoff).toBe('2026-07-04T00:00:00.000Z')
        expect(capThroughId).toBe(0)
        return 1
      },
      eventPruneCount: async () => 5,
    })
    const batches = await new EventLogPrunePlanner(port).plan({
      maxAgeDays: 14,
      maxRows: 50_000,
      batchSize: 2,
      nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
    })
    expect(batches).toHaveLength(3)
    expect(batches.map((b) => b.fromId)).toEqual([1, 3, 5])
    expect(new Set(batches.map((b) => b.cutoff)).size).toBe(1)
    // The cap and the head come from one snapshot.
    expect(port.scans).toBe(1)
  })

  it('EventLogPrunePlanner plans nothing when no row is prunable', async () => {
    const port = portOf({
      eventCapThroughId: async () => 7,
      eventPruneHead: async () => null,
      eventPruneCount: async () => {
        throw new Error('no head: the count is not read')
      },
    })
    expect(
      await new EventLogPrunePlanner(port).plan({
        maxAgeDays: 14,
        maxRows: 1,
        batchSize: 2,
        nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
      }),
    ).toEqual([])
  })

  it('[POD-925 B2] ConnectScanReader proposes a shallow scan per remote machine', async () => {
    const port = portOf({
      remoteMachines: async ({ localMachineId }) => {
        expect(localMachineId).toBe('local')
        return [{ id: 'remote', lastSeenAt: '2026-07-18T00:00:00.000Z' }]
      },
    })
    // Recovered 6 minutes later: still a candidate (lastSeenAt is the durable handshake fact).
    expect(await new ConnectScanReader(port).read('2026-07-18T00:06:00.000Z', 'local')).toEqual([
      { machineId: 'remote', lastSeenAt: '2026-07-18T00:00:00.000Z', deep: false },
    ])
  })

  it('[POD-925 review] ChangeLogPrunePlanner advances fromSeq so recovery cannot starve', async () => {
    let feed = { headSeq: 250, floorSeq: 1, agedSeq: 250 as number | null }
    const planner = new ChangeLogPrunePlanner(portOf({ changeFeed: async () => feed }), 'local')
    const input = {
      keepRows: 0,
      maxAgeMs: 1,
      batchSize: 100,
      nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
    }
    const first = await planner.plan(input)
    expect(first.map((b) => b.fromSeq)).toEqual([1, 101, 201])
    expect(first.every((b) => b.tenantId === 'local')).toBe(true)
    // A capped first tick deleted the first 200 rows (2 batches) and moved the floor.
    feed = { headSeq: 250, floorSeq: 201, agedSeq: 250 }
    const second = await planner.plan(input)
    expect(second[0]?.fromSeq).toBe(201)
    expect(second[0]?.fromSeq).not.toBe(first[0]?.fromSeq)
  })
})

/**
 * The tail that archive cannot reach (POD-564). Which checkouts qualify is the
 * server's SQL (`janitor-reads.test.ts`, both engines); this is what the janitor
 * makes of them.
 */
describe('[POD-7035] retention jobs', () => {
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const NOW = Date.parse('2026-07-18T00:30:00.000Z')

  it('EventLogPrunePlanner finds the row cap by a seek that stays exact across missing ids', async () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE podium_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        repo_path TEXT,
        payload TEXT
      )`)
      db.exec('CREATE INDEX idx_podium_events_kind ON podium_events (kind)')
      const insert = db.prepare(
        "INSERT INTO podium_events (ts, kind, subject, payload) VALUES ('2099-01-01T00:00:00.000Z', ?, 's', '{}')",
      )
      for (let i = 0; i < 120; i += 1) insert.run(i % 2 ? 'a' : 'b')
      db.exec('DELETE FROM podium_events WHERE id IN (118, 110, 109, 100, 61, 60, 2)')
      const planner = new EventLogPrunePlanner(db)
      for (const maxRows of [0, 1, 5, 20, 50, 59, 60, 112, 113, 200]) {
        const walked =
          (
            db
              .prepare('SELECT id FROM podium_events ORDER BY id DESC LIMIT 1 OFFSET ?')
              .get(maxRows) as { id: number } | undefined
          )?.id ?? 0
        const batches = await planner.plan({ maxAgeDays: 14, maxRows, batchSize: 500, nowMs: NOW })
        expect(batches[0]?.capThroughId ?? 0, `maxRows ${maxRows}`).toBe(walked)
      }
    } finally {
      db.close()
    }
  })

  it('AppliedMutationsPrunePlanner batches the receipts past an hour-rounded cutoff', async () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE applied_mutations (
        mutation_id TEXT PRIMARY KEY, proc TEXT NOT NULL, result TEXT NOT NULL, applied_at INTEGER NOT NULL
      )`)
      db.exec('CREATE INDEX idx_applied_mutations_applied_at ON applied_mutations (applied_at)')
      const maxAgeMs = 30 * DAY
      const cutoff = Math.floor((NOW - maxAgeMs) / HOUR) * HOUR
      const insert = db.prepare(
        "INSERT INTO applied_mutations (mutation_id, proc, result, applied_at) VALUES (?, 'p', '\"r\"', ?)",
      )
      for (let i = 0; i < 5; i += 1) insert.run(`old-${i}`, cutoff - 1_000 - i)
      // Past the true horizon but not the rounded cutoff: the next hour's batch.
      insert.run('this-hour', cutoff + 1_000)
      insert.run('young', NOW)
      const planner = new AppliedMutationsPrunePlanner(db)
      const batches = await planner.plan({ maxAgeMs, batchSize: 2, nowMs: NOW })
      expect(batches).toEqual(
        [0, 1, 2].map((batch) => ({
          maxAgeMs,
          cutoffAppliedAt: cutoff,
          batchSize: 2,
          fromAppliedAt: cutoff - 1_004,
          batch,
        })),
      )
      // A tick later in the same hour plans the same occurrences.
      expect(await planner.plan({ maxAgeMs, batchSize: 2, nowMs: NOW + 60_000 })).toEqual(batches)
      expect(planner.backlog({ maxAgeMs, nowMs: NOW })).toBe(5)
      const plan = (
        db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM applied_mutations WHERE applied_at < ?',
          )
          .all() as { detail: string }[]
      ).map((row) => row.detail)
      expect(plan.join(' | ')).toContain('idx_applied_mutations_applied_at')
    } finally {
      db.close()
    }
  })

  it('QueuedMessagesExpiryReader names each session once, by its newest row past the horizon', async () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE queued_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL, queued_at INTEGER NOT NULL
      )`)
      db.exec('CREATE INDEX queued_messages_session ON queued_messages (session_id, queued_at)')
      const maxAgeMs = 14 * DAY
      const horizon = NOW - maxAgeMs
      const insert = db.prepare(
        'INSERT INTO queued_messages (id, session_id, text, queued_at) VALUES (?, ?, ?, ?)',
      )
      insert.run('a1', 'ses_a', 'x', horizon - 5_000)
      insert.run('a2', 'ses_a', 'x', horizon - 1_000)
      insert.run('a3', 'ses_a', 'x', horizon + 1_000)
      insert.run('b1', 'ses_b', 'x', horizon - 9_000)
      insert.run('c1', 'ses_c', 'x', horizon + 1)
      const reader = new QueuedMessagesExpiryReader(db)
      expect(await reader.read({ maxAgeMs, nowMs: NOW, limit: 100 })).toEqual([
        { sessionId: asSessionId('ses_b'), maxAgeMs, throughQueuedAt: horizon - 9_000, rows: 1 },
        { sessionId: asSessionId('ses_a'), maxAgeMs, throughQueuedAt: horizon - 1_000, rows: 2 },
      ])
      expect(reader.backlog({ maxAgeMs, nowMs: NOW })).toBe(3)
    } finally {
      db.close()
    }
  })

  it("applies the receipt prune and queue expiry, and reports each job's backlog after it runs", async () => {
    const applies: MaintenanceCommand[] = []
    const backlogReads: RetentionJob[] = []
    const service = new JanitorService({
      generationId: 'gen_retention',
      now: () => NOW,
      handshake: async () => readyLease({ fencingToken: 2 }),
      readExpiryCandidates: () => [],
      planAppliedMutationsPrune: async (input) => [
        {
          maxAgeMs: input.maxAgeMs,
          cutoffAppliedAt: 1,
          batchSize: input.batchSize,
          fromAppliedAt: 0,
          batch: 0,
        },
      ],
      readQueuedMessagesExpiry: async (input) => [
        { sessionId: asSessionId('ses_a'), maxAgeMs: input.maxAgeMs, throughQueuedAt: 5, rows: 2 },
      ],
      retentionBacklog: (job) => {
        backlogReads.push(job)
        return job === 'applied-mutations-prune' ? 7 : 0
      },
      apply: async (request) => {
        applies.push(request)
        return { status: 'applied', jobKind: request.jobKind, runKey: request.runKey, deleted: 1 }
      },
    })
    await service.tick()
    expect(applies.map((command) => command.jobKind)).toEqual([
      'applied-mutations-prune',
      'queued-messages-expiry',
    ])
    expect(applies[0]).toMatchObject({
      observed: { maxAgeMs: 30 * DAY, batchSize: 100 },
      fencingToken: 2,
    })
    expect(applies[1]).toMatchObject({ observed: { maxAgeMs: 14 * DAY } })
    expect(backlogReads).toEqual(['applied-mutations-prune', 'queued-messages-expiry'])
    expect(service.snapshotCounters().retentionBacklog).toEqual({
      'applied-mutations-prune': 7,
      'queued-messages-expiry': 0,
    })
  })

  it('marks a job stalled when its backlog has not shrunk across three runs', async () => {
    const backlogs = [10, 9, 9, 9, 12, 0]
    let run = 0
    const service = new JanitorService({
      generationId: 'gen_stall',
      now: () => NOW,
      handshake: async () => readyLease({ fencingToken: 1, expiresAt: '2099-01-01T00:00:00.000Z' }),
      readExpiryCandidates: () => [],
      planMaintenanceCommandsPrune: async () => [],
      retentionBacklog: () => backlogs[run]!,
      apply: async (request) => ({
        status: 'applied',
        jobKind: request.jobKind,
        runKey: request.runKey,
      }),
    })
    const stalledAfterEachRun: boolean[] = []
    for (run = 0; run < backlogs.length; run += 1) {
      await service.tick()
      stalledAfterEachRun.push(
        service.snapshotCounters().retentionStalled.includes('maintenance-commands-prune'),
      )
    }
    // 10, 9: shrinking. 9, 9, 9: three runs without shrinking. 12: still not.
    // 0: drained.
    expect(stalledAfterEachRun).toEqual([false, false, false, true, true, false])
  })

  it('a failed backlog read is skipped and never stops the tick', async () => {
    const applies: string[] = []
    const service = new JanitorService({
      generationId: 'gen_backlog_fail',
      now: () => NOW,
      handshake: async () => readyLease(),
      readExpiryCandidates: () => [],
      planAppliedMutationsPrune: async () => [],
      readQueuedMessagesExpiry: async () => [
        { sessionId: asSessionId('ses_a'), maxAgeMs: 14 * DAY, throughQueuedAt: 5, rows: 1 },
      ],
      retentionBacklog: () => {
        throw new Error('database is locked')
      },
      apply: async (request) => {
        applies.push(request.jobKind)
        return { status: 'applied', jobKind: request.jobKind, runKey: request.runKey }
      },
    })
    await service.tick()
    expect(applies).toEqual(['queued-messages-expiry'])
    expect(service.snapshotCounters().retentionBacklog).toEqual({})
  })
})

describe('WorktreeGcReader proposes reclaimable checkouts [POD-564]', () => {
  const CLOSED = '2026-07-01T00:00:00.000Z'

  it('carries the policy it was proposed under, so the server can refuse a disagreement', async () => {
    const port = portOf({
      worktreeGcPage: async ({ cutoffClosedAt }) => {
        expect(cutoffClosedAt).toBe('2026-07-15T00:00:00.000Z')
        return [
          {
            id: 'iss_1',
            worktreePath: '/r/.worktrees/one',
            stage: 'done',
            closedReason: null,
            closedAt: CLOSED,
          },
        ]
      },
    })
    const [found] = await new WorktreeGcReader(port).read({
      cutoffClosedAt: '2026-07-15T00:00:00.000Z',
      mode: 'auto',
      afterDays: 30,
      limit: 100,
    })
    expect(found).toEqual({
      issueId: 'iss_1',
      worktreePath: '/r/.worktrees/one',
      stage: 'done',
      closedReason: null,
      closedAt: CLOSED,
      deletedAt: null,
      mode: 'auto',
      afterDays: 30,
    })
  })

  it('walks the candidates in pages up to the limit', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `iss_${index.toString().padStart(2, '0')}`,
      worktreePath: `/r/w/${index}`,
      stage: 'done',
      closedReason: null,
      closedAt: CLOSED,
    }))
    const pages = pagesOver(rows, (row) => `${row.closedAt}|${row.id}`, byText)
    const port = portOf({
      worktreeGcPage: async ({ limit, after }) =>
        pages(limit, after && `${after.closedAt}|${after.id}`),
    })
    const read = (limit: number) =>
      new WorktreeGcReader(port).read({
        cutoffClosedAt: CLOSED,
        mode: 'propose',
        afterDays: 14,
        limit,
      })
    expect((await read(100)).map((c) => c.issueId)).toEqual(rows.map((row) => row.id))
    expect(await read(30)).toHaveLength(30)
  })
})

describe('the sweep is off when the operator says off [POD-564]', () => {
  const gcService = (
    worktreeGcMode: 'off' | 'propose' | 'auto',
    readWorktreeGcCandidates: () => WorktreeGcObservation[],
  ) => {
    const apply = vi.fn(
      async (command: MaintenanceCommand): Promise<MaintenanceCommandReply> => ({
        status: 'applied',
        jobKind: command.jobKind,
        runKey: command.runKey,
      }),
    )
    const service = new JanitorService({
      generationId: 'gen_gc',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async () => readyLease({ expiresAt: '2099-01-01T00:00:00.000Z', worktreeGcMode }),
      readExpiryCandidates: () => [],
      readWorktreeGcCandidates,
      apply,
    })
    return { service, apply }
  }

  const candidate: WorktreeGcObservation = {
    issueId: asIssueId('iss_gc'),
    worktreePath: '/r/.worktrees/gc',
    stage: 'done',
    closedReason: null,
    closedAt: '2026-07-01T00:00:00.000Z',
    deletedAt: null,
    mode: 'propose',
    afterDays: 14,
  }

  it('does not even read candidates under `off`', async () => {
    const read = vi.fn(() => [candidate])
    const { service, apply } = gcService('off', read)
    await service.tick()
    expect(read).not.toHaveBeenCalled()
    expect(apply.mock.calls.some(([c]) => c.jobKind === 'worktree-gc')).toBe(false)
  })

  it('proposes one command per candidate under `propose`, keyed by path and close', async () => {
    const { service, apply } = gcService('propose', () => [candidate])
    await service.tick()
    const sent = apply.mock.calls.map(([c]) => c).filter((c) => c.jobKind === 'worktree-gc')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.runKey).toBe(worktreeGcRunKey(candidate))
  })
})

/**
 * The one branch in this file that can END A PROCESS [POD-2505, review finding 3].
 *
 * Co-hosted inside the server, `process.exit(78)` on a mid-run compatibility
 * refusal exits the SERVER; the parent then reads 78 as a component refusal and
 * parks the server permanently stopped. A housekeeping loop's schema check would
 * end all serving, which is the exact inverse of the §8 policy it implements.
 */
describe('handleTickError', () => {
  const refusal = (): Error =>
    new MaintenanceCompatibilityError(MAINTENANCE_PROTOCOL_VERSION + 1, '20260901_future')

  it('a HOSTED refusal stops the tick and reports — it must never exit', () => {
    const exit = vi.fn()
    const stopTicking = vi.fn()
    const onCompatibilityRefusal = vi.fn()
    handleTickError(refusal(), { stopTicking, onCompatibilityRefusal, exit })
    expect(exit, 'a co-hosted janitor must not exit its host').not.toHaveBeenCalled()
    expect(stopTicking).toHaveBeenCalledOnce()
    expect(onCompatibilityRefusal).toHaveBeenCalledOnce()
  })

  it('a STANDALONE refusal still exits 78, which is what its supervisor reads', () => {
    const exit = vi.fn()
    const stopTicking = vi.fn()
    handleTickError(refusal(), { stopTicking, exit })
    expect(exit).toHaveBeenCalledWith(78)
  })

  it('any other tick failure is a delay, not a verdict', () => {
    const exit = vi.fn()
    const stopTicking = vi.fn()
    const onCompatibilityRefusal = vi.fn()
    handleTickError(new Error('server briefly unreachable'), {
      stopTicking,
      onCompatibilityRefusal,
      exit,
    })
    expect(exit).not.toHaveBeenCalled()
    expect(stopTicking, 'a transient error must not stop the loop').not.toHaveBeenCalled()
    expect(onCompatibilityRefusal).not.toHaveBeenCalled()
  })
})
