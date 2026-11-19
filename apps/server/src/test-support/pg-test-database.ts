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
 *   `':memory:'` SQLite stores do not. A clone made inside a test is dropped when
 *   that test ends; one made in `beforeAll` or at module scope when the file ends.
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
  // Through `unknown`: a package that also loads Bun's own types would otherwise
  // intersect them with this narrow shape and pick Bun's signatures.
  const runtime = globalThis as unknown as { Bun?: { SQL?: PgClientConstructor } }
  const SQL = runtime.Bun?.SQL
  if (SQL === undefined) throw new Error('the Postgres test harness needs Bun (Bun.SQL)')
  const client = new SQL(url, { max, idleTimeout: 30 })
  return {
    async unsafe<Row>(query: string, params?: unknown[]): Promise<Row[]> {
      const rows: Row[] = await client.unsafe<Row>(query, params)
      return Array.from(rows)
    },
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
// Per-process state. A vitest fork runs one test file at a time. The worker
// setup file drops a database when the test that made it ends, or when the file
// ends for one made outside any test (module scope, `beforeAll`).
// ---------------------------------------------------------------------------

/** How long a database lives: until its test ends, or until its file ends. */
export type PgTestScope = 'test' | 'file'

let admin: PgTestClient | undefined
let workerDatabase: Promise<PgTestDatabase> | undefined
let created: {
  readonly name: string
  readonly scope: PgTestScope
  readonly closers: (() => Promise<void>)[]
}[] = []
let sequence = 0
let currentScope: () => PgTestScope = () => 'file'

/**
 * Tell the harness whether a test is running. The worker setup file installs a
 * reader over vitest's state; this module imports no vitest itself, because
 * `openTestStore` also runs under `bun test`.
 */
export function setPgTestScopeReader(read: () => PgTestScope): void {
  currentScope = read
}

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
 * A fresh database cloned from this run's template. One made inside a test (or its
 * `beforeEach`) is dropped when that test ends; an empty Postgres database is about
 * 8 MB of tmpfs, and a file that opens a store per test would otherwise hold them all.
 *
 * FILE_COPY copies the template's files instead of writing every page through
 * the WAL. On a tmpfs-backed test server that is the cheaper strategy for a small
 * template (measured in docs/agents/testing.md, "Postgres store lane").
 */
export async function clonePgTestDatabase(
  scope: PgTestScope = currentScope(),
): Promise<PgTestDatabase> {
  return createPgTestDatabase(pgTestEnvironment().template, scope)
}

/**
 * A fresh EMPTY database, without the store schema the run's template holds [POD-6981]:
 * for a test that builds a schema of its own (a driver test's `sync_feed`, say) or one
 * that migrates the database itself. Dropped as {@link clonePgTestDatabase}'s are.
 */
export async function emptyPgTestDatabase(
  scope: PgTestScope = currentScope(),
): Promise<PgTestDatabase> {
  return createPgTestDatabase('template0', scope)
}

async function createPgTestDatabase(template: string, scope: PgTestScope): Promise<PgTestDatabase> {
  const environment = pgTestEnvironment()
  const name = nextDatabaseName(environment.run)
  await adminClient(environment.url).unsafe(
    `CREATE DATABASE ${quotePgIdentifier(name)} TEMPLATE ${quotePgIdentifier(template)} STRATEGY FILE_COPY`,
  )
  created.push({ name, scope, closers: [] })
  return { name, url: pgUrlForDatabase(environment.url, name) }
}

/** This worker's own database, made on first use and kept until the file ends. */
export function pgWorkerDatabase(): Promise<PgTestDatabase> {
  workerDatabase ??= clonePgTestDatabase('file')
  return workerDatabase
}

/** The databases this process has made and not yet dropped. */
export function pgTestDatabasesCreated(): readonly string[] {
  return created.map((database) => database.name)
}

/**
 * Run `close` before the database named `name` is dropped when its file ends
 * [POD-6994]: a store a test opened on it and never closed still has timers and queries
 * of its own, and a `DROP … WITH (FORCE)` under them fails those queries as errors nobody
 * awaits. A close that fails or hangs past two seconds does not stop the drop.
 */
export function closeBeforeDrop(name: string, close: () => Promise<void>): void {
  created.find((database) => database.name === name)?.closers.push(close)
}

async function runClosers(closers: readonly (() => Promise<void>)[]): Promise<void> {
  await Promise.all(
    closers.map(async (close) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        close().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000)
        }),
      ])
      clearTimeout(timer)
    }),
  )
}

async function drop(client: PgTestClient, names: readonly string[]): Promise<void> {
  // `WITH (FORCE)` ends connections a test left open (a store it never closed),
  // so a leaked pool cannot keep a database alive.
  for (const name of names) {
    await client.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdentifier(name)} WITH (FORCE)`)
  }
}

/**
 * Drop the databases made during the test that just ended, the ones nothing still uses.
 *
 * A database a store still holds (a test that left its store, and a registry's timers
 * over it, running: harmless on SQLite, where an in-memory store simply stays open)
 * is not forced away under it; it is kept until the file ends [POD-6994]. Whether
 * anything still uses one is read from `pg_stat_activity` first: a plain `DROP
 * DATABASE` on a database with connections waits five seconds before it refuses.
 */
export async function dropPgTestScopedDatabases(): Promise<void> {
  const ending = created.filter((database) => database.scope === 'test')
  if (ending.length === 0 || admin === undefined) return
  const busy = new Set(
    (
      await admin.unsafe<{ datname: string }>(
        `SELECT DISTINCT datname FROM pg_stat_activity WHERE datname IN (${ending
          .map((database) => `'${database.name.replaceAll("'", "''")}'`)
          .join(', ')})`,
      )
    ).map((row) => row.datname),
  )
  const kept: typeof created = []
  for (const database of ending) {
    if (busy.has(database.name)) {
      kept.push({ ...database, scope: 'file' })
      continue
    }
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdentifier(database.name)}`)
    } catch (error) {
      // A connection that arrived since the read: keep it to the file's end.
      const { errno, code } = error as { errno?: string; code?: string }
      if (errno !== '55006' && code !== '55006') throw error
      kept.push({ ...database, scope: 'file' })
    }
  }
  created = [...created.filter((database) => database.scope !== 'test'), ...kept]
}

/**
 * Drop every database this process made, then close the admin client. Called when
 * a test file ends; the lane's teardown sweeps whatever a killed worker left behind.
 */
export async function dropPgTestDatabases(): Promise<void> {
  const names = pgTestDatabasesCreated()
  const closers = created.flatMap((database) => database.closers)
  created = []
  workerDatabase = undefined
  const client = admin
  admin = undefined
  if (client === undefined) return
  try {
    await runClosers(closers)
    await drop(client, names)
  } finally {
    await client.close({ timeout: 5 })
  }
}
