import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asMachineId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { deriveRepoId } from './repo-id'
import type { IssueRow, SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

function db(store: SessionStore) {
  // @ts-expect-error private db — schema/migration assertions
  return store.db
}

function issueRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId('iss_x'),
    repoPath: '/r',
    seq: 1,
    title: 'X',
    description: '',
    stage: 'backlog',
    ownerUserId: FIRST_ADMIN_USER_ID,
    visibility: 'personal',
    createdByActor: FIRST_ADMIN_USER_ID,
    createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    createdAt: 't',
    updatedAt: 't',
    archived: false,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    design: null,
    acceptance: null,
    notes: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    ...over,
  }
}

describe('repo_id schema (v8, #74)', () => {
  it('fresh DB has repo_id columns on repos and issues', () => {
    const s = openTestStore(':memory:')
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

  it('addRepo derives repo_id (origin-based when given, path-fallback otherwise)', () => {
    const s = openTestStore(':memory:')
    s.repos.addRepo('/a', asMachineId('m1'), 'https://github.com/o/r')
    s.repos.addRepo('/b', asMachineId('m1'))
    const rows = s.repos.listRepos()
    expect(rows.find((r) => r.path === '/a')?.repoId).toBe(
      deriveRepoId({
        originUrl: 'https://github.com/o/r',
        machineId: asMachineId('m1'),
        path: '/a',
      }),
    )
    expect(rows.find((r) => r.path === '/b')?.repoId).toBe(
      deriveRepoId({ machineId: asMachineId('m1'), path: '/b' }),
    )
    s.close()
  })

  it('two paths with the same origin share one repo_id', () => {
    const s = openTestStore(':memory:')
    s.repos.addRepo('/clone/one', asMachineId('m1'), 'git@github.com:o/r.git')
    s.repos.addRepo('/clone/two', asMachineId('m2'), 'https://github.com/o/r')
    const rows = s.repos.listRepos()
    expect(rows[0]?.repoId).toBe(rows[1]?.repoId)
    s.close()
  })

  it('updateRepoOrigin upgrades a path-fallback id (and its issues) but not an origin-derived id', () => {
    const s = openTestStore(':memory:')
    s.repos.addRepo('/r', asMachineId('m1')) // no origin → path fallback
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_1'), repoPath: '/r' }))
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_2'), repoPath: '/r/nested', seq: 2 }))
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_3'), repoPath: '/other', seq: 3 }))
    const fallback = deriveRepoId({ machineId: asMachineId('m1'), path: '/r' })
    expect(s.repos.listRepos()[0]?.repoId).toBe(fallback)
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(fallback)

    s.repos.updateRepoOrigin(asMachineId('m1'), '/r', 'git@github.com:o/r.git')
    const originId = deriveRepoId({
      originUrl: 'git@github.com:o/r.git',
      machineId: asMachineId('m1'),
      path: '/r',
    })
    expect(s.repos.listRepos()[0]?.repoId).toBe(originId)
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(originId)
    expect(s.issues.getIssue('iss_2')?.repoId).toBe(originId)
    // untouched: issue outside the repo (path-fallback under THIS host — see above)
    expect(s.issues.getIssue('iss_3')?.repoId).toBe(
      deriveRepoId({ machineId: s.hostMachineId, path: '/other' }),
    )

    // A later, different origin must NOT rewrite the established identity.
    s.repos.updateRepoOrigin(asMachineId('m1'), '/r', 'git@github.com:fork/r.git')
    expect(s.repos.listRepos()[0]?.repoId).toBe(originId)
    expect(s.repos.listRepos()[0]?.originUrl).toBe('git@github.com:fork/r.git')
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(originId)
    s.close()
  })

  it('upsertIssue dual-writes repo_id from the registered repo prefix match', () => {
    const s = openTestStore(':memory:')
    s.repos.addRepo('/repo', asMachineId('m1'), 'https://github.com/o/repo')
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_1'), repoPath: '/repo' }))
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(
      deriveRepoId({
        originUrl: 'https://github.com/o/repo',
        machineId: asMachineId('m1'),
        path: '/repo',
      }),
    )
    s.close()
  })
})

/**
 * WHAT THE RETIRED UPGRADE LEFT: A REFUSAL (POD-1360, retired at POD-3246).
 *
 * The rewrite that filled `repo_id` on pre-v8 rows is gone. It could go because
 * every writer left derives an id before it inserts and the last one that could
 * not — the legacy `repos.json` import — was itself retired: nothing has written
 * that file since 2026-06-09, ten weeks before the first release.
 *
 * What a database with an unfilled `repo_id` means is unchanged, and it is not
 * cosmetic: `repo_id` is what issues are bucketed and numbered by, so serving one
 * means serving rows that belong to no repo. The boot refuses instead.
 */
describe('the repo-identity boot refusal (POD-1360)', () => {
  it('refuses to open a database whose repo rows carry no repo_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-repo-refusal-'))
    try {
      const file = join(dir, 'podium.db')
      // Plant the legacy row behind the repository, which is the only way to make
      // one: `addRepo` derives an id before it inserts.
      const first = openTestStore(file)
      db(first)
        .prepare(
          `INSERT INTO repos (machine_id, path, origin_url, added_at)
           VALUES ('m1', '/legacy', NULL, 't')`,
        )
        .run()
      first.close()

      expect(() => openTestStore(file)).toThrow(/legacy repo identity is unfilled.*repos: 1/s)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses when the unfilled row is an issue rather than a repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-issue-refusal-'))
    try {
      const file = join(dir, 'podium.db')
      const first = openTestStore(file)
      db(first)
        .prepare(
          `INSERT INTO issues (id, repo_path, seq, title, stage, parent_branch, default_agent,
             created_at, updated_at)
           VALUES ('iss_legacy', '/legacy', 1, 'A', 'backlog', 'main', 'claude-code', 't', 't')`,
        )
        .run()
      first.close()

      expect(() => openTestStore(file)).toThrow(/legacy repo identity is unfilled.*issues: 1/s)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens a database whose rows all carry one — the refusal is not always-on', () => {
    // The counterfactual for both tests above: the same boot path, on the ordinary
    // state, does not throw. Without it they would pass against a store that
    // refused every database.
    const dir = mkdtempSync(join(tmpdir(), 'podium-repo-refusal-ok-'))
    try {
      const file = join(dir, 'podium.db')
      const first = openTestStore(file)
      first.repos.addRepo('/ordinary', first.hostMachineId)
      first.close()

      const second = openTestStore(file)
      expect(second.repos.listRepoPaths()).toEqual(['/ordinary'])
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A STORED REPO ID IS OPAQUE, AND NOTHING RE-DERIVES IT (POD-318).
 *
 * A `repo_id` is OPAQUE STORED IDENTITY. Issues, locks, prefixes and the session
 * view all key off it, so rewriting one cascades into every referencing row for
 * zero product value — which is why the retired machine-identity upgrade moved
 * `machine_id` and never touched `repo_id`, even though a path-fallback id was
 * derived FROM the machine id it was moving off.
 *
 * These pin the property that made that safe and still governs every reader: a
 * repo that has a row answers with its STORED id, so no reader re-derives to
 * find it, and a repo minted under another machine keeps its id here.
 */
describe('stored repo ids are read, never re-derived', () => {
  it('a registered path resolves to the STORED id, never to a fresh derivation', () => {
    // The property the design asked to be PROVEN, at the one function every reader
    // goes through: `resolveRepoIdForPath` returns `match?.repoId` for anything a
    // repo row claims, so the derivation below is unreachable for it — and the
    // counterfactual is right there, since deriving the same path under this host
    // gives a DIFFERENT id.
    const s = openTestStore(':memory:')
    s.repos.addRepo('/legacy', asMachineId('11112222-3333-4444-5555-666677778888'))

    const stored = s.repos.listRepos()[0]?.repoId
    expect(s.repos.resolveRepoIdForPath('/legacy')).toBe(stored)
    expect(s.repos.resolveRepoIdForPath('/legacy/deep/inside')).toBe(stored)
    expect(deriveRepoId({ machineId: s.hostMachineId, path: '/legacy' })).not.toBe(stored)
    // And its issues keep pointing at it.
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_1'), repoPath: '/legacy' }))
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(stored)
    s.close()
  })

  it('an UNREGISTERED path is the one re-derive lookup, and it derives under this host', () => {
    // KNOWN LIMIT, pinned rather than hidden. `resolveRepoIdForPath` is used as a
    // lookup key (`store/issues.ts` issue-by-repo queries, `prefixForPath`), and for
    // a path no repo row claims it DERIVES rather than reads. That derivation used
    // to be namespaced by `'__local__'` and is now namespaced by this host, so an
    // issue whose repo was never registered was stored under the old namespace and
    // is looked up under the new one. Registering the repo — the ordinary state —
    // returns the stored id and makes the question moot; see the test above.
    const s = openTestStore(':memory:')
    expect(s.repos.resolveRepoIdForPath('/nowhere')).toBe(
      deriveRepoId({ machineId: s.hostMachineId, path: '/nowhere' }),
    )
    s.close()
  })
})
