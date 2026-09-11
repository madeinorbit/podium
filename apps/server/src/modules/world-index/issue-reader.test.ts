import { makeFeedVisibility } from '../../feed-visibility'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asIssueId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type { IssueRow, SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { IssueStore } from '../issues/service/core'
import type { IssueDeps } from '../issues/service/types'
import { DurableIssueAccessIndex } from '../issues/access-index'
import { MemoryVisibilityPolicy } from '../memory/visibility'
import { WorldIndex } from './index'
import { readIssue, readIssues, readIssueRows, readIssueCwdRows, readIssueParentEdges, readClosedIssueIds } from './issue-reader'

const stores: SessionStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.close() })
const alice = asUserId('alice')
const bob = asUserId('bob')
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
async function setup(bound: boolean) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.issues.upsertIssue(issueRow({ ownerUserId: alice }))
  await WorldIndex.load(store)
  // Only hydration and row projection are needed; workflow ports are not used.
  const index = bound ? await new IssueStore({ store } as IssueDeps).init() : undefined
  return { store, index }
}

// Ownership is immutable on upsert. A delete/recreate is the repository-level
// transition that can actually replace the owner, and must never use stale auth.
async function replaceIssue(store: SessionStore, row: IssueRow) {
  await store.transact(async () => {
    await store.issues.deleteIssue(row.id)
    await store.issues.upsertIssue(row)
  })
}

