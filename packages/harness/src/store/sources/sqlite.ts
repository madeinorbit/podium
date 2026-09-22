import type { TranscriptItem } from '@podium/model'
import {
  loadOpencodeTranscriptTail,
  openOpencodeDb,
} from '../../opencode/db.js'
import {
  opencodeFileId,
  opencodePartToItems,
  type OpencodeMessagePartRow,
} from '../../adapters/opencode/transcript.js'
import type { SqliteTranscriptLocator } from '../../transcript-types.js'
import { encodeCursor } from '../cursor-codec.js'
import { sliceItemsByAnchor, type TranscriptSource } from '../source.js'

/**
 * THE SQLITE TRANSCRIPT SOURCE (this issue, spec §4.5): the host-only source
 * the Store builds for sqlite-backed grammars. HOST-ONLY: `bun:sqlite` (via
 * `@podium/runtime/sqlite`) may be imported only here — never from the
 * Store's contract entries or its open barrel — so the lake serves opencode
 * transcripts live off the machine's database until the database itself is
 * mirrored (open point), never from a lake copy.
 *
 * KNOWLEDGE vs MECHANISM, split exactly once: the adapter owns what an
 * opencode row MEANS (`opencodePartToItems`: row → unstamped items) and the
 * cursor namespace (`opencodeFileId`: `opencode:<session>`); this module owns
 * HOW it is read (open the DB, cap the tail, slice by anchor) and HOW
 * identity is stamped (the cursor codec). The Store stamps sqlite identity
 * in exactly this one place — the live observer and the driver map call the
 * same `stampOpencodeItems`, so live deltas and on-demand reads interoperate.
 */

/**
 * Map opencode part rows to cursor-stamped items, stamping each item with a
 * cursor that encodes the part's position in the session's total
 * `(time_created, id, sub)` order. One part → 0..N items (a tool part is a call +
 * a result), so each item gets its own `sub` index within the part.
 *
 *   - `offset` = `row.timeCreated` (the DB's primary order key)
 *   - `uuid`   = `row.partId`      (disambiguates same-`time_created` ties; the
 *                                   secondary `id` order key)
 *   - `sub`    = item index within the part
 *
 * The triple is the part-position analog of the file `(offset, uuid, sub)` and
 * yields a total order matching the DB's `(time_created, id, sub)`. The cursor
 * namespace (`fileId`) is derived from `sessionId` here so callers pass only
 * `(rows, sessionId)` — they never construct the fileId themselves.
 */
export function stampOpencodeItems(
  rows: OpencodeMessagePartRow[],
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionId: string,
): TranscriptItem[] {
  const fileId = opencodeFileId(sessionId)
  const out: TranscriptItem[] = []
  for (const row of rows) {
    const items = opencodePartToItems(row)
    for (let sub = 0; sub < items.length; sub++) {
      const item = items[sub]
      if (!item) continue
      out.push({
        ...item,
        ...(item.event === 'interrupt'
          ? {}
          : { cursor: encodeCursor({ fileId, offset: row.timeCreated, uuid: row.partId, sub }) }),
      })
    }
  }
  return out
}

/**
 * Source for opencode. opencode stores transcript "parts" in SQLite ordered by
 * `(time_updated ASC, id ASC)`. A single session's parts are bounded (≤8000, the
 * `loadOpencodeTranscriptTail` cap), so loading them in one indexed query is
 * cheap and IS the bounded read — there is no per-call full-DB scan beyond this
 * one session's capped part list. We then build the full ordered item list and
 * index-slice it in memory, exactly matching `readTranscriptSlice`'s semantics.
 */
/** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
export function opencodeDbSource(input: {
  sessionId: string
  homeDir?: string
  databasePath?: string
}): TranscriptSource {
  return {
    readSlice: async (opts) => {
      if (opts.limit <= 0) return { items: [], hasMore: false }
      const db = openOpencodeDb(input.homeDir, input.databasePath)
      if (!db) return { items: [], hasMore: false }
      let rows: OpencodeMessagePartRow[]
      try {
        rows = loadOpencodeTranscriptTail(db, input.sessionId)
      } catch {
        return { items: [], hasMore: false }
      } finally {
        db.close()
      }
      // ASC by (time_updated, id); each part expands to 0..N stamped items in
      // intra-part order, so `all` is the session's full transcript in total order.
      const all = stampOpencodeItems(rows, input.sessionId)
      return sliceItemsByAnchor(all, opts)
    },
  }
}

/**
 * Build the sqlite source from the adapter's locator: the ONLY entry
 * `transcriptSourceFromGrammar` uses. The locator carries the adapter's
 * db-path rule already resolved (`databasePath`) plus the native session key;
 * everything else — opening, tailing, stamping, slicing — is the Store's.
 */
export function sqliteTranscriptSource(locator: SqliteTranscriptLocator): TranscriptSource {
  return opencodeDbSource({
    sessionId: locator.sessionKey,
    ...(locator.homeDir !== undefined ? { homeDir: locator.homeDir } : {}),
    ...(locator.databasePath ? { databasePath: locator.databasePath } : {}),
  })
}
