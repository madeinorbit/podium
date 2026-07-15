import { describe, expect, it } from 'vitest'
import { deriveRepoId } from './repo-id'
import { SessionStore } from './store'
import type { IssueRow } from './store'

function db(store: SessionStore) {
  // @ts-expect-error private db — schema/migration assertions
  return store.db
}

function issueRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 'iss_x', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
    worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
    defaultModel: 'auto', defaultEffort: 'auto',
    linearId: null, linearIdentifier: null, linearUrl: null, activityNotes: null,
    notesUpdatedAt: null, suggestedStage: null, suggestedReason: null, blockedBy: [],
    dependencyNote: null, prUrl: null, createdAt: 't', updatedAt: 't', archived: false,
    priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
    notes: null, dueAt: null, deferUntil: null, closedReason: null, supersededBy: null,
    duplicateOf: null, pinned: false, estimateMin: null,
    needsHuman: false, humanQuestion: null,
    ...over,
  }
}

describe('repo_id schema (v8, #74)', () => {
  it('fresh DB has repo_id columns on repos and issues', () => {
    const s = new SessionStore(':memory:')
    for (const table of ['repos', 'issues']) {
      const cols = new Set(
        (db(s).prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      )
      expect(cols.has('repo_id'), `missing repo_id on ${table}`).toBe(true)
    }
    // The legacy `meta.schema_version` marker (written by migration 002's DML) is
    // NOT carried on a fresh drizzle-built DB [spec:SP-4428] — the baseline is
    // DDL only, and nothing at runtime reads that marker. It still appears on
    // pre-drizzle databases healed by the legacy chain (see the backfill test).
    s.close()
  })

  it('backfills repo_id for pre-v8 repos and issues rows', () => {
    const s = new SessionStore(':memory:')
    // Simulate a v7 DB: rows present, repo_id wiped, marker at 7.
    db(s)
      .prepare(
        `INSERT INTO repos (machine_id, path, origin_url, added_at)
         VALUES ('m1', '/r', 'git@github.com:o/r.git', 't'),
                ('m2', '/no-origin', NULL, 't')`,
      )
      .run()
    db(s)
      .prepare(
        `INSERT INTO issues (id, repo_path, seq, title, stage, parent_branch, default_agent,
           created_at, updated_at)
         VALUES ('iss_1', '/r/sub', 1, 'A', 'backlog', 'main', 'claude-code', 't', 't'),
                ('iss_2', '/unregistered', 1, 'B', 'backlog', 'main', 'claude-code', 't', 't')`,
      )
      .run()
    // @ts-expect-error private method
    s.backfillRepoIds()
    const repos = s.repos.listRepos()
    expect(repos.find((r) => r.path === '/r')?.repoId).toBe(
      deriveRepoId({ originUrl: 'git@github.com:o/r.git', machineId: 'm1', path: '/r' }),
    )
    expect(repos.find((r) => r.path === '/no-origin')?.repoId).toBe(
      deriveRepoId({ machineId: 'm2', path: '/no-origin' }),
    )
    // Issue under a registered repo inherits its repo_id via prefix match…
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(repos.find((r) => r.path === '/r')?.repoId)
    // …and an unregistered repo_path gets the deterministic '__local__' fallback.
    expect(s.issues.getIssue('iss_2')?.repoId).toBe(
      deriveRepoId({ machineId: '__local__', path: '/unregistered' }),
    )
    s.close()
  })

  it('addRepo derives repo_id (origin-based when given, path-fallback otherwise)', () => {
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/a', 'm1', 'https://github.com/o/r')
    s.repos.addRepo('/b', 'm1')
    const rows = s.repos.listRepos()
    expect(rows.find((r) => r.path === '/a')?.repoId).toBe(
      deriveRepoId({ originUrl: 'https://github.com/o/r', machineId: 'm1', path: '/a' }),
    )
    expect(rows.find((r) => r.path === '/b')?.repoId).toBe(
      deriveRepoId({ machineId: 'm1', path: '/b' }),
    )
    s.close()
  })

  it('two paths with the same origin share one repo_id', () => {
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/clone/one', 'm1', 'git@github.com:o/r.git')
    s.repos.addRepo('/clone/two', 'm2', 'https://github.com/o/r')
    const rows = s.repos.listRepos()
    expect(rows[0]?.repoId).toBe(rows[1]?.repoId)
    s.close()
  })

  it('updateRepoOrigin upgrades a path-fallback id (and its issues) but not an origin-derived id', () => {
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/r', 'm1') // no origin → path fallback
    s.issues.upsertIssue(issueRow({ id: 'iss_1', repoPath: '/r' }))
    s.issues.upsertIssue(issueRow({ id: 'iss_2', repoPath: '/r/nested', seq: 2 }))
    s.issues.upsertIssue(issueRow({ id: 'iss_3', repoPath: '/other', seq: 3 }))
    const fallback = deriveRepoId({ machineId: 'm1', path: '/r' })
    expect(s.repos.listRepos()[0]?.repoId).toBe(fallback)
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(fallback)

    s.repos.updateRepoOrigin('m1', '/r', 'git@github.com:o/r.git')
    const originId = deriveRepoId({ originUrl: 'git@github.com:o/r.git', machineId: 'm1', path: '/r' })
    expect(s.repos.listRepos()[0]?.repoId).toBe(originId)
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(originId)
    expect(s.issues.getIssue('iss_2')?.repoId).toBe(originId)
    // untouched: issue outside the repo
    expect(s.issues.getIssue('iss_3')?.repoId).toBe(
      deriveRepoId({ machineId: '__local__', path: '/other' }),
    )

    // A later, different origin must NOT rewrite the established identity.
    s.repos.updateRepoOrigin('m1', '/r', 'git@github.com:fork/r.git')
    expect(s.repos.listRepos()[0]?.repoId).toBe(originId)
    expect(s.repos.listRepos()[0]?.originUrl).toBe('git@github.com:fork/r.git')
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(originId)
    s.close()
  })

  it('upsertIssue dual-writes repo_id from the registered repo prefix match', () => {
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/repo', 'm1', 'https://github.com/o/repo')
    s.issues.upsertIssue(issueRow({ id: 'iss_1', repoPath: '/repo' }))
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(
      deriveRepoId({ originUrl: 'https://github.com/o/repo', machineId: 'm1', path: '/repo' }),
    )
    s.close()
  })
})
