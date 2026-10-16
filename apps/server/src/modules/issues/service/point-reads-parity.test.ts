/**
 * Single-issue reads answer from the database as the issue map did (POD-6190,
 * part of POD-6158; design §7 step 3.2).
 *
 * Every switched reader asks both: the database answers, and under vitest the
 * comparison (`map-parity.ts`) throws on any difference. This file drives the
 * point reads over the benchmark corpus (POD-6146: cell h1a1, seed 4443) and
 * over edge fixtures — deleted, archived and quarantined rows, nested parents,
 * labels, deps, legacy rows without a repository id, ambiguous and unknown
 * references — so a difference anywhere in them fails here. The last case
 * plants a difference to prove the comparison is armed.
 */

import { fileURLToPath } from 'node:url'
import { asIssueId, asMachineId, firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { IssueRow, SessionStore } from '../../../store'
import { applyAfterCommit, spanOpen } from '../../../store/executor/executor'
import { issueRowFixture } from '../../../test-support/issue-row'
import { openTestStore } from '../../../test-support/open-test-store'
import { IssueStore } from './core'
import { IssueMapParityError, issueMapParityMode } from './map-parity'
import { IssueRefusal } from './refusal'
import type { IssueDeps } from './types'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

interface CorpusIssue {
  id: string
  seq: number
  repoPath: string | null
  worktreePath: string | null
  parentId: string | null
  stage: string
  archived: boolean
  deletedAt: string | null
}

async function exportedCorpus(): Promise<{ issues: CorpusIssue[]; deps: { fromId: string; toId: string; type: string }[]; repos: string[] }> {
  const module = fileURLToPath(new URL('../../../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url))
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<{
      issues: CorpusIssue[]
      deps: { fromId: string; toId: string; type: string }[]
      repos: string[]
    }>
  }
  return await exportCorpus('h1a1', 4443)
}

/** Two capital letters per repository index: AA, AB, ... */
const prefixOf = (index: number) =>
  String.fromCharCode(65 + Math.floor(index / 26) % 26) + String.fromCharCode(65 + (index % 26))

function rowOf(issue: CorpusIssue, repoPath: string, machineId: string): IssueRow {
  return {
    ...issueRowFixture({
      id: issue.id,
      repoPath,
      seq: issue.seq,
      ownerUserId: firstAdminMemberId(),
      createdByActor: firstAdminMemberId(),
      createdByOnBehalfOf: firstAdminMemberId(),
    }),
    repoId: undefined,
    machineId: asMachineId(machineId),
    parentId: issue.parentId ? asIssueId(issue.parentId) : null,
    worktreePath: issue.worktreePath,
    stage: issue.stage as IssueRow['stage'],
    archived: issue.archived,
    deletedAt: issue.deletedAt,
    revision: undefined,
  } as IssueRow
}

async function harness(issues: readonly CorpusIssue[], repos: readonly string[], deps: { fromId: string; toId: string; type: string }[] = []) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.transact(async () => {
    for (const [index, path] of repos.entries()) {
      await store.repos.addRepo(path, store.hostMachineId, undefined, prefixOf(index))
    }
  })
  // Parents are a foreign key: every row first, then the parent links.
  for (let start = 0; start < issues.length; start += 500) {
    await store.transact(async () => {
      for (const issue of issues.slice(start, start + 500)) {
        await store.issues.upsertIssue(
          rowOf({ ...issue, parentId: null }, issue.repoPath ?? repos[0]!, store.hostMachineId),
        )
      }
    })
  }
  const ids = new Set(issues.map((issue) => issue.id))
  await store.transact(async () => {
    for (const issue of issues) {
      if (!issue.parentId || !ids.has(issue.parentId)) continue
      const row = (await store.issues.getIssue(issue.id))!
      row.parentId = asIssueId(issue.parentId)
      await store.issues.upsertIssue(row)
    }
  })
  await store.transact(async () => {
    for (const dep of deps) await store.issues.addIssueDep(asIssueId(dep.fromId), asIssueId(dep.toId), dep.type)
  })
  return store
}

function storeOf(store: SessionStore): Promise<IssueStore> {
  return new IssueStore({ store, applyCommit: { spanOpen, onCommit: applyAfterCommit } } as IssueDeps).init()
}

const raw = (store: SessionStore, statement: string, ...args: unknown[]) =>
  (store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
    .prepare(statement)
    .run(...args)

/** Every reference spelling a row can be asked by, plus some that name nothing. */
function refsOf(rows: readonly { seq: number; repoPath: string }[], prefixes: ReadonlyMap<string, string>): string[] {
  const refs = new Set<string>(['#0', 'ZZ-1', 'garbage', 'iss_missing', '/nowhere#1'])
  for (const row of rows) {
    const prefix = prefixes.get(row.repoPath)
    if (prefix) refs.add(`${prefix}-${row.seq}`)
    refs.add(`#${row.seq}`)
    refs.add(`${row.seq}`)
    refs.add(`${row.repoPath}#${row.seq}`)
    refs.add(`${row.repoPath.split('/').at(-1)}#${row.seq}`)
  }
  return [...refs]
}

/** Ask every point read; an ambiguous reference is a refusal on both sides. */
async function askEverything(issues: IssueStore, ids: readonly string[], refs: readonly string[]) {
  let asked = 0
  for (const id of [...ids, 'iss_missing']) {
    await issues.row(id)
    await issues.liveRow(id)
    await issues.issueUserState(asIssueId(id))
    asked += 3
  }
  await issues.rowsByIds([...ids, 'iss_missing'])
  for (const ref of refs) {
    try {
      await issues.resolveRef(ref)
    } catch (err) {
      if (!(err instanceof IssueRefusal)) throw err
    }
    asked += 1
  }
  await issues.resolveRefs(refs)
  return asked + 2
}

describe('issue point reads: the database answers as the issue map', () => {
  it('compares in throw mode under vitest', () => {
    expect(issueMapParityMode()).toBe('throw')
  })

  it('over the benchmark corpus', async () => {
    const corpus = await exportedCorpus()
    const repos = [...new Set([...corpus.repos, ...corpus.issues.flatMap((row) => (row.repoPath ? [row.repoPath] : []))])]
    const rows = corpus.issues.map((row) => ({ ...row, id: `iss_${row.id}`, parentId: row.parentId ? `iss_${row.parentId}` : null }))
    const ids = new Set(rows.map((row) => row.id))
    // The corpus's older dependency spellings, folded as the fixed-types
    // migration and the bench seeder fold them; anything else is dropped.
    const folded: Readonly<Record<string, string>> = {
      blocks: 'blocked-by', 'waits-on': 'blocked-by', duplicate: 'duplicates',
      tracks: 'related', 'caused-by': 'related', validates: 'related',
    }
    const types = new Set(['blocked-by', 'related', 'discovered-from', 'supersedes', 'duplicates'])
    const deps = corpus.deps
      .map((dep) => ({ fromId: `iss_${dep.fromId}`, toId: `iss_${dep.toId}`, type: folded[dep.type] ?? dep.type }))
      .filter((dep) => ids.has(dep.fromId) && ids.has(dep.toId) && types.has(dep.type))
    const store = await harness(rows, repos, deps)
    const viewer = await firstAdminMemberId(store)
    await store.transact(async () => {
      for (const row of rows.filter((_, index) => index % 7 === 0)) {
        await store.issues.setIssueUserState(viewer, asIssueId(row.id), { readAt: row.id.length % 2 ? '2026-10-01T00:00:00.000Z' : null, pinnedAt: '2026-10-02T00:00:00.000Z' })
      }
    })
    const issues = await storeOf(store)
    const prefixes = new Map(repos.map((path, index) => [path, prefixOf(index)]))
    const asked = await askEverything(
      issues,
      [...ids],
      refsOf(rows.map((row) => ({ seq: row.seq, repoPath: row.repoPath ?? repos[0]! })), prefixes),
    )
    console.log('point-read parity over the corpus', JSON.stringify({ issues: rows.length, repos: repos.length, asked }))
    expect(rows.length).toBeGreaterThan(100)
    expect(rows.some((row) => row.deletedAt)).toBe(true)
  })

  it('over the edge fixtures', async () => {
    const live = (seq: number, patch: Partial<CorpusIssue> = {}): CorpusIssue => ({
      id: `iss_${seq}`, seq, repoPath: '/a', worktreePath: null, parentId: null, stage: 'backlog',
      archived: false, deletedAt: null, ...patch,
    })
    const rows: CorpusIssue[] = [
      live(1),
      live(2, { parentId: 'iss_1' }),
      live(3, { parentId: 'iss_2', worktreePath: '/a/.worktrees/issue-3' }),
      live(4, { deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(5, { archived: true, stage: 'done' }),
      // The same numbers in a second repository: bare `#N` is ambiguous.
      live(1, { id: 'iss_b1', repoPath: '/b' }),
      live(4, { id: 'iss_b4', repoPath: '/b', deletedAt: '2026-10-01T00:00:00.000Z' }),
      // Legacy rows (no repository id) under the same paths.
      live(6, { id: 'iss_legacy_a' }),
      live(7, { id: 'iss_legacy_b', repoPath: '/b' }),
    ]
    const store = await harness(rows, ['/a', '/b'], [
      { fromId: 'iss_2', toId: 'iss_1', type: 'blocked-by' },
      { fromId: 'iss_3', toId: 'iss_4', type: 'related' },
    ])
    await store.issues.setIssueLabels(asIssueId('iss_1'), ['one', 'two'])
    const viewer = await firstAdminMemberId(store)
    await store.issues.setIssueUserState(viewer, asIssueId('iss_1'), { readAt: '2026-10-01T00:00:00.000Z' })
    await store.issues.setIssueUserState(viewer, asIssueId('iss_4'), { pinnedAt: '2026-10-01T00:00:00.000Z' })
    raw(store, 'UPDATE issues SET repo_id = NULL WHERE id IN (?, ?)', 'iss_legacy_a', 'iss_legacy_b')
    // Quarantined: SQLite allows a NULL in a TEXT primary key, and the boot
    // load skips such a row (issues.boot-quarantine.test.ts); so do the reads.
    await store.issues.upsertIssue(rowOf(live(8, { id: 'iss_corrupt' }), '/a', store.hostMachineId))
    raw(store, 'UPDATE issues SET id = NULL WHERE id = ?', 'iss_corrupt')
    const issues = await storeOf(store)
    const prefixes = new Map([['/a', prefixOf(0)], ['/b', prefixOf(1)]])
    const refs = refsOf(
      [...rows, live(8, { id: 'iss_corrupt' })].map((row) => ({ seq: row.seq, repoPath: row.repoPath ?? '/a' })),
      prefixes,
    )
    await askEverything(issues, [...rows.map((row) => row.id), 'iss_corrupt'], refs)
    await expect(issues.resolveRef('#1')).rejects.toThrow(/ambiguous issue ref #1/)
    expect(await issues.resolveRef('#1', '/b')).toBe('iss_b1')
    expect(await issues.resolveRef('AB-4')).toBe('iss_b4')
    expect(await issues.resolveRef('AA-6')).toBe('iss_legacy_a')
  })

  it('is armed: a planted map-only difference fails the read', async () => {
    const store = await harness(
      [{ id: 'iss_1', seq: 1, repoPath: '/a', worktreePath: null, parentId: null, stage: 'backlog', archived: false, deletedAt: null }],
      ['/a'],
    )
    const issues = await storeOf(store)
    const planted = { ...issues.rows.get('iss_1')!, title: 'only in the map' }
    issues.installRow('iss_1', planted)
    await expect(issues.row('iss_1')).rejects.toThrow(IssueMapParityError)
    await expect(issues.liveRow('iss_1')).rejects.toThrow(IssueMapParityError)
    issues.installRow('iss_ghost', { ...planted, id: asIssueId('iss_ghost'), seq: 9 })
    await expect(issues.resolveRef('AA-9')).rejects.toThrow(IssueMapParityError)
  })
})
