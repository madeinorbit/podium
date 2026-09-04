import { fromExpoSqlite, SqliteSyncStore } from '@podium/sync/adapters/mobile-sqlite'
import * as SQLite from 'expo-sqlite'

/**
 * Open the durable entity store used by iOS and Android.
 *
 * Kept separate from the web adapter so a native bundle never carries the
 * IndexedDB implementation, while the browser never imports expo-sqlite.
 */
export function openMobileEntityStore(databaseName: string, onDegraded: (cause: string) => void) {
  return SqliteSyncStore.open({
    openDatabase: () => fromExpoSqlite(SQLite.openDatabaseSync(databaseName)),
    deleteDatabase: () => SQLite.deleteDatabaseSync(databaseName),
    onDegraded: (degradation) => onDegraded(String(degradation.cause)),
  })
}
