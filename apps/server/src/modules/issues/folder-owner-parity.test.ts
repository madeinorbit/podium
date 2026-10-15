/**
 * Old/new parity for "which issue owns this folder" (POD-6155 step 5).
 *
 * OLD: the durable access index (`DurableIssueAccessIndex.issueForCwd`,
 * `issuesForCwds`, `soleOwnerForCwd`), which copies and sorts every issue row
 * on every call, and the world index's literal-prefix map
 * (`WorldIndex.reader.issueForWorktree`). NEW: one indexed query for the
 * candidates (`IssuesRepository.worktreeOwnerCandidates`) and the pure ranking
 * in `folder-owner.ts`. Compared over the benchmark corpus (POD-6146: cell
 * h1a1, seed 4443: its issues' worktrees and repos, its sessions' folders) and
 * edge cases: nested worktrees, repo roots, deleted and archived issues, ties,
 * trailing separators, relative paths, and Windows drive, UNC, mixed-separator
 * and mixed-case forms.
 *
 * ONE DELIBERATE DIFFERENCE, pinned at the end: a POSIX-absolute folder used to
 * count as inside a Windows-style worktree with the same tail (`/r/wt` inside
 * `C:\r\wt`), an accident of resolving a rooted path against the root's drive.
 * A folder and a worktree always come from the same machine, so the two forms
 * never meet in a real answer; the new lookup does not reproduce it.
 */

import { fileURLToPath } from 'node:url'
import { asIssueId, firstAdminMemberId, machinePathKey } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { issueRowFixture } from '../../test-support/issue-row'
import { WorldIndex } from '../world-index'
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

async function exportedCorpus() {
  const module = fileURLToPath(new URL('../../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url))
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<{
      issues: CorpusIssue[]
      sessions: { cwd: string }[]
      repos: string[]
    }>
  }
  return await exportCorpus('h1a1', 4443)
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

/** Every folder worth asking about: each worktree, below it, above it, beside it. */
function foldersOf(rows: readonly CorpusIssue[], extra: readonly string[]): string[] {
  const folders = new Set(extra)
  for (const row of rows) {
    if (!row.worktreePath) continue
    folders.add(row.worktreePath)
    folders.add(`${row.worktreePath}/src/deep`)
    folders.add(`${row.worktreePath}-sibling`)
    const parent = row.worktreePath.slice(0, row.worktreePath.lastIndexOf('/'))
    if (parent) folders.add(parent)
  }
  return [...folders]
}

async function expectParity(store: SessionStore, folders: readonly string[], world?: WorldIndex) {
  const access = new DurableIssueAccessIndex(store.issues, store.grants, store.repos)
  const roots = new Set((await store.repos.listRepoPaths()).map(machinePathKey))
  const rows = await store.issues.worktreeOwnerCandidates(folders)
  const oldMany = await access.issuesForCwds(folders)
  const mismatches: unknown[] = []
  for (const cwd of folders) {
    // NEW answers from one shared candidate read, and from a read of its own.
    const own = await store.issues.worktreeOwnerCandidates([cwd])
    const answer = { owner: deepestOwner(rows, cwd), alone: deepestOwner(own, cwd), sole: soleOwner(own, cwd, roots) }
    const old = { owner: await access.issueForCwd(cwd), alone: oldMany.get(cwd) ?? null, sole: await access.soleOwnerForCwd(cwd) }
    if (JSON.stringify(answer) !== JSON.stringify(old)) mismatches.push({ cwd, old, new: answer })
    // The world index probes literal '/' prefixes only (no trailing-slash or
    // Windows roots) and breaks ties by locale order; it agrees wherever those
    // never arise, which is every folder in the corpus.
    if (world) {
      const literal = world.reader.issueForWorktree(cwd) ?? null
      if (literal !== answer.owner) mismatches.push({ cwd, world: literal, new: answer.owner })
    }
  }
  expect(mismatches).toEqual([])
}

describe('folder owner: old copies and the new query give the same answers', () => {
  it('over the benchmark corpus', async () => {
    const corpus = await exportedCorpus()
    const store = await openTestStore(':memory:')
    stores.push(store)
    const repos = [...new Set([...corpus.repos, ...corpus.issues.flatMap((row) => (row.repoPath ? [row.repoPath] : []))])]
    const rows = corpus.issues.map((row) => ({ ...row, id: `iss_${row.id}` }))
    await seed(store, repos, rows)
    expect(rows.filter((row) => row.worktreePath).length).toBeGreaterThan(100)
    const world = await WorldIndex.load(store)
    const folders = foldersOf(rows, [...corpus.sessions.map((session) => session.cwd), ...repos])
    expect(folders.length).toBeGreaterThan(1000)
    await expectParity(store, folders, world)
  }, 300_000)

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
    await expectParity(store, [
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
    expect(await access.issueForCwd(crossForm)).toBe(asIssueId('iss_edge_12'))
    expect(deepestOwner(await store.issues.worktreeOwnerCandidates([crossForm]), crossForm)).toBeNull()
  })
})
