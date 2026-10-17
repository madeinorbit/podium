import type { TranscriptDatabases } from '@podium/client-core/replica-assembly'
import {
  openIndexedDbTranscriptBackend,
  type TranscriptIdbFactory,
  type TranscriptIdbKeyRange,
} from '@podium/client-core/transcript-store'

/** One IndexedDB database per user for chat history (POD-5801) — never the entity store. */
export function transcriptDatabaseFile(principal: string): string {
  return `podium-transcripts:${encodeURIComponent(principal)}`
}

const factory = () => globalThis.indexedDB as unknown as TranscriptIdbFactory

export const mobileTranscriptDatabases: TranscriptDatabases = {
  open: (principal) =>
    openIndexedDbTranscriptBackend({
      factory: factory(),
      keyRange: (globalThis as unknown as { IDBKeyRange: TranscriptIdbKeyRange }).IDBKeyRange,
      databaseName: transcriptDatabaseFile(principal),
    }),
  erase: (principal) =>
    new Promise((resolve, reject) => {
      const request = factory().deleteDatabase(transcriptDatabaseFile(principal))
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    }),
}
