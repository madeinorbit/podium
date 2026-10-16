/**
 * The full-truth reconcile reads its issues from the database as it did from
 * the issue map (POD-6158; design §6, D1g's boot step).
 *
 * The issueProjection truth (every issue, a page at a time, with its labels)
 * and the issueGitState truth (the observed issues, by id) are compared, under
 * vitest in throw mode, over the benchmark corpus (POD-6146: cell h1a1, seed
 * 4443) and over edge fixtures: deleted and archived rows, labels, an empty id,
 * a quarantined row, and page boundaries. The truth keeps the boot load's
 * order (`repo_path`, then `seq`), so the change log appends as it did.
 */

import { asIssueId, asSessionId, type IssueGitState } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../../store'
import { applyAfterCommit, spanOpen } from '../../../store/executor/executor'
import { type CorpusIssue, exportedCorpus, rawSql, rowOf, seededStore } from '../../../test-support/issue-corpus'
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

const observed = (seq: number): IssueGitState => ({
  updatedAt: `2026-10-0${1 + (seq % 9)}T00:00:00.000Z`,
  branch: `issue/${seq}`,
  shared: false,
  ahead: seq % 4,
  dirtyFiles: seq % 3,
})

/** The boot load's order: every row of `listIssueRows`. */
async function bootOrder(store: SessionStore): Promise<string[]> {
  return (await store.issues.listIssueRows()).map((row) => row.id)
}

describe('full-truth reconcile: the database answers as the issue map', () => {
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
    await store.transact(async () => {
      for (const [index, row] of rows.entries()) {
        if (index % 7 === 0) await store.issues.setIssueLabels(asIssueId(row.id), [`l${index % 5}`, 'shared'])
      }
    })
    const svc = await serviceOver(store)
    const issues = svc.reports.store
    for (const [index, row] of rows.entries()) if (index % 11 === 0) issues.gitStates.set(row.id, observed(row.seq))

    const truth = await issues.allProjections()
    expect(truth?.map((entry) => entry.id)).toEqual(await bootOrder(store))
    await issues.reconcileProjections()
    await issues.reconcileCompanions()
    console.log('reconcile parity over the corpus', JSON.stringify({ issues: rows.length, projected: truth?.length }))
    expect(truth!.length).toBeGreaterThan(1000)
  })

  it('over the edge fixtures', async () => {
    const live = (seq: number, patch: Partial<CorpusIssue> = {}): CorpusIssue => ({
      id: `iss_${seq}`, seq, repoPath: '/a', worktreePath: null, parentId: null, stage: 'backlog',
      archived: false, deletedAt: null, ...patch,
    })
    const rows: CorpusIssue[] = [
      live(3),
      live(1),
      live(2, { parentId: 'iss_1', archived: true }),
      live(4, { deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(5, { id: 'iss_empty' }),
      live(1, { id: 'iss_b1', repoPath: '/b' }),
      live(2, { id: 'iss_b2', repoPath: '/b', deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(6, { id: 'iss_corrupt' }),
    ]
    const store = await seededStore(rows, ['/a', '/b'])
    stores.push(store)
    await store.issues.setIssueLabels(asIssueId('iss_1'), ['one', 'two'])
    await store.issues.setIssueLabels(asIssueId('iss_b2'), ['gone'])
    // An empty id is a string: the boot load keeps it, and so does the walk.
    rawSql(store, "UPDATE issues SET id = '' WHERE id = 'iss_empty'")
    // A NULL id is quarantined by both.
    rawSql(store, 'UPDATE issues SET id = NULL WHERE id = ?', 'iss_corrupt')
    const svc = await serviceOver(store)
    const issues = svc.reports.store
    for (const id of ['iss_1', 'iss_4', 'iss_b1', 'iss_b2', 'iss_missing']) issues.gitStates.set(id, observed(id.length))

    const truth = await issues.allProjections()
    expect(truth?.map((entry) => entry.id)).toEqual(await bootOrder(store))
    expect(truth?.map((entry) => entry.id)).toEqual(['iss_1', 'iss_2', 'iss_3', 'iss_4', '', 'iss_b1', 'iss_b2'])
    await issues.reconcileProjections()
    await issues.reconcileCompanions()

    // Pages end where they should, and the quarantined row costs only itself.
    const pages: string[][] = []
    for await (const page of store.issues.issueRowPages(2)) pages.push(page.map((row) => row.id))
    expect(pages).toEqual([['', 'iss_1'], ['iss_2', 'iss_3'], ['iss_4', 'iss_b1'], ['iss_b2']])
  })

  it('reads every issue a page at a time', async () => {
    const rows = Array.from({ length: 1203 }, (_, index): CorpusIssue => ({
      id: `iss_${String(index).padStart(5, '0')}`, seq: index + 1, repoPath: '/a', worktreePath: null,
      parentId: null, stage: 'backlog', archived: false, deletedAt: null,
    }))
    const store = await seededStore([], ['/a'])
    stores.push(store)
    await store.transact(async () => {
      for (const row of rows) await store.issues.upsertIssue(rowOf(row, '/a', store.hostMachineId))
    })
    const sizes: number[] = []
    for await (const page of store.issues.issueRowPages()) sizes.push(page.length)
    expect(sizes).toEqual([500, 500, 203])
  })
})
