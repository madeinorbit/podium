/**
 * THE ISSUE REPOSITORIES ON BOTH ENGINES [POD-6984, POD-6958 design 2.1, 2.3, 2.5, 2.10].
 *
 * Every definition of the issue group whose SQL differs by engine has a Postgres form:
 * the `julianday` comparison and order of `updated_at` (Postgres compares its
 * `timestamptz` directly), `instr` (`strpos`), the count groups' order key (`printf`,
 * `char(0)`), `INDEXED BY`, `rowid`, SQLite's `IS NOT` between values, `LIKE`'s ASCII case
 * folding (`ILIKE`), the computed `lower()` texts (`COLLATE "C"`) and the JSON comparisons
 * (`CAST(… AS TEXT)`). Each case below runs one of them and expects the answer SQLite gives,
 * on the run's engine: SQLite on the store lane, Postgres on `server-store-pg`
 * (`test-support/issue-store-engine.ts`). Beside them: statement pins for the listing
 * reads, the same count on both engines, and the capture rows the Postgres write forms add.
 */

import {
  asIssueId,
  asMachineId,
  asUserId,
  firstAdminMemberId,
  type IssueGitState,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { type IssueEngineStore, openIssueEngineStore } from '../test-support/issue-store-engine'
import { expectConstantStatements, type StatementPin } from '../test-support/statement-count'
import type { IssueListingShape } from './issue-listings'
import type { IssueRow } from './types'

const scope = fixtureWriteScope()
const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 10, minute)).toISOString()

function issueRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId('iss_x'),
    repoPath: '/r',
    seq: 1,
    title: 'X',
    description: '',
    stage: 'backlog',
    ownerUserId: firstAdminMemberId(),
    visibility: 'personal',
    createdByActor: firstAdminMemberId(),
    createdByOnBehalfOf: firstAdminMemberId(),
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
    createdAt: at(0),
    updatedAt: at(0),
    archived: false,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    acceptance: null,
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

/** A store whose host machine reports `/r` and each of `repos`. */
async function openStore(...repos: string[]): Promise<IssueEngineStore> {
  const store = await openIssueEngineStore()
  for (const repo of ['/r', ...repos]) await store.repos.addRepo(repo, store.hostMachineId)
  return store
}

