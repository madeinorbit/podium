/**
 * The hierarchy reads of the issue writes answer from the database as they did
 * from the issue map (POD-6192, part of POD-6158; design §7 step 3.2).
 *
 * Children (all, live, live and unarchived), descendants (all and live),
 * ancestors and the manual-order key spaces (each parent's children, each
 * repository's top level with and without the viewer's pins) are compared,
 * under vitest in throw mode, over the benchmark corpus (POD-6146: cell h1a1,
 * seed 4443) and over edge fixtures: deleted, archived and pinned rows, a
 * parent in another repository, and a parent cycle.
 */

import { asIssueId, asSessionId, firstAdminMemberId, type IssueId, type RepoId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../../store'
import { applyAfterCommit, spanOpen } from '../../../store/executor/executor'
import { type CorpusIssue, exportedCorpus, rawSql, seededStore } from '../../../test-support/issue-corpus'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { type IssueDeps, IssueService } from '../service'
import { issueMapParityMode } from './map-parity'
import { issueTestPlumbing } from './test-plumbing'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function serviceOver(store: SessionStore): Promise<IssueService> {
  return await IssueService.create({
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () => normalizeSettings({}),
    spawnSession: vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'm' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(() => {}),
    setSessionArchived: vi.fn(),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
  } as IssueDeps)
}

type SortScopes = {
  sortScopeRows(repoId: RepoId | null, repoPath: string, parentId: string | null, opts?: { includePinned?: boolean }): Promise<unknown>
}

/** Ask every hierarchy read for these parents and repositories. */
async function everyRead(svc: IssueService, parents: readonly string[], repos: readonly { repoId: RepoId; path: string }[]) {
  const store = svc.reports.store
  const crud = svc.crud as unknown as SortScopes
  let asked = 0
  for (const id of parents) {
    await store.childRows(id)
    await store.childRows(id, { live: true })
    await store.childRows(id, { live: true, unarchived: true })
    await store.descendantRows(id)
    await store.descendantRows(id, { live: true })
    await svc.hierarchy.ancestorIds(id)
    await svc.hierarchy.inProposedSubtree(id)
    await crud.sortScopeRows(null, '', id)
    asked += 8
  }
  for (const repo of repos) {
    await crud.sortScopeRows(repo.repoId, repo.path, null)
    await crud.sortScopeRows(repo.repoId, repo.path, null, { includePinned: true })
    asked += 2
  }
  return asked
}

describe('issue hierarchy reads: the database answers as the issue map', () => {
  it('compares in throw mode under vitest', () => {
    expect(issueMapParityMode()).toBe('throw')
  })

  it('over the benchmark corpus', async () => {
    const corpus = await exportedCorpus()
    const repos = [...new Set([...corpus.repos, ...corpus.issues.flatMap((row) => (row.repoPath ? [row.repoPath] : []))])]
    const rows: CorpusIssue[] = corpus.issues.map((row) => ({
      ...row,
      id: `iss_${row.id}`,
      parentId: row.parentId ? `iss_${row.parentId}` : null,
    }))
    const store = await seededStore(rows, repos)
    stores.push(store)
    const viewer = await firstAdminMemberId(store)
    await store.transact(async () => {
      for (const [index, row] of rows.entries()) {
        if (index % 6 === 0) {
          await store.issues.setIssueUserState(viewer, asIssueId(row.id), { pinnedAt: '2026-10-01T00:00:00.000Z' })
        }
      }
    })
    const svc = await serviceOver(store)
    const parents = [...new Set(rows.flatMap((row) => (row.parentId ? [row.parentId] : [])))].slice(0, 120)
    const resolve = await store.repos.issueRepoIdResolver()
    const sizes = new Map<string, number>()
    for (const row of rows) if (row.repoPath) sizes.set(row.repoPath, (sizes.get(row.repoPath) ?? 0) + 1)
    const busiest = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([path]) => ({ repoId: resolve(path)!, path }))
    const asked = await everyRead(svc, [...parents, rows[0]!.id, 'iss_missing'], busiest)
    console.log('hierarchy parity over the corpus', JSON.stringify({ issues: rows.length, parents: parents.length, asked }))
    expect(parents.length).toBeGreaterThan(20)
  })

  it('over the edge fixtures', async () => {
    const live = (seq: number, patch: Partial<CorpusIssue> = {}): CorpusIssue => ({
      id: `iss_${seq}`, seq, repoPath: '/a', worktreePath: null, parentId: null, stage: 'backlog',
      archived: false, deletedAt: null, ...patch,
    })
    const rows: CorpusIssue[] = [
      live(1),
      live(2, { parentId: 'iss_1' }),
      live(3, { parentId: 'iss_2', stage: 'proposed' }),
      live(4, { parentId: 'iss_3' }),
      live(5, { parentId: 'iss_1', deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(6, { parentId: 'iss_5' }),
      live(7, { parentId: 'iss_1', archived: true }),
      live(8),
      live(9, { deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(1, { id: 'iss_b1', repoPath: '/b', parentId: 'iss_1' }),
      live(2, { id: 'iss_b2', repoPath: '/b' }),
      live(10, { id: 'iss_c1' }),
      live(11, { id: 'iss_c2', parentId: 'iss_c1' }),
    ]
    const store = await seededStore(rows, ['/a', '/b'])
    stores.push(store)
    // A parent cycle: no write path makes one, so it is planted.
    rawSql(store, "UPDATE issues SET parent_id = 'iss_c2' WHERE id = 'iss_c1'")
    const viewer = await firstAdminMemberId(store)
    await store.issues.setIssueUserState(viewer, asIssueId('iss_8'), { pinnedAt: '2026-10-01T00:00:00.000Z' })
    const svc = await serviceOver(store)
    const resolve = await store.repos.issueRepoIdResolver()
    const asked = await everyRead(
      svc,
      ['iss_1', 'iss_2', 'iss_3', 'iss_4', 'iss_5', 'iss_b1', 'iss_c1', 'iss_c2', 'iss_missing'],
      [{ repoId: resolve('/a')!, path: '/a' }, { repoId: resolve('/b')!, path: '/b' }],
    )
    expect(asked).toBeGreaterThan(60)
    expect((await svc.reports.store.descendantRows('iss_1')).map((r) => r.id as IssueId)).toEqual(
      ['iss_b1', 'iss_2', 'iss_3', 'iss_4', 'iss_5', 'iss_6', 'iss_7'],
    )
    expect(await svc.hierarchy.inProposedSubtree('iss_4')).toBe(true)
  })
})
