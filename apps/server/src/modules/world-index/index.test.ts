import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import {
  asIssueId,
  asRepoId,
  asUserId,
  firstAdminMemberId,
} from '@podium/model'
import { queryAttributionEnabled } from '@podium/runtime/query-attribution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IssueRow, SessionStore } from '../../store'
import type { GrantRow } from '../../store/grants'
import { withReadScope } from '../../store/executor/read-scope'
import { openTestStore } from '../../test-support/open-test-store'
import { statementBudget } from '../../test-support/statement-budget'
import { WorldIndex } from './index'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
async function setup() {
  const store = await openTestStore(':memory:')
  // Issues are placed on a machine that reported their repo (2b803efb5 refuses
  // implicit placement), so the fixture's repo is reported by the host machine.
  await store.repos.addRepo('/r', store.hostMachineId)
  stores.push(store)
  return store
}
const alice = asUserId('user:world-alice')
const at = '2026-09-11T00:00:00Z'
const grant: GrantRow = {
  resourceKind: 'issue',
  resourceId: 'iss_x',
  grantee: alice,
  verb: 'read',
  owner: alice,
  visibility: 'personal',
  createdAt: at,
  actorKind: 'user',
  actorId: alice,
  onBehalfOf: alice,
}
const account = {
  id: alice,
  displayName: 'Alice',
  email: null,
  accountId: null,
  avatar: null,
  role: 'admin' as const,
  createdAt: at,
  disabledAt: null,
}
const machine = {
  id: 'world-machine',
  name: 'First',
  hostname: 'host',
  tokenHash: 'secret',
  ownerUserId: alice,
}
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
    createdAt: 't',
    updatedAt: 't',
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

