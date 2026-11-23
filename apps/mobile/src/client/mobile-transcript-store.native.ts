import type { TranscriptDatabases } from '@podium/client-core/replica-assembly'
import { openSqliteTranscriptBackend } from '@podium/client-core/transcript-store'
import { fromExpoSqlite } from '@podium/sync/adapters/mobile-sqlite'
import * as SQLite from 'expo-sqlite'

/** One SQLite file per user for chat history (POD-5801) — never the entity store's file. */
export function transcriptDatabaseFile(principal: string): string {
  return `podium-transcripts-${encodeURIComponent(principal)}.db`
}

export const mobileTranscriptDatabases: TranscriptDatabases = {
  open: async (principal) => {
    const name = transcriptDatabaseFile(principal)
    return openSqliteTranscriptBackend({
      open: () => fromExpoSqlite(SQLite.openDatabaseSync(name)),
      deleteDatabase: () => SQLite.deleteDatabaseSync(name),
    })
  },
  erase: async (principal) => {
    try {
      SQLite.deleteDatabaseSync(transcriptDatabaseFile(principal))
    } catch (error) {
      // A user who never opened a chat has no file to delete.
      if (!/not found|does not exist|no such file/i.test(String(error))) throw error
    }
  },
}
