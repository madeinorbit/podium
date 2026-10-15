/**
 * "Which issue owns this folder" answers like the durable access index always
 * did (POD-6155 step 5).
 *
 * Before the world index and the access index's whole-table scans were
 * deleted, this file compared them with the new indexed query over the
 * benchmark corpus (POD-6146: cell h1a1, seed 4443) and these edge cases, at
 * the commit that adds it. What stays is the edge-case part, as a regression
 * test against an oracle that runs the old algorithm (`isMemberCwd` over every
 * live row in repository order, the deepest `machinePathKey` winning) on the
 * fixture rows: nested worktrees, repo roots, deleted and archived issues,
 * ties, trailing separators, relative paths, and Windows drive, UNC,
 * mixed-separator and mixed-case forms.
 *
 * ONE DELIBERATE DIFFERENCE, pinned at the end: a POSIX-absolute folder used to
 * count as inside a Windows-style worktree with the same tail (`/r/wt` inside
 * `C:\r\wt`), an accident of resolving a rooted path against the root's drive.
 * A folder and a worktree always come from the same machine, so the two forms
 * never meet in a real answer; the new lookup does not reproduce it.
 */

import { firstAdminMemberId, type IssueId, machinePathKey } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements } from '../../test-support/statement-count'
import { issueRowFixture } from '../../test-support/issue-row'
import { isMemberCwd } from '../../issue-util'
import { DurableIssueAccessIndex } from './access-index'
import { deepestOwner, soleOwner } from './folder-owner'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

interface CorpusIssue {
  id: string
  seq: number
  repoPath: string | null
  worktreePath: string | null
  archived: boolean
  deletedAt: string | null
}

async function seed(store: SessionStore, repos: readonly string[], rows: readonly CorpusIssue[]) {
  await store.transact(async () => {
    for (const path of repos) await store.repos.addRepo(path, store.hostMachineId)
  })
  for (let start = 0; start < rows.length; start += 500) {
    await store.transact(async () => {
      for (const row of rows.slice(start, start + 500)) {
        await store.issues.upsertIssue({
          ...issueRowFixture({ id: row.id, repoPath: row.repoPath ?? repos[0]!, seq: row.seq, ownerUserId: firstAdminMemberId() }),
          repoId: undefined,
          machineId: store.hostMachineId,
          parentId: null,
          worktreePath: row.worktreePath,
          archived: row.archived,
          deletedAt: row.deletedAt,
        } as never)
      }
    })
  }
}

/** The old algorithm, over every live fixture row in BINARY repository order. */
function oracle(rows: readonly CorpusIssue[], cwd: string, roots: ReadonlySet<string>) {
  const live = rows
    .filter((row) => !row.deletedAt)
    .map((row) => ({ ...row, key: Buffer.from(row.repoPath ?? '') }))
    .sort((a, b) => Buffer.compare(a.key, b.key) || a.seq - b.seq)
  const depth = (row: CorpusIssue) => (row.worktreePath ? machinePathKey(row.worktreePath).length : 0)
  let owner: { id: string; length: number } | undefined
  for (const row of live) {
    if (!isMemberCwd(row.worktreePath, cwd)) continue
    if (!owner || depth(row) > owner.length) owner = { id: row.id, length: depth(row) }
  }
  const candidates = live.filter((row) => !row.archived && row.worktreePath !== null
    && !roots.has(machinePathKey(row.worktreePath)) && isMemberCwd(row.worktreePath, cwd))
  const deepest = Math.max(0, ...candidates.map(depth))
  const sole = candidates.filter((row) => depth(row) === deepest)
  return { owner: (owner?.id ?? null) as IssueId | null, sole: (sole.length === 1 ? sole[0]!.id : null) as IssueId | null }
}

async function expectAnswers(store: SessionStore, rows: readonly CorpusIssue[], folders: readonly string[]) {
  const access = new DurableIssueAccessIndex(store.issues, store.grants, store.repos)
  const roots = new Set((await store.repos.listRepoPaths()).map(machinePathKey))
  const shared = await store.issues.worktreeOwnerCandidates(folders)
  const many = await access.issuesForCwds(folders)
  const mismatches: unknown[] = []
  for (const cwd of folders) {
    const want = oracle(rows, cwd, roots)
    const got = {
      owner: await access.issueForCwd(cwd),
      shared: deepestOwner(shared, cwd),
      many: many.get(cwd) ?? null,
      sole: await access.soleOwnerForCwd(cwd),
      soleShared: soleOwner(shared, cwd, roots),
    }
    const expected = { owner: want.owner, shared: want.owner, many: want.owner, sole: want.sole, soleShared: want.sole }
    if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches.push({ cwd, got, expected })
  }
  expect(mismatches).toEqual([])
}

