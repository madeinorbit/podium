import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Scheduled automations (#470) [spec:SP-17db] — the cron half of the Automations
 * tab, previously a front-end mock with no backend at all.
 *
 * `automations` is the definition (when + where + what to run); `automation_runs`
 * is the honest run history the tab lists: one row per fire, including the ones
 * that did NOT spawn (missed / skipped_overlap / error), so the UI can explain a
 * silent night instead of showing nothing.
 *
 * `repo_path IS NULL` means a GLOBAL automation: its session spawns in the user's
 * home directory, for cross-repo chores. A scheduled task is not always about one
 * repo [spec:SP-17db].
 *
 * The table is shaped for reactive (event-triggered) automations to land later as
 * a `trigger_kind = 'event'` column reusing the subscription matcher; they are NOT
 * built here.
 */
export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 0,
      repo_path   TEXT,
      cron        TEXT NOT NULL,
      agent_kind  TEXT NOT NULL,
      model       TEXT NOT NULL DEFAULT 'auto',
      effort      TEXT NOT NULL DEFAULT 'auto',
      prompt      TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      fired_at      TEXT NOT NULL,
      session_id    TEXT,
      outcome       TEXT NOT NULL
        CHECK (outcome IN ('spawned','missed','skipped_overlap','error')),
      detail        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
      ON automation_runs(automation_id, fired_at DESC);
  `)
}
