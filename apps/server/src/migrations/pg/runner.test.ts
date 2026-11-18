/**
 * THE POSTGRES MIGRATION RUNNER [POD-6981, POD-6958 design 2.7].
 *
 * The planner's rules run on every leg, without a database. The runner itself runs on
 * the `server-store-pg` lane, each case on an EMPTY database of its own
 * (`emptyPgTestDatabase`, not the run's template, which is already migrated): the real
 * chain on a fresh database, a re-run, the downgrade guard, two migrators at once, the
 * boot check, and the out-of-order and atomicity rules over small synthetic chains.
 */

import postgres from 'postgres'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyPgTestDatabase, testStoreEngine } from '../../test-support/pg-test-database'
import type { DrizzleMigration } from '../index'
import {
  checkPgLedger,
  isRewrite,
  migratePg,
  migrationStatements,
  PG_MIGRATIONS,
  PgMigrationRefusal,
  pgMigrateCommand,
  planPgMigrations,
  preparePgStoreSchema,
  REWRITE_MARK,
} from './index'

const migration = (name: string, sql: string): DrizzleMigration => ({ name, sql })
const A = migration('20270101000000_a', 'CREATE TABLE a (id bigint PRIMARY KEY);')
const B = migration('20270102000000_b', 'CREATE TABLE b (id bigint PRIMARY KEY);')
const C = migration('20270103000000_c', 'CREATE TABLE c (id bigint PRIMARY KEY);')

describe('the plan', () => {
  it('applies what the ledger lacks, in name order', () => {
    const plan = planPgMigrations(['20270101000000_a'], [C, A, B])
    expect(plan.pending.map((m) => m.name)).toEqual([B.name, C.name])
    expect(plan.unknown).toEqual([])
    expect(plan.outOfOrder).toEqual([])
  })

  it('names an applied migration the build does not define', () => {
    expect(planPgMigrations([A.name, 'from_a_newer_build'], [A]).unknown).toEqual([
      'from_a_newer_build',
    ])
  })

  it('names a late migration, and a late rewrite separately', () => {
    const lateRewrite = migration(B.name, `${REWRITE_MARK}\nCREATE TABLE b2 AS SELECT * FROM a;`)
    expect(planPgMigrations([A.name, C.name], [A, B, C])).toMatchObject({
      outOfOrder: [B.name],
      outOfOrderRewrites: [],
    })
    expect(planPgMigrations([A.name, C.name], [A, lateRewrite, C])).toMatchObject({
      outOfOrder: [B.name],
      outOfOrderRewrites: [B.name],
    })
  })

  it('reads the rewrite mark only as a line of its own', () => {
    expect(isRewrite(migration('x', `${REWRITE_MARK}\nSELECT 1;`))).toBe(true)
    expect(isRewrite(migration('x', `SELECT '${REWRITE_MARK}';`))).toBe(false)
  })

  it('splits statements at the breakpoints and skips comment-only chunks', () => {
    expect(
      migrationStatements(
        'CREATE TABLE x (id int);--> statement-breakpoint\n-- nothing here\n--> statement-breakpoint\nSELECT 1;',
      ),
    ).toEqual(['CREATE TABLE x (id int);', 'SELECT 1;'])
  })

  it('carries the baseline first, named after the SQLite migration it covers', () => {
    expect(PG_MIGRATIONS[0]?.name).toMatch(/^\d{14}_baseline$/)
  })
})

