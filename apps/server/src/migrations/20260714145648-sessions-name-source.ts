/**
 * Migration 20260714145648 — sessions-name-source (#490).
 *
 * WHO named the session. `sessions.name` is the curated slot that wins in the UI,
 * and until now it had exactly one writer: the human. An agent that names its own
 * session writes the SAME slot, so the slot alone can no longer say whether a name
 * may be overwritten — this column does:
 *
 *   'user'  — a human named it (web rename, superagent rename_session tool).
 *             An agent may NEVER overwrite this.
 *   'agent' — the agent named itself. It may re-title ITSELF as the work clarifies.
 *   NULL    — nobody named it (legacy rows, and every session before it is titled).
 *
 * Deliberately a bare TEXT column with no CHECK: the value is only ever written
 * through the sessions service, and a CHECK constraint would force a table rebuild
 * the day a third source appears. NULL is the honest default for pre-existing rows.
 *
 * ADDITIVE ONLY. Runs inside a transaction — do NOT BEGIN/COMMIT here.
 * ORDER-INDEPENDENT: `sessions` is created by 002, but a back-filled migration can
 * run after higher-numbered ones, so the column add is guarded by PRAGMA table_info
 * (019's shape) rather than assuming a predecessor already ran.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('name_source')) db.exec('ALTER TABLE sessions ADD COLUMN name_source TEXT')
}
