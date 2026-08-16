import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { BLANK_TO_NULL_COLUMNS } from '../modules/issues/blank-text'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

/**
 * POD-820 — the one-time retirement of the second spelling of "absent".
 *
 * The write path stops producing `''` on nullable text columns; this covers the
 * rows written before it did. The test also pins the correspondence between the
 * SQL and `BLANK_TO_NULL_COLUMNS`: a column normalized in memory but left
 * un-swept in the database would leave the ambiguity alive on exactly the rows
 * the migration exists for.
 */
describe('issue blank-text backfill migration [POD-820]', () => {
  const cutIndex = DRIZZLE_MIGRATIONS.findIndex((migration) =>
    migration.name.includes('issue-blank-text-to-null'),
  )

  it('nulls empty nullable text and leaves the empty description alone', () => {
    const db = openDatabase(':memory:')
    expect(cutIndex).toBeGreaterThan(0)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex))

    db.prepare(
      `INSERT INTO issues
        (id, repo_path, seq, title, description, stage, parent_branch, default_agent,
         created_at, updated_at, assignee, pr_url, branch)
       VALUES ('blank', '/r', 1, 'T', '', 'backlog', 'main', 'claude-code',
         '2026-01-01', '2026-01-01', '', '', '')`,
    ).run()
    db.prepare(
      `INSERT INTO issues
        (id, repo_path, seq, title, description, stage, parent_branch, default_agent,
         created_at, updated_at, assignee)
       VALUES ('kept', '/r', 2, 'T', 'real', 'backlog', 'main', 'claude-code',
         '2026-01-01', '2026-01-01', 'user:sole')`,
    ).run()

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const blank = db.prepare('SELECT * FROM issues WHERE id = ?').get('blank') as Record<
      string,
      unknown
    >
    expect(blank.assignee).toBeNull()
    expect(blank.pr_url).toBeNull()
    expect(blank.branch).toBeNull()
    // NOT NULL, and '' is its legitimate value — 146 live rows hold it.
    expect(blank.description).toBe('')

    const kept = db.prepare('SELECT assignee FROM issues WHERE id = ?').get('kept') as {
      assignee: string
    }
    expect(kept.assignee).toBe('user:sole')
  })

  it('sweeps exactly the columns the write path normalizes', () => {
    const sql = DRIZZLE_MIGRATIONS[cutIndex]?.sql ?? ''
    const snakeCase = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    // Scope to the columns that EXISTED at the cut. A nullable text column added
    // after POD-820 (landed_at/landed_sha, POD-1085) cannot be swept by a
    // migration that ran before it existed, and needs no sweeping: it is born
    // with the normalizing write path already in force, so it has no legacy ''
    // rows. Reading the shape from the database rather than hardcoding a skip
    // list keeps the real protection — a column that DID exist then and is
    // normalized now must have been swept — intact for every future column.
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex))
    const atCut = new Set(
      (db.prepare('PRAGMA table_info(issues)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    const inScope = BLANK_TO_NULL_COLUMNS.filter((column) => atCut.has(snakeCase(column)))
    // Guard the guard: if this ever empties, the assertion below passes vacuously.
    expect(inScope.length).toBeGreaterThan(10)
    for (const column of inScope) {
      expect({
        column,
        swept: sql.includes(`UPDATE issues SET ${snakeCase(column)} = NULL`),
      }).toEqual({ column, swept: true })
    }
  })
})