describe.skipIf(testStoreEngine() !== 'pg')('the runner on Postgres', () => {
  const open: postgres.Sql[] = []

  async function fresh(): Promise<{ url: string; sql: postgres.Sql }> {
    const { url } = await emptyPgTestDatabase('test')
    const sql = connect(url)
    return { url, sql }
  }

  function connect(url: string): postgres.Sql {
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    open.push(sql)
    return sql
  }

  async function ledger(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql.unsafe<{ name: string }[]>(
      'SELECT name FROM drizzle.__drizzle_migrations ORDER BY id',
    )
    return rows.map((row) => row.name)
  }

  async function tables(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql.unsafe<{ name: string }[]>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    )
    return rows.map((row) => row.name)
  }

  afterEach(async () => {
    for (const sql of open.splice(0)) await sql.end({ timeout: 5 })
  })

  it('migrates a fresh database to the whole schema, and a second run is a no-op', async () => {
    const { sql } = await fresh()
    expect(await migratePg(sql)).toEqual(PG_MIGRATIONS.map((m) => m.name))
    expect(await ledger(sql)).toEqual(PG_MIGRATIONS.map((m) => m.name))
    const built = await tables(sql)
    expect(built).toEqual(
      expect.arrayContaining(['issues', 'sessions', 'sync_feed', 'sync_capture']),
    )
    // The fail-closed capture guard's foreign key is deferred, as on SQLite (design 2.5).
    const [guard] = await sql.unsafe<{ deferrable: boolean; deferred: boolean }[]>(
      `SELECT condeferrable AS deferrable, condeferred AS deferred FROM pg_constraint
        WHERE conname = 'fk_sync_capture_undrained_sync_capture_guard_id_fk'`,
    )
    expect(guard).toEqual({ deferrable: true, deferred: true })
    // A run that applied something analyses the database afterwards (design 2.8): a table
    // never analysed or vacuumed has reltuples -1; an analysed empty one has 0.
    const [analysed] = await sql.unsafe<{ reltuples: number }[]>(
      "SELECT reltuples::float8 AS reltuples FROM pg_class WHERE relname = 'issues' AND relkind = 'r'",
    )
    expect(Number(analysed?.reltuples)).toBe(0)

    expect(await migratePg(sql)).toEqual([])
    expect(await ledger(sql)).toEqual(PG_MIGRATIONS.map((m) => m.name))
    expect(await tables(sql)).toEqual(built)
  })

  it('refuses a database that has applied a migration this build does not define', async () => {
    const { sql } = await fresh()
    await migratePg(sql, [A])
    await sql.unsafe(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ('', 0, '20270201000000_from_a_newer_build')",
    )
    const refused = migratePg(sql, [A, B])
    await expect(refused).rejects.toBeInstanceOf(PgMigrationRefusal)
    await expect(refused).rejects.toMatchObject({ reason: 'newer-than-build' })
    await expect(refused).rejects.toThrow(
      /20270201000000_from_a_newer_build.*downgrades are not supported/,
    )
    // Nothing applied: B's table is absent and the ledger is as it was.
    expect(await tables(sql)).toEqual(['a'])
    expect(await checkPgLedger(sql, [A, B]).catch((error) => error.reason)).toBe('newer-than-build')
  })

  it('serialises two migrators on one fresh database without an error', async () => {
    const { url } = await fresh()
    const first = connect(url)
    const second = connect(url)
    const runs = await Promise.all([migratePg(first), migratePg(second)])
    // One of them applied the chain; the other waited on the ledger lock, then found it done.
    expect(runs.map((names) => names.length).sort()).toEqual([0, PG_MIGRATIONS.length])
    expect(await ledger(first)).toEqual(PG_MIGRATIONS.map((m) => m.name))
  })

  it('serialises two migrators on a migrated database with something pending', async () => {
    const { url, sql } = await fresh()
    await migratePg(sql, [A])
    const runs = await Promise.all([
      migratePg(connect(url), [A, B, C]),
      migratePg(connect(url), [A, B, C]),
    ])
    expect(runs.map((names) => names.join(',')).sort()).toEqual(['', `${B.name},${C.name}`])
    expect(await ledger(sql)).toEqual([A.name, B.name, C.name])
  })

  it('checks the ledger at boot: refuses a database behind the build, serves a current one', async () => {
    const { url, sql } = await fresh()
    // No ledger at all: a database nobody migrated.
    await expect(checkPgLedger(sql, [A])).rejects.toMatchObject({
      reason: 'behind-build',
      migrations: [A.name],
    })
    await migratePg(sql, [A])
    await expect(checkPgLedger(sql, [A, B])).rejects.toThrow(
      /behind this build: 1 migration\(s\) not applied \(20270102000000_b\)/,
    )
    expect(await checkPgLedger(sql, [A])).toBe(1)
    // The boot entry checks by default and migrates only when asked.
    await expect(preparePgStoreSchema(url, { migrations: [A, B] })).rejects.toMatchObject({
      reason: 'behind-build',
    })
    expect(await tables(sql)).toEqual(['a'])
    expect(await preparePgStoreSchema(url, { migrations: [A, B], migrateAtBoot: true })).toEqual([
      B.name,
    ])
    expect(await preparePgStoreSchema(url, { migrations: [A, B] })).toEqual([])
  })

  it('warns and applies a late migration, refuses a late rewrite', async () => {
    const { sql } = await fresh()
    await migratePg(sql, [A, C])
    const rewrite = migration(B.name, `${REWRITE_MARK}\nCREATE TABLE b AS SELECT * FROM a;`)
    await expect(migratePg(sql, [A, rewrite, C])).rejects.toMatchObject({
      reason: 'out-of-order-rewrite',
      migrations: [B.name],
    })
    expect(await tables(sql)).toEqual(['a', 'c'])
    expect(await migratePg(sql, [A, B, C])).toEqual([B.name])
    expect(await ledger(sql)).toEqual([A.name, C.name, B.name])
  })

  it('applies a batch atomically: one failing statement leaves the database as it was', async () => {
    const { sql } = await fresh()
    await migratePg(sql, [A])
    const broken = migration(
      C.name,
      'CREATE TABLE c (id bigint PRIMARY KEY);--> statement-breakpoint\nINSERT INTO missing VALUES (1);',
    )
    await expect(migratePg(sql, [A, B, broken])).rejects.toThrow(/missing/)
    expect(await tables(sql)).toEqual(['a'])
    expect(await ledger(sql)).toEqual([A.name])
  })

  it('runs as `podium server migrate`, which never prints the URL', async () => {
    const { url } = await fresh()
    const lines: string[] = []
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) }
    expect(await pgMigrateCommand(['--database', url, '--check'], io, [A])).toBe(1)
    expect(await pgMigrateCommand([`--database=${url}`], io, [A])).toBe(0)
    expect(await pgMigrateCommand(['--database', url], io, [A])).toBe(0)
    expect(await pgMigrateCommand(['--database', url, '--check'], io, [A])).toBe(0)
    expect(lines).toEqual([
      expect.stringMatching(/^podium server migrate: the database is behind this build/),
      `applied 1 migration(s): ${A.name}`,
      'the database is current: nothing to apply.',
      'the database is current: 1 migration(s) applied.',
    ])
    expect(lines.join('\n')).not.toContain(new URL(url).password)
  })
})
