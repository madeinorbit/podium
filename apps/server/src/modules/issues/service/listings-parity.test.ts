/**
 * Issue listings and reports answer from SQL as they did from the issue map
 * (POD-6191, part of POD-6158; design §7 step 3.2).
 *
 * Every listing asks both: SQL answers, the map's code (`reads-legacy.ts`)
 * answers beside it, and under vitest the comparison throws on a difference.
 * This file drives every listing over the benchmark corpus (POD-6146: cell
 * h1a1, seed 4443, when PODIUM_ISSUE_MAP_CORPUS=1), for the server and for three readers (the owner of most
 * issues, one who owns some and holds read, write and non-reading grants on
 * others, one who sees nothing), and over edge fixtures: deleted, archived,
 * quarantined rows, nested parents across repositories, labels, blockers that
 * are deleted or gone, deferrals in every spelling, and search filters.
 */

import { asIssueId, asUserId, firstAdminMemberId, type IssueSearchFilter, type UserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../../store'
import { applyAfterCommit, spanOpen } from '../../../store/executor/executor'
import {
  BOB,
  CAROL,
  type CorpusIssue,
  exportedCorpus,
  foldedDeps,
  grantIssue,
  rawSql,
  seededStore,
} from '../../../test-support/issue-corpus'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { IssueStore } from './core'
import { issueMapParityMode } from './map-parity'
import { type IssueReader, IssueReportsModule, UNRESTRICTED_READER } from './reads'
import type { IssueDeps } from './types'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function reportsOver(store: SessionStore, log = ''): Promise<IssueReportsModule> {
  const issues = await new IssueStore({
    store,
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
    ...sessionReadPorts(() => []),
    repoOp: async () => ({ ok: true, output: log }),
  } as unknown as IssueDeps).init()
  return new IssueReportsModule(issues)
}

/** The command context's reader, built the way `IssueCommandCtx` builds it. */
function readerFor(reports: IssueReportsModule, user: UserId): IssueReader {
  return {
    readableBy: () => user,
    mayRead: async (id) => {
      const target = await reports.ownedTarget(id, 'read')
      return target !== undefined && (target.owner === user || target.grants.includes(user))
    },
  }
}

/** Every listing for one scope and reader; a difference throws. */
async function everyListing(
  reports: IssueReportsModule,
  repoPath: string | undefined,
  reader: IssueReader,
  sample: {
    parents: readonly string[]
    bound: readonly string[]
    seqs: readonly number[]
    /** Roots for the subtree dependency report: the old one walks every issue
     *  per level with an awaited check per row, so only small subtrees. */
    depRoots?: readonly string[]
  },
): Promise<number> {
  let asked = 0
  const ask = async (run: () => Promise<unknown>) => {
    await run()
    asked++
  }
  await ask(() => reports.list(repoPath, reader))
  await ask(() => reports.readyList(repoPath, reader))
  await ask(() => reports.blockedList(repoPath, reader))
  await ask(() => reports.graph(repoPath, reader))
  await ask(() => reports.closeEligibleEpics(repoPath, reader))
  await ask(() => reports.staleList(repoPath, 30, Date.parse('2026-10-16T00:00:00.000Z'), reader))
  await ask(() => reports.doctor(repoPath, reader))
  await ask(() => reports.count(repoPath, reader))
  await ask(() => reports.stats(repoPath, reader))
  await ask(() => reports.depReport({ ...(repoPath ? { repoPath } : {}) }, reader))
  for (const status of ['open', 'closed', 'ready', 'blocked', 'deferred'] as const) {
    await ask(() => reports.search({ ...(repoPath ? { repoPath } : {}), status }, reader))
  }
  await ask(() => reports.search({ ...(repoPath ? { repoPath } : {}), text: 'issue 1', priority: 2 }, reader))
  if (repoPath) {
    // Jaccard is quadratic in the scope: per repository only.
    await ask(() => reports.findDuplicates(repoPath, 0.6, reader))
    await ask(() => reports.orphans(repoPath, reader))
    for (const seq of sample.seqs) await ask(() => reports.getBySeq(repoPath, seq))
  }
  for (const id of sample.parents) {
    const tolerate = async (run: () => Promise<unknown>) => {
      try {
        await ask(run)
      } catch (err) {
        // A root the reader may not see is refused on both sides alike.
        if (!(err instanceof Error) || !/unknown|not found|iss_/i.test(err.message)) throw err
      }
    }
    await tolerate(() => reports.children(id, false, reader))
    await tolerate(() => reports.children(id, true, reader))
    await tolerate(() => reports.epicStatus(id, reader))
    await tolerate(() => reports.tree(id, {}, reader))
    await tolerate(() => reports.tree(id, { maxDepth: 1, maxNodes: 5 }, reader))
  }
  for (const id of sample.depRoots ?? sample.parents) {
    try {
      await ask(() => reports.depReport({ id }, reader))
    } catch (err) {
      if (!(err instanceof Error) || !/unknown|not found|iss_/i.test(err.message)) throw err
    }
  }
  for (const id of sample.bound) {
    await ask(() => reports.prime({ ...(repoPath ? { repoPath } : {}), boundIssueId: asIssueId(id) }, reader))
  }
  await ask(() => reports.prime({ ...(repoPath ? { repoPath } : {}), boundIssueId: null }, reader))
  return asked
}

describe('issue listings: SQL answers as the issue map', () => {
  it('compares in throw mode under vitest', () => {
    expect(issueMapParityMode()).toBe('throw')
  })

  // About five minutes on the agents VM: the old side builds every report from
  // the map. Run on purpose (PODIUM_ISSUE_MAP_CORPUS=1) for each reader group's
  // landing; the edge fixtures below always run.
  it.runIf(process.env.PODIUM_ISSUE_MAP_CORPUS === '1')('over the benchmark corpus, for the server and three readers', async () => {
    const corpus = await exportedCorpus()
    const repos = [...new Set([...corpus.repos, ...corpus.issues.flatMap((row) => (row.repoPath ? [row.repoPath] : []))])]
    const rows: CorpusIssue[] = corpus.issues.map((row, index) => ({
      ...row,
      id: `iss_${row.id}`,
      parentId: row.parentId ? `iss_${row.parentId}` : null,
      ...(index % 5 === 1 ? { ownerUserId: BOB } : {}),
    }))
    const ids = new Set(rows.map((row) => row.id))
    const deps = foldedDeps(
      corpus.deps.map((dep) => ({ ...dep, fromId: `iss_${dep.fromId}`, toId: `iss_${dep.toId}` })),
      ids,
    )
    const store = await seededStore(rows, repos, deps)
    stores.push(store)
    const viewer = await firstAdminMemberId(store)
    await store.transact(async () => {
      for (const [index, row] of rows.entries()) {
        if (index % 7 === 0) await grantIssue(store, row.id, BOB, 'read')
        if (index % 11 === 0) await grantIssue(store, row.id, BOB, 'write')
        if (index % 13 === 0) await grantIssue(store, row.id, BOB, 'see')
        if (index % 17 === 0) await grantIssue(store, row.id, CAROL, 'use')
        if (index % 9 === 0) {
          await store.issues.setIssueUserState(viewer, asIssueId(row.id), { readAt: '2026-10-01T00:00:00.000Z' })
        }
      }
    })
    await store.issues.setIssueLabels(asIssueId(rows[0]!.id), ['alpha', 'beta'])
    const reports = await reportsOver(store, rows.slice(0, 50).map((row) => `#${row.seq} fixed`).join('\n'))
    // The busiest repositories, and parents with the deepest subtrees.
    const sizes = new Map<string, number>()
    for (const row of rows) if (row.repoPath) sizes.set(row.repoPath, (sizes.get(row.repoPath) ?? 0) + 1)
    const busiest = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path]) => path)
    const childCounts = new Map<string, number>()
    for (const row of rows) if (row.parentId) childCounts.set(row.parentId, (childCounts.get(row.parentId) ?? 0) + 1)
    const ranked = [...childCounts.entries()].sort((a, b) => b[1] - a[1])
    const parents = ranked.slice(0, 3).map(([id]) => id)
    const depRoots = ranked.filter(([, n]) => n >= 2 && n <= 4).slice(0, 2).map(([id]) => id)
    const bound = [parents[0]!, rows.find((row) => !row.deletedAt && row.parentId)!.id]
    const sample = { parents, bound, seqs: [1, 2, 3], depRoots }
    let asked = 0
    // Every issue at once, for the server's own reads.
    asked += await everyListing(reports, undefined, UNRESTRICTED_READER, { parents: [], bound: [], seqs: [], depRoots: [] })
    for (const reader of [UNRESTRICTED_READER, readerFor(reports, viewer), readerFor(reports, BOB), readerFor(reports, CAROL)]) {
      for (const repoPath of busiest) asked += await everyListing(reports, repoPath, reader, sample)
      asked += await everyListing(reports, '/no/such/repo', reader, { parents: [], bound: [], seqs: [1], depRoots: [] })
    }
    console.log('listing parity over the corpus', JSON.stringify({ issues: rows.length, repos: repos.length, asked }))
    expect(rows.some((row) => row.deletedAt)).toBe(true)
    expect(asked).toBeGreaterThan(200)
  }, 600_000)

  it('over the edge fixtures', async () => {
    const live = (seq: number, patch: Partial<CorpusIssue> = {}): CorpusIssue => ({
      id: `iss_${seq}`, seq, repoPath: '/a', worktreePath: null, parentId: null, stage: 'backlog',
      archived: false, deletedAt: null, updatedAt: '2026-06-01T00:00:00.000Z', ...patch,
    })
    const rows: CorpusIssue[] = [
      live(1, { title: 'Epic about login', type: 'phase' }),
      live(2, { parentId: 'iss_1', title: 'Login form', description: 'Fix the LOGIN form' }),
      live(3, { parentId: 'iss_2', worktreePath: '/a/.worktrees/issue-3', stage: 'in_progress' }),
      live(4, { parentId: 'iss_1', deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(5, { parentId: 'iss_1', archived: true, stage: 'done' }),
      live(6, { stage: 'done', closedReason: 'done' }),
      live(7, { closedReason: 'cancelled' }),
      live(8, { deferUntil: 'next-message' }),
      live(9, { deferUntil: '2099-01-01' }),
      live(10, { deferUntil: '2000-01-01T00:00:00.000Z' }),
      live(11, { deferUntil: 'not a date' }),
      live(12, { stage: 'proposed' }),
      live(13, { stage: 'shipping' }),
      live(14, { priority: 0, title: 'Ünïcode lögin', updatedAt: '2026-09-30T00:00:00.000Z' }),
      live(15, { ownerUserId: BOB, parentId: 'iss_1' }),
      live(16, { ownerUserId: CAROL }),
      // A second repository: the same numbers, and a child of a parent in /a.
      live(1, { id: 'iss_b1', repoPath: '/b', parentId: 'iss_1', title: 'Login elsewhere' }),
      live(2, { id: 'iss_b2', repoPath: '/b', worktreePath: '/b/.worktrees/issue-2', stage: 'done' }),
      live(3, { id: 'iss_b3', repoPath: '/b', stage: 'done', closedReason: 'done', worktreePath: '/b/wt-3' }),
      live(17, { id: 'iss_gone_blocker' }),
    ]
    const store = await seededStore(rows, ['/a', '/b'], [
      { fromId: 'iss_2', toId: 'iss_3', type: 'blocked-by' },
      { fromId: 'iss_3', toId: 'iss_4', type: 'blocked-by' }, // a deleted, open blocker still blocks
      { fromId: 'iss_8', toId: 'iss_6', type: 'blocked-by' }, // a finished blocker does not
      { fromId: 'iss_9', toId: 'iss_gone_blocker', type: 'blocked-by' },
      { fromId: 'iss_10', toId: 'iss_b1', type: 'blocked-by' },
      { fromId: 'iss_b1', toId: 'iss_2', type: 'related' },
      { fromId: 'iss_12', toId: 'iss_13', type: 'blocked-by' },
      { fromId: 'iss_13', toId: 'iss_12', type: 'blocked-by' }, // a cycle for doctor
      { fromId: 'iss_14', toId: 'iss_16', type: 'duplicates' },
    ])
    stores.push(store)
    // A blocker whose row is gone (hard delete cascades its edges, so the edge
    // is planted after with the foreign keys off).
    await store.issues.deleteIssue('iss_gone_blocker')
    rawSql(store, 'PRAGMA foreign_keys = OFF')
    rawSql(store, "INSERT INTO issue_deps (from_id, to_id, type) VALUES ('iss_9', 'iss_gone_blocker', 'blocked-by')")
    rawSql(store, 'PRAGMA foreign_keys = ON')
    await store.issues.setIssueLabels(asIssueId('iss_2'), ['ui', 'auth'])
    await store.issues.setIssueLabels(asIssueId('iss_b1'), ['auth'])
    await grantIssue(store, 'iss_2', BOB, 'read')
    await grantIssue(store, 'iss_3', BOB, 'see')
    await grantIssue(store, 'iss_b1', BOB, 'manage')
    await grantIssue(store, 'iss_16', BOB, 'write')
    const viewer = await firstAdminMemberId(store)
    await store.issues.setIssueUserState(viewer, asIssueId('iss_2'), { readAt: '2026-10-01T00:00:00.000Z', pinnedAt: '2026-10-02T00:00:00.000Z' })
    // Quarantined: a NULL id (SQLite allows one in a TEXT primary key).
    await store.issues.upsertIssue({ ...(await store.issues.getIssue('iss_7'))!, id: asIssueId('iss_corrupt'), seq: 99, revision: undefined } as never)
    rawSql(store, 'UPDATE issues SET id = NULL WHERE id = ?', 'iss_corrupt')
    const reports = await reportsOver(store, 'abc fix #2 and issue/3-login\n#14 done')
    const sample = { parents: ['iss_1', 'iss_2', 'iss_b1'], bound: ['iss_1', 'iss_2', 'iss_15'], seqs: [1, 2, 3, 4] }
    for (const reader of [UNRESTRICTED_READER, readerFor(reports, viewer), readerFor(reports, BOB), readerFor(reports, CAROL)]) {
      for (const repoPath of [undefined, '/a', '/b']) await everyListing(reports, repoPath, reader, sample)
      const filters: IssueSearchFilter[] = [
        { text: 'login' }, { text: 'LÖGIN' }, { label: 'auth' }, { parentId: asIssueId('iss_1') },
        { stage: 'done' }, { type: 'phase' }, { assignee: asUserId('nobody') }, { priority: 0 },
      ]
      for (const filter of filters) {
        await reports.search(filter, reader)
        await reports.search({ ...filter, repoPath: '/a' }, reader)
      }
    }
    await reports.closedWithWork(new Set(['iss_6', 'iss_7', 'iss_b3']))
    await reports.closedWithWork(new Set())
    // The answers themselves, on the SQL side, for the cases the map never had.
    expect((await reports.blockedList('/a')).map((r) => r.id)).toEqual(expect.arrayContaining(['iss_2', 'iss_3']))
    expect((await reports.readyList('/a')).map((r) => r.id)).not.toContain('iss_9')
    expect((await reports.doctor('/a')).cycles.length).toBeGreaterThan(0)
  })
})
