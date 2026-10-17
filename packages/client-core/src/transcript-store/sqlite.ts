import type { SqlDatabaseLike, SqlValue } from '@podium/sync/adapters/mobile-sqlite'
import type {
  StoredTranscriptChat,
  StoredTranscriptMessage,
  TranscriptBackendChange,
  TranscriptStoreBackend,
} from './backend'

export interface SqliteTranscriptBackendInit {
  /** Opens THIS user's transcript file — never the entity store's file. */
  open(): SqlDatabaseLike
  /** Deletes the file after the connection is closed. */
  deleteDatabase(): void | Promise<void>
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS transcript_messages (
     chat TEXT NOT NULL, id TEXT NOT NULL, seq REAL NOT NULL, json TEXT NOT NULL, bytes INTEGER NOT NULL,
     PRIMARY KEY (chat, id)
   ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS transcript_messages_order ON transcript_messages (chat, seq)',
  `CREATE TABLE IF NOT EXISTS transcript_chats (
     chat TEXT PRIMARY KEY NOT NULL, opened_at INTEGER NOT NULL, saved_at INTEGER NOT NULL,
     newest_seq REAL, count INTEGER NOT NULL, bytes INTEGER NOT NULL
   )`,
]

interface ChatRow {
  chat: string
  opened_at: number
  saved_at: number
  newest_seq: number | null
  count: number
  bytes: number
}

const toChat = (row: ChatRow): StoredTranscriptChat => ({
  chat: row.chat,
  openedAt: row.opened_at,
  savedAt: row.saved_at,
  newestSeq: row.newest_seq,
  count: row.count,
  bytes: row.bytes,
})

/**
 * The phone's transcript file over expo-sqlite's synchronous API.
 *
 * Each commit is one `BEGIN IMMEDIATE … COMMIT`, and the chat row's count, byte
 * total and newest order are recomputed inside it from the rows themselves, so a
 * rolled-back write can never leave the totals the budget reads disagreeing with
 * what is stored. A chat holds at most 2,000 rows, so the aggregate is cheap.
 */
export function openSqliteTranscriptBackend(
  init: SqliteTranscriptBackendInit,
): TranscriptStoreBackend {
  let db: SqlDatabaseLike | undefined = init.open()
  for (const statement of SCHEMA) db.exec(statement)

  const live = (): SqlDatabaseLike => {
    if (!db) throw new Error('transcript database is closed')
    return db
  }
  const run = (sql: string, ...params: SqlValue[]) =>
    live()
      .prepare(sql)
      .run(...params)
  const all = <T>(sql: string, ...params: SqlValue[]) =>
    live()
      .prepare(sql)
      .all(...params) as T[]
  const get = <T>(sql: string, ...params: SqlValue[]) =>
    live()
      .prepare(sql)
      .get(...params) as T | undefined | null

  const transaction = <T>(body: () => T): T => {
    live().exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      live().exec('COMMIT')
      return result
    } catch (error) {
      try {
        live().exec('ROLLBACK')
      } catch {
        // The failed statement may already have ended the transaction.
      }
      throw error
    }
  }

  return {
    async chats() {
      return all<ChatRow>('SELECT * FROM transcript_chats').map(toChat)
    },
    async messages(chat, before, limit) {
      const rows =
        before === undefined
          ? all<StoredTranscriptMessage>(
              'SELECT id, seq, json FROM transcript_messages WHERE chat = ? ORDER BY seq DESC LIMIT ?',
              chat,
              limit,
            )
          : all<StoredTranscriptMessage>(
              'SELECT id, seq, json FROM transcript_messages WHERE chat = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
              chat,
              before,
              limit,
            )
      return rows.map((row) => ({ id: row.id, seq: row.seq, json: row.json })).reverse()
    },
    async commit(chat, change: TranscriptBackendChange) {
      return transaction(() => {
        if (change.clear) run('DELETE FROM transcript_messages WHERE chat = ?', chat)
        if (change.removeBelow !== undefined)
          run(
            'DELETE FROM transcript_messages WHERE chat = ? AND seq < ?',
            chat,
            change.removeBelow,
          )
        if (change.removeFrom !== undefined)
          run(
            'DELETE FROM transcript_messages WHERE chat = ? AND seq >= ?',
            chat,
            change.removeFrom,
          )
        for (const id of change.remove ?? [])
          run('DELETE FROM transcript_messages WHERE chat = ? AND id = ?', chat, id)
        for (const row of change.upsert ?? [])
          run(
            'INSERT OR REPLACE INTO transcript_messages (chat, id, seq, json, bytes) VALUES (?, ?, ?, ?, ?)',
            chat,
            row.id,
            row.seq,
            row.json,
            row.json.length,
          )
        if (change.keepNewest !== undefined) {
          const cutoff = get<{ seq: number }>(
            'SELECT seq FROM transcript_messages WHERE chat = ? ORDER BY seq DESC LIMIT 1 OFFSET ?',
            chat,
            change.keepNewest,
          )
          if (cutoff)
            run('DELETE FROM transcript_messages WHERE chat = ? AND seq <= ?', chat, cutoff.seq)
        }
        const totals = get<{ count: number; bytes: number; newest: number | null }>(
          'SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes, max(seq) AS newest FROM transcript_messages WHERE chat = ?',
          chat,
        )
        const prev = get<ChatRow>('SELECT * FROM transcript_chats WHERE chat = ?', chat)
        const next: StoredTranscriptChat = {
          chat,
          openedAt: change.openedAt ?? prev?.opened_at ?? 0,
          savedAt: change.savedAt ?? prev?.saved_at ?? 0,
          newestSeq: totals?.newest ?? null,
          count: totals?.count ?? 0,
          bytes: totals?.bytes ?? 0,
        }
        run(
          'INSERT OR REPLACE INTO transcript_chats (chat, opened_at, saved_at, newest_seq, count, bytes) VALUES (?, ?, ?, ?, ?, ?)',
          chat,
          next.openedAt,
          next.savedAt,
          next.newestSeq,
          next.count,
          next.bytes,
        )
        return next
      })
    },
    async remove(chats) {
      transaction(() => {
        for (const chat of chats) {
          run('DELETE FROM transcript_messages WHERE chat = ?', chat)
          run('DELETE FROM transcript_chats WHERE chat = ?', chat)
        }
      })
    },
    async erase() {
      db?.close()
      db = undefined
      await init.deleteDatabase()
    },
    close() {
      db?.close()
      db = undefined
    },
  }
}
