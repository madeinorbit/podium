/**
 * Migration 009 — sessions.stop_report (#146).
 *
 * Agent-declared stop report (JSON of AgentStopReport): what state the agent says
 * its turn ended in. Legacy rows read NULL, which the domain parses as "no report"
 * — the deterministic classifier stays the floor. The value is transient (cleared
 * when the agent starts a new turn) but persisted so an idle agent's report
 * survives a server restart.
 */

import type { SqlDatabase } from '@podium/core/sqlite'

export function up(db: SqlDatabase): void {
  const has = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
    (c) => c.name === 'stop_report',
  )
  if (!has) db.exec('ALTER TABLE sessions ADD COLUMN stop_report TEXT')
}
