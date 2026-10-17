/**
 * The hierarchy reads of the issue writes answer from the database (POD-6192,
 * part of POD-6158; design §7 step 3.2).
 *
 * This file pins children (all, live, live and unarchived), descendants (all
 * and live), ancestors, the proposed-subtree test and the manual-order key
 * spaces (a parent's children, a repository's top level with and without the
 * viewer's pins) over edge fixtures: deleted, archived and pinned rows, a
 * parent in another repository, and a parent cycle. Until POD-6158 removed
 * the issue map, these reads were also compared with it.
 */

import { asIssueId, asSessionId, firstAdminMemberId, type RepoId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../../store'
import { type CorpusIssue, rawSql, seededStore } from '../../../test-support/issue-corpus'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { type IssueDeps, IssueService } from '../service'
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
  } as IssueDeps)
}

type SortScopes = {
  sortScopeRows(
    repoId: RepoId | null,
    repoPath: string,
    parentId: string | null,
    opts?: { includePinned?: boolean },
  ): Promise<{ id: string }[]>
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describe('issue hierarchy reads over the database', () => {
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
    const issues = svc.reports.store
    const crud = svc.crud as unknown as SortScopes
    const resolve = await store.repos.issueRepoIdResolver()

    // Children in repository order (path, then sequence).
    expect(ids(await issues.childRows('iss_1'))).toEqual(['iss_2', 'iss_5', 'iss_7', 'iss_b1'])
    expect(ids(await issues.childRows('iss_1', { live: true }))).toEqual(['iss_2', 'iss_7', 'iss_b1'])
    expect(ids(await issues.childRows('iss_1', { live: true, unarchived: true }))).toEqual(['iss_2', 'iss_b1'])
    expect(await issues.childRows('iss_missing')).toEqual([])

    // Descendants depth first, each level by sequence; `live` drops a deleted
    // row with its subtree; a parent cycle stops at the first repeat.
    expect(ids(await issues.descendantRows('iss_1'))).toEqual(
      ['iss_b1', 'iss_2', 'iss_3', 'iss_4', 'iss_5', 'iss_6', 'iss_7'],
    )
    expect(ids(await issues.descendantRows('iss_1', { live: true }))).toEqual(
      ['iss_b1', 'iss_2', 'iss_3', 'iss_4', 'iss_7'],
    )
    expect(ids(await issues.descendantRows('iss_c1'))).toEqual(['iss_c2'])

    // Ancestors, nearest first, through deleted rows and around a cycle.
    expect(await svc.hierarchy.ancestorIds('iss_4')).toEqual(['iss_3', 'iss_2', 'iss_1'])
    expect(await svc.hierarchy.ancestorIds('iss_6')).toEqual(['iss_5', 'iss_1'])
    expect(await svc.hierarchy.ancestorIds('iss_b1')).toEqual(['iss_1'])
    expect(await svc.hierarchy.ancestorIds('iss_c1')).toEqual(['iss_c2', 'iss_c1'])
    expect(await svc.hierarchy.ancestorIds('iss_missing')).toEqual([])

    expect(await svc.hierarchy.inProposedSubtree('iss_3')).toBe(true)
    expect(await svc.hierarchy.inProposedSubtree('iss_4')).toBe(true)
    expect(await svc.hierarchy.inProposedSubtree('iss_2')).toBe(false)

    // The manual-order key spaces: live rows only, in no particular order.
    expect(ids(await crud.sortScopeRows(null, '', 'iss_1')).sort()).toEqual(['iss_2', 'iss_7', 'iss_b1'])
    const a = resolve('/a')!
    const b = resolve('/b')!
    expect(ids(await crud.sortScopeRows(a, '/a', null, { includePinned: true })).sort()).toEqual(['iss_1', 'iss_8'])
    expect(ids(await crud.sortScopeRows(a, '/a', null))).toEqual(['iss_1'])
    expect(ids(await crud.sortScopeRows(b, '/b', null, { includePinned: true }))).toEqual(['iss_b2'])
  })
})
