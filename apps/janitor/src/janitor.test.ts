import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
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
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  ChangeLogPrunePlanner,
  ConnectScanReader,
  createMaintenanceHttpClient,
  EventLogPrunePlanner,
  JanitorService,
  MessageExpiryReader,
  type WorktreeGcReadInput,
  WorktreeGcReader,
} from './janitor'

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
  changeKeepRows: 20_000,
  changeMaxAgeMs: 3 * 24 * 60 * 60 * 1000,
  maintenanceCommandMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
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
            status: 'queued',
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
          status: 'queued',
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

  it('reads only durable due facts in bounded pages without consulting runtime state', async () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX idx_messages_expiry_explicit
        ON messages(status, expires_at, id);
      CREATE INDEX idx_messages_expiry_implicit
        ON messages(status, lifecycle, expires_at, created_at, id);`)
      const insert = db.prepare(
        'INSERT INTO messages (id, status, lifecycle, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      insert.run(
        'msg_explicit',
        'queued',
        'wake',
        '2026-07-17T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z',
      )
      insert.run('msg_wait', 'queued', 'wait', '2026-07-01T00:00:00.000Z', null)
      insert.run('msg_wake', 'queued', 'wake', '2026-07-01T00:00:00.000Z', null)
      insert.run(
        'msg_future',
        'queued',
        'wait',
        '2026-07-17T00:00:00.000Z',
        '2026-07-19T00:00:00.000Z',
      )

      const reader = new MessageExpiryReader(db)
      const prepare = vi.spyOn(db, 'prepare')
      const rows = await reader.read({
        now: '2026-07-18T00:00:00.000Z',
        waitImplicitCutoff: '2026-07-11T00:00:00.000Z',
        limit: 100,
      })
      expect(rows.map((row) => row.messageId)).toEqual(['msg_wait', 'msg_explicit'])

      for (let index = 0; index < 30; index += 1) {
        const suffix = index.toString().padStart(2, '0')
        insert.run(`msg_wait_${suffix}`, 'queued', 'wait', '2026-07-01T00:00:00.000Z', null)
        insert.run(
          `msg_explicit_${suffix}`,
          'queued',
          'wake',
          '2026-07-17T00:00:00.000Z',
          '2026-07-18T00:00:00.000Z',
        )
      }
      const paged = await reader.read({
        now: '2026-07-18T00:00:00.000Z',
        waitImplicitCutoff: '2026-07-11T00:00:00.000Z',
        limit: 100,
      })
      expect(paged).toHaveLength(62)
      expect(new Set(paged.map((row) => row.messageId)).size).toBe(62)

      const bounded = await reader.read({
        now: '2026-07-18T00:00:00.000Z',
        waitImplicitCutoff: '2026-07-11T00:00:00.000Z',
        limit: 1,
      })
      expect(bounded).toHaveLength(1)
      const queries = prepare.mock.calls.map(([sql]) => sql).join('\n')
      expect(queries).toContain('INDEXED BY idx_messages_expiry_explicit')
      expect(queries).toContain('INDEXED BY idx_messages_expiry_implicit')
      const planDetails = (sql: string, ...params: Array<string | number>): string =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
          .map((row) => row.detail)
          .join('\n')
      const implicitSql = prepare.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes('idx_messages_expiry_implicit'))
      const explicitSql = prepare.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes('idx_messages_expiry_explicit'))
      if (!implicitSql || !explicitSql) throw new Error('expected both indexed expiry queries')
      expect(planDetails(implicitSql, '2026-07-11T00:00:00.000Z', 25)).toContain(
        'SEARCH messages USING COVERING INDEX idx_messages_expiry_implicit',
      )
      expect(planDetails(explicitSql, '2026-07-18T00:00:00.000Z', 25)).toContain(
        'SEARCH messages USING INDEX idx_messages_expiry_explicit',
      )
    } finally {
      db.close()
    }
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
          keepRows: 20_000,
          maxAgeMs: 3 * 24 * 60 * 60 * 1000,
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
          readerUserId: FIRST_ADMIN_USER_ID,
          archived: false,
          deletedAt: null,
        },
      ],
      readSessionAutoArchiveCandidates: async () => [
        {
          sessionId: asSessionId('ses_1'),
          issueId: null,
          stoppedAt: '2026-07-01T00:00:00.000Z',
          readerUserId: FIRST_ADMIN_USER_ID,
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
      const insert = db.prepare(
        'INSERT INTO podium_events (ts, kind, subject, payload) VALUES (?, ?, ?, ?)',
      )
      for (let i = 0; i < 5; i++) {
        insert.run('2026-06-01T00:00:00.000Z', 'old', `s${i}`, '{}')
      }
      const planner = new EventLogPrunePlanner(db)
      const batches = await planner.plan({
        maxAgeDays: 14,
        maxRows: 50_000,
        batchSize: 2,
        nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
      })
      expect(batches).toHaveLength(3)
      expect(batches.map((b) => b.fromId)).toEqual([1, 3, 5])
      expect(new Set(batches.map((b) => b.cutoff)).size).toBe(1)
    } finally {
      db.close()
    }
  })

  it('[POD-925 B2] ConnectScanReader keeps candidates after 5m (delay-not-lose)', async () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        name TEXT,
        hostname TEXT,
        token_hash TEXT,
        created_at TEXT,
        last_seen_at TEXT,
        inventory_json TEXT
      )`)
      db.prepare(
        `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('remote', 'r', 'r', 't', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')
      const reader = new ConnectScanReader(db)
      // Recovered 6 minutes later — still a candidate (lastSeenAt is durable handshake fact).
      const candidates = reader.read('2026-07-18T00:06:00.000Z', 'local')
      expect(candidates).toEqual([
        { machineId: 'remote', lastSeenAt: '2026-07-18T00:00:00.000Z', deep: false },
      ])
    } finally {
      db.close()
    }
  })

  it('[POD-925 review] ChangeLogPrunePlanner advances fromSeq so recovery cannot starve', async () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT,
        entity_id TEXT,
        op TEXT,
        payload TEXT,
        event_time INTEGER
      )`)
      const insert = db.prepare(
        'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
      )
      // 250 aged rows; batchSize 100 → first plan 3 batches; after deleting 200, replan continues.
      const aged = Date.parse('2026-07-01T00:00:00.000Z')
      for (let i = 0; i < 250; i++) {
        insert.run('issue', `i${i}`, 'upsert', '{}', aged)
      }
      const planner = new ChangeLogPrunePlanner(db)
      const first = await planner.plan({
        keepRows: 0,
        maxAgeMs: 1,
        batchSize: 100,
        nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
      })
      expect(first.length).toBeGreaterThanOrEqual(2)
      expect(first[0]?.fromSeq).toBe(1)
      expect(first[1]?.fromSeq).toBe(101)
      // Simulate a capped first tick deleting the first 200 rows (2 batches).
      db.prepare('DELETE FROM changes WHERE seq <= 200').run()
      const second = await planner.plan({
        keepRows: 0,
        maxAgeMs: 1,
        batchSize: 100,
        nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
      })
      expect(second[0]?.fromSeq).toBe(201)
      expect(second[0]?.fromSeq).not.toBe(first[0]?.fromSeq)
    } finally {
      db.close()
    }
  })
})

