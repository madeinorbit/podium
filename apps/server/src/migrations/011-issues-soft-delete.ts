import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Keep deleted issues and their member sessions recoverable as one lifecycle. */
export function up(db: SqlDatabase): void {
  db.exec('ALTER TABLE issues ADD COLUMN deleted_at TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_deleted_at ON issues(deleted_at)')
  db.exec('ALTER TABLE sessions ADD COLUMN deleted_at TEXT')
  db.exec('ALTER TABLE sessions ADD COLUMN deleted_by_issue_id TEXT')
  db.exec('ALTER TABLE sessions ADD COLUMN deletion_source TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_sessions_deleted_by_issue ON sessions(deleted_by_issue_id)',
  )
}
