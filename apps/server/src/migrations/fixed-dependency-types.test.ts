/**
 * DEPENDENCY TYPES ARE A FIXED LIST (POD-6100, decision D7).
 *
 * The migration rebuilds `issue_deps` with a CHECK on `type` and folds every
 * older spelling onto the list. These tests run it on a database holding the
 * live mix of types:
 *
 *  - `blocks`, `blocked-by` and `waits-on` become `blocked-by`, `duplicate`
 *    becomes `duplicates`, the retired vocabulary becomes `related`, and an
 *    unknown type is dropped;
 *  - an edge stored under two spellings of one type merges into one row;
 *  - the CHECK refuses anything off the list, also through the store's
 *    `ON CONFLICT DO NOTHING` insert;
 *  - the indexes and the cascade from `issues` survive the rebuild;
 *  - a second boot applies nothing and changes nothing.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

const CUT = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_fixed-dependency-types'))

function beforeMigration(): SqlDatabase {
  expect(CUT).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, CUT))
  const insert = db.prepare(
    `INSERT INTO issues
      (id, repo_path, seq, title, stage, parent_branch, default_agent, created_at, updated_at)
     VALUES (?, '/r', ?, ?, 'backlog', 'main', 'claude-code', '2026-01-01', '2026-01-01')`,
  )
  ;['a', 'b', 'c', 'd'].forEach((id, i) => insert.run(id, i + 1, id.toUpperCase()))
  return db
}

function addEdge(db: SqlDatabase, from: string, to: string, type: string): void {
  db.prepare('INSERT INTO issue_deps (from_id, to_id, type) VALUES (?, ?, ?)').run(from, to, type)
}

function edges(db: SqlDatabase): string[] {
  return (
    db.prepare('SELECT from_id, to_id, type FROM issue_deps ORDER BY 1, 2, 3').all() as {
      from_id: string
      to_id: string
      type: string
    }[]
  ).map((e) => `${e.from_id}->${e.to_id} ${e.type}`)
}

describe('fixed dependency types migration (POD-6100)', () => {
  it('folds every older spelling onto the fixed list and drops unknown types', () => {
    const db = beforeMigration()
    addEdge(db, 'a', 'b', 'blocks')
    addEdge(db, 'a', 'c', 'waits-on')
    addEdge(db, 'a', 'd', 'blocked-by')
    addEdge(db, 'b', 'c', 'duplicate')
    addEdge(db, 'b', 'd', 'duplicates')
    addEdge(db, 'c', 'a', 'tracks')
    addEdge(db, 'c', 'b', 'caused-by')
    addEdge(db, 'c', 'd', 'validates')
    addEdge(db, 'd', 'a', 'discovered-from')
    addEdge(db, 'd', 'b', 'supersedes')
    addEdge(db, 'd', 'c', 'bogus')
    addEdge(db, 'b', 'a', 'related')

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    expect(edges(db)).toEqual([
      'a->b blocked-by',
      'a->c blocked-by',
      'a->d blocked-by',
      'b->a related',
      'b->c duplicates',
      'b->d duplicates',
      'c->a related',
      'c->b related',
      'c->d related',
      'd->a discovered-from',
      'd->b supersedes',
    ])
  })

  it('merges one edge stored under two spellings of the same type', () => {
    const db = beforeMigration()
    addEdge(db, 'a', 'b', 'blocks')
    addEdge(db, 'a', 'b', 'blocked-by')
    addEdge(db, 'a', 'b', 'waits-on')
    addEdge(db, 'a', 'b', 'related')
    addEdge(db, 'c', 'd', 'duplicate')
    addEdge(db, 'c', 'd', 'duplicates')

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    expect(edges(db)).toEqual(['a->b blocked-by', 'a->b related', 'c->d duplicates'])
  })

  it('refuses a type off the list, also through ON CONFLICT DO NOTHING', () => {
    const db = beforeMigration()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    for (const type of ['blocks', 'waits-on', 'duplicate', 'parent-child', 'bogus'])
      expect(() => addEdge(db, 'a', 'b', type), type).toThrow(/CHECK constraint failed/)
    // The store's insert is `ON CONFLICT DO NOTHING`, which covers the primary
    // key only; a CHECK failure must still reach the caller.
    expect(() =>
      db
        .prepare(
          "INSERT INTO issue_deps (from_id, to_id, type) VALUES ('a', 'b', 'blocks') ON CONFLICT DO NOTHING",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
    db.prepare("INSERT INTO issue_deps (from_id, to_id) VALUES ('a', 'b')").run()
    expect(edges(db)).toEqual(['a->b blocked-by'])
  })

  it('keeps the indexes and the cascade from issues', () => {
    const db = beforeMigration()
    addEdge(db, 'a', 'b', 'blocks')
    addEdge(db, 'c', 'a', 'related')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'issue_deps' AND sql IS NOT NULL ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(['idx_issue_deps_from', 'idx_issue_deps_to'])

    db.prepare('PRAGMA foreign_keys = ON').run()
    db.prepare("DELETE FROM issues WHERE id = 'a'").run()
    expect(edges(db)).toEqual([])
  })

  it('a second boot applies nothing and changes nothing', () => {
    const db = beforeMigration()
    addEdge(db, 'a', 'b', 'blocks')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const once = edges(db)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(edges(db)).toEqual(once)
    expect(once).toEqual(['a->b blocked-by'])
  })
})
