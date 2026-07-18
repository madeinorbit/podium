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
          batchIndex: 0,
        },
      ],
      planChangeLogPrune: async () => [
        {
          keepRows: 20_000,
          maxAgeMs: 3 * 24 * 60 * 60 * 1000,
          thresholdSeq: 9,
          batchSize: 100,
          batchIndex: 0,
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
    expect(counters.maxBatchDeleted).toBe(1)
    expect(counters.lastProgressAt).not.toBeNull()
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
      expect(batches[0]?.batchIndex).toBe(0)
      expect(batches[2]?.batchIndex).toBe(2)
      expect(new Set(batches.map((b) => b.cutoff)).size).toBe(1)
    } finally {
      db.close()
    }
  })
})
