import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Cross-issue design input from #285, carried by the messaging/spawn work
 * (#237) [spec:SP-34d7 cross-harness]: OPTIONAL workflow-coordination metadata
 * on sessions. Pure PASS-THROUGH — nullable, uninterpreted by the messaging
 * substrate or the session registry; an external coordinator stamps them at
 * spawn/assignment and reads them back. Parent linkage deliberately reuses the
 * existing spawned_by column ('session:<id>'), NOT a new parent column.
 */
export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name),
  )
  const add = (name: string): void => {
    if (!cols.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} TEXT`)
  }
  add('workflow_run_id')
  add('workflow_step_id')
  add('execution_profile_id')
}
