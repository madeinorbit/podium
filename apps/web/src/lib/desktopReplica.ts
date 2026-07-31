/**
 * Desktop SQLite replica factory (POD-789): when the app runs inside the Tauri
 * shell (feature-detected via the injected __PODIUM_DESKTOP__ bridge — never
 * UA sniffing), the client-core replica persists into a dedicated NATIVE
 * SQLite file through TanStack DB 0.6's persistence layer
 * (@tanstack/db-sqlite-persistence-core) over @tauri-apps/plugin-sql.
 *
 * WHY OUR OWN DRIVER and not @tanstack/tauri-db-sqlite-persistence's: that
 * driver spans `BEGIN IMMEDIATE … COMMIT` across separate plugin invokes, but
 * tauri-plugin-sql (2.4) executes every invoke on a sqlx connection POOL that
 * does not pin a connection between invokes. Under real load the statements of
 * one "transaction" scatter across pool connections: COMMIT lands on a
 * connection with no open transaction ("cannot commit"), the connection that
 * DID open it keeps the write lock forever, and every later write fails with
 * "database is locked" (traced statement-by-statement against the real shell,
 * 2026-07-17 — see POD-789). So this driver keeps the serialized FIFO queue
 * but runs batches WITHOUT cross-invoke transactions: every statement
 * autocommits. That trades batch atomicity for correctness-under-pooling,
 * which is sound for the replica: it is a resync-able CACHE, and the cursor
 * is only persisted AFTER a batch's writes fully settled (the replica's
 * lastWrite fence) — a torn batch is never covered by the cursor, so the next
 * boot's changesSince refetches it idempotently. Restoring real transactions
 * needs a pool-pinning (or single-connection) upstream plugin — tracked as a
 * deferred follow-up on the issue.
 *
 * Everything Tauri-specific is loaded via dynamic import so plain browsers /
 * the PWA never fetch this chunk's dependencies, and an older shell without
 * the SQL plugin (or a missing capability grant) fails the probe and falls
 * back to the localStorage backend — the swap is strictly best-effort.
 *
 * The returned factory hands the engine an ALREADY-HYDRATED replica: SQLite
 * collections load asynchronously, and the engine reads rows / cursor /
 * outbox / ui-state synchronously at construction (see replica.ts).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROOT ATTRIBUTES ITS STORE IN PLACE (POD-1252)
 * ---------------------------------------------------------------------------
 *
 * POD-378's TanStack removal is expected to delete this file, and the tempting
 * bookkeeping was to record the finding as "closes with that deletion". It is
 * fixed here instead, for a reason that has nothing to do with tidiness: the
 * deletion is blocked behind the main catch-up, and until it lands this is a
 * SHIPPING desktop path with a dedicated SQLite file full of one person's rows on
 * a machine other people use. A finding parked against another issue's deletion is
 * a finding nobody is holding — which is exactly how this item came to be
 * unowned in the first place (POD-1239 closed with four of six left).
 *
 * TWO STORES ARE AT STAKE HERE, NOT ONE, and missing the second would be a gate
 * with half an effect. The SQLite file is the obvious one. The other is
 * `window.localStorage`: SQLite mode is the single surviving ambient reach in the
 * replica (`legacyMigrationStorage`), because the one-time localStorage→SQLite
 * migration READS the old blobs through it — "that legacy read is itself
 * unattributed, and this function is not the place to fix it: the persisted roots
 * are named composition roots … they get a caller there". This is that caller.
 */

import { createReplica, type Replica } from '@podium/client-core/replica'
import {
  decideLegacyAdoption,
  type LegacyAdoptionReason,
  type LegacyIdentityEvidence,
} from '@podium/sync/adapters/legacy-replica'
import type { SQLiteDriver } from '@tanstack/db-sqlite-persistence-core'
import type Database from '@tauri-apps/plugin-sql'
import {
  defaultWebEvidence,
  NO_IMPORT_PLAN,
  noLegacyMigrationSource,
  WEB_REPLICA_PRINCIPAL,
} from './legacyStoreAttribution'
import { nativeDesktopBridge } from './nativeDesktop'

