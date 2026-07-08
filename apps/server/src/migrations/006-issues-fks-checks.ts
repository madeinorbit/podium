/**
 * Migration 006 — real referential integrity + value constraints on the issue
 * tables (issue #164 step 2). SQLite cannot ADD a foreign key or CHECK to an
 * existing table, so this is the standard rebuild (create-new → copy → drop →
 * rename → recreate indexes); `PRAGMA foreign_keys` is deliberately enabled
 * only AFTER the migration chain runs (see SessionStore), so the rebuild needs
 * no FK toggling and a mid-transaction crash rolls back cleanly.
 *
 * issues:
 *  - CHECK stage/type/priority match the wire enums (@podium/protocol
 *    IssueStage / IssueType, priority P0–P4) — garbage is rejected at the SQL
 *    layer, not just by the app-level upsert guard.
 *  - parent_id / superseded_by / duplicate_of → issues(id) ON DELETE SET NULL:
 *    deleting an issue clears back-references on other rows in the engine,
 *    replacing the manual null-out that deleteIssue used to run.
 *
 * issue_labels / issue_deps / issue_comments / issue_messages:
 *  - issue_id (deps: from_id AND to_id) → issues(id) ON DELETE CASCADE.
 *
 * Legacy data is SANITIZED first so a populated database always converges:
 * out-of-enum stage/type/priority values are coerced to safe defaults (loudly
 * logged — these rows were already unrenderable garbage to the board), and
 * dangling references (scalar back-refs to deleted ids; orphaned child rows)
 * are cleared/deleted exactly as the app-level scrubs would eventually have.
 */

import type { SqlDatabase } from '@podium/core/sqlite'
import { ISSUE_STAGES, IssueType } from '@podium/protocol'

const STAGES = ISSUE_STAGES
const TYPES = IssueType.options

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}

