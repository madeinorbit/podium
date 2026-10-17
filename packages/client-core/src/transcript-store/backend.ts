/**
 * THE TRANSCRIPT DATABASE, as each platform must provide it (POD-5801).
 *
 * Chat history lives in a database of its own per signed-in user: an IndexedDB
 * database on web and desktop, an expo-sqlite file on the phone. Never an object
 * store inside the entity replica and never the entity store's file, so nothing
 * done here — trimming, sweeping, a quota failure, an erase — can reach sync
 * records, drafts, the outbox or UI state.
 *
 * The adapters are deliberately small and rule-free, the same split as
 * `SqliteSyncStore` / `IndexedDbSyncStore`: they store rows and keep each chat's
 * row count and byte total exact inside the one transaction that changes them.
 * Every LIMIT (2,000 per chat, 30 days, 10 MB) is decided in `store.ts`, once,
 * for both platforms.
 *
 * Rows are keyed by chat + message id and ordered by an index on chat + `seq`.
 * Keying by id rather than by order means two tabs writing the same message
 * update one row instead of making two, and a streaming message that is written
 * again lands on its own row.
 */

/** One stored message: the frozen TranscriptItem, serialized as written today. */
export interface StoredTranscriptMessage {
  readonly id: string
  /** Order within the chat. Assigned by the writer; gaps are normal. */
  readonly seq: number
  /** `JSON.stringify(item)`. Its length is the row's counted bytes. */
  readonly json: string
}

/** One row per chat. `count` and `bytes` are maintained by the adapter. */
export interface StoredTranscriptChat {
  readonly chat: string
  /** Epoch ms the chat was last opened. Drives the age sweep and eviction order. */
  readonly openedAt: number
  /** Epoch ms of the last write — the "as of <time>" a stored page is shown with. */
  readonly savedAt: number
  /** Highest `seq` stored, or null when the chat holds no messages. */
  readonly newestSeq: number | null
  readonly count: number
  /** Sum of the stored messages' `json` lengths. */
  readonly bytes: number
}

/** One atomic change to one chat. Applied in this order: clear, ranges, removes, upserts, trim. */
export interface TranscriptBackendChange {
  /** Delete every message of the chat first. */
  readonly clear?: boolean
  /** Delete messages with `seq < removeBelow`. */
  readonly removeBelow?: number
  /** Delete messages with `seq >= removeFrom`. */
  readonly removeFrom?: number
  /** Delete these message ids. */
  readonly remove?: readonly string[]
  readonly upsert?: readonly StoredTranscriptMessage[]
  /** After the writes, delete the oldest messages until at most this many remain. */
  readonly keepNewest?: number
  readonly openedAt?: number
  readonly savedAt?: number
}

export interface TranscriptStoreBackend {
  /** Every chat row. Small: one row per stored chat. */
  chats(): Promise<StoredTranscriptChat[]>
  /** The newest `limit` messages with `seq < before` (all seqs when undefined), oldest first. */
  messages(
    chat: string,
    before: number | undefined,
    limit: number,
  ): Promise<StoredTranscriptMessage[]>
  /** Apply one change in one transaction and return the chat row it leaves. A chat
   *  row is created on first write; a quota failure rejects and changes nothing. */
  commit(chat: string, change: TranscriptBackendChange): Promise<StoredTranscriptChat>
  /** Delete whole chats: their messages and their chat rows. */
  remove(chats: readonly string[]): Promise<void>
  /** Close and delete the whole database. */
  erase(): Promise<void>
  close(): void
}

/** True for the platform's "out of space" failures, which earn one clean-up and retry. */
export function isTranscriptQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'QuotaExceededError') return true
  const message = error instanceof Error ? error.message : String(error)
  return /quota|SQLITE_FULL|database or disk is full|disk full/i.test(message)
}
