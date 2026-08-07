/**
 * The one place `SessionStore` acquires its SQLite connection, and the single seam
 * the test fixture replaces [POD-523].
 *
 * WHY A SEAM AT ALL. A `new SessionStore(':memory:')` spends ~408 ms of its ~469 ms
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
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'

/** Opens the database backing a `SessionStore` at `path` (`:memory:` included). */
export type StoreDatabaseOpener = (path: string) => SqlDatabase

let installed: StoreDatabaseOpener | undefined

/** Open the store's database — the installed test opener, or the real driver. */
export function openStoreDatabase(path: string): SqlDatabase {
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