/** Resolved by Tauri's SQL plugin into the app config dir. Stable name — the
 *  per-collection schemaVersion ('reset' policy) handles shape migrations. */
const REPLICA_DB = 'sqlite:podium-replica.sqlite'

/** Serialized no-cross-invoke-transaction driver over the plugin database —
 *  see the module header for why transactions are deliberately absent. The
 *  FIFO queue keeps statements ordered AND keeps the plugin's pool at one
 *  connection in practice (never more than one statement in flight). */
function pluginSqliteDriver(db: Database): SQLiteDriver {
  // Tauri invoke rejections are PLAIN STRINGS ("error returned from database:
  // (code: 1) duplicate column name: …"), but the persistence core's error
  // pardons check `error instanceof Error` — without normalization its
  // ensureInitialized dies on the expected duplicate-column ALTER and nothing
  // persists (verified against the real plugin, 2026-07-17).
  const asError = (e: unknown): never => {
    throw e instanceof Error ? e : new Error(String(e))
  }
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = queue.then(op, op)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  const rawExec = async (sql: string, params?: ReadonlyArray<unknown>): Promise<void> => {
    await db.execute(sql, params ? [...params] : undefined).catch(asError)
  }
  const rawQuery = async <T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> =>
    db.select<T[]>(sql, params ? [...params] : undefined).catch(asError)
  // The "transaction" driver handed to adapter callbacks: statements run
  // directly (the outer enqueue already holds the queue slot); a nested
  // transaction() is flattened for the same no-real-transaction reason.
  const txDriver: SQLiteDriver = {
    exec: (sql) => rawExec(sql),
    query: (sql, params) => rawQuery(sql, params),
    run: (sql, params) => rawExec(sql, params),
    transaction: (fn) => fn(txDriver),
  }
  return {
    exec: (sql) => enqueue(() => rawExec(sql)),
    query: (sql, params) => enqueue(() => rawQuery(sql, params)),
    run: (sql, params) => enqueue(() => rawExec(sql, params)),
    transaction: (fn) => enqueue(() => fn(txDriver)),
  }
}

/**
 * What the gate decided, and the two things the decision CHANGES about the
 * construction that follows.
 *
 * Returned rather than applied-and-forgotten so the effect is measurable: POD-1220
 * found the shape where a gate has a caller and no effect (their entities were
 * retired unconditionally either way), and a boolean nobody spends is exactly that
 * shape. `desktopReplica.attribution.test.ts` drives this function directly and
 * asserts both spends, then a mutation forcing `adopt = true` turns both red.
 */
export interface DesktopStoreAttribution {
  readonly adopt: boolean
  readonly reason: LegacyAdoptionReason
  /**
   * The store handed to `ReplicaInit.storage`, which in SQLite mode is ONLY the
   * legacy blob source the one-time migration reads. `undefined` keeps the
   * replica's surviving ambient reach for `window.localStorage` — the adopting
   * path, unchanged. A refusal substitutes an empty store, so the migration reads
   * nothing and therefore retires nothing: the blobs stay on disk for a later boot
   * that can attribute them.
   */
  readonly migrationSource: ReturnType<typeof noLegacyMigrationSource> | undefined
}

export interface AttributeDesktopStoreOptions {
  /** The SQLite wipe. On a refusal this is the discard: the file is DEDICATED to
   *  the replica, so dropping every table leaves nothing of the previous person's
   *  slice to serve. */
  readonly clearPersisted: () => Promise<void>
  /** Injected, never hardcoded — see {@link defaultWebEvidence}. */
  readonly evidence?: LegacyIdentityEvidence
  readonly now?: () => number
}

/**
 * THE ATTRIBUTION GATE FOR THE DESKTOP STORE, before a single row is read.
 *
 * Runs BEFORE `createReplica` because the SQLite collections load as the replica
 * hydrates: a wipe issued afterwards would be a wipe of rows the engine could
 * already have been handed.
 */
