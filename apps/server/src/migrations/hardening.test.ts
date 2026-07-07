/**
 * Migrations 003/004 — hardening indexes and the (repo_path, seq) UNIQUE
 * invariant on issues (including the pre-index dedupe of legacy duplicates).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/core/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../store'
import { LEGACY_SCHEMA_SQL } from './legacy-schema.fixture'

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-hardening-')), name)
}

function indexNames(file: string): string[] {
  const db = openDatabase(file)
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .all() as { name: string }[]
  db.close()
  return rows.map((r) => r.name)
}

const insertIssue = `INSERT INTO issues (id, repo_path, seq, title, stage, default_agent, created_at, updated_at)
                     VALUES (?, ?, ?, ?, 'backlog', 'claude-code', ?, ?)`

describe('migration 003: hardening indexes', () => {
  it('creates issues(parent_id) and podium_events(repo_path) indexes', () => {
    const file = tmpDb('idx.db')
    new SessionStore(file).close()
    const names = indexNames(file)
    expect(names).toContain('idx_issues_parent')
    expect(names).toContain('idx_podium_events_repo')
  })
})

describe('migration 004: UNIQUE(repo_path, seq) on issues', () => {
  it('dedupes legacy duplicates (oldest keeps the seq; newer rows renumbered) then enforces uniqueness', () => {
    // Build a legacy-shaped DB with a real (repo_path, seq) collision.
    const file = tmpDb('dupes.db')
    {
      const db = openDatabase(file)
      for (const sql of LEGACY_SCHEMA_SQL) db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (1, ?, ?)').run(
        'baseline',
        '2026-01-01T00:00:00.000Z',
      )
      const ins = db.prepare(insertIssue)
      ins.run('iss_old', '/repo', 3, 'older claimant', '2026-01-01T00:00:00Z', 't')
      ins.run('iss_new', '/repo', 3, 'newer duplicate', '2026-02-01T00:00:00Z', 't')
      ins.run('iss_other', '/repo', 7, 'unrelated', '2026-01-05T00:00:00Z', 't')
      db.close()
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = new SessionStore(file) // runs 002→004
      const rows = store.listIssueRows('/repo')
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get('iss_old')?.seq).toBe(3) // oldest keeps its number
      expect(byId.get('iss_new')?.seq).toBe(8) // renumbered to MAX(seq)+1
      expect(byId.get('iss_other')?.seq).toBe(7)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('duplicate issue seq /repo#3'))
      store.close()
    } finally {
      warnSpy.mockRestore()
    }

    // The unique index now rejects any future collision at the SQL level.
    const db = openDatabase(file)
    expect(() =>
      db.prepare(insertIssue).run('iss_clash', '/repo', 7, 'collides', 't', 't'),
    ).toThrow(/unique/i)
    db.close()
  })

  it('a fresh database gets the unique index too', () => {
    const file = tmpDb('fresh.db')
    new SessionStore(file).close()
    expect(indexNames(file)).toContain('idx_issues_repo_seq')
  })
})
