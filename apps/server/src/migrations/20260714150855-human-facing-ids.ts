/**
 * Migration 20260714150855 — human-facing ids (#474).
 *
 * Adds the presentable, stable reference ids for issues and sessions on top of
 * their guaranteed-unique internal ids:
 *   - `repo_prefixes`     — one prefix per LOGICAL repo (keyed by the stable
 *     repo_id), 2–5 uppercase letters, `UNIQUE(prefix)` server-wide (`POD`).
 *     A dedicated table, not a `repos.prefix` column: the repos table has one
 *     row per (machine, path), so sibling checkouts of one origin would each
 *     need to carry the SAME prefix — which a column-level unique index forbids.
 *   - `sessions.ref_issue_id` / `ref_letter` — birth issue + column letter
 *     (`POD-13-A`); the birth name is permanent (no rename on re-attach).
 *   - `sessions.ref_draft` — per-repo draft counter for truly issueless sessions
 *     (`POD-DRAFT-3`).
 *   - `issue_ref_letters`  — per-issue high-water so a letter is never reused
 *     within an issue, even after a session is deleted.
 *   - `repo_draft_seq`     — per-repo high-water for the DRAFT namespace.
 *
 * ADDITIVE ONLY. Runs inside a transaction — do NOT BEGIN/COMMIT here. Must be
 * ORDER-INDEPENDENT: guarded with defensive column checks so it converges on a
 * legacy-built database too.
 */

import { derivePrefix } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'

function hasColumn(db: SqlDatabase, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === column,
  )
}

export function up(db: SqlDatabase): void {
  // --- repo_prefixes (one prefix per logical repo) ------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_prefixes (
      repo_id TEXT PRIMARY KEY,
      prefix TEXT NOT NULL UNIQUE
    )
  `)

  // --- sessions ref fields ------------------------------------------------
  for (const [col, type] of [
    ['ref_issue_id', 'TEXT'],
    ['ref_letter', 'TEXT'],
    ['ref_draft', 'INTEGER'],
  ] as const) {
    if (!hasColumn(db, 'sessions', col)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`)
    }
  }

  // --- allocation high-water tables --------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_ref_letters (
      issue_id TEXT PRIMARY KEY,
      next_index INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_draft_seq (
      repo_id TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL
    )
  `)

  // --- backfill repo prefixes (deterministic) -----------------------------
  // One prefix per logical repo, keyed by repo_id. Rows without a repo_id yet
  // (pre-#74 heal) are left for the per-boot `backfillPrefixes` heal, which can
  // resolve a path to its logical repo_id. Iterated in rowid order so colliding
  // repo names resolve to the same fallback prefixes on every run/host.
  const rows = db
    .prepare('SELECT repo_name, path, repo_id FROM repos WHERE repo_id IS NOT NULL ORDER BY rowid ASC')
    .all() as { repo_name: string | null; path: string; repo_id: string }[]

  const taken = new Set<string>(
    (db.prepare('SELECT prefix FROM repo_prefixes').all() as { prefix: string }[]).map(
      (r) => r.prefix,
    ),
  )
  const assigned = new Set<string>(
    (db.prepare('SELECT repo_id FROM repo_prefixes').all() as { repo_id: string }[]).map(
      (r) => r.repo_id,
    ),
  )
  const insert = db.prepare('INSERT INTO repo_prefixes (repo_id, prefix) VALUES (?, ?)')
  for (const r of rows) {
    if (assigned.has(r.repo_id)) continue
    const name = r.repo_name ?? r.path.split('/').pop() ?? 'REPO'
    const prefix = derivePrefix(name, (p) => taken.has(p))
    taken.add(prefix)
    assigned.add(r.repo_id)
    insert.run(r.repo_id, prefix)
  }
}
