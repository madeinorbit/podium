import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

describe('proposed lane migration [spec:SP-6144]', () => {
  it('accepts proposed and backfills only untouched top-level agent backlog issues', () => {
    const db = openDatabase(':memory:')
    const cut = DRIZZLE_MIGRATIONS.findIndex((migration) =>
      migration.name.includes('proposed-lane-brief'),
    )
    expect(cut).toBeGreaterThan(0)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))

    const insert = db.prepare(
      `INSERT INTO issues
        (id, repo_path, seq, title, stage, parent_branch, default_agent, created_at, updated_at, origin)
       VALUES (?, '/r', ?, ?, 'backlog', 'main', 'claude-code', '2026-01-01', '2026-01-01', 'agent')`,
    )
    insert.run('untouched', 1, 'Untouched')
    insert.run('touched', 2, 'Touched')
    insert.run('parent', 3, 'Parent')
    db.prepare("UPDATE issues SET parent_id = 'parent' WHERE id = 'touched'").run()
    insert.run('operator-touched', 4, 'Operator touched')
    db.prepare(
      `INSERT INTO podium_events (ts, kind, subject, payload)
       VALUES ('2026-01-02', 'issue.stage_changed', 'operator-touched', '{}')`,
    ).run()

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const stage = (id: string) =>
      (db.prepare('SELECT stage FROM issues WHERE id = ?').get(id) as { stage: string }).stage
    expect(stage('untouched')).toBe('proposed')
    expect(stage('touched')).toBe('backlog')
    expect(stage('operator-touched')).toBe('backlog')
    expect(() =>
      db.prepare("UPDATE issues SET stage = 'proposed' WHERE id = 'parent'").run(),
    ).not.toThrow()
    expect(() =>
      db.prepare("UPDATE issues SET stage = 'nonsense' WHERE id = 'parent'").run(),
    ).toThrow(/check/i)
    db.close()
  })
})
