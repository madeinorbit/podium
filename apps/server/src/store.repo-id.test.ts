import { FIRST_ADMIN_USER_ID, SOLE_USER_ID, asIssueId } from '@podium/model'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    id: asIssueId('iss_x'), repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
    ownerUserId: FIRST_ADMIN_USER_ID, visibility: 'personal', createdByActor: FIRST_ADMIN_USER_ID,
    createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
    worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
    defaultModel: 'auto', defaultEffort: 'auto',
    linearId: null, linearIdentifier: null, linearUrl: null, activityNotes: null,
    notesUpdatedAt: null, suggestedStage: null, suggestedReason: null, blockedBy: [],
    dependencyNote: null, prUrl: null, createdAt: 't', updatedAt: 't', archived: false,
    priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
    notes: null, dueAt: null, deferUntil: null, closedReason: null, closedAt: null, supersededBy: null,
    duplicateOf: null, estimateMin: null,
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

  it('the one-time upgrade fills repo_id on pre-v8 repos and issues rows', () => {
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
    s.migrateLegacyRepoIdentity()
    const repos = s.repos.listRepos()
    expect(repos.find((r) => r.path === '/r')?.repoId).toBe(
      deriveRepoId({ originUrl: 'git@github.com:o/r.git', machineId: 'm1', path: '/r' }),
    )
    expect(repos.find((r) => r.path === '/no-origin')?.repoId).toBe(
      deriveRepoId({ machineId: 'm2', path: '/no-origin' }),
    )
    // Issue under a registered repo inherits its repo_id via prefix match…
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(repos.find((r) => r.path === '/r')?.repoId)
    // …and an unregistered repo_path gets the deterministic (host, path) fallback.
    // POD-318: the machine half of that derivation is this host's minted id, not the
    // `'__local__'` placeholder it used to be. A path NOBODY has registered is the
    // only thing that ever reaches it — every registered repo returns its STORED id,
    // untouched by the identity change (see `resolveRepoIdForPath`).
    expect(s.issues.getIssue('iss_2')?.repoId).toBe(
      deriveRepoId({ machineId: s.hostMachineId, path: '/unregistered' }),
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
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_1'), repoPath: '/r' }))
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_2'), repoPath: '/r/nested', seq: 2 }))
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_3'), repoPath: '/other', seq: 3 }))
    const fallback = deriveRepoId({ machineId: 'm1', path: '/r' })
    expect(s.repos.listRepos()[0]?.repoId).toBe(fallback)
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(fallback)

    s.repos.updateRepoOrigin('m1', '/r', 'git@github.com:o/r.git')
    const originId = deriveRepoId({ originUrl: 'git@github.com:o/r.git', machineId: 'm1', path: '/r' })
    expect(s.repos.listRepos()[0]?.repoId).toBe(originId)
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(originId)
    expect(s.issues.getIssue('iss_2')?.repoId).toBe(originId)
    // untouched: issue outside the repo (path-fallback under THIS host — see above)
    expect(s.issues.getIssue('iss_3')?.repoId).toBe(
      deriveRepoId({ machineId: s.hostMachineId, path: '/other' }),
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
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_1'), repoPath: '/repo' }))
    expect(s.issues.getIssue('iss_1')?.repoId).toBe(
      deriveRepoId({ originUrl: 'https://github.com/o/repo', machineId: 'm1', path: '/repo' }),
    )
    s.close()
  })
})

/**
 * THE UPGRADE IS BOUNDED, NOT A STANDING HEAL (POD-1360).
 *
 * The four heals this replaced ran on EVERY boot, and one of them — the local-origin
 * step — did real work every time: a git-config read off disk per originless repo,
 * forever, because "no originless rows left" is a state a fleet with remote-machine
 * repos never reaches. These pin the two halves of the replacement: the upgrade does
 * the legacy work when a database has not seen it, and does NOT run again afterwards.
 */