async function seed(store: IssueEngineStore, over: Partial<IssueRow>): Promise<IssueRow> {
  const row = issueRow(over)
  await store.issues.upsertIssue(scope, row)
  return row
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describe('the issue listings', () => {
  it('lists the open issues updated before a bound, oldest update first (julianday on SQLite)', async () => {
    const store = await openStore()
    await seed(store, { id: asIssueId('iss_late'), seq: 1, updatedAt: at(30) })
    await seed(store, { id: asIssueId('iss_early'), seq: 2, updatedAt: at(10) })
    await seed(store, { id: asIssueId('iss_tie_b'), seq: 4, updatedAt: at(20) })
    await seed(store, { id: asIssueId('iss_tie_a'), seq: 3, updatedAt: at(20) })
    await seed(store, { id: asIssueId('iss_new'), seq: 5, updatedAt: at(50) })
    await seed(store, { id: asIssueId('iss_done'), seq: 6, updatedAt: at(5), stage: 'done' })
    const shape: IssueListingShape = {
      repo: false,
      live: true,
      state: 'open',
      updatedBefore: true,
      order: 'updated',
    }

    // Equal updates are ordered by repository path, then sequence.
    expect(ids(await store.issues.listIssueRowsWhere(shape, { before: at(40) }))).toEqual([
      'iss_early',
      'iss_tie_a',
      'iss_tie_b',
      'iss_late',
    ])
    // The bound is strict.
    expect(ids(await store.issues.listIssueRowsWhere(shape, { before: at(20) }))).toEqual([
      'iss_early',
    ])
    await store.close()
  })

  it('finds lowered ASCII text in the title, description and brief, folding ASCII only', async () => {
    const store = await openStore()
    await seed(store, { id: asIssueId('iss_title'), seq: 1, title: 'Fix the PARSER' })
    await seed(store, { id: asIssueId('iss_body'), seq: 2, description: 'the parser breaks' })
    await seed(store, { id: asIssueId('iss_brief'), seq: 3, brief: 'see Parser.ts' })
    await seed(store, { id: asIssueId('iss_umlaut'), seq: 4, title: 'ÄBC header' })
    await seed(store, { id: asIssueId('iss_none'), seq: 5, title: 'unrelated' })
    const shape: IssueListingShape = { repo: false, live: true, text: true, order: 'seq' }

    expect(ids(await store.issues.listIssueRowsWhere(shape, { text: 'parser' }))).toEqual([
      'iss_title',
      'iss_body',
      'iss_brief',
    ])
    // SQLite's lower() folds ASCII only, and so does Postgres's over a C-collated text:
    // `Ä` stays upper case, so its lower-case spelling finds nothing.
    expect(ids(await store.issues.listIssueRowsWhere(shape, { text: 'äbc' }))).toEqual([])
    expect(ids(await store.issues.listIssueRowsWhere(shape, { text: 'Äbc' }))).toEqual([
      'iss_umlaut',
    ])
    await store.close()
  })

  it('lists by repository then sequence, a row without a repository id first', async () => {
    const store = await openStore('/s')
    const r = await store.repos.resolveRepoIdForPath('/r')
    const s = await store.repos.resolveRepoIdForPath('/s')
    const [first, second] = [r, s].sort()
    await seed(store, { id: asIssueId('iss_second_1'), repoPath: '/r', seq: 1, repoId: second })
    await seed(store, { id: asIssueId('iss_first_2'), repoPath: '/s', seq: 2, repoId: first })
    await seed(store, { id: asIssueId('iss_none'), repoPath: '/elsewhere', seq: 7, repoId: r })
    // A legacy row the boot heal has not stamped: the upsert always resolves an id.
    await store.seedRow((db, t) =>
      db
        .update(t.issues)
        .set({ repoId: null })
        .where(eq(t.issues.id, asIssueId('iss_none')))
        .prepare(),
    )
    await seed(store, { id: asIssueId('iss_first_1'), repoPath: '/s', seq: 1, repoId: first })

    expect(
      ids(await store.issues.listIssueRowsWhere({ repo: false, live: true, order: 'repo-seq' })),
    ).toEqual(['iss_none', 'iss_first_1', 'iss_first_2', 'iss_second_1'])
    await store.close()
  })

  it('orders count groups by their first (repository path, sequence)', async () => {
    const store = await openStore('/r/sub')
    // `/r` sorts before `/r/sub` as a path: the separator sorts below `/`.
    await seed(store, { id: asIssueId('iss_sub_backlog'), repoPath: '/r/sub', seq: 1 })
    await seed(store, { id: asIssueId('iss_review'), repoPath: '/r', seq: 9, stage: 'review' })
    await seed(store, { id: asIssueId('iss_backlog'), repoPath: '/r', seq: 10 })
    await seed(store, {
      id: asIssueId('iss_planning'),
      repoPath: '/r',
      seq: 100,
      stage: 'planning',
    })

    const groups = await store.issues.countIssueGroups({ repo: false, live: true, order: 'seq' })
    // Sequence 9 before 10 before 100: the sequence is zero-padded, not compared as text.
    expect(groups.map((group) => [group.stage, group.n])).toEqual([
      ['review', 1],
      ['backlog', 2],
      ['planning', 1],
    ])
    await store.close()
  })
})

describe('labels, worktrees and paths', () => {
  it('orders the vocabulary by lower-cased name in byte order, and finds a name ignoring case', async () => {
    const store = await openStore()
    for (const name of ['Zeta', 'bug', 'API', '_internal']) await store.issues.defineLabel({ name })

    // Byte order of the lowered names: `_` (0x5f) before the letters.
    expect((await store.issues.listLabels()).map((label) => label.name)).toEqual([
      '_internal',
      'API',
      'bug',
      'Zeta',
    ])
    expect([...(await store.issues.findLabels(['BUG', 'zeta', 'missing'])).keys()].sort()).toEqual([
      'bug',
      'zeta',
    ])
    // A second definition of the same name ignoring case edits the stored one.
    await store.issues.defineLabel({ name: 'Bug', description: 'a defect' })
    expect((await store.issues.findLabels(['bug'])).get('bug')).toMatchObject({
      name: 'bug',
      description: 'a defect',
    })
    await store.close()
  })

  it('finds a Windows worktree owner through the folded path, folding ASCII only', async () => {
    const store = await openStore()
    await seed(store, { id: asIssueId('iss_win'), seq: 1, worktreePath: 'C:/Work/ÄRepo' })
    await seed(store, { id: asIssueId('iss_other'), seq: 2, worktreePath: 'C:/Work/Other' })

    const owners = await store.issues.worktreeOwnerCandidates(['c:\\work\\Ärepo\\src'])
    expect(ids(owners)).toEqual(['iss_win'])
    // `ä` is not `Ä` folded: no engine folds beyond ASCII.
    expect(await store.issues.worktreeOwnerCandidates(['c:\\work\\ärepo\\src'])).toEqual([])
    await store.close()
  })

  it('reads the live worktree tasks of machines (INDEXED BY on SQLite)', async () => {
    const store = await openStore()
    const m1 = asMachineId('mach_1')
    const m2 = asMachineId('mach_2')
    await seed(store, { id: asIssueId('iss_live'), seq: 1, worktreePath: '/w/1', machineId: m1 })
    await seed(store, { id: asIssueId('iss_two'), seq: 2, worktreePath: '/w/2', machineId: m2 })
    await seed(store, {
      id: asIssueId('iss_deleted'),
      seq: 3,
      worktreePath: '/w/3',
      machineId: m1,
      deletedAt: at(1),
    })
    await seed(store, { id: asIssueId('iss_no_worktree'), seq: 4, machineId: m1 })

    const found = await store.issues.liveWorktreeIssuesOnMachines([m1, m2, 'mach_none'])
    expect(Object.fromEntries([...found].map(([machine, rows]) => [machine, ids(rows)]))).toEqual({
      mach_1: ['iss_live'],
      mach_2: ['iss_two'],
      mach_none: [],
    })
    await store.close()
  })

  it('renumbers colliding seqs of equally old rows in id order (the tie-break was rowid)', async () => {
    const store = await openStore()
    await store.repos.addRepo('/root', asMachineId('m1'))
    await store.repos.addRepo('/root/one', asMachineId('m1'))
    await store.repos.addRepo('/root/two', asMachineId('m1'))
    const root = await store.repos.resolveRepoIdForPath('/root')
    // Written in the order opposite to their ids, so insertion order would disagree.
    await seed(store, {
      id: asIssueId('iss_b'),
      repoPath: '/root/two',
      seq: 1,
      repoId: await store.repos.resolveRepoIdForPath('/root/two'),
    })
    await seed(store, {
      id: asIssueId('iss_a'),
      repoPath: '/root/one',
      seq: 1,
      repoId: await store.repos.resolveRepoIdForPath('/root/one'),
    })

    await store.issues.assignRepoIdToIssuesUnder(root, '/root')

    expect(await store.issues.getIssue('iss_a')).toMatchObject({ repoId: root, seq: 1 })
    expect(await store.issues.getIssue('iss_b')).toMatchObject({ repoId: root, seq: 2 })
    await store.close()
  })
})

describe('comments, git states, uploads and the upsert', () => {
  it('searches comments ignoring ASCII case, newest first', async () => {
    const store = await openStore()
    await seed(store, { id: asIssueId('iss_1') })
    for (const [i, body] of ['a NEEDLE here', 'needle first', 'no match', 'Ärger'].entries()) {
      await store.issues.addIssueComment({
        id: `cmt_${i}`,
        issueId: asIssueId('iss_1'),
        author: 'a',
        body,
        createdAt: at(i),
        actor: null,
        onBehalfOf: null,
      })
    }

    expect((await store.issues.searchIssueComments('Needle')).map((hit) => hit.body)).toEqual([
      'needle first',
      'a NEEDLE here',
    ])
    expect(await store.issues.searchIssueComments('ärger')).toEqual([])
    await store.close()
  })

  it('writes a git state only when its facts change', async () => {
    const store = await openStore()
    await seed(store, { id: asIssueId('iss_1') })
    const state = (updatedAt: string, dirtyFiles: number): IssueGitState => ({
      updatedAt,
      branch: 'issue/1',
      shared: false,
      ahead: 1,
      dirtyFiles,
    })

    expect(await store.issues.gitStates.set(scope, 'iss_1', state(at(1), 0))).toMatchObject({
      id: 'iss_1',
      updatedAt: at(1),
    })
    // The same facts observed later: nothing is written, the first time stays.
    expect(await store.issues.gitStates.set(scope, 'iss_1', state(at(2), 0))).toBeUndefined()
    expect(await store.issues.gitStates.get('iss_1')).toMatchObject({ updatedAt: at(1) })
    expect(await store.issues.gitStates.set(scope, 'iss_1', state(at(3), 2))).toMatchObject({
      updatedAt: at(3),
      dirtyFiles: 2,
    })
    await store.close()
  })

  it('advances an upload only from the received counts the caller read', async () => {
    const store = await openStore()
    await seed(store, { id: asIssueId('iss_upload') })
    const upload = {
      issueId: asIssueId('iss_upload'),
      uploadId: 'u1',
      beginJson: '{"action":"begin"}',
      received: [0, 0],
      createdAt: 1_000,
    }
    expect(await store.uploads.begin(upload)).toBe(true)
    expect(await store.uploads.advance(upload.issueId, 'u1', [0, 0], [3, 0])).toBe(true)
    expect(await store.uploads.advance(upload.issueId, 'u1', [0, 0], [0, 4])).toBe(false)
    expect(await store.uploads.advance(upload.issueId, 'u1', [3, 0], [3, 4])).toBe(true)
    expect((await store.uploads.get(upload.issueId, 'u1'))?.received).toEqual([3, 4])
    await store.close()
  })

  it('skips an upsert that changes nothing and bumps one that changes only a JSON column', async () => {
    const store = await openStore()
    const row = await seed(store, { id: asIssueId('iss_1'), blockedBy: ['a'] })
    expect(row.revision).toBe(1)
    await store.issues.upsertIssue(scope, { ...row })
    expect((await store.issues.getIssue('iss_1'))?.revision).toBe(1)
    // `blocked_by` is a json column: compared as text on Postgres, as SQLite compares it.
    await store.issues.upsertIssue(scope, { ...row, blockedBy: ['a', 'b'] })
    expect(await store.issues.getIssue('iss_1')).toMatchObject({
      revision: 2,
      blockedBy: ['a', 'b'],
    })
    // NULL to a value is a change: `IS NOT` on SQLite, `IS DISTINCT FROM` on Postgres
    // (a plain `<>` would read it as unchanged).
    await store.issues.upsertIssue(scope, { ...row, blockedBy: ['a', 'b'], prUrl: 'u' })
    expect((await store.issues.getIssue('iss_1'))?.revision).toBe(3)
    await store.close()
  })

  it('keeps an issue panel through its saves, toggles and removals', async () => {
    const store = await openStore()
    await seed(store, { id: asIssueId('iss_1') })
    const todo = (id: string, position: number, text: string) => ({
      id,
      issueId: 'iss_1',
      position,
      text,
      done: false,
    })
    await store.issues.panel.save(scope, 'issuePanelTodo', todo('td_1', 0, 'one') as never)
    await store.issues.panel.save(scope, 'issuePanelTodo', todo('td_2', 1, 'two') as never)
    await store.issues.panel.save(scope, 'issuePanelState', {
      id: 'iss_1',
      text: 'where things stand',
      updatedAt: at(1),
    } as never)
    await store.issues.panel.toggle(scope, 'iss_1', 'td_2', true)
    await store.issues.panel.remove(scope, 'issuePanelTodo', 'iss_1', 'td_1')

    const panel = await store.issues.panel.read('iss_1')
    expect(panel).toMatchObject({ todos: [{ text: 'two', done: true }] })
    expect(await store.issues.panel.state('iss_1')).toMatchObject({ text: 'where things stand' })
    expect(await store.issues.panel.clearTodos(scope, 'iss_1')).toEqual(['td_2'])
    await store.close()
  })
})

describe('change capture on Postgres (design 2.5)', () => {
  it("captures an issue's insert, update and delete in the write statements", async () => {
    const store = await openStore()
    const keysOf = (
      rows: readonly { op: string; oldKey: unknown; newKey: unknown }[],
      op: string,
    ) => rows.filter((row) => row.op === op).map((row) => JSON.stringify(row.newKey ?? row.oldKey))
    const inserted = await store.captureOf(
      async (issues) => await issues.upsertIssue(scope, issueRow({ id: asIssueId('iss_1') })),
    )
    const updated = await store.captureOf(
      async (issues) =>
        await issues.upsertIssue(scope, issueRow({ id: asIssueId('iss_1'), title: 'second' })),
    )
    const unchanged = await store.captureOf(
      async (issues) =>
        await issues.upsertIssue(scope, issueRow({ id: asIssueId('iss_1'), title: 'second' })),
    )
    const deleted = await store.captureOf(async (issues) => await issues.deleteIssue('iss_1'))
    if (store.engine === 'sqlite') {
      // The SQLite test database has no capture triggers until a change log attaches.
      expect([...inserted, ...updated, ...unchanged, ...deleted]).toEqual([])
    } else {
      expect(keysOf(inserted, 'i').some((key) => key.includes('iss_1'))).toBe(true)
      expect(keysOf(updated, 'u').some((key) => key.includes('iss_1'))).toBe(true)
      // A skipped upsert writes no row, so it captures nothing.
      expect(unchanged).toEqual([])
      expect(keysOf(deleted, 'd').some((key) => key.includes('iss_1'))).toBe(true)
    }
    await store.close()
  })
})

// ---------------------------------------------------------------------------
// Statement pins: one statement per listing read, whatever the number of issues,
// the same on both engines.
// ---------------------------------------------------------------------------

async function listingFixture(size: number): Promise<IssueEngineStore> {
  const store = await openStore()
  await seed(store, { id: asIssueId('iss_parent'), seq: 1, type: 'phase' })
  for (let i = 0; i < size; i++) {
    await seed(store, {
      id: asIssueId(`iss_${i}`),
      seq: i + 2,
      parentId: asIssueId('iss_parent'),
      title: `child ${i}`,
      updatedAt: at(i % 50),
      ownerUserId: i % 2 === 0 ? firstAdminMemberId() : asUserId('user:other'),
      ...(i % 3 === 0 ? { stage: 'done' as const } : {}),
    })
  }
  return store
}

const pin = (name: string, run: (store: IssueEngineStore) => Promise<unknown>) =>
  ({
    name,
    sizes: [4, 40],
    setup: listingFixture,
    target: (store) => store.probeTarget,
    run: async (store) => await run(store),
    teardown: async (store) => await store.close(),
  }) satisfies StatementPin<IssueEngineStore>

// Each case seeds two fixtures (4 and 40 issues), which takes a while on a loaded host.
describe('issue listing reads: one statement each at 4 and 40 issues', { timeout: 60_000 }, () => {
  it('a listing with the stale bound and its order', async () => {
    await expectConstantStatements(
      pin('listIssueRowsWhere(updated)', async (store) =>
        store.reads.listIssueRowsWhere(
          { repo: false, live: true, state: 'open', updatedBefore: true, order: 'updated' },
          { before: at(59) },
        ),
      ),
      1,
    )
  })

  it('a text search', async () => {
    await expectConstantStatements(
      pin('listIssueRowsWhere(text)', async (store) =>
        store.reads.listIssueRowsWhere(
          { repo: false, live: true, text: true, order: 'seq' },
          { text: 'child' },
        ),
      ),
      1,
    )
  })

  it('the count groups and the totals', async () => {
    await expectConstantStatements(
      pin('countIssueGroups', async (store) =>
        store.reads.countIssueGroups({ repo: false, live: true, order: 'seq' }),
      ),
      1,
    )
    await expectConstantStatements(
      pin('issueStatTotals', async (store) =>
        store.reads.issueStatTotals({ repo: false, live: true, order: 'seq' }),
      ),
      1,
    )
  })

  it('the live children of a parent', async () => {
    await expectConstantStatements(
      pin('liveChildrenOf', async (store) => store.reads.liveChildrenOf(['iss_parent'])),
      1,
    )
  })
})
