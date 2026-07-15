/**
 * Migration 20260715085920 — automation-run-sessions.
 *
 * Adds session mode to automations and widens the frozen issues.type CHECK for
 * the automation issue kind. SQLite requires a table rebuild to widen a CHECK;
 * all current columns and indexes are copied explicitly below.
 *
 * Runs inside a transaction — do NOT BEGIN/COMMIT here.
 * Must be ORDER-INDEPENDENT: a back-filled migration can run after higher-numbered
 * ones, so do not assume a predecessor already ran — guard defensively instead.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      repo_path TEXT,
      cron TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'auto',
      effort TEXT NOT NULL DEFAULT 'auto',
      prompt TEXT NOT NULL,
      session_mode TEXT NOT NULL DEFAULT 'fresh'
        CHECK (session_mode IN ('fresh', 'resume')),
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      fired_at TEXT NOT NULL,
      session_id TEXT,
      outcome TEXT NOT NULL
        CHECK (outcome IN ('spawned', 'missed', 'skipped_overlap', 'error')),
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
      ON automation_runs(automation_id, fired_at DESC);
  `)

  const automationColumns = db.prepare('PRAGMA table_info(automations)').all() as Array<{
    name: string
  }>
  if (!automationColumns.some((column) => column.name === 'session_mode')) {
    db.exec(
      "ALTER TABLE automations ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'fresh' CHECK (session_mode IN ('fresh', 'resume'))",
    )
  }

  const issueTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'")
    .get() as { sql: string } | undefined
  if (!issueTable || issueTable.sql.includes("'automation'")) return

  db.exec(`
    CREATE TABLE issues_automation_type (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      repo_id TEXT,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL
        CHECK (stage IN ('backlog', 'planning', 'in_progress', 'review', 'verifying', 'done')),
      worktree_path TEXT,
      branch TEXT,
      parent_branch TEXT NOT NULL DEFAULT 'main',
      default_agent TEXT NOT NULL,
      default_model TEXT NOT NULL DEFAULT 'auto',
      default_effort TEXT NOT NULL DEFAULT 'auto',
      machine_id TEXT,
      linear_id TEXT,
      linear_identifier TEXT,
      linear_url TEXT,
      activity_notes TEXT,
      notes_updated_at TEXT,
      suggested_stage TEXT,
      suggested_reason TEXT,
      blocked_by TEXT NOT NULL DEFAULT '[]',
      dependency_note TEXT,
      pr_url TEXT,
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
      type TEXT NOT NULL DEFAULT 'task'
        CHECK (type IN ('task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone', 'automation')),
      assignee TEXT,
      parent_id TEXT REFERENCES issues_automation_type(id) ON DELETE SET NULL,
      design TEXT,
      acceptance TEXT,
      notes TEXT,
      due_at TEXT,
      defer_until TEXT,
      closed_reason TEXT,
      superseded_by TEXT REFERENCES issues_automation_type(id) ON DELETE SET NULL,
      duplicate_of TEXT REFERENCES issues_automation_type(id) ON DELETE SET NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      estimate_min INTEGER,
      needs_human INTEGER NOT NULL DEFAULT 0,
      human_question TEXT,
      panel TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'human',
      draft INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      audience TEXT NOT NULL DEFAULT 'human',
      deleted_at TEXT
    );

    INSERT INTO issues_automation_type (
      id, repo_path, repo_id, seq, title, description, stage, worktree_path, branch,
      parent_branch, default_agent, default_model, default_effort, machine_id,
      linear_id, linear_identifier, linear_url, activity_notes, notes_updated_at,
      suggested_stage, suggested_reason, blocked_by, dependency_note, pr_url,
      priority, type, assignee, parent_id, design, acceptance, notes, due_at,
      defer_until, closed_reason, superseded_by, duplicate_of, pinned, estimate_min,
      needs_human, human_question, panel, created_at, updated_at, archived, origin,
      draft, read_at, audience, deleted_at
    )
    SELECT
      id, repo_path, repo_id, seq, title, description, stage, worktree_path, branch,
      parent_branch, default_agent, default_model, default_effort, machine_id,
      linear_id, linear_identifier, linear_url, activity_notes, notes_updated_at,
      suggested_stage, suggested_reason, blocked_by, dependency_note, pr_url,
      priority, type, assignee, parent_id, design, acceptance, notes, due_at,
      defer_until, closed_reason, superseded_by, duplicate_of, pinned, estimate_min,
      needs_human, human_question, panel, created_at, updated_at, archived, origin,
      draft, read_at, audience, deleted_at
    FROM issues;

    DROP TABLE issues;
    ALTER TABLE issues_automation_type RENAME TO issues;
    CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_path);
    CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_repo_id_seq ON issues(repo_id, seq);
    CREATE INDEX IF NOT EXISTS idx_issues_deleted_at ON issues(deleted_at);
  `)
}
