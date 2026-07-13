import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Approval broker queue [spec:SP-edbb] (#410): agent-initiated management ops
 *  awaiting a human approve/deny. Survives restarts; pending rows are
 *  re-broadcast to the web on boot/attach. */
export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      issue_id TEXT,
      op_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','denied','executing','succeeded','failed')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      result_text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_requests_status
      ON approval_requests(status, created_at);
  `)
}
