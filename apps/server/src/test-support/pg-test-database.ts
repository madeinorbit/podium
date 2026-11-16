/**
 * Postgres databases for store tests [POD-6980, POD-6958 design 2.10].
 *
 * THE SHAPE. One Postgres server per test host (the `podium-test-pg` container, or
 * CI's service container), started by the `server-store-pg` lane's globalSetup
 * (`pg-test-host.ts`). That setup builds one TEMPLATE database per schema digest,
 * the Postgres counterpart of the SQLite schema image, and hands the forks the
 * server's address, the template's name and a run id through the environment.
 * This module is the fork side: every database a test touches is a
 * `CREATE DATABASE … TEMPLATE … STRATEGY FILE_COPY` clone of that template.
 *
 * - {@link pgWorkerDatabase}: the worker's own database, made on first use and
 *   dropped when the worker's test file ends (`pg-test-worker-setup.ts`).
 * - {@link clonePgTestDatabase}: one more fresh clone. `openTestStore` takes one per
 *   store, so two stores in one test never share rows, exactly as two
 *   `':memory:'` SQLite stores do not.
 *
 * Every name is `t_<run>_<pool>_<pid>_<n>`: unique per run, per vitest pool slot,
 * per process and per clone, and old enough runs are swept by the next lane.
 *
 * THIS MODULE IS ON THE PER-FORK PATH of every `apps/server` test file (through
 * `pre-migrated-store.ts` and `open-test-store.ts`), so it imports nothing heavy and
 * connects to nothing until a Postgres-leg test asks for a database.
 *
 * THE CLIENT. Bun's built-in Postgres client (`Bun.SQL`), so the harness adds no
 * dependency. It is reached through `globalThis` with a narrow structural type, the
 * way `gateway/ws-server.ts` reaches `Bun.serve`, because this package compiles
 * against Node's types only. The store's own driver (POD-6979) brings postgres.js.
 */

/** Selects the store engine for a test run: `sqlite` (default) or `pg`. */
export const TEST_STORE_ENGINE_ENV = 'PODIUM_TEST_STORE_ENGINE'
/**
 * The Postgres server to test against, as a URL naming its maintenance database.
 * CI sets it to its service container; locally the lane's globalSetup sets it to
 * the `podium-test-pg` container.
 */
export const PG_TEST_URL_ENV = 'PODIUM_TEST_PG_URL'
/** The template database this run clones, set by the lane's globalSetup. */
export const PG_TEST_TEMPLATE_ENV = 'PODIUM_TEST_PG_TEMPLATE'
/** This run's id, the prefix of every database the run makes. */
export const PG_TEST_RUN_ENV = 'PODIUM_TEST_PG_RUN'

export type TestStoreEngine = 'sqlite' | 'pg'

/** The engine this test run's stores use. */
export function testStoreEngine(
  env: Record<string, string | undefined> = process.env,
): TestStoreEngine {
  const value = env[TEST_STORE_ENGINE_ENV]?.trim()
  if (!value || value === 'sqlite') return 'sqlite'
  if (value === 'pg') return 'pg'
  throw new Error(`${TEST_STORE_ENGINE_ENV} must be "sqlite" or "pg", got "${value}"`)
}

/** One database on the test server. */
export interface PgTestDatabase {
  readonly name: string
  /** A URL a client opens this database with. */
  readonly url: string
}

/** The part of `Bun.SQL` the harness uses. */
export interface PgTestClient {
  unsafe<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>
  close(options?: { timeout?: number }): Promise<void>
}

type PgClientConstructor = new (
  url: string,
  options?: { max?: number; idleTimeout?: number },
) => PgTestClient

/**
 * Open a client on `url`. `max` bounds its connections. Rows come back as a plain
 * array: Bun's result is an array subclass carrying `count` and `command`, which
 * `toEqual` would compare too.
 */