describe('world index committed facts', () => {
  it('loads all facts, excludes leases and exposes only memory reads', async () => {
    const store = await setup()
    await store.users.create(account, 'hash')
    await store.grants.upsert(grant)
    await store.issues.upsertIssue(issueRow({ worktreePath: '/worktree' }))
    await store.machines.upsertMachine(machine)
    const loading = queryAttributionEnabled
      ? await statementBudget(() => WorldIndex.load(store))
      : null
    const index = loading?.result ?? (await WorldIndex.load(store))
    if (loading)
      expect(
        [...loading.byQuery]
          .filter(([sql]) => /^select /i.test(sql))
          .reduce((sum, [, n]) => sum + n, 0),
      ).toBe(1)
    expect(await WorldIndex.load(store)).toBe(index)
    expect(index.reader).not.toHaveProperty('lease')
    const read = () => {
      expect(index.reader.issueForWorktree('/worktree')).toBe('iss_x')
    }
    read()
    if (queryAttributionEnabled) expect((await statementBudget(read)).statements).toBe(0)
    else
      await expect(statementBudget(read)).rejects.toThrow(
        'requires PODIUM_LOOP_PROFILE=attribution',
      )
  })

  it('cannot republish a disabled account from an older credential caller read scope', async () => {
    const store = await setup()
    await store.users.create(account, 'hash')
    let cached!: () => void
    let resume!: () => void
    const cachedAccount = new Promise<void>((resolve) => {
      cached = resolve
    })
    const disabled = new Promise<void>((resolve) => {
      resume = resolve
    })
    const caller = withReadScope(async () => {
      expect(await store.users.get(alice)).toEqual(account)
      cached()
      await disabled
      // A committed disable invalidates even an older authentication read scope.
      expect(await store.users.get(alice)).toBeUndefined()
      await expect(store.users.setPasswordHash(alice, 'replacement', at)).rejects.toThrow(
        'unknown user',
      )
    })
    await cachedAccount
    await store.users.disable(alice, at)
    resume()
    await caller
    expect(await store.users.get(alice)).toBeUndefined()
  })

  it('resolves deepest literal prefixes and excludes tombstones at load and commit', async () => {
    const store = await setup()
    const broad = issueRow({ worktreePath: '/tree' })
    const narrow = issueRow({ id: asIssueId('iss_nested'), seq: 2, worktreePath: '/tree/nested' })
    const deleted = issueRow({ id: asIssueId('iss_deleted'), seq: 3, worktreePath: '/tree/nested/deleted', deletedAt: at })
    for (const row of [broad, narrow, deleted]) await store.issues.upsertIssue(row)
    const index = await WorldIndex.load(store)
    expect(index.reader.issueForWorktree('/tree/nested/src')).toBe(narrow.id)
    expect(index.reader.issueForWorktree('/tree/nested/deleted/src')).toBe(narrow.id)
    expect(index.reader.issueForWorktree('/tree-other')).toBeUndefined()
    expect(index.reader.issueForWorktree('/tree/nested-other')).toBe(broad.id)
    expect(index.reader.issueForWorktree('/tree/')).toBe(broad.id)
    const scan = vi.spyOn(store.issues, 'listIssueCwdRows')
    const read = () => {
      for (let i = 0; i < 200; i++) expect(index.reader.issueForWorktree(`/tree/nested/src/${i}`)).toBe(narrow.id)
    }
    if (queryAttributionEnabled) expect((await statementBudget(read)).statements).toBe(0)
    else read()
    expect(scan).not.toHaveBeenCalled()
    await expect(store.transact(async () => {
      await store.issues.upsertIssue({ ...narrow, deletedAt: at })
      expect(index.reader.issueForWorktree('/tree/nested/src')).toBe(narrow.id)
      throw new Error('rollback membership')
    })).rejects.toThrow('rollback membership')
    expect(index.reader.issueForWorktree('/tree/nested/src')).toBe(narrow.id)
    await store.issues.upsertIssue({ ...narrow, deletedAt: at })
    expect(index.reader.issueForWorktree('/tree/nested/src')).toBe(broad.id)
    await store.issues.upsertIssue(narrow)
    expect(index.reader.issueForWorktree('/tree/nested/src')).toBe(narrow.id)
  })

  it('moves issue worktrees and follows shipping, reassignment, bulk backfill and deletion', async () => {
    const store = await setup()
    const index = await WorldIndex.load(store)
    const apply = vi.spyOn(index, 'apply')
    const row = issueRow({ stage: 'review', worktreePath: '/before' })
    await store.issues.upsertIssue(row)
    expect(apply).toHaveBeenCalled()
    expect(index.reader.issueForWorktree('/before')).toBe(row.id)
    row.worktreePath = '/after'
    await store.issues.upsertIssue(row)
    expect(index.reader.issueForWorktree('/before')).toBeUndefined()
    expect(index.reader.issueForWorktree('/after')).toBe(row.id)
    for (const write of [
      () => store.issues.transitionShippingStage(row.id, 'review', 'shipping', at),
      () => store.issues.assignRepoIdToIssuesUnder(asRepoId('repo:new'), row.repoPath),
    ]) {
      apply.mockClear()
      await write()
      expect(apply).toHaveBeenCalled()
      expect(index.reader.issueForWorktree('/after')).toBe(row.id)
    }
    const child = issueRow({
      id: asIssueId('iss_child'),
      seq: 2,
      parentId: row.id,
      supersededBy: row.id,
      duplicateOf: row.id,
    })
    await store.issues.upsertIssue(child)
    await store.issues.deleteIssue(row.id)
    expect(index.reader.issueForWorktree('/after')).toBeUndefined()
    expect((await store.issues.getIssue(child.id))?.parentId).toBeNull()
  })

  it('applies legacy renumbering and preserves duplicate-worktree ordering at load and commit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'world-index-renumber-'))
    const file = join(directory, 'store.db')
    const store = await openTestStore(file)
    try {
      // An isolated legacy fixture: production creates this index at boot.
      const raw = openDatabase(file)
      try {
        raw.exec('DROP INDEX idx_issues_repo_id_seq')
      } finally {
        raw.close()
      }
      const repoId = asRepoId('repo:shared')
      await store.issues.upsertIssue(issueRow({ repoId, repoPath: '/a', worktreePath: '/shared' }))
      await store.issues.upsertIssue(
        issueRow({ id: asIssueId('iss_y'), repoId, repoPath: '/b', worktreePath: '/shared' }),
      )
      const index = await WorldIndex.load(store)
      expect(index.reader.issueForWorktree('/shared')).toBe('iss_x')
      const apply = vi.spyOn(index, 'apply')
      expect(await store.issues.renumberCollidingIssueSeqs()).toBe(1)
      expect(apply).toHaveBeenCalledTimes(1)
      expect(apply.mock.calls[0]?.[0]).toMatchObject({
        kind: 'issues',
        rows: [{ id: 'iss_y', seq: 2 }],
      })
      expect(index.reader.issueForWorktree('/shared')).toBe('iss_x')
      apply.mockClear()
      await store.issues.deleteIssue('iss_x')
      expect(apply).toHaveBeenCalledTimes(1)
      expect(index.reader.issueForWorktree('/shared')).toBe('iss_y')
    } finally {
      await store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rolls back all facts, including nested writes, and publishes only after commit', async () => {
    const store = await setup()
    const index = await WorldIndex.load(store)
    const apply = vi.spyOn(index, 'apply')
    await expect(
      store.transact(async () => {
        await store.users.create(account, 'hash')
        await store.grants.upsert(grant)
        await store.machines.upsertMachine(machine)
        await store.issues.upsertIssue(issueRow({ worktreePath: '/rollback' }))
        expect(apply).not.toHaveBeenCalled()
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(apply).not.toHaveBeenCalled()
    expect(index.reader.issueForWorktree('/rollback')).toBeUndefined()
    await store.transact(async () => {
      await store.issues.upsertIssue(issueRow({ worktreePath: '/kept' }))
      await expect(
        store.transact(async () => {
          await store.issues.upsertIssue(issueRow({ worktreePath: '/rolled-back' }))
          throw new Error('inner')
        }),
      ).rejects.toThrow('inner')
    })
    expect(index.reader.issueForWorktree('/kept')).toBe('iss_x')
    expect(index.reader.issueForWorktree('/rolled-back')).toBeUndefined()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does not expose half a commit to microtask readers', async () => {
    const store = await setup()
    const index = await WorldIndex.load(store)
    const observations: boolean[] = []
    store.grants.committed.subscribe(() => {
      queueMicrotask(() => observations.push(index.reader.issueForWorktree('/micro') !== undefined))
    })
    await store.transact(async () => {
      await store.grants.upsert(grant)
      await store.issues.upsertIssue(issueRow({ worktreePath: '/micro' }))
    })
    expect(observations).toEqual([true])
  })
})
