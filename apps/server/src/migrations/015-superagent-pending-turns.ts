import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Durable superagent inbox + outbox. Raw input is inserted before any async
 * turn preparation, then atomically promoted before daemon dispatch. */
export function up(db: SqlDatabase): void {
  db.exec(
    `CREATE TABLE superagent_queued_inputs (
       input_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL UNIQUE,
       text TEXT NOT NULL,
       focus_json TEXT,
       created_at TEXT NOT NULL
     );
     CREATE TABLE superagent_pending_turns (
       turn_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL UNIQUE,
       podium_session_id TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       first_turn INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     )`,
  )
}
