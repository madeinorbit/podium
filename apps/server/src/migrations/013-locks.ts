/**
 * Migration 011 — advisory named lease locks [spec:SP-85d1].
 *
 * `locks` holds the current lease per (repo_id, name); `lock_waiters` is the
 * FIFO wait queue (rowid ordering — INTEGER PRIMARY KEY is the rowid, so
 * insertion order IS queue order). Locks are purely advisory coordination
 * tokens for agents (`podium lock` / `podium merge-lock`); no code path
 * refuses a git merge because of one.
 *
 * holder_session_id is NULL for a direct-HTTP operator holder (no session to
 * bind the lease to); lock_waiters.session_id uses the 'operator' sentinel
 * instead so the (repo_id, name, session_id) dedup UNIQUE stays total.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locks (
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      holder_session_id TEXT,
      holder_issue_id TEXT,
      holder_label TEXT NOT NULL,
      note TEXT,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (repo_id, name)
    );
    CREATE TABLE IF NOT EXISTS lock_waiters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      issue_id TEXT,
      label TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      UNIQUE (repo_id, name, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_locks_holder_session ON locks(holder_session_id);
    CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_lock_waiters_lock ON lock_waiters(repo_id, name, id);
    CREATE INDEX IF NOT EXISTS idx_lock_waiters_session ON lock_waiters(session_id);
  `)
}