describe('the repo-identity upgrade is spent once per database (POD-1360)', () => {
  /** A legacy pair — a repo row and an issue row, both with no repo_id. */
  function insertLegacyRows(s: SessionStore): void {
    db(s)
      .prepare(
        `INSERT INTO repos (machine_id, path, origin_url, added_at)
         VALUES ('m1', '/legacy', 'git@github.com:o/r.git', 't')`,
      )
      .run()
    db(s)
      .prepare(
        `INSERT INTO issues (id, repo_path, seq, title, stage, parent_branch, default_agent,
           created_at, updated_at)
         VALUES ('iss_legacy', '/legacy', 1, 'A', 'backlog', 'main', 'claude-code', 't', 't')`,
      )
      .run()
  }

  function nullRepoIdCounts(s: SessionStore): { repos: number; issues: number } {
    const count = (sql: string) => (db(s).prepare(sql).get() as { c: number }).c
    return {
      repos: count('SELECT COUNT(*) AS c FROM repos WHERE repo_id IS NULL'),
      issues: count('SELECT COUNT(*) AS c FROM issues WHERE repo_id IS NULL'),
    }
  }

  it('a database that has never seen it gets the legacy rows filled; the next boot does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-repo-upgrade-'))
    try {
      const file = join(dir, 'podium.db')
      // First boot on a fresh file spends the upgrade (there is nothing to do) and
      // stamps the marker. Legacy rows planted AFTER it are the probe.
      const first = new SessionStore(file)
      insertLegacyRows(first)
      first.close()

      // Second boot: the marker is set, so the upgrade must not run — the planted
      // rows are still NULL. This is the assertion the old per-boot heal could not
      // make, and it is what "bounded" means here.
      const second = new SessionStore(file)
      expect(nullRepoIdCounts(second)).toEqual({ repos: 1, issues: 1 })
      // Clearing the marker is the counterfactual: the SAME boot path, on a database
      // that has not been past this code, does fill them. Without this the test above
      // would pass just as well if the upgrade had been deleted outright.
      db(second).prepare("DELETE FROM meta WHERE key = 'repo-identity-upgrade'").run()
      second.close()

      const third = new SessionStore(file)
      expect(nullRepoIdCounts(third)).toEqual({ repos: 0, issues: 0 })
      expect(third.issues.getIssue('iss_legacy')?.repoId).toBe(
        deriveRepoId({ originUrl: 'git@github.com:o/r.git', machineId: 'm1', path: '/legacy' }),
      )
      // …and it re-stamps the marker, so a fourth boot is bounded again.
      expect(
        db(third).prepare("SELECT value FROM meta WHERE key = 'repo-identity-upgrade'").get(),
      ).toBeDefined()
      third.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records the local origin for a repo whose checkout this host can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-repo-origin-'))
    try {
      // A checkout on disk with an origin, registered the way a pre-v8 row was:
      // origin_url NULL, so the row sits on a path-fallback id until something reads
      // the git config. The upgrade is now the only thing at boot that does.
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(
        join(dir, '.git', 'config'),
        '[remote "origin"]\n\turl = git@github.com:o/local.git\n',
      )
      const s = new SessionStore(':memory:')
      db(s)
        .prepare(
          `INSERT INTO repos (machine_id, path, origin_url, added_at)
           VALUES ('m1', ?, NULL, 't')`,
        )
        .run(dir)

      s.migrateLegacyRepoIdentity()

      const row = s.repos.listRepos()[0]
      expect(row?.originUrl).toBe('git@github.com:o/local.git')
      // The identity upgraded with it — a path fallback replaced by the origin-derived
      // id, which is the whole reason the origin read was worth doing at all.
      expect(row?.repoId).toBe(
        deriveRepoId({ originUrl: 'git@github.com:o/local.git', machineId: 'm1', path: dir }),
      )
      // And the prefix step ran after it, keyed on the settled id (#474).
      expect(s.repos.prefixForRepoId(row!.repoId!)).not.toBeNull()
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails the boot loudly when a repo_id survives the rewrite', () => {
    // THE RESIDUE CHECK MUST BE ABLE TO FIRE, or it is decoration. Stubbing the repos
    // half out is the only way to produce the state it guards — the derivation cannot
    // fail, so in production a survivor means the rewrite did not run. That is exactly
    // what this simulates, and the check catches it on its own second read.
    const s = new SessionStore(':memory:')
    db(s)
      .prepare(
        `INSERT INTO repos (machine_id, path, origin_url, added_at)
         VALUES ('m1', '/legacy', NULL, 't')`,
      )
      .run()
    s.repos.migrateLegacyRepoRows = () => {}

    expect(() => s.migrateLegacyRepoIdentity()).toThrow(/legacy repo identity survived/)
    s.close()
  })
})

/**
 * REPO-ID STABILITY ACROSS THE MACHINE-IDENTITY CHANGE (POD-318).
 *
 * A `repo_id` is OPAQUE STORED IDENTITY. Issues, locks, prefixes and the session
 * view all key off it, so rewriting one cascades into every referencing row for
 * zero product value — which is why the boot upgrade moves `machine_id` and does
 * not touch `repo_id`, even though a path-fallback id was derived FROM the machine
 * id it is moving off.
 *
 * These pin the property that makes that safe: a repo that has a row answers with
 * its STORED id, so no reader re-derives to find it.
 */
describe('stored repo ids survive the machine-identity upgrade untouched', () => {
  it('the row keeps the id it was minted with after its machine_id is rewritten', () => {
    const s = new SessionStore(':memory:')
    // A pre-POD-318 row: minted under the placeholder, machine column since moved.
    s.repos.addRepo('/legacy', '__local__')
    const minted = s.repos.listRepos()[0]?.repoId
    expect(minted).toBe(deriveRepoId({ machineId: '__local__', path: '/legacy' }))

    s.migrateLegacyMachineIdentity(s.hostMachineId)

    const row = s.repos.listRepos()[0]
    expect(row?.machineId).toBe(s.hostMachineId)
    // The id did NOT move with the machine. That is the whole decision.
    expect(row?.repoId).toBe(minted)
    s.close()
  })

  it('a registered path resolves to the STORED id, never to a fresh derivation', () => {
    // The property the design asked to be PROVEN, at the one function every reader
    // goes through: `resolveRepoIdForPath` returns `match?.repoId` for anything a
    // repo row claims, so the derivation below is unreachable for it — and the
    // counterfactual is right there, since deriving the same path under this host
    // gives a DIFFERENT id.
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/legacy', '__local__')
    s.migrateLegacyMachineIdentity(s.hostMachineId)

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
    const s = new SessionStore(':memory:')
    expect(s.repos.resolveRepoIdForPath('/nowhere')).toBe(
      deriveRepoId({ machineId: s.hostMachineId, path: '/nowhere' }),
    )
    s.close()
  })
})
