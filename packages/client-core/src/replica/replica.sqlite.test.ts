/**
 * SQLite-persisted replica backend (POD-789): the same `Replica` contract,
 * driven against REAL SQLite (bun:sqlite — the unit lane runs on the Bun
 * runtime, SP-3f93) through @tanstack/db-sqlite-persistence-core, the exact
 * engine the desktop Tauri adapter wraps. The thin Tauri driver itself
 * (placeholder conversion, plugin IPC) is upstream-tested and covered by the
 * desktop runtime verification.
 *
 * Covers the invariants the backend swap must preserve:
 *  - round-trip: a "restart" (fresh replica over the same sqlite handle)
 *    hydrates rows, cursor, transcripts, outbox, ui-state;
 *  - present→absent regression (#170 / POD-789 req 3): a field cleared to
 *    undefined must be REMOVED from the reloaded row;
 *  - cursor-after-data ordering (spec invariant 3) at the SQL level;
 *  - cursor honesty on persist failure (degrade → the cursor freezes at the
 *    last value whose data persisted; never advances over a gap);
 *  - localStorage→SQLite migration: outbox blobs fold in (never dropped
 *    silently), ui-state folds in, dead entity blobs retire;
 *  - poisoned replica: hydrate() never throws, cold-starts (invariant 2).
 */

import { createRequire } from 'node:module'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import type {
  PersistedCollectionPersistence,
  SQLiteDriver,
} from '@tanstack/db-sqlite-persistence-core'
import {
  createSQLiteCorePersistenceAdapter,
  persistedCollectionOptions,
  SingleProcessCoordinator,
} from '@tanstack/db-sqlite-persistence-core'
import { describe, expect, it } from 'vitest'
import type { OutboxEntry } from '../outbox'
import {
  createReplica,
  memoryStorage,
  REPLICA_SQLITE_SCHEMA_VERSION,
  type ReplicaInit,
} from './replica'

// Typed lazy require of `bun:sqlite` (same pattern as
// packages/runtime/src/sqlite/bun.ts — the repo carries no bun-types): the
// unit lane runs on the Bun runtime (SP-3f93), where the builtin exists.
interface BunStatement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface BunDb {
  prepare(sql: string): BunStatement
  exec(sql: string): void
}
type Database = BunDb
const Database = (
  createRequire(import.meta.url)('bun:sqlite') as { Database: new (path: string) => BunDb }
).Database

function session(id: string): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    title: id,
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  } as unknown as SessionMeta
}

const issue = (id: string, extra: Record<string, unknown> = {}): IssueWire =>
  ({ id, title: id, ...extra }) as unknown as IssueWire

/** Serialized SQLiteDriver over bun:sqlite — the same contract the Tauri
 *  driver implements (one FIFO queue; BEGIN IMMEDIATE transactions). `hooks`
 *  lets tests observe executed SQL and inject write failures. */
