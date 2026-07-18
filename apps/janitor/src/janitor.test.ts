import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  type MaintenanceCommandReply,
  type MaintenanceHandshake,
  type MaintenanceHandshakeReply,
} from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  ChangeLogPrunePlanner,
  ConnectScanReader,
  createMaintenanceHttpClient,
  EventLogPrunePlanner,
  JanitorService,
  MessageExpiryReader,
} from './janitor'

const readyLease = (
  over: Partial<{ fencingToken: number; expiresAt: string }> = {},
): Extract<MaintenanceHandshakeReply, { status: 'ready' }> => ({
  status: 'ready',
  fencingToken: over.fencingToken ?? 1,
  expiresAt: over.expiresAt ?? '2026-07-18T00:01:30.000Z',
  messageWaitTtlMs: 7 * 24 * 60 * 60_000,
  autoArchiveReadWindowMs: 24 * 60 * 60 * 1000,
  eventRetentionMaxAgeDays: 14,
  eventRetentionMaxRows: 50_000,
  changeKeepRows: 20_000,
  changeMaxAgeMs: 3 * 24 * 60 * 60 * 1000,
  maintenanceCommandMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
})

describe('JanitorService [spec:SP-c29e]', () => {
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
          issueId: 'iss_1',
          stage: 'done',
          closedReason: null,
          readAt: '2026-07-01T00:00:00.000Z',
          archived: false,
          deletedAt: null,
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
    expect(applies).toEqual(['event-log-prune', 'change-log-prune', 'issue-auto-archive'])
    const counters = service.snapshotCounters()
    expect(counters.applied).toBe(3)
    expect(counters.ticks).toBe(1)
    expect(counters.applies).toBe(3)
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