/**
 * The tail that archive cannot reach (POD-564).
 *
 * Every case here is a durable-snapshot question. Whether the tree is clean and
 * whether an agent is standing in the directory right now are NOT — the server
 * re-reads both inside the mutation, and the SQL below only keeps the janitor
 * from proposing work that is obviously already refused.
 */
describe('WorktreeGcReader proposes reclaimable checkouts [POD-564]', () => {
  const CLOSED = '2026-07-01T00:00:00.000Z'
  const CUTOFF = '2026-07-15T00:00:00.000Z'

  const withDb = async (
    seed: (insertIssue: (row: Record<string, unknown>) => void, db: SqlDatabase) => void,
    input: Partial<WorktreeGcReadInput> = {},
  ) => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE issues (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        stage TEXT,
        closed_reason TEXT,
        closed_at TEXT,
        worktree_path TEXT,
        deleted_at TEXT
      )`)
      db.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL
      )`)
      const insert = db.prepare(
        `INSERT INTO issues (id, parent_id, stage, closed_reason, closed_at, worktree_path, deleted_at)
         VALUES (@id, @parent_id, @stage, @closed_reason, @closed_at, @worktree_path, @deleted_at)`,
      )
      seed(
        (row) =>
          insert.run({
            parent_id: null,
            stage: 'done',
            closed_reason: null,
            closed_at: CLOSED,
            deleted_at: null,
            ...row,
          } as never),
        db,
      )
      return await new WorktreeGcReader(db).read({
        cutoffClosedAt: CUTOFF,
        mode: 'propose',
        afterDays: 14,
        limit: 100,
        ...input,
      })
    } finally {
      db.close()
    }
  }

  it('proposes a SUB-ISSUE’s checkout — the hole the archive sweep can never reach', async () => {
    // `sweepAutoArchive` gates on `parent_id IS NULL`, so a sub-issue's worktree
    // is outside the archive door permanently. If this reader ever grows that
    // same gate, the sweep silently stops reclaiming most of what is on disk.
    const found = await withDb((issue) => {
      issue({ id: 'iss_parent', worktree_path: '/r/.worktrees/parent' })
      issue({ id: 'iss_child', parent_id: 'iss_parent', worktree_path: '/r/.worktrees/child' })
    })
    // Ordered oldest-close first, then by id — both closed at the same instant here.
    expect(found.map((c) => c.issueId)).toEqual(['iss_child', 'iss_parent'])
  })

  it('carries the policy it was proposed under, so the server can refuse a disagreement', async () => {
    const [found] = await withDb(
      (issue) => issue({ id: 'iss_1', worktree_path: '/r/.worktrees/one' }),
      { mode: 'auto', afterDays: 30 },
    )
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

  it('skips open work, deleted rows, checkouts already freed, and closes inside the window', async () => {
    const found = await withDb((issue) => {
      issue({ id: 'iss_open', stage: 'in_progress', closed_at: null, worktree_path: '/r/w/open' })
      issue({ id: 'iss_deleted', worktree_path: '/r/w/del', deleted_at: CLOSED })
      issue({ id: 'iss_freed', worktree_path: null })
      issue({ id: 'iss_young', closed_at: '2026-07-16T00:00:00.000Z', worktree_path: '/r/w/young' })
      issue({ id: 'iss_ok', worktree_path: '/r/w/ok' })
    })
    expect(found.map((c) => c.issueId)).toEqual(['iss_ok'])
  })

  it('counts a close REASON as closed, not only the done stage', async () => {
    const found = await withDb((issue) =>
      issue({
        id: 'iss_dup',
        stage: 'in_progress',
        closed_reason: 'duplicate',
        worktree_path: '/r/w/dup',
      }),
    )
    expect(found.map((c) => c.issueId)).toEqual(['iss_dup'])
  })

  it('leaves a directory an agent is still standing in — including one from another issue', async () => {
    const found = await withDb((issue, db) => {
      issue({ id: 'iss_busy', worktree_path: '/r/.worktrees/busy' })
      issue({ id: 'iss_idle', worktree_path: '/r/.worktrees/idle' })
      const session = db.prepare('INSERT INTO sessions (id, cwd, status) VALUES (?, ?, ?)')
      // A subdirectory of the worktree, and a session that belongs to nobody
      // here: the match is on the PATH, the way the server's guard makes it.
      session.run('ses_1', '/r/.worktrees/busy/packages/web', 'live')
      // An exited session is not standing in anything.
      session.run('ses_2', '/r/.worktrees/idle', 'exited')
    })
    expect(found.map((c) => c.issueId)).toEqual(['iss_idle'])
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
