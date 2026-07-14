/**
 * Migration 018 — needs-human question metadata (issue #53).
 *
 * Three additive columns on `issues` so the Tray can render structured answer
 * chips and attribute/timestamp the question (was: one plain `human_question`
 * string):
 *  - human_question_options   TEXT — JSON string[] of suggested answers; NULL = free-form.
 *  - human_question_asked_by  TEXT — sessionId of the asking agent session; NULL = unattributed.
 *  - human_question_asked_at  TEXT — ISO time the flag was raised; NULL = pre-053 row.
 *
 * No backfill: existing flagged rows simply carry no metadata (the web tray
 * falls back to Reply…/resolve). Idempotent: skips columns that already exist.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name),
  )
  for (const col of [
    'human_question_options',
    'human_question_asked_by',
    'human_question_asked_at',
  ]) {
    if (!cols.has(col)) db.exec(`ALTER TABLE issues ADD COLUMN ${col} TEXT`)
  }
}
