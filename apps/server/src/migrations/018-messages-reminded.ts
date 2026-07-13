import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Migration 17 (#237) [spec:SP-34d7 acks]: stop-hook single-reminder state.
 * `reminded_at` records the ONE block-with-reason reminder issued for a
 * delivered-but-unacked message — persisted so the reminder never repeats
 * across restarts (the steward fallback owns the message after that).
 */
export function up(db: SqlDatabase): void {
  db.exec('ALTER TABLE messages ADD COLUMN reminded_at TEXT')
}
