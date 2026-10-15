import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import {
  asIssueId,
  asRepoId,
  asSessionId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
} from '@podium/model'
import { queryAttributionEnabled } from '@podium/runtime/query-attribution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IssueRow, MessageRow, SessionStore } from '../../store'
import type { GrantRow } from '../../store/grants'
import { withReadScope } from '../../store/executor/read-scope'
import { openTestStore } from '../../test-support/open-test-store'
import { statementBudget } from '../../test-support/statement-budget'
import { WorldIndex } from './index'
import { DeliveryScheduler } from '../messages/scheduler'

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
const session = asSessionId('world-reader')
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

function message(input: Omit<Partial<MessageRow>, 'id'> & { id: string }): MessageRow {
  return {
    threadId: asThreadId(input.id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind: 'issue',
    toId: 'iss_target',
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: input.id,
    expiresAt: null,
    createdAt: 't0',
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    readAt: null,
    injectedAt: null,
    deadLetteredAt: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
    ...input,
  } as MessageRow
}

describe('world index committed facts', () => {
  it('loads all facts, excludes leases and exposes only memory reads', async () => {
    const store = await setup()
    await store.users.create(account, 'hash')
    await store.grants.upsert(grant)
    await store.issues.upsertIssue(issueRow({ worktreePath: '/worktree' }))
    await store.machines.upsertMachine(machine)
    await store.messages.addMessage(message({ id: 'one' }))
    await store.messages.addMessage(message({ id: 'two' }))
    await store.messages.addMessage(message({ id: 'done' }))
    await store.messages.markDelivered('done', null, 't1')
    const loading = queryAttributionEnabled
      ? await statementBudget(() => WorldIndex.load(store))
      : null
    const index = loading?.result ?? (await WorldIndex.load(store))
    if (loading)
      expect(
        [...loading.byQuery]
          .filter(([sql]) => /^select /i.test(sql))
          .reduce((sum, [, n]) => sum + n, 0),
      ).toBe(2)
    expect(await WorldIndex.load(store)).toBe(index)
    expect(index.reader).not.toHaveProperty('lease')
    const read = () => {
      expect(index.reader.issueForWorktree('/worktree')).toBe('iss_x')
      expect(index.reader.pendingCount({ kind: 'issue', id: 'iss_target' })).toBe(2)
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
        await store.messages.addMessage(message({ id: 'rollback' }))
        await store.issues.upsertIssue(issueRow({ worktreePath: '/rollback' }))
        expect(apply).not.toHaveBeenCalled()
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(apply).not.toHaveBeenCalled()
    expect(index.reader.pendingCount({ kind: 'issue', id: 'iss_target' })).toBe(0)
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

  it('counts every message transition and duplicate CAS without before-image reads', async () => {
    const store = await setup()
    const index = await WorldIndex.load(store)
    const apply = vi.spyOn(index, 'apply')
    const writes: Array<[string, (id: string) => Promise<unknown>]> = [
      ['markDispatched', (id) => store.messages.markDispatched(id, session, at)],
      ['markTyped', (id) => store.messages.markTyped(id, session, at)],
      ['markDelivered', (id) => store.messages.markDelivered(id, null, at)],
      ['markCancelled', (id) => store.messages.markCancelled(id)],
      ['markDeliveredByPull', (id) => store.messages.markDeliveredByPull(id, null, at)],
      ['markRead', (id) => store.messages.markRead(id, null, at)],
      ['markDeadLetter', (id) => store.messages.markDeadLetter(id, at)],
      [
        'markDeliveryAbandoned',
        (id) => store.messages.markDeliveryAbandoned(id, session, at, 'teardown'),
      ],
      ['markAcked', (id) => store.messages.markAcked(id, 'ack')],
      ['markReminded', (id) => store.messages.markReminded(id, at)],
      [
        'expireObserved',
        (id) =>
          store.messages.expireObserved({
            id,
            createdAt: 't0',
            lifecycle: 'wait',
            expiresAt: null,
          }),
      ],
    ]
    for (const [id, write] of writes) {
      await store.messages.addMessage(message({ id }))
      apply.mockClear()
      await write(id)
      expect(apply, id).toHaveBeenCalledTimes(1)
      await write(id)
      expect(index.reader.pendingCount({ kind: 'issue', id: 'iss_target' })).toBe(
        await store.messages.countPending({ kind: 'issue', id: 'iss_target' }),
      )
    }
    for (const transition of ['refuse', 'read'] as const) {
      const id = `dispatched-${transition}`
      await store.messages.addMessage(message({ id }))
      await store.messages.markDispatched(id, session, at)
      apply.mockClear()
      if (transition === 'refuse')
        await store.messages.markDeliveryAbandoned(id, session, at, 'teardown')
      else await store.messages.markRead(id, null, at)
      expect(apply).toHaveBeenCalledTimes(1)
      expect(index.reader.pendingCount({ kind: 'issue', id: 'iss_target' })).toBe(
        await store.messages.countPending({ kind: 'issue', id: 'iss_target' }),
      )
    }
    if (queryAttributionEnabled) {
      // A move that applies is ONE statement: no before-image read. Only a move
      // that did not apply reads the row once, by primary key, to say whether
      // it was already there or refused.
      await store.messages.addMessage(message({ id: 'budget' }))
      const applied = await statementBudget(() => store.messages.markCancelled('budget'))
      expect([...applied.byQuery.keys()].filter((sql) => /^select /i.test(sql))).toEqual([])
      expect([...applied.byQuery.keys()].filter((sql) => /^update /i.test(sql))).toHaveLength(1)
      const refused = await statementBudget(() => store.messages.markCancelled('absent'))
      expect([...refused.byQuery.keys()].filter((sql) => /^select /i.test(sql))).toHaveLength(1)
      expect([...refused.byQuery.keys()].filter((sql) => /^update /i.test(sql))).toHaveLength(1)
    }
  })
})


describe('pending message counter properties', () => {
  it.each([1, 17, 3852, 3871])('matches SQLite after each random transition (seed %i)', async (seed) => {
    const store = await setup()
    const targets = [
      { kind: 'issue' as const, id: 'iss_target' },
      { kind: 'issue' as const, id: 'iss_other' },
      { kind: 'session' as const, id: 'world-reader' },
      { kind: 'operator' as const },
    ]
    let state = seed
    const random = (n: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % n
    }
    const ids: string[] = []
    // Exercise boot hydration as well as subsequent commit projections.
    await store.messages.addMessage(message({ id: 'initial' }))
    ids.push('initial')
    const index = await WorldIndex.load(store)
    const check = async () => {
      for (const target of targets) {
        expect(index.reader.pendingCount(target), JSON.stringify({ seed, state, target })).toBe(
          await store.messages.countPending(target),
        )
      }
    }
    await check()
    for (let step = 0; step < 200; step++) {
      const operation = random(5)
      const id = ids[random(ids.length)]!
      if (operation === 0) {
        const target = targets[random(targets.length)]!
        const next = `random-${step}`
        await store.messages.addMessage(message({ id: next, toKind: target.kind, toId: target.id ?? null }))
        ids.push(next)
      } else if (operation === 1) {
        await store.messages.markDelivered(id, session, at)
      } else if (operation === 2) {
        await store.messages.markCancelled(id)
      } else if (operation === 3) {
        await store.messages.expireObserved({ id, createdAt: 't0', lifecycle: 'wait', expiresAt: null })
      } else {
        await store.messages.markDispatched(id, session, at)
      }
      await check()
      if (step % 25 === 0) {
        await expect(store.transact(async () => {
          await store.messages.addMessage(message({ id: `rollback-${step}` }))
          await store.messages.markCancelled(id)
          throw new Error('rollback property')
        })).rejects.toThrow('rollback property')
        await check()
      }
    }
  })

  it.skipIf(!queryAttributionEnabled)('200 delivery triggers execute zero SQL statements', async () => {
    const store = await setup()
    await store.messages.addMessage(message({ id: 'pending' }))
    const index = await WorldIndex.load(store)
    const scheduler = new DeliveryScheduler({
      messages: store.messages,
      worldIndex: index.reader,
      now: () => at,
      runner: {
        targetOf: () => null,
        nowMs: () => 0,
        attemptOne: () => {},
      },
    })
    try {
      const budget = await statementBudget(async () => {
        for (let i = 0; i < 200; i++) {
          await scheduler.queueDeliveryTarget({ kind: 'issue', id: i % 2 ? 'empty' : 'iss_target' })
        }
      })
      expect(budget.statements).toBe(0)
      expect(scheduler.deliveryStats()).toMatchObject({ pendingTargetCount: 1, coalescedTriggerCount: 99 })
    } finally {
      scheduler.dispose()
    }
  })
})
