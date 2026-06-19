import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

// Load node:sqlite at runtime instead of via a static import: bundlers (tsup/esbuild)
// rewrite the `node:` prefix to bare `sqlite`, which isn't a valid npm package name.
// Using createRequire with a runtime string is opaque to both bundlers.
const requireBuiltin = createRequire(import.meta.url)
const { DatabaseSync } = requireBuiltin('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }

export type OpencodeSessionRow = {
  id: string
  directory: string
  title: string
  timeCreated: number
  timeUpdated: number
  timeCompacting: number | null
  messageCount: number
}

export type OpencodeMessagePartRow = {
  messageId: string
  partId: string
  sessionId: string
  timeCreated: number
  timeUpdated: number
  messageData: string
  partData: string
}

export function opencodeDataRoot(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.local', 'share', 'opencode')
}

export function opencodeDbPath(homeDir?: string): string {
  return join(opencodeDataRoot(homeDir), 'opencode.db')
}

export function openOpencodeDb(homeDir?: string): DatabaseSyncType | undefined {
  try {
    return new DatabaseSync(opencodeDbPath(homeDir), { readOnly: true })
  } catch {
    return undefined
  }
}

export function listOpencodeSessions(db: DatabaseSyncType): OpencodeSessionRow[] {
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
  db: DatabaseSyncType,
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
  db: DatabaseSyncType,
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
  db: DatabaseSyncType,
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
  db: DatabaseSyncType,
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