// Run the identical characterization against the original repository route
// and the bound snapshot route; expected authorization decisions are explicit.
describe.each([false, true])('issue authority, bound=%s', bound => {
  it('preserves owner, stranger, missing, deleted and transferred ownership', async () => {
    const { store } = await setup(bound)
    const access = new DurableIssueAccessIndex(store.issues, store.grants, store.repos)
    const policy = new MemoryVisibilityPolicy(store)
    const world = await WorldIndex.load(store)
    const feed = makeFeedVisibility({ store, worldIndex: world.reader,
      audienceResourceIds: kind => store.grants.visibilityAudienceResourceIds(kind),
      audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
      authorizationRevision: () => store.grants.visibilityRevision() })
    const allowed = async (id: typeof alice, issue = 'iss_x') => {
      const memory = await policy.mayRead({ kind: 'user', id }, { class: 'issue', id: issue })
      expect(await feed.mayReadIssue(id, asIssueId(issue))).toBe(memory)
      return memory
    }
    expect(await allowed(alice)).toBe(true)
    expect(await allowed(bob)).toBe(false)
    expect(await allowed(alice, 'absent')).toBe(false)
    expect(await access.has(asIssueId('absent'))).toBe(false)
    expect((await access.ownedTarget(asIssueId('iss_x'), 'read'))?.owner).toBe(alice)
    await store.transact(async () => {
      await replaceIssue(store, issueRow({ ownerUserId: bob }))
      expect(await allowed(alice)).toBe(false)
      expect(await allowed(bob)).toBe(true)
    })
    expect(await allowed(alice)).toBe(false)
    expect(await allowed(bob)).toBe(true)
    await expect(store.transact(async () => {
      await replaceIssue(store, issueRow({ ownerUserId: alice }))
      expect(await allowed(alice)).toBe(true)
      expect(await allowed(bob)).toBe(false)
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await allowed(alice)).toBe(false)
    expect(await allowed(bob)).toBe(true)
    // Existing policy does not filter soft deletion at this low-level seam.
    await store.issues.upsertIssue(issueRow({ ownerUserId: bob, deletedAt: '2026-09-11' }))
    expect(await allowed(bob)).toBe(true)
    await store.issues.deleteIssue('iss_x')
    expect(await allowed(bob)).toBe(false)
  })

  it('preserves grant verbs and missing-row denial', async () => {
    const { store } = await setup(bound)
    const policy = new MemoryVisibilityPolicy(store)
    for (const verb of ['read', 'write', 'manage', 'use'] as const) {
      await store.grants.upsert({ resourceKind: 'issue', resourceId: 'iss_x', grantee: bob,
        verb, owner: alice, visibility: 'personal', createdAt: '2026-09-11',
        actorKind: 'user', actorId: alice, onBehalfOf: alice })
      expect(await policy.mayRead({ kind: 'user', id: bob }, { class: 'issue', id: 'iss_x' })).toBe(verb !== 'use')
      await store.grants.remove('issue', 'iss_x', bob, verb)
    }
  })
})

it('serves committed point/batch/list reads without SQL and returns private copies', async () => {
  const { store, index } = await setup(true)
  const point = vi.spyOn(store.issues, 'getIssue')
  const batch = vi.spyOn(store.issues, 'getIssues')
  const list = vi.spyOn(store.issues, 'listIssueRows')
  const row = (await readIssue(store.issues, 'iss_x'))!
  row.ownerUserId = bob
  row.blockedBy.push('mutated')
  expect((await readIssue(store.issues, 'iss_x'))?.ownerUserId).toBe(alice)
  expect((await readIssue(store.issues, 'iss_x'))?.blockedBy).toEqual([])
  expect(await readIssue(store.issues, 'absent')).toBeNull()
  expect([...(await readIssues(store.issues, ['iss_x', 'absent', 'iss_x'])).keys()]).toEqual(['iss_x'])
  expect((await readIssueRows(store.issues)).map(row => row.id)).toEqual(['iss_x'])
  expect(point).not.toHaveBeenCalled()
  expect(batch).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
  await store.issues.upsertIssue(issueRow({ ownerUserId: bob, title: 'direct write' }))
  expect(index?.rows.get('iss_x')?.title).toBe('direct write')
  // The returned durable row preserves the original owner on ordinary upsert.
  expect((await readIssue(store.issues, 'iss_x'))?.ownerUserId).toBe(alice)
  const other = await setup(false)
  expect((await readIssue(other.store.issues, 'iss_x'))?.ownerUserId).toBe(alice)
})

it('keeps snapshot isolated through nested rollback and refreshes on commit', async () => {
  const { store, index } = await setup(true)
  await store.transact(async () => {
    await replaceIssue(store, issueRow({ ownerUserId: bob }))
    expect(index?.rows.get('iss_x')?.ownerUserId).toBe(alice)
    expect((await readIssues(store.issues, ['iss_x'])).get('iss_x')?.ownerUserId).toBe(bob)
    expect((await readIssueRows(store.issues))[0]?.ownerUserId).toBe(bob)
    await expect(store.transact(async () => {
      await replaceIssue(store, issueRow({ ownerUserId: alice }))
      throw new Error('savepoint')
    })).rejects.toThrow('savepoint')
    expect((await readIssue(store.issues, 'iss_x'))?.ownerUserId).toBe(bob)
  })
  expect((await readIssue(store.issues, 'iss_x'))?.ownerUserId).toBe(bob)
})


it('preserves cwd ordering, archive ambiguity, and lightweight projections', async () => {
  const { store } = await setup(false)
  await store.issues.upsertIssue(issueRow({ worktreePath: '/r/work', archived: true }))
  await store.issues.upsertIssue(issueRow({ id: asIssueId('iss_y'), seq: 2, worktreePath: '/r/work', parentId: asIssueId('iss_x'), stage: 'done' }))
  const access = new DurableIssueAccessIndex(store.issues, store.grants, store.repos)
  const before = {
    cwd: await store.issues.listIssueCwdRows(), parents: await store.issues.listIssueParentEdges(), closed: await store.issues.closedIssueIds(),
    match: await access.issueForCwd('/r/work/sub'), sole: await access.soleOwnerForCwd('/r/work/sub'), paths: await access.worktreePaths(),
  }
  await new IssueStore({ store } as IssueDeps).init()
  expect(await readIssueCwdRows(store.issues)).toEqual(before.cwd)
  expect(await readIssueParentEdges(store.issues)).toEqual(before.parents)
  expect(await readClosedIssueIds(store.issues)).toEqual(before.closed)
  expect(await access.issueForCwd('/r/work/sub')).toBe(before.match)
  expect(await access.soleOwnerForCwd('/r/work/sub')).toBe(before.sole)
  expect(await access.worktreePaths()).toEqual(before.paths)
})

it('disables the snapshot when boot quarantines a row', async () => {
  const { store } = await setup(false)
  const raw = (store as unknown as { db: { prepare(sql: string): { run(): void } } }).db
  raw.prepare("INSERT INTO issues (id, repo_path, seq, title, stage, default_agent, created_at, updated_at) VALUES (NULL, '/r', 99, 'bad', 'backlog', 'claude-code', 't', 't')").run()
  await new IssueStore({ store } as IssueDeps).init()
  const point = vi.spyOn(store.issues, 'getIssue')
  const cwd = vi.spyOn(store.issues, 'listIssueCwdRows')
  expect((await readIssue(store.issues, 'iss_x'))?.ownerUserId).toBe(alice)
  await readIssueCwdRows(store.issues)
  expect(point).toHaveBeenCalledOnce()
  expect(cwd).toHaveBeenCalledOnce()
})
