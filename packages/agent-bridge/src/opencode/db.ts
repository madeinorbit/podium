import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/core/sqlite'
import type { OpencodeMessagePartRow } from '@podium/transcript'

// The row TYPE lives next to the pure part→items mapper in @podium/transcript;
// re-exported here for compatibility (this module is the SQLite producer of it).
export type { OpencodeMessagePartRow } from '@podium/transcript'

export type OpencodeSessionRow = {
  id: string
  directory: string
  title: string
  timeCreated: number
  timeUpdated: number
  timeCompacting: number | null
  messageCount: number
}

export function opencodeDataRoot(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.local', 'share', 'opencode')
}

export function opencodeDbPath(homeDir?: string): string {
  return join(opencodeDataRoot(homeDir), 'opencode.db')
}

export function openOpencodeDb(homeDir?: string): SqlDatabase | undefined {
  try {
    return openDatabase(opencodeDbPath(homeDir), { readOnly: true })
  } catch {
    return undefined
  }
}

/**
 * Freshest mtime (ms) across the opencode DB and its WAL sidecars, for polling
 * change-detection. opencode.db runs in WAL mode, so a write usually lands in
 * `opencode.db-wal`/`-shm` and bumps THEIR mtime while the main `.db` mtime stays
 * put until a checkpoint — gating on the main file alone would miss live writes.
 * Returns `undefined` if even the main DB can't be statted (caller must then treat
 * the change-state as unknown and do a fresh read rather than trust a cache).
 */
export function opencodeDbMtimeMs(homeDir?: string): number | undefined {
  const base = opencodeDbPath(homeDir)
  let main: number
  try {
    main = statSync(base).mtimeMs
  } catch {
    return undefined
  }
  let newest = main
  for (const suffix of ['-wal', '-shm']) {
    try {
      newest = Math.max(newest, statSync(base + suffix).mtimeMs)
    } catch {
      // sidecar absent (non-WAL or checkpointed) — ignore; the main mtime stands.
    }
  }
  return newest
}

export function listOpencodeSessions(db: SqlDatabase): OpencodeSessionRow[] {
  return db
    .prepare(
      `SELECT s.id, s.directory, s.title, s.time_created AS timeCreated,
              s.time_updated AS timeUpdated, s.time_compacting AS timeCompacting,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messageCount
       FROM session s
       WHERE s.time_archived IS NULL
       ORDER BY s.time_updated DESC`,
    )
    .all() as OpencodeSessionRow[]
}

export function getOpencodeSession(
  db: SqlDatabase,
  sessionId: string,
): OpencodeSessionRow | undefined {
  return db
    .prepare(
      `SELECT s.id, s.directory, s.title, s.time_created AS timeCreated,
              s.time_updated AS timeUpdated, s.time_compacting AS timeCompacting,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messageCount
       FROM session s
       WHERE s.id = ?
       LIMIT 1`,
    )
    .get(sessionId) as OpencodeSessionRow | undefined
}

export function findLatestOpencodeSession(
  db: SqlDatabase,
  cwd: string,
  sinceMs?: number,
): OpencodeSessionRow | undefined {
  const rows = db
    .prepare(
      `SELECT s.id, s.directory, s.title, s.time_created AS timeCreated,
              s.time_updated AS timeUpdated, s.time_compacting AS timeCompacting,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messageCount
       FROM session s
       WHERE s.directory = ?
         AND (? IS NULL OR s.time_updated >= ?)
       ORDER BY s.time_updated DESC
       LIMIT 5`,
    )
    .all(cwd, sinceMs ?? null, sinceMs ?? 0) as OpencodeSessionRow[]
  return rows[0]
}

export function loadOpencodeMessageParts(
  db: SqlDatabase,
  sessionId: string,
  sinceTimeUpdated = 0,
): OpencodeMessagePartRow[] {
  return db
    .prepare(
      `SELECT m.id AS messageId, p.id AS partId, p.session_id AS sessionId,
              p.time_created AS timeCreated, p.time_updated AS timeUpdated,
              m.data AS messageData, p.data AS partData
       FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
         AND p.time_updated > ?
       ORDER BY p.time_updated ASC, p.id ASC`,
    )
    .all(sessionId, sinceTimeUpdated) as OpencodeMessagePartRow[]
}

export function loadOpencodeTranscriptTail(
  db: SqlDatabase,
  sessionId: string,
  maxParts = 8000,
): OpencodeMessagePartRow[] {
  const rows = db
    .prepare(
      `SELECT m.id AS messageId, p.id AS partId, p.session_id AS sessionId,
              p.time_created AS timeCreated, p.time_updated AS timeUpdated,
              m.data AS messageData, p.data AS partData
       FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY p.time_updated DESC, p.id DESC
       LIMIT ?`,
    )
    .all(sessionId, maxParts) as OpencodeMessagePartRow[]
  return rows.reverse()
}