export function connectPgTest(url: string, max = 1): PgTestClient {
  const runtime = globalThis as typeof globalThis & { Bun?: { SQL?: PgClientConstructor } }
  const SQL = runtime.Bun?.SQL
  if (SQL === undefined) throw new Error('the Postgres test harness needs Bun (Bun.SQL)')
  const client = new SQL(url, { max, idleTimeout: 30 })
  return {
    unsafe: async <Row>(query: string, params?: unknown[]) => [
      ...(await client.unsafe<Row>(query, params)),
    ],
    close: (options) => client.close(options),
  }
}

/** `url` with its database replaced by `database`. */
export function pgUrlForDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

/** A double-quoted identifier. Harness names are generated, so this is a guard, not an escape. */
export function quotePgIdentifier(name: string): string {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`not a harness database name: ${name}`)
  return `"${name}"`
}

/** What the forks were handed by the lane, or a refusal naming the lane. */
export function pgTestEnvironment(env: Record<string, string | undefined> = process.env): {
  readonly url: string
  readonly template: string
  readonly run: string
} {
  const url = env[PG_TEST_URL_ENV]
  const template = env[PG_TEST_TEMPLATE_ENV]
  const run = env[PG_TEST_RUN_ENV]
  if (!url || !template || !run) {
    throw new Error(
      `Postgres test database requested, but ${PG_TEST_URL_ENV}, ${PG_TEST_TEMPLATE_ENV} and ` +
        `${PG_TEST_RUN_ENV} are not all set. Run the file through the Postgres lane: ` +
        '`bun run test:lane -- server-store-pg -- <file>`.',
    )
  }
  return { url, template, run }
}

/** The prefix every database of run `run` starts with. */
export function pgRunPrefix(run: string): string {
  return `t_${run}_`
}

// ---------------------------------------------------------------------------
// Per-process state. A vitest fork runs one test file at a time; the worker
// setup file drops everything made here when that file ends.
// ---------------------------------------------------------------------------

let admin: PgTestClient | undefined
let workerDatabase: Promise<PgTestDatabase> | undefined
let created: string[] = []
let sequence = 0

function adminClient(url: string): PgTestClient {
  // Two connections, so a test that clones while another clone is in flight
  // does not queue behind it.
  admin ??= connectPgTest(url, 2)
  return admin
}

function nextDatabaseName(run: string): string {
  const pool = (process.env.VITEST_POOL_ID ?? '0').replace(/[^0-9]/g, '') || '0'
  sequence += 1
  return `${pgRunPrefix(run)}${pool}_${process.pid}_${sequence}`
}

/**
 * A fresh database cloned from this run's template.
 *
 * FILE_COPY copies the template's files instead of writing every page through
 * the WAL. On a tmpfs-backed test server that is the cheaper strategy for a small
 * template (measured in docs/agents/testing.md, "Postgres store lane").
 */
export async function clonePgTestDatabase(): Promise<PgTestDatabase> {
  const environment = pgTestEnvironment()
  const name = nextDatabaseName(environment.run)
  await adminClient(environment.url).unsafe(
    `CREATE DATABASE ${quotePgIdentifier(name)} TEMPLATE ${quotePgIdentifier(environment.template)} STRATEGY FILE_COPY`,
  )
  created.push(name)
  return { name, url: pgUrlForDatabase(environment.url, name) }
}

/** This worker's own database, made on first use. */
export function pgWorkerDatabase(): Promise<PgTestDatabase> {
  workerDatabase ??= clonePgTestDatabase()
  return workerDatabase
}

/** The databases this process has made and not yet dropped. */
export function pgTestDatabasesCreated(): readonly string[] {
  return [...created]
}

/**
 * Drop every database this process made, then close the admin client.
 *
 * `WITH (FORCE)` ends connections a test left open (a store it never closed), so
 * a leaked pool cannot keep a database alive. Called when a test file ends; the
 * lane's teardown sweeps whatever a killed worker left behind.
 */
export async function dropPgTestDatabases(): Promise<void> {
  const names = created
  created = []
  workerDatabase = undefined
  const client = admin
  admin = undefined
  if (client === undefined) return
  try {
    for (const name of names) {
      await client.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdentifier(name)} WITH (FORCE)`)
    }
  } finally {
    await client.close({ timeout: 5 })
  }
}
