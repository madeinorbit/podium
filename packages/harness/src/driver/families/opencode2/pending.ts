import { openDatabase } from '@podium/runtime/sqlite'

/** Read only the supplied engine store. Both schemas were measured in
 * POD-4864: stable retains promoted inputs; the beta deletes delivered inbox
 * rows. An unavailable store is unknown, never evidence of an empty queue. */
export function pendingPromptIds(databasePath: string, sessionID: string): string[] | undefined {
  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(databasePath, { readOnly: true })
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_input', 'session_inbox')",
      )
      .all() as { name: string }[]
    const ids: string[] = []
    for (const { name } of tables) {
      const rows = db
        .prepare(
          name === 'session_input'
            ? 'SELECT id FROM session_input WHERE session_id = ? AND promoted_seq IS NULL'
            : "SELECT id FROM session_inbox WHERE session_id = ? AND type = 'user'",
        )
        .all(sessionID) as { id: string }[]
      ids.push(...rows.map((row) => row.id))
    }
    return tables.length ? ids : undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}
