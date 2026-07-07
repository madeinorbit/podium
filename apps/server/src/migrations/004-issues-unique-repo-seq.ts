/**
 * Migration 004 — enforce the (repo_path, seq) identity invariant on issues.
 *
 * `seq` is the human-facing per-repo issue number (repo#seq): two issues in one
 * repo sharing a seq is a data corruption (nextIssueSeq hands out MAX+1, but
 * nothing stopped an external write / sync replay from colliding). Before the
 * UNIQUE index lands, existing duplicates are DEDUPED: within each colliding
 * (repo_path, seq) group the OLDEST row (created_at, then rowid) keeps the seq
 * and every newer row is reassigned the next free seq for that repo, loudly
 * logged so the renumbering is observable. If a collision somehow survives the
 * dedupe pass, the migration fails (transaction rolls back — the DB is
 * untouched) with instructions rather than guessing.
 */

import type { SqlDatabase } from '@podium/core/sqlite'

export function up(db: SqlDatabase): void {
  const dupes = db
    .prepare(
      `SELECT repo_path, seq FROM issues
       GROUP BY repo_path, seq HAVING COUNT(*) > 1
       ORDER BY repo_path, seq`,
    )
    .all() as { repo_path: string; seq: number }[]
  if (dupes.length > 0) {
    const nextSeq = new Map<string, number>()
    for (const d of dupes) {
      if (!nextSeq.has(d.repo_path)) {
        const r = db
          .prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_path = ?')
          .get(d.repo_path) as { m: number | null }
        nextSeq.set(d.repo_path, (r.m ?? 0) + 1)
      }
      // Keep the oldest claimant; renumber every newer duplicate.
      const rows = db
        .prepare(
          `SELECT id, rowid AS rid FROM issues WHERE repo_path = ? AND seq = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(d.repo_path, d.seq) as { id: string; rid: number }[]
      for (const row of rows.slice(1)) {
        const newSeq = nextSeq.get(d.repo_path) as number
        nextSeq.set(d.repo_path, newSeq + 1)
        console.warn(
          `[podium] migration 004: duplicate issue seq ${d.repo_path}#${d.seq} — ` +
            `reassigning issue ${row.id} to seq ${newSeq} (issue ids are unchanged; ` +
            `only the human-facing repo#seq number moved)`,
        )
        db.prepare('UPDATE issues SET seq = ? WHERE id = ?').run(newSeq, row.id)
      }
    }
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM issues GROUP BY repo_path, seq HAVING COUNT(*) > 1)')
      .get() as { n: number }
    if (Number(remaining.n) > 0) {
      throw new Error(
        'issues still contain duplicate (repo_path, seq) pairs after dedupe. ' +
          'Inspect them with: SELECT repo_path, seq, COUNT(*) FROM issues ' +
          'GROUP BY repo_path, seq HAVING COUNT(*) > 1; then renumber the newer ' +
          'rows (UPDATE issues SET seq = <free seq> WHERE id = <id>) and restart.',
      )
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_repo_seq ON issues(repo_path, seq)')
}
