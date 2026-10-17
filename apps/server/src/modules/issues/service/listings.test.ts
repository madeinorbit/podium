/**
 * Issue listings and reports answer from SQL (POD-6191, part of POD-6158;
 * design §7 step 3.2).
 *
 * This file pins the listings over edge fixtures: deleted, archived and
 * quarantined rows, nested parents across repositories, labels, blockers that
 * are deleted or gone, deferrals in every spelling, search filters, and
 * readers who own some issues or hold grants on them. Until POD-6158 removed
 * the issue map, every listing was also compared with the map's code.
 */

import { asIssueId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../../store'
import { BOB, CAROL, type CorpusIssue, grantIssue, rawSql, seededStore } from '../../../test-support/issue-corpus'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { IssueStore } from './core'
import { type IssueReader, IssueReportsModule } from './reads'
import type { IssueDeps } from './types'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

function reportsOver(store: SessionStore, log = ''): IssueReportsModule {
  const issues = new IssueStore({
    store,
    ...sessionReadPorts(() => []),
    repoOp: async () => ({ ok: true, output: log }),
  } as unknown as IssueDeps)
  return new IssueReportsModule(issues)
}

/** The command context's reader, built the way `IssueCommandCtx` builds it. */
function readerFor(reports: IssueReportsModule, user: UserId): IssueReader {
  return {
    readableBy: () => user,
    mayRead: async (id) => {
      const target = await reports.ownedTarget(id, 'read')
      return target !== undefined && (target.owner === user || target.grants.includes(user))
    },
  }
}

const ids = (reports: readonly { id: string }[]) => reports.map((report) => report.id)

describe('issue listings over the database', () => {
  it('over the edge fixtures', async () => {
    const live = (seq: number, patch: Partial<CorpusIssue> = {}): CorpusIssue => ({
      id: `iss_${seq}`, seq, repoPath: '/a', worktreePath: null, parentId: null, stage: 'backlog',
      archived: false, deletedAt: null, updatedAt: '2026-06-01T00:00:00.000Z', ...patch,
    })
    const rows: CorpusIssue[] = [
      live(1, { title: 'Epic about login', type: 'phase' }),
      live(2, { parentId: 'iss_1', title: 'Login form', description: 'Fix the LOGIN form' }),
      live(3, { parentId: 'iss_2', worktreePath: '/a/.worktrees/issue-3', stage: 'in_progress' }),
      live(4, { parentId: 'iss_1', deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(5, { parentId: 'iss_1', archived: true, stage: 'done' }),
      live(6, { stage: 'done', closedReason: 'done' }),
      live(7, { closedReason: 'cancelled' }),
      live(8, { deferUntil: 'next-message' }),
      live(9, { deferUntil: '2099-01-01' }),
      live(10, { deferUntil: '2000-01-01T00:00:00.000Z' }),
      live(11, { deferUntil: 'not a date' }),
      live(12, { stage: 'proposed' }),
      live(13, { stage: 'shipping' }),
      live(14, { priority: 0, title: 'Ünïcode lögin', updatedAt: '2026-09-30T00:00:00.000Z' }),
      live(15, { ownerUserId: BOB, parentId: 'iss_1' }),
      live(16, { ownerUserId: CAROL }),
      // A second repository: the same numbers, and a child of a parent in /a.
      live(1, { id: 'iss_b1', repoPath: '/b', parentId: 'iss_1', title: 'Login elsewhere' }),
      live(2, { id: 'iss_b2', repoPath: '/b', worktreePath: '/b/.worktrees/issue-2', stage: 'done' }),
      live(3, { id: 'iss_b3', repoPath: '/b', stage: 'done', closedReason: 'done', worktreePath: '/b/wt-3' }),
      live(17, { id: 'iss_gone_blocker' }),
    ]
    const store = await seededStore(rows, ['/a', '/b'], [
      { fromId: 'iss_2', toId: 'iss_3', type: 'blocked-by' },
      { fromId: 'iss_3', toId: 'iss_4', type: 'blocked-by' }, // a deleted, open blocker still blocks
      { fromId: 'iss_8', toId: 'iss_6', type: 'blocked-by' }, // a finished blocker does not
      { fromId: 'iss_9', toId: 'iss_gone_blocker', type: 'blocked-by' },
      { fromId: 'iss_10', toId: 'iss_b1', type: 'blocked-by' },
      { fromId: 'iss_b1', toId: 'iss_2', type: 'related' },
      { fromId: 'iss_12', toId: 'iss_13', type: 'blocked-by' },
      { fromId: 'iss_13', toId: 'iss_12', type: 'blocked-by' }, // a cycle for doctor
      { fromId: 'iss_14', toId: 'iss_16', type: 'duplicates' },
    ])
    stores.push(store)
    // A blocker whose row is gone (hard delete cascades its edges, so the edge
    // is planted after with the foreign keys off).
    await store.issues.deleteIssue('iss_gone_blocker')
    rawSql(store, 'PRAGMA foreign_keys = OFF')
    rawSql(store, "INSERT INTO issue_deps (from_id, to_id, type) VALUES ('iss_9', 'iss_gone_blocker', 'blocked-by')")
    rawSql(store, 'PRAGMA foreign_keys = ON')
    await store.issues.setIssueLabels(asIssueId('iss_2'), ['ui', 'auth'])
    await store.issues.setIssueLabels(asIssueId('iss_b1'), ['auth'])
    await grantIssue(store, 'iss_2', BOB, 'read')
    await grantIssue(store, 'iss_3', BOB, 'see')
    await grantIssue(store, 'iss_b1', BOB, 'manage')
    await grantIssue(store, 'iss_16', BOB, 'write')
    const viewer = await firstAdminMemberId(store)
    await store.issues.setIssueUserState(viewer, asIssueId('iss_2'), { readAt: '2026-10-01T00:00:00.000Z', pinnedAt: '2026-10-02T00:00:00.000Z' })
    // Quarantined: a NULL id (SQLite allows one in a TEXT primary key).
    await store.issues.upsertIssue({ ...(await store.issues.getIssue('iss_7'))!, id: asIssueId('iss_corrupt'), seq: 99, revision: undefined } as never)
    rawSql(store, 'UPDATE issues SET id = NULL WHERE id = ?', 'iss_corrupt')
    const reports = reportsOver(store, 'abc fix #2 and issue/3-login\n#14 done')

    // Work queues: an open blocker blocks even when deleted; a finished one or
    // a missing row does not; deferral leaves the ready queue.
    expect(ids(await reports.blockedList('/a'))).toEqual(['iss_2', 'iss_3', 'iss_10', 'iss_12', 'iss_13'])
    expect(ids(await reports.readyList('/a'))).toEqual(['iss_14', 'iss_1', 'iss_11', 'iss_15', 'iss_16'])
    expect((await reports.doctor('/a')).cycles.length).toBeGreaterThan(0)
    // Open issues the repository's log names, by `#N` or branch stem.
    expect((await reports.orphans('/a')).map((orphan) => [orphan.id, orphan.ref])).toEqual([
      ['iss_2', '#2'], ['iss_3', 'issue/3-'], ['iss_14', '#14'],
    ])

    // Search filters, in priority then sequence order across repositories.
    expect(ids(await reports.search({ label: 'auth' }))).toEqual(['iss_b1', 'iss_2'])
    expect(ids(await reports.search({ text: 'login' }))).toEqual(['iss_1', 'iss_b1', 'iss_2'])
    expect(ids(await reports.search({ text: 'LÖGIN' }))).toEqual(['iss_14'])
    expect(ids(await reports.search({ parentId: asIssueId('iss_1') }))).toEqual(['iss_b1', 'iss_2', 'iss_5', 'iss_15'])
    expect(ids(await reports.search({ stage: 'done' }))).toEqual(['iss_b2', 'iss_b3', 'iss_5', 'iss_6'])
    expect(ids(await reports.search({ priority: 0 }))).toEqual(['iss_14'])
    expect(ids(await reports.search({ assignee: asUserId('nobody') }))).toEqual([])

    // Readers see what they own or hold a read-covering grant on.
    expect(ids(await reports.search({}, readerFor(reports, BOB)))).toEqual(['iss_b1', 'iss_2', 'iss_15', 'iss_16'])
    expect(ids(await reports.search({}, readerFor(reports, CAROL)))).toEqual(['iss_16'])

    // A parent's live children across repositories, by sequence number.
    expect(ids(await reports.children('iss_1'))).toEqual(['iss_b1', 'iss_2', 'iss_5', 'iss_15'])

    // One repository's number, deleted or not; an unknown repository has none.
    expect((await reports.getBySeq('/b', 1))?.id).toBe('iss_b1')
    expect((await reports.getBySeq('/a', 4))?.id).toBe('iss_4')
    expect(await reports.getBySeq('/no/such/repo', 1)).toBeUndefined()

    // The closed-issue sweep: closed, live, with a worktree or a member.
    expect([...(await reports.closedWithWork(new Set(['iss_6', 'iss_7', 'iss_b3'])))].sort()).toEqual(['iss_6', 'iss_7', 'iss_b2', 'iss_b3'])
    expect(await reports.closedWithWork(new Set())).toEqual(['iss_b2', 'iss_b3'])
  })
})