export function up(db: SqlDatabase): void {
  // ---- sanitize: enum/range coercions (logged per column) ----
  const coerce = (column: string, where: string, fallback: string): void => {
    const bad = db
      .prepare(`SELECT id, ${column} AS v FROM issues WHERE ${where}`)
      .all() as { id: string; v: unknown }[]
    for (const b of bad) {
      console.warn(
        `[podium] migration 006: issue ${b.id} has out-of-range ${column} ` +
          `${JSON.stringify(b.v)} — coerced to ${fallback}`,
      )
    }
    if (bad.length > 0) db.exec(`UPDATE issues SET ${column} = ${fallback} WHERE ${where}`)
  }
  coerce('stage', `stage NOT IN (${sqlList(STAGES)})`, "'backlog'")
  coerce('type', `type NOT IN (${sqlList(TYPES)})`, "'task'")
  coerce(
    'priority',
    'priority NOT BETWEEN 0 AND 4 OR CAST(priority AS INTEGER) != priority',
    '2',
  )

  // ---- sanitize: dangling references ----
  for (const col of ['parent_id', 'superseded_by', 'duplicate_of']) {
    db.exec(
      `UPDATE issues SET ${col} = NULL
       WHERE ${col} IS NOT NULL AND ${col} NOT IN (SELECT id FROM issues)`,
    )
  }
  db.exec('DELETE FROM issue_labels WHERE issue_id NOT IN (SELECT id FROM issues)')
  db.exec(
    `DELETE FROM issue_deps
     WHERE from_id NOT IN (SELECT id FROM issues) OR to_id NOT IN (SELECT id FROM issues)`,
  )
  db.exec('DELETE FROM issue_comments WHERE issue_id NOT IN (SELECT id FROM issues)')
  db.exec('DELETE FROM issue_messages WHERE issue_id NOT IN (SELECT id FROM issues)')

  // ---- rebuild issues (CHECKs + self-referential ON DELETE SET NULL FKs) ----
  db.exec(
    `CREATE TABLE issues_v6 (
         id TEXT PRIMARY KEY,
         repo_path TEXT NOT NULL,
         repo_id TEXT,
         seq INTEGER NOT NULL,
         title TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         stage TEXT NOT NULL CHECK (stage IN (${sqlList(STAGES)})),
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
         type TEXT NOT NULL DEFAULT 'task' CHECK (type IN (${sqlList(TYPES)})),
         assignee TEXT,
         parent_id TEXT REFERENCES issues_v6(id) ON DELETE SET NULL,
         design TEXT,
         acceptance TEXT,
         notes TEXT,
         due_at TEXT,
         defer_until TEXT,
         closed_reason TEXT,
         superseded_by TEXT REFERENCES issues_v6(id) ON DELETE SET NULL,
         duplicate_of TEXT REFERENCES issues_v6(id) ON DELETE SET NULL,
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
         read_at TEXT
       )`,
  )
  // Explicit column list: a long-lived legacy DB grew several of these columns
  // via ALTER TABLE ADD COLUMN, so its physical column ORDER can differ from a
  // fresh CREATE — `SELECT *` would mis-align.
  const issueCols =
    'id, repo_path, repo_id, seq, title, description, stage, worktree_path, branch, ' +
    'parent_branch, default_agent, default_model, default_effort, machine_id, linear_id, ' +
    'linear_identifier, linear_url, activity_notes, notes_updated_at, suggested_stage, ' +
    'suggested_reason, blocked_by, dependency_note, pr_url, priority, type, assignee, ' +
    'parent_id, design, acceptance, notes, due_at, defer_until, closed_reason, superseded_by, ' +
    'duplicate_of, pinned, estimate_min, needs_human, human_question, panel, created_at, ' +
    'updated_at, archived, origin, draft, read_at'
  db.exec(`INSERT INTO issues_v6 (${issueCols}) SELECT ${issueCols} FROM issues`)
  db.exec('DROP TABLE issues')
  db.exec('ALTER TABLE issues_v6 RENAME TO issues')
  // Note: the intra-table REFERENCES keep pointing at the renamed table (SQLite
  // rewrites self-references on RENAME). Recreate the dropped indexes.
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_path)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_repo_id_seq ON issues(repo_id, seq)')

  // ---- rebuild child tables (ON DELETE CASCADE onto issues) ----
  db.exec(
    `CREATE TABLE issue_labels_v6 (
         issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         label    TEXT NOT NULL,
         PRIMARY KEY (issue_id, label)
       )`,
  )
  db.exec('INSERT INTO issue_labels_v6 (issue_id, label) SELECT issue_id, label FROM issue_labels')
  db.exec('DROP TABLE issue_labels')
  db.exec('ALTER TABLE issue_labels_v6 RENAME TO issue_labels')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label)')

  db.exec(
    `CREATE TABLE issue_deps_v6 (
         from_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         to_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         type    TEXT NOT NULL DEFAULT 'blocks',
         PRIMARY KEY (from_id, to_id, type)
       )`,
  )
  db.exec('INSERT INTO issue_deps_v6 (from_id, to_id, type) SELECT from_id, to_id, type FROM issue_deps')
  db.exec('DROP TABLE issue_deps')
  db.exec('ALTER TABLE issue_deps_v6 RENAME TO issue_deps')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_from ON issue_deps(from_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_to ON issue_deps(to_id)')

  db.exec(
    `CREATE TABLE issue_comments_v6 (
         id         TEXT PRIMARY KEY,
         issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         author     TEXT NOT NULL,
         body       TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
  )
  db.exec(
    `INSERT INTO issue_comments_v6 (id, issue_id, author, body, created_at)
     SELECT id, issue_id, author, body, created_at FROM issue_comments`,
  )
  db.exec('DROP TABLE issue_comments')
  db.exec('ALTER TABLE issue_comments_v6 RENAME TO issue_comments')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)')

  db.exec(
    `CREATE TABLE issue_messages_v6 (
         id          TEXT PRIMARY KEY,
         issue_id    TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         from_author TEXT NOT NULL,
         body        TEXT NOT NULL,
         created_at  TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'unread',
         claimed_by  TEXT,
         read_at     TEXT,
         claimed_at  TEXT
       )`,
  )
  db.exec(
    `INSERT INTO issue_messages_v6 (id, issue_id, from_author, body, created_at, status, claimed_by, read_at, claimed_at)
     SELECT id, issue_id, from_author, body, created_at, status, claimed_by, read_at, claimed_at FROM issue_messages`,
  )
  db.exec('DROP TABLE issue_messages')
  db.exec('ALTER TABLE issue_messages_v6 RENAME TO issue_messages')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_messages_issue ON issue_messages(issue_id)')
}
