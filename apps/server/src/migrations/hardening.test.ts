/**
 * Migrations 003/004/005 — hardening indexes, the seq-uniqueness invariant on
 * issues (004: per repo_path; 005: re-keyed to the stable repo_id, including
 * each migration's pre-index dedupe of legacy duplicates).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { deriveRepoId } from '../repo-id'
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

function newLegacyDb(file: string): ReturnType<typeof openDatabase> {
  const db = openDatabase(file)
  for (const sql of LEGACY_SCHEMA_SQL) db.exec(sql)
  db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (1, ?, ?)').run(
    'baseline',
    '2026-01-01T00:00:00.000Z',
  )
  return db
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

describe('migrations 004+005: seq uniqueness (repo_path, then repo_id)', () => {
  it('dedupes legacy duplicates (oldest keeps the seq; newer rows renumbered) then enforces uniqueness', () => {
    // Build a legacy-shaped DB with a real (repo_path, seq) collision.
    const file = tmpDb('dupes.db')
    {
      const db = newLegacyDb(file)
      const ins = db.prepare(insertIssue)
      ins.run('iss_old', '/repo', 3, 'older claimant', '2026-01-01T00:00:00Z', 't')
      ins.run('iss_new', '/repo', 3, 'newer duplicate', '2026-02-01T00:00:00Z', 't')
      ins.run('iss_other', '/repo', 7, 'unrelated', '2026-01-05T00:00:00Z', 't')
      db.close()
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = new SessionStore(file) // runs 002→005
      const rows = store.issues.listIssueRows('/repo')
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get('iss_old')?.seq).toBe(3) // oldest keeps its number
      expect(byId.get('iss_new')?.seq).toBe(8) // renumbered to MAX(seq)+1
      expect(byId.get('iss_other')?.seq).toBe(7)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('duplicate issue seq /repo#3'))
      store.close()
    } finally {
      warnSpy.mockRestore()
    }

    // The unique index now rejects any future (repo_id, seq) collision at the
    // SQL level. '/repo' is unregistered, so 005 backfilled the deterministic
    // '__local__' path-fallback id onto its rows.
    const repoId = deriveRepoId({ machineId: '__local__', path: '/repo' })
    const db = openDatabase(file)
    expect(db.prepare('SELECT repo_id FROM issues WHERE id = ?').get('iss_other')).toEqual({
      repo_id: repoId,
    })
    expect(() =>
      db
        .prepare(
          `INSERT INTO issues (id, repo_path, repo_id, seq, title, stage, default_agent, created_at, updated_at)
           VALUES ('iss_clash', '/repo', ?, 7, 'collides', 'backlog', 'claude-code', 't', 't')`,
        )
        .run(repoId),
    ).toThrow(/unique/i)
    db.close()
  })

  it('a fresh database gets the repo_id-keyed unique index (the repo_path one is gone)', () => {
    const file = tmpDb('fresh.db')
    new SessionStore(file).close()
    const names = indexNames(file)
    expect(names).toContain('idx_issues_repo_id_seq')
    expect(names).not.toContain('idx_issues_repo_seq')
  })
})

describe('migration 005: repo_id as issue identity', () => {
  it('merges two clones of one logical repo: shared repo_id, deduped seqs, one counter', () => {
    // Two registered clones of the SAME repository (same origin URL) at
    // different paths, each with a seq-1 issue — a collision once identity
    // keys on the origin-derived repo_id.
    const file = tmpDb('clones.db')
    {
      const db = newLegacyDb(file)
      const insRepo = db.prepare(
        `INSERT INTO repos (machine_id, path, origin_url, repo_name, added_at)
         VALUES ('__local__', ?, 'git@github.com:o/r.git', 'r', 't')`,
      )
      insRepo.run('/clone-a')
      insRepo.run('/clone-b')
      const ins = db.prepare(insertIssue)
      ins.run('iss_a1', '/clone-a', 1, 'in clone a', '2026-01-01T00:00:00Z', 't')
      ins.run('iss_b1', '/clone-b', 1, 'in clone b', '2026-02-01T00:00:00Z', 't')
      db.close()
    }

    const sharedId = deriveRepoId({
      originUrl: 'git@github.com:o/r.git',
      machineId: '__local__',
      path: '/clone-a',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = new SessionStore(file)
      const rows = store.issues.listIssueRows('/clone-a') // repo_id-scoped: both clones list together
      expect(rows.map((r) => r.id).sort()).toEqual(['iss_a1', 'iss_b1'])
      expect(rows.every((r) => r.repoId === sharedId)).toBe(true)
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get('iss_a1')?.seq).toBe(1) // oldest keeps its number
      expect(byId.get('iss_b1')?.seq).toBe(2) // renumbered into the shared space
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reassigning issue iss_b1'))
      // Seq allocation is keyed on repo_id: both paths share ONE counter.
      expect(store.issues.nextIssueSeq(store.repos.resolveRepoIdForPath('/clone-a'))).toBe(3)
      expect(store.issues.nextIssueSeq(store.repos.resolveRepoIdForPath('/clone-b'))).toBe(3)
      store.close()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('backfills NULL repo_id from the longest registered root, else the path fallback', () => {
    const file = tmpDb('backfill.db')
    {
      const db = newLegacyDb(file)
      db.prepare(
        `INSERT INTO repos (machine_id, path, origin_url, repo_name, added_at)
         VALUES ('__local__', '/r', 'git@github.com:o/r.git', 'r', 't')`,
      ).run()
      const ins = db.prepare(insertIssue)
      ins.run('iss_sub', '/r/sub', 1, 'under the root', 't', 't')
      ins.run('iss_free', '/elsewhere', 1, 'unregistered', 't', 't')
      db.close()
    }
    const store = new SessionStore(file)
    expect(store.issues.getIssue('iss_sub')?.repoId).toBe(
      deriveRepoId({ originUrl: 'git@github.com:o/r.git', machineId: '__local__', path: '/r' }),
    )
    expect(store.issues.getIssue('iss_free')?.repoId).toBe(
      deriveRepoId({ machineId: '__local__', path: '/elsewhere' }),
    )
    store.close()
  })
})