function bunSqliteDriver(
  db: Database,
  hooks: { log?: string[]; failWrites?: () => boolean } = {},
): SQLiteDriver {
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(op: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(() => op())
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  const isWrite = (sql: string) => /^\s*(insert|update|delete|create|drop|alter)/i.test(sql)
  const raw = {
    exec: (sql: string): void => {
      hooks.log?.push(sql)
      if (hooks.failWrites?.() && isWrite(sql)) throw new Error('injected sqlite write failure')
      db.exec(sql)
    },
    query: <T>(sql: string, params: ReadonlyArray<unknown> = []): ReadonlyArray<T> => {
      hooks.log?.push(sql)
      return db.prepare(sql).all(...(params as never[])) as T[]
    },
    run: (sql: string, params: ReadonlyArray<unknown> = []): void => {
      hooks.log?.push(sql)
      if (hooks.failWrites?.() && isWrite(sql)) throw new Error('injected sqlite write failure')
      db.prepare(sql).run(...(params as never[]))
    },
  }
  let savepoint = 0
  const txDriver: SQLiteDriver = {
    exec: async (sql) => raw.exec(sql),
    query: async (sql, params) => raw.query(sql, params),
    run: async (sql, params) => raw.run(sql, params),
    transaction: async (fn) => {
      const name = `test_sp_${++savepoint}`
      raw.exec(`SAVEPOINT ${name}`)
      try {
        const result = await fn(txDriver)
        raw.exec(`RELEASE SAVEPOINT ${name}`)
        return result
      } catch (err) {
        raw.exec(`ROLLBACK TO SAVEPOINT ${name}`)
        raw.exec(`RELEASE SAVEPOINT ${name}`)
        throw err
      }
    },
  }
  return {
    exec: (sql) => enqueue(() => raw.exec(sql)),
    query: (sql, params) => enqueue(() => raw.query(sql, params)),
    run: (sql, params) => enqueue(() => raw.run(sql, params)),
    transaction: (fn) =>
      enqueue(async () => {
        raw.exec('BEGIN IMMEDIATE')
        try {
          const result = await fn(txDriver)
          raw.exec('COMMIT')
          return result
        } catch (err) {
          try {
            raw.exec('ROLLBACK')
          } catch {
            // keep the original failure
          }
          throw err
        }
      }),
  }
}

/** Mirrors what apps/web builds via createTauriSQLitePersistence: the core
 *  adapter (schemaMismatchPolicy 'reset') + a single-process coordinator. */
function persistenceOver(driver: SQLiteDriver): PersistedCollectionPersistence {
  return {
    adapter: createSQLiteCorePersistenceAdapter({
      driver,
      schemaVersion: REPLICA_SQLITE_SCHEMA_VERSION,
      schemaMismatchPolicy: 'reset',
    }),
    coordinator: new SingleProcessCoordinator(),
  }
}

let dbSeq = 0
/** A fresh on-"disk" (in-memory) sqlite db + a replica factory over it. Each
 *  factory call = one "process lifetime" (fresh adapter + coordinator + replica
 *  over the SAME database), with a unique key prefix per db so TanStack's
 *  global collection-id space never collides across tests. */
function sqliteReplicaHarness(init: Partial<ReplicaInit> = {}) {
  const db = new Database(':memory:')
  const prefix = `podium.replica.t${++dbSeq}`
  const log: string[] = []
  let failing = false
  const driver = bunSqliteDriver(db, { log, failWrites: () => failing })
  const make = (over: Partial<ReplicaInit> = {}) =>
    createReplica({
      keyPrefix: prefix,
      storage: memoryStorage(),
      persisted: {
        persistence: persistenceOver(driver),
        collectionOptions: persistedCollectionOptions,
      },
      ...init,
      ...over,
    })
  return { db, prefix, log, make, setFailing: (v: boolean) => (failing = v) }
}

describe('sqlite-persisted replica (POD-789)', () => {
  it('round-trips entities, cursor, and transcripts across a restart', async () => {
    const h = sqliteReplicaHarness()
    const a = h.make()
    await a.hydrate()
    expect(a.persistent).toBe(true)
    a.applySnapshot('sessions', [session('s1'), session('s2')])
    a.applyChanges('issues', [issue('i1')], [])
    a.putTranscriptWindow('conv1', [{ kind: 'text', text: 'hello' } as never])
    a.setCursor(42)
    await a.flush()

    const b = h.make()
    const snap = await b.hydrate()
    expect(snap.sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
    expect(snap.issues.map((i) => i.id)).toEqual(['i1'])
    expect(snap.cursor).toBe(42)
    expect(b.transcriptWindow('conv1')?.items).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('removes a field cleared to undefined on the reloaded row (#170 regression)', async () => {
    const h = sqliteReplicaHarness()
    const a = h.make()
    await a.hydrate()
    a.applyChanges('issues', [issue('i1', { deferUntil: 1234, note: 'x' })], [])
    // The wire row now omits deferUntil (cleared server-side): the update
    // draft must drop it via undefined-assignment (delete is untracked).
    a.applyChanges('issues', [issue('i1', { note: 'x' })], [])
    await a.flush()

    const b = h.make()
    const snap = await b.hydrate()
    const row = snap.issues[0] as unknown as Record<string, unknown>
    expect(row.id).toBe('i1')
    expect(row.note).toBe('x')
    expect('deferUntil' in row).toBe(false)
  })

  it('persists the cursor AFTER the entity data it covers (spec invariant 3)', async () => {
    const h = sqliteReplicaHarness()
    const a = h.make()
    await a.hydrate()
    h.log.length = 0
    a.applyChanges('sessions', [session('s1')], [])
    a.setCursor(7)
    await a.flush()
    // Identify the meta (cursor) and sessions row tables by their contents,
    // then assert the log ordered the sessions write before the cursor write.
    const rowTables = (
      h.db.prepare("select name from sqlite_master where type='table'").all() as Array<{
        name: string
      }>
    )
      .map((t) => t.name)
      .filter((name) => /^c_[a-z2-7]/.test(name))
    const tableContaining = (needle: string) =>
      rowTables.find((name) =>
        (h.db.prepare(`select value from ${name}`).all() as Array<{ value: string }>).some((r) =>
          r.value.includes(needle),
        ),
      )
    const metaTable = tableContaining('"cursor"')
    const sessionsTable = tableContaining('"s1"')
    expect(metaTable).toBeDefined()
    expect(sessionsTable).toBeDefined()
    const firstWriteTouching = (table: string) =>
      h.log.findIndex((sql) => /insert|update/i.test(sql) && sql.includes(table))
    const cursorWriteAt = firstWriteTouching(metaTable as string)
    const sessionsWriteAt = firstWriteTouching(sessionsTable as string)
    expect(sessionsWriteAt).toBeGreaterThanOrEqual(0)
    expect(cursorWriteAt).toBeGreaterThan(sessionsWriteAt)
  })

  it('refuses to advance the cursor after an entity persist failure (cursor honesty)', async () => {
    const h = sqliteReplicaHarness()
    const a = h.make()
    await a.hydrate()
    a.applyChanges('sessions', [session('s1')], [])
    a.setCursor(1)
    await a.flush()
    expect(a.getCursor()).toBe(1)

    h.setFailing(true)
    a.applyChanges('sessions', [session('s2')], [])
    await a.flush()
    // Degraded: the cursor is void for this session…
    expect(a.getCursor()).toBeNull()
    a.setCursor(2)
    await a.flush()
    expect(a.getCursor()).toBeNull()
    h.setFailing(false)

    // The durable cursor stays at 1 — it was fenced behind the writes it
    // covers, so durable rows + cursor 1 are a CONSISTENT snapshot: the next
    // boot resumes from 1 and refetches the failed batch as a delta.
    const b = h.make()
    const snap = await b.hydrate()
    expect(snap.cursor).toBe(1)
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(['s1'])
  })

  it('migrates localStorage outbox blobs (never silently dropped) and retires them', async () => {
    const h = sqliteReplicaHarness()
    const legacy = memoryStorage()
    const entry = (id: string, seq: number): Record<string, unknown> => ({
      mutationId: id,
      kind: 'issue.update',
      input: { id: 'i1' },
      queuedAt: 1000 + seq,
      seq,
    })
    const blob = (rows: Record<string, unknown>[]) =>
      JSON.stringify(
        Object.fromEntries(rows.map((r) => [`s:${r.mutationId}`, { versionKey: 'v', data: r }])),
      )
    legacy.setItem(`${h.prefix}.outbox.v1`, blob([entry('m2', 2), entry('m1', 1)]))
    legacy.setItem(
      `${h.prefix}.outbox-awaiting.v1`,
      blob([{ ...entry('m3', 1), state: 'awaiting-truth', resolvedAt: 2000 }]),
    )
    // Ancient raw-key era too (parseOutboxEntries path).
    legacy.setItem(
      'podium.outbox.v1',
      JSON.stringify([{ mutationId: 'm0', kind: 'issue.update', input: {}, queuedAt: 500 }]),
    )

    const a = h.make({ storage: legacy })
    await a.hydrate()
    const queued = a.outboxStorage().load()
    // Blob entries first (their internal seq order: m1 then m2), then the raw
    // legacy key's m0 appended after (it folds in second).
    expect(queued.map((e: OutboxEntry) => e.mutationId)).toEqual(['m1', 'm2', 'm0'])
    const awaiting = a.outboxAwaitingStorage().load()
    expect(awaiting.map((e: OutboxEntry) => e.mutationId)).toEqual(['m3'])
    expect(awaiting[0]?.state).toBe('awaiting-truth')
    // Blobs retired.
    expect(legacy.getItem(`${h.prefix}.outbox.v1`)).toBeNull()
    expect(legacy.getItem(`${h.prefix}.outbox-awaiting.v1`)).toBeNull()
    expect(legacy.getItem('podium.outbox.v1')).toBeNull()
    await a.flush()

    // And they SURVIVE a restart from sqlite (the whole point).
    const b = h.make({ storage: memoryStorage() })
    await b.hydrate()
    expect(
      b
        .outboxStorage()
        .load()
        .map((e: OutboxEntry) => e.mutationId),
    ).toEqual(['m1', 'm2', 'm0'])
  })

  it('migrates the ui-state blob and retires dead entity blobs + cursor key', async () => {
    const h = sqliteReplicaHarness()
    const legacy = memoryStorage()
    legacy.setItem(
      `${h.prefix}.uistate.v1`,
      JSON.stringify({
        's:podium.view': { versionKey: 'v', data: { key: 'podium.view', value: 'chat' } },
      }),
    )
    legacy.setItem(`${h.prefix}.sessions.v1`, '{}')
    legacy.setItem(`${h.prefix}.cursor.v1`, '99')

    const a = h.make({ storage: legacy })
    await a.hydrate()
    expect(a.uiState().get('podium.view')).toBe('chat')
    expect(legacy.getItem(`${h.prefix}.uistate.v1`)).toBeNull()
    expect(legacy.getItem(`${h.prefix}.sessions.v1`)).toBeNull()
    expect(legacy.getItem(`${h.prefix}.cursor.v1`)).toBeNull()
    // The old localStorage cursor is deliberately NOT migrated: entities
    // re-bootstrap, so a null cursor (full snapshot fetch) is the honest seed.
    expect(a.getCursor()).toBeNull()
    await a.flush()

    const b = h.make({ storage: memoryStorage() })
    await b.hydrate()
    expect(b.uiState().get('podium.view')).toBe('chat')
  })

  it('outbox entries and ui-state written through the replica survive a restart', async () => {
    const h = sqliteReplicaHarness()
    const a = h.make()
    await a.hydrate()
    a.outboxStorage().save([
      { mutationId: 'w1', kind: 'issue.update', input: { id: 'i1' }, queuedAt: 1 },
      { mutationId: 'w2', kind: 'issue.update', input: { id: 'i2' }, queuedAt: 2 },
    ])
    a.uiState().set('podium.view', 'files')
    await a.flush()

    const b = h.make()
    await b.hydrate()
    expect(
      b
        .outboxStorage()
        .load()
        .map((e: OutboxEntry) => e.mutationId),
    ).toEqual(['w1', 'w2'])
    expect(b.uiState().get('podium.view')).toBe('files')
  })

  it('hydrate never throws on a poisoned database and cold-starts (invariant 2)', async () => {
    const h = sqliteReplicaHarness()
    const a = h.make()
    await a.hydrate()
    a.applySnapshot('sessions', [session('s1')])
    await a.flush()

    // Poison: corrupt every persisted row's JSON payload.
    const tables = (
      h.db.prepare("select name from sqlite_master where type='table'").all() as Array<{
        name: string
      }>
    ).filter((t) => /^c_[a-z2-7]/.test(t.name))
    for (const t of tables) {
      h.db.exec(`update ${t.name} set value = 'NOT JSON'`)
    }

    const b = h.make()
    const snap = await b.hydrate()
    expect(snap.sessions).toEqual([])
    expect(snap.cursor).toBeNull()
    expect(b.rows('sessions')).toEqual([])
  })
})
