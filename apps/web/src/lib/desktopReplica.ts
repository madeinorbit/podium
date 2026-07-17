/**
 * Desktop SQLite replica factory (POD-789): when the app runs inside the Tauri
 * shell (feature-detected via the injected __PODIUM_DESKTOP__ bridge — never
 * UA sniffing), the client-core replica persists into a dedicated NATIVE
 * SQLite file through TanStack DB 0.6's Tauri adapter (@tauri-apps/plugin-sql)
 * instead of localStorage blobs.
 *
 * Everything Tauri-specific is loaded via dynamic import so plain browsers /
 * the PWA never fetch the adapter chunk, and an older shell without the SQL
 * plugin (or a window whose capability grant is missing) fails the probe and
 * falls back to the localStorage backend — the swap is strictly best-effort.
 *
 * The returned factory hands the engine an ALREADY-HYDRATED replica: SQLite
 * collections load asynchronously, and the engine reads rows / cursor /
 * outbox / ui-state synchronously at construction (see replica.ts).
 */

import { createReplica, type Replica } from '@podium/client-core/replica'
import { nativeDesktopBridge } from './nativeDesktop'

/** Resolved by Tauri's SQL plugin into the app config dir. Stable name — the
 *  per-collection schemaVersion ('reset' policy) handles shape migrations. */
const REPLICA_DB = 'sqlite:podium-replica.sqlite'

async function buildDesktopReplica(): Promise<(() => Replica) | undefined> {
  if (!nativeDesktopBridge()) return undefined
  try {
    const [{ default: Database }, { createTauriSQLitePersistence, persistedCollectionOptions }] =
      await Promise.all([
        import('@tauri-apps/plugin-sql'),
        import('@tanstack/tauri-db-sqlite-persistence'),
      ])
    // Probe + open in one step: an older shell without the SQL plugin (or a
    // missing capability grant) rejects here → localStorage fallback.
    const database = await Database.load(REPLICA_DB)
    const persistence = createTauriSQLitePersistence({
      database,
      // The replica is a cache: a schema-version bump wipes and re-bootstraps
      // instead of erroring (spec invariant 2 posture).
      schemaMismatchPolicy: 'reset',
    })
    // Poisoned-replica clear (invariant 2): the file is DEDICATED to the
    // replica, so "clear" = drop every table (sqlite_* internals excepted).
    const clearPersisted = async (): Promise<void> => {
      const tables = await database.select<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
      for (const t of tables) {
        if (t.name.startsWith('sqlite_')) continue
        await database.execute(`DROP TABLE IF EXISTS "${t.name.replaceAll('"', '""')}"`)
      }
    }
    const replica = createReplica({
      persisted: { persistence, collectionOptions: persistedCollectionOptions, clearPersisted },
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
