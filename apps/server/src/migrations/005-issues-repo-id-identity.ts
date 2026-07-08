/**
 * Migration 005 — repo_id becomes the issue's repo identity (#74 cutover,
 * issue #164).
 *
 * Until now repo_id was dual-written but everything (reads, filters, seq
 * allocation, the 004 UNIQUE index) keyed on repo_path. This migration
 * completes the cutover:
 *
 *  1. Backfill repos.repo_id (NULL rows) — same derivation the per-boot heal
 *     uses (origin-derived when an origin URL is recorded, else the
 *     deterministic (machineId, path) fallback).
 *  2. Backfill issues.repo_id (NULL rows) — longest registered repo root that
 *     contains the issue's repo_path (any machine), else the '__local__'
 *     path fallback. Mirrors ReposRepository.resolveRepoIdForPath.
 *  3. Dedupe (repo_id, seq) collisions. Two clones of the SAME logical repo
 *     registered at different paths share one origin-derived repo_id, so their
 *     per-path seq counters can collide once identity is repo_id-keyed.
 *     Within each colliding group the OLDEST row (created_at, then rowid)
 *     keeps its seq; every newer row is renumbered to the next free seq for
 *     that repo_id, loudly logged (issue ids never change — only the
 *     human-facing #seq).
 *  4. Replace UNIQUE(repo_path, seq) (004) with UNIQUE(repo_id, seq).
 *
 * NULL semantics: repo_id stays nullable (defense in depth — the per-boot
 * heal re-fills any NULL, and every write path resolves it), and SQLite
 * treats NULLs as distinct in unique indexes, so a hypothetical NULL-repo_id
 * row never trips the index.
 */

import type { SqlDatabase } from '@podium/core/sqlite'
import { deriveRepoId } from '../repo-id'
import { normalizeRepoPath } from '../store/repos'

export function up(db: SqlDatabase): void {
  // 1. repos.repo_id backfill (pre-v8 rows the boot heal hasn't touched yet —
  //    migrations run before the heals).
  const repos = db
    .prepare('SELECT machine_id, path, origin_url, repo_id FROM repos')
    .all() as { machine_id: string; path: string; origin_url: string | null; repo_id: string | null }[]
  const setRepo = db.prepare('UPDATE repos SET repo_id = ? WHERE machine_id = ? AND path = ?')
  for (const r of repos) {
    if (r.repo_id == null) {
      r.repo_id = deriveRepoId({ originUrl: r.origin_url, machineId: r.machine_id, path: r.path })
      setRepo.run(r.repo_id, r.machine_id, r.path)
    }
  }

  // 2. issues.repo_id backfill: longest registered root containing repo_path,
  //    else the deterministic '__local__' path fallback.
  const roots = repos
    .map((r) => ({ path: normalizeRepoPath(r.path), repoId: r.repo_id as string }))
    .sort((a, b) => b.path.length - a.path.length)
  const nullIssues = db
    .prepare('SELECT id, repo_path FROM issues WHERE repo_id IS NULL')
    .all() as { id: string; repo_path: string }[]
  const setIssue = db.prepare('UPDATE issues SET repo_id = ? WHERE id = ?')
  for (const i of nullIssues) {
    const p = normalizeRepoPath(i.repo_path)
    const root = roots.find((r) => p === r.path || p.startsWith(r.path === '/' ? r.path : `${r.path}/`))
    setIssue.run(root?.repoId ?? deriveRepoId({ machineId: '__local__', path: p }), i.id)
  }

  // 3. Dedupe (repo_id, seq) collisions — oldest keeps the number.
  const dupes = db
    .prepare(
      `SELECT repo_id, seq FROM issues WHERE repo_id IS NOT NULL
       GROUP BY repo_id, seq HAVING COUNT(*) > 1
       ORDER BY repo_id, seq`,
    )
    .all() as { repo_id: string; seq: number }[]
  if (dupes.length > 0) {
    const nextSeq = new Map<string, number>()
    for (const d of dupes) {
      if (!nextSeq.has(d.repo_id)) {
        const r = db
          .prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_id = ?')
          .get(d.repo_id) as { m: number | null }
        nextSeq.set(d.repo_id, (r.m ?? 0) + 1)
      }
      const rows = db
        .prepare(
          `SELECT id, repo_path FROM issues WHERE repo_id = ? AND seq = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(d.repo_id, d.seq) as { id: string; repo_path: string }[]
      for (const row of rows.slice(1)) {
        const newSeq = nextSeq.get(d.repo_id) as number
        nextSeq.set(d.repo_id, newSeq + 1)
        console.warn(
          `[podium] migration 005: duplicate issue seq #${d.seq} within logical repo ` +
            `${d.repo_id} (${row.repo_path}) — reassigning issue ${row.id} to seq ${newSeq} ` +
            `(issue ids are unchanged; only the human-facing #seq number moved)`,
        )
        db.prepare('UPDATE issues SET seq = ? WHERE id = ?').run(newSeq, row.id)
      }
    }
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM issues WHERE repo_id IS NOT NULL
         GROUP BY repo_id, seq HAVING COUNT(*) > 1)`,
      )
      .get() as { n: number }
    if (Number(remaining.n) > 0) {
      throw new Error(
        'issues still contain duplicate (repo_id, seq) pairs after dedupe. ' +
          'Inspect them with: SELECT repo_id, seq, COUNT(*) FROM issues ' +
          'GROUP BY repo_id, seq HAVING COUNT(*) > 1; then renumber the newer ' +
          'rows (UPDATE issues SET seq = <free seq> WHERE id = <id>) and restart.',
      )
    }
  }

  // 4. The identity invariant moves from (repo_path, seq) to (repo_id, seq).
  db.exec('DROP INDEX IF EXISTS idx_issues_repo_seq')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_repo_id_seq ON issues(repo_id, seq)')
}
