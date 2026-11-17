/**
 * The one place `SessionStore` acquires its SQLite connection, and the single seam
 * the test fixture replaces [POD-523].
 *
 * WHY A SEAM AT ALL. Opening a store with `SessionStore.open(':memory:')` spends ~408 ms of its ~469 ms
 * replaying all 54 migrations to arrive at a schema that is the same every time; the
 * POD-515 cold profile counted 2,341 of those in one server run. The fixture in
 * `test-support/pre-migrated-store.ts` hands back a database that is already at the
 * head of the chain, so the migrator finds nothing pending and returns immediately.
 *
 * WHY IT IS A HOOK RATHER THAN A CONSTRUCTOR ARGUMENT. There are 389 `new
 * SessionStore(...)` sites across 95 test files. Threading an option through all of
 * them would be the change, not a detail of it — and every future site would have to
 * remember. An ambient opener makes the fast path the default for ordinary tests and
 * leaves the constructor's own signature untouched.
 *
 * WHY IT CANNOT LEAK INTO PRODUCTION. `installStoreDatabaseOpener` refuses outside a
 * test runner, so the shipped binary has no reachable code path that installs one and
 * `openStoreDatabase` is exactly `openDatabase` there. The refusal is a real guard,
 * not a comment: a store that silently skipped its migrations in production would
 * serve an arbitrarily old schema.
 *
 * THE ENGINE IS CHOSEN HERE, FROM THE LOCATION, ONCE [POD-6979, POD-6958 design 2.1].
 * A `postgres://` (or `postgresql://`) URL is a Postgres store; anything else is a
 * SQLite file path, `:memory:` included. {@link storeEngineFor} is the one test;
 * nothing below the store asks again. A Postgres location never reaches the SQLite
 * opener: {@link openStoreDatabase} refuses it rather than create a file named after
 * the URL, and {@link openPgStoreDriver} opens its pool.
 */

import { refuseLiveStateDir } from '@podium/runtime/live-state-guard'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import type { StoreDialect } from './store/executor/binding'
import type { PgDriverOptions, PgStoreDriver } from './store/executor/pg-driver'

const POSTGRES_LOCATION = /^postgres(?:ql)?:\/\//i

/** The engine a store at `location` opens on: Postgres for a URL, SQLite for a path. */
export function storeEngineFor(location: string): StoreDialect {
  return POSTGRES_LOCATION.test(location) ? 'pg' : 'sqlite'
}

/** A Postgres location was handed to the SQLite opener. */
export class PostgresLocationError extends Error {
  constructor() {
    super(
      'openStoreDatabase opens SQLite files; this store location is a Postgres URL. ' +
        'Open it with openPgStoreDriver (the server boots on Postgres from POD-6994).',
    )
    this.name = 'PostgresLocationError'
  }
}

/**
 * A Postgres store was asked to boot. The engine is chosen, the driver exists and so
 * does the migration chain (`migrations/pg/index.ts`, POD-6981), but a Postgres store
 * has no store-lifecycle port for its boot steps (POD-6994) yet, so the open refuses
 * before it touches anything: no pool, no directory named after the URL.
 *
 * On the `server-store-pg` lane this is what a store test file that has not been
 * converted hits through `openTestStore()`, so the message names the list it belongs on.
 */
export class PostgresStoreBootError extends Error {
  constructor() {
    super(
      'this store location is a Postgres URL, and a Postgres store cannot boot yet: it needs ' +
        'the store-lifecycle port (POD-6994). Open the driver alone with openPgStoreDriver. ' +
        'On the server-store-pg lane, a test file that opens a store belongs on "pending" in ' +
        'apps/server/test-store-engines.json until then.',
    )
    this.name = 'PostgresStoreBootError'
  }
}

/**
 * Open the driver of a Postgres store at `url`. The pool opens connections lazily, so
 * this does not touch the network; the first lease does. The driver module (and
 * postgres.js with it) loads here, so a SQLite store never loads it.
 */
export async function openPgStoreDriver(
  url: string,
  options: Omit<PgDriverOptions, 'url'> = {},
): Promise<PgStoreDriver> {
  if (storeEngineFor(url) !== 'pg') throw new Error('openPgStoreDriver needs a postgres:// URL')
  const { createPgStoreDriver } = await import('./store/executor/pg-driver')
  return createPgStoreDriver({ ...options, url })
}

/** Opens the database backing a `SessionStore` at `path` (`:memory:` included). */
export type StoreDatabaseOpener = (path: string) => SqlDatabase | Promise<SqlDatabase>

let installed: StoreDatabaseOpener | undefined

/** Open the store's database — the installed test opener, or the real driver. */
export async function openStoreDatabase(path: string): Promise<SqlDatabase> {
  // The URL names no file; it must never reach the live-state guard's path checks or
  // bun:sqlite, which would create a database file named after it.
  if (storeEngineFor(path) === 'pg') throw new PostgresLocationError()
  // Belt to instanceStateDir's braces, and the one that actually matters: THIS is the
  // routine that migrates. SessionStore.open -> openStoreDatabase -> the migration
  // chain, which backs the file up and then applies every pending migration. A caller
  // that arrived at a live path by a route the resolver never saw — a hard-coded join,
  // a path read from a fixture, an argv value, a defaulted parameter — still stops
  // here, because this signature has no `env` to weaken and reads the process's own.
  // Inert in production: neither marker is set there. [live-state-guard]
  if (path !== ':memory:') refuseLiveStateDir(path, 'openStoreDatabase')
  return installed === undefined ? openDatabase(path) : installed(path)
}

/**
 * Route `SessionStore`'s database open through `open` for this process. Refuses
 * outside a test runner — see this module's header.
 */
export function installStoreDatabaseOpener(open: StoreDatabaseOpener): void {
  if (!inTestRunner()) {
    throw new Error(
      'installStoreDatabaseOpener is a test-only seam: a production store must build its ' +
        'schema through the real migration chain',
    )
  }
  installed = open
}

/** Restore the real driver — the escape hatch for a suite that needs the full chain. */
export function resetStoreDatabaseOpener(): void {
  installed = undefined
}

/** True while a test opener is installed. */
export function storeDatabaseOpenerInstalled(): boolean {
  return installed !== undefined
}

function inTestRunner(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === 'test'
}