describe('folder owner: the indexed query answers like the old algorithm', () => {
  it('over the edge cases', async () => {
    const store = await openTestStore(':memory:')
    stores.push(store)
    let seq = 0
    const issue = (worktreePath: string, over: Partial<CorpusIssue> = {}): CorpusIssue =>
      ({ id: `iss_edge_${++seq}`, seq, repoPath: '/r', worktreePath, archived: false, deletedAt: null, ...over })
    const rows: CorpusIssue[] = [
      issue('/r/.worktrees/a'),
      issue('/r/.worktrees/a/nested'), // nested worktree
      issue('/r'), // a repo root as a worktree
      issue('/r/.worktrees/deleted', { deletedAt: '2026-10-01T00:00:00Z' }),
      issue('/r/.worktrees/archived', { archived: true }),
      issue('/r/.worktrees/tie'), // two live issues at one worktree: repository order decides
      issue('/r/.worktrees/tie', { repoPath: '/a' }),
      issue('/r/.worktrees/tie', { repoPath: '/r' }),
      issue('/r/.worktrees/trailing/'), // trailing separator
      issue('/r/.worktrees/a//double'), // literal POSIX spelling
      issue('relative/wt', { repoPath: '/a' }), // relative paths stay literal
      issue('C:\\Repo\\.worktrees\\Win', { repoPath: 'C:\\Repo' }),
      issue('C:/Repo/.worktrees/forward', { repoPath: 'C:\\Repo' }), // stored with forward slashes
      issue('D:\\Trailing\\', { repoPath: 'C:\\Repo' }),
      issue('\\\\srv\\share\\wt', { repoPath: 'C:\\Repo' }), // UNC
      issue('C:\\Repo\\.worktrees\\Win\\Inner', { repoPath: 'C:\\Repo' }),
    ]
    await seed(store, ['/r', '/a', 'C:\\Repo'], rows)
    await expectAnswers(store, rows, [
      '/r', '/r/', '/r/src', '/r/.worktrees', '/r/.worktrees/a', '/r/.worktrees/a/', '/r/.worktrees/a/x',
      '/r/.worktrees/a/nested', '/r/.worktrees/a/nested/deeper', '/r/.worktrees/a-sibling',
      '/r/.worktrees/deleted/x', '/r/.worktrees/archived', '/r/.worktrees/archived/x',
      '/r/.worktrees/tie', '/r/.worktrees/tie/x',
      '/r/.worktrees/trailing', '/r/.worktrees/trailing/', '/r/.worktrees/trailing/x',
      '/r/.worktrees/a//double', '/r/.worktrees/a//double/x', '/r/.worktrees/a/double',
      'relative/wt', 'relative/wt/sub', 'relative', '/relative/wt',
      'C:\\Repo\\.worktrees\\Win', 'c:\\repo\\.worktrees\\win\\x', 'C:/Repo/.worktrees/Win/x',
      'C:\\Repo\\.worktrees\\Win\\Inner\\y', 'c:/REPO/.WORKTREES/WIN/INNER',
      'C:\\Repo\\.worktrees\\forward\\x', 'c:\\repo\\.worktrees\\FORWARD',
      'D:\\Trailing', 'D:\\trailing\\x', 'E:\\Trailing\\x',
      '\\\\srv\\share\\wt\\x', '\\\\SRV\\share\\WT', '\\\\srv\\share',
      'C:\\Repo\\.worktrees\\Win\\..\\Win\\z', 'C:\\Repo\\.worktrees\\Win.\\z',
      '', '/', 'C:\\', 'not-a-path',
    ])

    // The one deliberate difference (see the header).
    const access = new DurableIssueAccessIndex(store.issues, store.grants, store.repos)
    const crossForm = '/Repo/.worktrees/Win/x'
    expect(oracle(rows, crossForm, new Set()).owner).toBe('iss_edge_12')
    expect(await access.issueForCwd(crossForm)).toBeNull()
  })

  it('answers a set of folders in one statement, however many issues there are', async () => {
    const folders = Array.from({ length: 50 }, (_, i) => `/r/.worktrees/wt-${i}/src/deep`)
    await expectConstantStatements(
      {
        name: 'issuesForCwds',
        setup: async (size) => {
          const store = await openTestStore(':memory:')
          stores.push(store)
          await seed(store, ['/r'], Array.from({ length: size }, (_, i) => ({
            id: `iss_count_${i}`, seq: i + 1, repoPath: '/r', worktreePath: `/r/.worktrees/wt-${i}`,
            archived: false, deletedAt: null,
          })))
          return { store, access: new DurableIssueAccessIndex(store.issues, store.grants, store.repos) }
        },
        target: (f) => f.store,
        run: async (f) => await f.access.issuesForCwds(folders),
        check: (owners) => expect((owners as Map<string, string | null>).get(folders[0]!)).toBe('iss_count_0'),
      },
      1,
    )
  })
})