export async function attributeDesktopStore(
  options: AttributeDesktopStoreOptions,
): Promise<DesktopStoreAttribution> {
  // The EMPTY plan is deliberate: `decideLegacyAdoption` returns a decision and a
  // set of records, and only the decision applies at a root that migrates nothing
  // into the kernel store. Re-deriving the rule here would fork it.
  const adoption = decideLegacyAdoption(
    NO_IMPORT_PLAN,
    options.evidence ?? defaultWebEvidence(WEB_REPLICA_PRINCIPAL),
    (options.now ?? Date.now)(),
  )
  if (adoption.adopt) {
    return { adopt: true, reason: adoption.reason, migrationSource: undefined }
  }
  // FAIL CLOSED. The replica is a re-derivable cache, so discarding costs one
  // bootstrap; adopting rows that may be someone else's costs the property the
  // whole privacy model rests on (POD-307).
  await options.clearPersisted()
  console.warn(
    `[podium] desktop sqlite replica not adopted (${adoption.reason}) — cleared and re-bootstrapping`,
  )
  return { adopt: false, reason: adoption.reason, migrationSource: noLegacyMigrationSource() }
}

async function buildDesktopReplica(): Promise<(() => Replica) | undefined> {
  if (!nativeDesktopBridge()) return undefined
  try {
    const [
      { default: DatabaseCtor },
      { createSQLiteCorePersistenceAdapter, persistedCollectionOptions, SingleProcessCoordinator },
    ] = await Promise.all([
      import('@tauri-apps/plugin-sql'),
      import('@tanstack/db-sqlite-persistence-core'),
    ])
    // Probe + open in one step: an older shell without the SQL plugin (or a
    // missing capability grant) rejects here → localStorage fallback.
    //
    // Close-then-reopen: the plugin's connection pool lives in the SHELL
    // process and survives webview reloads — a reload mid-write can leave the
    // previous page generation's work in flight on the old pool. Explicitly
    // closing tears it down before this generation starts clean.
    // Best-effort: a failed close must not downgrade the session to
    // localStorage — the reopen below is what matters.
    await DatabaseCtor.load(REPLICA_DB)
      .then((stale) => stale.close())
      .catch(() => {})
    const database = await DatabaseCtor.load(REPLICA_DB)
    const driver = pluginSqliteDriver(database)
    const { REPLICA_SQLITE_SCHEMA_VERSION } = await import('@podium/client-core/replica')
    const persistence = {
      adapter: createSQLiteCorePersistenceAdapter({
        driver,
        schemaVersion: REPLICA_SQLITE_SCHEMA_VERSION,
        // The replica is a cache: a schema-version bump wipes and
        // re-bootstraps instead of erroring (spec invariant 2 posture).
        schemaMismatchPolicy: 'reset',
      }),
      coordinator: new SingleProcessCoordinator(),
    }
    // Poisoned-replica clear (invariant 2): the file is DEDICATED to the
    // replica, so "clear" = drop every table (sqlite_* internals excepted).
    const clearPersisted = async (): Promise<void> => {
      const tables = await driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
      for (const t of tables) {
        if (t.name.startsWith('sqlite_')) continue
        await driver.exec(`DROP TABLE IF EXISTS "${t.name.replaceAll('"', '""')}"`)
      }
    }
    // The gate runs here — after the database is open (a wipe needs a driver) and
    // before the construction below reads a row.
    const attribution = await attributeDesktopStore({ clearPersisted })
    const replica = createReplica({
      persisted: { persistence, collectionOptions: persistedCollectionOptions, clearPersisted },
      // Undefined on the adopting path, which leaves the legacy-blob migration's
      // ambient reach exactly as it was; an empty store on a refusal, which is
      // what stops the migration reading someone else's queued work in.
      storage: attribution.migrationSource,
    })
    await replica.hydrate()
    return () => replica
  } catch (err) {
    console.warn(
      '[podium] desktop sqlite replica unavailable — falling back to localStorage persistence',
      err,
    )
    return undefined
  }
}

let cached: Promise<(() => Replica) | undefined> | undefined

/** Memoized: StrictMode double-mount (and any re-render) must not open a
 *  second replica over the same sqlite file in one JS context. */
export function desktopReplicaFactory(): Promise<(() => Replica) | undefined> {
  cached ??= buildDesktopReplica()
  return cached
}
