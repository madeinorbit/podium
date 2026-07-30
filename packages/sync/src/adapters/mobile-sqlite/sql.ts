/**
 * THE NARROW SQLite SURFACE THIS ADAPTER NAMES — declared here, structurally,
 * rather than taken from a driver package.
 *
 * POD-374 declined to widen `packages/sync`'s tsconfig `lib` to admit its adapter,
 * because that would have handed DOM types to every kernel module in the package
 * in order to name four interfaces in one directory. The same reasoning applies
 * here for a different reason: there is no ONE driver type to import. The engine is
 * `expo-sqlite` on device, `bun:sqlite` under the repo's Bun test lane and
 * `node:sqlite` under its Node lane — three packages, one shape. Naming any of them
 * in a type position would either add a dependency the mobile bundle must not carry
 * or pin the adapter to a runtime it does not run on.
 *
 * So the surface is declared structurally, and it is deliberately the SMALLEST one
 * that compiles:
 *
 *   - `bun:sqlite`'s `Database` satisfies it directly (prepare/run/get/all, exec, close).
 *   - `node:sqlite`'s `DatabaseSync` satisfies it directly.
 *   - `expo-sqlite`'s `SQLiteDatabase` does NOT — its sync API is named differently
 *     — so {@link fromExpoSqlite} adapts it, in the one file that is allowed to know
 *     expo exists. `sqlite-shim.test.ts` runs that mapping over a REAL engine
 *     wearing expo's method names, so the shim is evidence rather than a shape.
 *
 * EVERYTHING HERE IS SYNCHRONOUS, and that is the decisive difference from the web
 * adapter. `ReplicaCacheStore`'s reads return values and `applyAtomic` returns
 * `void`; `SyncSpanParticipant.publish` "MUST NOT await". IndexedDB forced POD-374
 * to publish its mirror BEFORE durability for those `void` methods, because an
 * IndexedDB transaction auto-closes on an unrelated await. SQLite's sync API has no
 * such hazard: `BEGIN IMMEDIATE … COMMIT` runs to completion inside one call, so
 * every publish in this adapter is strictly AFTER the commit — including the ones
 * POD-374 could not make wait. Choosing a driver's synchronous API is therefore a
 * D4.1/D10 requirement here, not a convenience, and an async-only driver would
 * reintroduce exactly the compromise this adapter avoids.
 */

/** What a bound parameter may be once a row has been serialized for storage. */
export type SqlValue = string | number | null

export interface SqlStatementLike {
  run(...params: SqlValue[]): unknown
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

export interface SqlDatabaseLike {
  prepare(sql: string): SqlStatementLike
  /** Statements with no parameters and no rows — DDL, and the transaction verbs. */
  exec(sql: string): void
  close(): void
}

/**
 * The `expo-sqlite` synchronous surface, as this adapter needs it.
 *
 * Declared structurally for the same reason as the rest of this file: naming the
 * package would put a React Native dependency in `packages/sync`, which is tagged
 * node-only and imported by the server. A caller in `apps/mobile` passes its real
 * `SQLiteDatabase` and TypeScript checks the shape at that call site.
 */
export interface ExpoSqliteExecuteResultLike {
  getAllSync(): unknown[]
  getFirstSync(): unknown
}

export interface ExpoSqliteStatementLike {
  executeSync(params?: SqlValue[]): ExpoSqliteExecuteResultLike
  finalizeSync(): void
}

export interface ExpoSqliteDatabaseLike {
  prepareSync(source: string): ExpoSqliteStatementLike
  execSync(source: string): void
  closeSync(): void
}

/**
 * Adapt an `expo-sqlite` database to {@link SqlDatabaseLike}.
 *
 * THE CONCRETE PACKAGE ADR 6 D1 LEFT TO THIS ISSUE IS `expo-sqlite`, and the reason
 * is that D1's requirement is not "SQLite" but "SQLite reached through a
 * SYNCHRONOUS API": see this file's header, and D4.7 ("SQLite transactions commit
 * before the adapter resolves the kernel write"). `expo-sqlite` ships that sync API
 * in the managed Expo workflow `apps/mobile` already uses (`expo ~57`), which no
 * other RN SQLite binding does without ejecting.
 *
 * Statements are prepared per call and finalized in a `finally`, because expo's
 * prepared statements hold a native handle that leaks if an execute throws — which
 * is precisely what happens on the quota and crash paths this adapter is built
 * around.
 */
export function fromExpoSqlite(db: ExpoSqliteDatabaseLike): SqlDatabaseLike {
  const withStatement = <T>(sql: string, use: (result: ExpoSqliteExecuteResultLike) => T) => {
    return (...params: SqlValue[]): T => {
      const statement = db.prepareSync(sql)
      try {
        return use(statement.executeSync(params))
      } finally {
        statement.finalizeSync()
      }
    }
  }
  return {
    prepare: (sql) => ({
      run: withStatement(sql, (result) => {
        // Drained deliberately: expo's execute is lazy, and a `run` that never
        // reads the result never applies the statement.
        result.getAllSync()
        return undefined
      }),
      get: withStatement(sql, (result) => result.getFirstSync() ?? undefined),
      all: withStatement(sql, (result) => result.getAllSync()),
    }),
    exec: (sql) => {
      db.execSync(sql)
    },
    close: () => {
      db.closeSync()
    },
  }
}

/**
 * ADR 6 D4.4 — is this the device saying "no space", or something else?
 *
 * The branch matters more than it looks: a quota error flips the store into
 * `degraded-memory` for the remainder of the session, and a CRASH that was
 * misclassified as quota would silently stop persisting after any transient
 * failure. `crash.test.ts` asserts the counterfactual — a power-loss error leaves
 * the mode `durable`.
 *
 * SQLite reports disk exhaustion as `SQLITE_FULL`, and a full filesystem underneath
 * it as `SQLITE_IOERR` with a disk-full errno; drivers surface these on `code` (both
 * `bun:sqlite` and `node:sqlite`) and repeat them in the message. Both are checked,
 * because a driver that only sets the message would otherwise degrade nothing.
 */
export function isQuotaError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === 'SQLITE_FULL' || code === 'SQLITE_IOERR_WRITE') return true
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return /SQLITE_FULL|database or disk is full|disk I\/O error/i.test(message)
}
