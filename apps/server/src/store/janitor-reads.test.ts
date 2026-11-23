/**
 * THE JANITOR'S READS ON BOTH ENGINES [POD-6993, POD-6958 design 2.9].
 *
 * The facts the janitor observes (`store/janitor-reads.ts`), each against rows that
 * should and should not qualify, on the run's engine. The janitor package tests its
 * paging and planning over a fake of the same port; what these pin is the SQL: which
 * rows each read returns and in what order, the same on SQLite and Postgres. The last
 * group opens the janitor's database the way its worker does (`janitor-database.ts`):
 * a read session of the store's own engine per scan.
 */

import {
  AppliedMutationsPrunePlanner,
  AutomationDueReader,
  ChangeLogPrunePlanner,
  ConnectScanReader,
  EventLogPrunePlanner,
  IssueAutoArchiveReader,
  type JanitorReadSource,
  MaintenanceCommandsPrunePlanner,
  MessageExpiryReader,
  QueuedMessagesExpiryReader,
  SessionAutoArchiveReader,
  StewardPollReader,
  WorktreeGcReader,
} from '@podium/janitor'
import { afterEach, describe, expect, it } from 'vitest'
import { openJanitorDatabase } from '../janitor-database'
import {
  type JanitorSlice,
  type JanitorStore,
  openJanitorStore,
} from '../test-support/janitor-store-slice'
import { countStatements } from '../test-support/statement-count'
import { fleetDb } from './executor/sync-drizzle'
import { workspacesWithFeed } from './janitor-reads'

let store: JanitorStore | undefined
let ws: JanitorSlice

async function open(workspace = 'local'): Promise<JanitorSlice> {
  const opened = await openJanitorStore([workspace])
  store = opened.store
  ;[ws] = opened.slices
  return ws
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const iso = (day: number, hour = 0) => new Date(Date.UTC(2026, 6, day, hour)).toISOString()

describe('JanitorReadsRepository: message expiry', () => {
  it('walks stored implicit-wait rows by (created_at, id), never a dispatched one', async () => {
    const { seed, reads } = await open()
    await seed.message({
      id: 'msg_dispatched',
      lifecycle: 'wait',
      createdAt: iso(1),
      deliveryStatus: 'dispatched',
    })
    await seed.message({ id: 'msg_b', lifecycle: 'wait', createdAt: iso(2) })
    await seed.message({ id: 'msg_a', lifecycle: 'wait', createdAt: iso(2) })
    await seed.message({ id: 'msg_wake', lifecycle: 'wake', createdAt: iso(2) })
    await seed.message({
      id: 'msg_has_deadline',
      lifecycle: 'wait',
      createdAt: iso(2),
      expiresAt: iso(20),
    })
    await seed.message({ id: 'msg_young', lifecycle: 'wait', createdAt: iso(12) })

    const first = await reads.implicitExpiryPage({ cutoff: iso(11), limit: 1 })
    expect(first).toEqual([{ id: 'msg_a', lifecycle: 'wait', createdAt: iso(2), expiresAt: null }])
    const rest = await reads.implicitExpiryPage({
      cutoff: iso(11),
      limit: 10,
      after: { createdAt: iso(2), id: 'msg_a' },
    })
    expect(rest.map((row) => row.id)).toEqual(['msg_b'])
  })

  it('walks stored rows past their own deadline by (expires_at, id)', async () => {
    const { seed, reads } = await open()
    await seed.message({ id: 'msg_late', lifecycle: 'wake', createdAt: iso(1), expiresAt: iso(10) })
    await seed.message({ id: 'msg_early', lifecycle: 'wake', createdAt: iso(1), expiresAt: iso(5) })
    await seed.message({
      id: 'msg_future',
      lifecycle: 'wait',
      createdAt: iso(1),
      expiresAt: iso(30),
    })
    await seed.message({
      id: 'msg_gone',
      lifecycle: 'wake',
      createdAt: iso(1),
      expiresAt: iso(2),
      deliveryStatus: 'expired',
    })

    const page = await reads.explicitExpiryPage({ now: iso(18), limit: 10 })
    expect(page).toEqual([
      { id: 'msg_early', lifecycle: 'wake', createdAt: iso(1), expiresAt: iso(5) },
      { id: 'msg_late', lifecycle: 'wake', createdAt: iso(1), expiresAt: iso(10) },
    ])
    const after = await reads.explicitExpiryPage({
      now: iso(18),
      limit: 10,
      after: { expiresAt: iso(5), id: 'msg_early' },
    })
    expect(after.map((row) => row.id)).toEqual(['msg_late'])
  })
})

describe('JanitorReadsRepository: retention heads', () => {
  it('finds the event cap and the prunable head, by age or over the cap', async () => {
    const { seed, reads } = await open()
    const ids: number[] = []
    for (const day of [1, 2, 3, 20, 21]) ids.push(await seed.event(iso(day)))
    // Two rows below the newest: the cap keeps the newest two.
    expect(await reads.eventCapThroughId(2)).toBe(ids[2])
    expect(await reads.eventCapThroughId(5)).toBeUndefined()
    // Older than day 10: the first three.
    const byAge = { cutoff: iso(10), capThroughId: 0 }
    expect(await reads.eventPruneHead(byAge)).toBe(ids[0])
    expect(await reads.eventPruneCount(byAge)).toBe(3)
    // Over the cap through the fourth.
    const overCap = { cutoff: iso(1), capThroughId: ids[3] as number }
    expect(await reads.eventPruneHead(overCap)).toBe(ids[0])
    expect(await reads.eventPruneCount(overCap)).toBe(4)
    expect(await reads.eventPruneHead({ cutoff: iso(1), capThroughId: 0 })).toBeNull()
    expect(await reads.eventPruneCount({ cutoff: iso(1), capThroughId: 0 })).toBe(0)
  })

  it("reads the feed's bounds and its highest aged sequence, event times out of order", async () => {
    const { seed, reads } = await open()
    await seed.feed({ headSeq: 4, floorSeq: 1 })
    // Seq 3 is the oldest event; seq 2 is newer than the threshold.
    await seed.change({ seq: 1, eventTime: 1_000 })
    await seed.change({ seq: 2, eventTime: 9_000 })
    await seed.change({ seq: 3, eventTime: 500 })
    await seed.change({ seq: 4, eventTime: 9_500 })
    expect(await reads.changeFeed(5_000)).toEqual({ headSeq: 4, floorSeq: 1, agedSeq: 3 })
    expect(await reads.changeFeed(100)).toEqual({ headSeq: 4, floorSeq: 1, agedSeq: null })
  })

  it('reads no feed bounds once the floor is past the head (an empty log)', async () => {
    const { seed, reads } = await open()
    await seed.feed({ headSeq: 4, floorSeq: 5 })
    expect(await reads.changeFeed(5_000)).toBeUndefined()
  })

  it('finds the event cap by a seek that stays exact across missing ids (POD-7035)', async () => {
    const { seed, reads } = await open()
    const ids: number[] = []
    for (let i = 0; i < 40; i += 1) ids.push(await seed.event(iso(1)))
    // Ids missing from the log: the guess `max(id) - maxRows` is too high by them.
    const kept = ids.filter((_, at) => ![1, 15, 16, 30, 38].includes(at))
    await seed.pruneEvents(ids.filter((id) => !kept.includes(id)))
    for (const maxRows of [0, 1, 2, 5, 10, 20, 34, 35, 50]) {
      // What `ORDER BY id DESC LIMIT 1 OFFSET maxRows` walked to.
      const walked = [...kept].sort((a, b) => b - a)[maxRows]
      expect(await reads.eventCapThroughId(maxRows), `maxRows ${maxRows}`).toBe(walked)
    }
  })

  it('counts receipts past a cutoff and gives the oldest one, as epoch ms (POD-7035)', async () => {
    const { seed, reads } = await open()
    expect(await reads.receiptPruneHead(5_000)).toBeNull()
    for (const [id, at] of [
      ['m_c', 3_000],
      ['m_a', 1_000],
      ['m_young', 9_000],
      ['m_b', 2_000],
    ] as const)
      await seed.receipt({ mutationId: id, appliedAt: at })
    expect(await reads.receiptPruneHead(5_000)).toBe(1_000)
    expect(await reads.receiptPruneCount(5_000)).toBe(3)
    expect(await reads.receiptPruneCount(1_000)).toBe(0)
  })

  it('names each session holding input past the horizon once, by its newest such row (POD-7035)', async () => {
    const { seed, reads } = await open()
    const horizon = 100_000
    await seed.queued({ id: 'a1', sessionId: 'ses_a', queuedAt: horizon - 5_000, queueOrder: 1 })
    await seed.queued({ id: 'a2', sessionId: 'ses_a', queuedAt: horizon - 1_000, queueOrder: 2 })
    await seed.queued({ id: 'a3', sessionId: 'ses_a', queuedAt: horizon + 1_000, queueOrder: 3 })
    await seed.queued({ id: 'b1', sessionId: 'ses_b', queuedAt: horizon - 9_000 })
    await seed.queued({ id: 'c1', sessionId: 'ses_c', queuedAt: horizon + 1 })
    expect(await reads.queuedExpiryPage({ through: horizon, limit: 100 })).toEqual([
      { sessionId: 'ses_b', through: horizon - 9_000, rows: 1 },
      { sessionId: 'ses_a', through: horizon - 1_000, rows: 2 },
    ])
    expect(await reads.queuedExpiryPage({ through: horizon, limit: 1 })).toHaveLength(1)
    expect(await reads.queuedExpiryCount(horizon)).toBe(3)
  })

  it('counts receipts applied before the cutoff and gives a plan position for them', async () => {
    const { seed, reads } = await open()
    await seed.command({ runKey: 'a', appliedAt: iso(1) })
    await seed.command({ runKey: 'b', appliedAt: iso(2) })
    await seed.command({ runKey: 'c', appliedAt: iso(20) })
    const head = await reads.commandPruneHead(iso(10))
    expect(await reads.commandPruneCount(iso(10))).toBe(2)
    expect(Number.isInteger(head)).toBe(true)
    expect(head).toBeGreaterThanOrEqual(0)
    expect(await reads.commandPruneHead(iso(1))).toBeNull()
    expect(await reads.commandPruneCount(iso(1))).toBe(0)
  })
})

describe('JanitorReadsRepository: auto-archive', () => {
  it("offers stopped sessions their owner read since, by the owner's read", async () => {
    const { seed, reads } = await open()
    await seed.issue({ id: 'iss_top', seq: 1 })
    await seed.issue({ id: 'iss_sub', seq: 2, parentId: 'iss_top' })
    const sessions = [
      // Read by the owner after it stopped, both before the cutoff: a candidate.
      { id: 'ses_read', stoppedAt: iso(2), readAt: iso(3) },
      { id: 'ses_on_top', stoppedAt: iso(2), readAt: iso(4), issueId: 'iss_top' },
      // Read before it stopped, never read, read too late, on a sub-issue, archived, running.
      { id: 'ses_read_before', stoppedAt: iso(5), readAt: iso(4) },
      { id: 'ses_unread', stoppedAt: iso(2), readAt: null },
      { id: 'ses_read_late', stoppedAt: iso(2), readAt: iso(20) },
      { id: 'ses_on_sub', stoppedAt: iso(2), readAt: iso(3), issueId: 'iss_sub' },
      { id: 'ses_archived', stoppedAt: iso(2), readAt: iso(3), archived: true },
      { id: 'ses_running', stoppedAt: null, readAt: iso(3) },
    ]
    for (const s of sessions) {
      await seed.session({
        id: s.id,
        ownerUserId: 'mem_owner',
        stoppedAt: s.stoppedAt,
        issueId: s.issueId ?? null,
        archived: s.archived ?? false,
      })
      await seed.sessionRead({ sessionId: s.id, userId: 'mem_owner', readAt: s.readAt })
    }
    // Someone else's read never counts.
    await seed.session({ id: 'ses_other_reader', ownerUserId: 'mem_owner', stoppedAt: iso(2) })
    await seed.sessionRead({ sessionId: 'ses_other_reader', userId: 'mem_other', readAt: iso(3) })

    expect(await reads.sessionArchivePage({ cutoffReadAt: iso(10), limit: 10 })).toEqual([
      { id: 'ses_read', issueId: null, stoppedAt: iso(2), ownerUserId: 'mem_owner' },
      { id: 'ses_on_top', issueId: 'iss_top', stoppedAt: iso(2), ownerUserId: 'mem_owner' },
    ])
    expect(await reads.sessionArchivePage({ cutoffReadAt: iso(10), limit: 1 })).toHaveLength(1)
  })

  it('offers finished top-level issues their assignee read, in a keyset walk', async () => {
    const { seed, reads } = await open()
    const issues = [
      { id: 'iss_done_b', seq: 1, readAt: iso(3) },
      { id: 'iss_done_a', seq: 2, readAt: iso(3) },
      {
        id: 'iss_closed',
        seq: 3,
        readAt: iso(4),
        stage: 'in_progress' as const,
        closedReason: 'duplicate',
      },
      { id: 'iss_open', seq: 4, readAt: iso(3), stage: 'in_progress' as const },
      { id: 'iss_sub', seq: 5, readAt: iso(3), parentId: 'iss_done_a' },
      { id: 'iss_deleted', seq: 6, readAt: iso(3), deletedAt: iso(5) },
      { id: 'iss_archived', seq: 7, readAt: iso(3), archived: true },
      { id: 'iss_late', seq: 8, readAt: iso(20) },
      { id: 'iss_unread', seq: 9, readAt: null },
    ]
    for (const i of issues) {
      await seed.issue({
        id: i.id,
        seq: i.seq,
        ownerUserId: 'mem_owner',
        stage: i.stage ?? 'done',
        closedReason: i.closedReason ?? null,
        parentId: i.parentId ?? null,
        deletedAt: i.deletedAt ?? null,
        archived: i.archived ?? false,
      })
      await seed.issueRead({ issueId: i.id, userId: 'mem_owner', readAt: i.readAt })
    }
    const first = await reads.issueArchivePage({ cutoffReadAt: iso(10), limit: 2 })
    expect(first).toEqual([
      {
        id: 'iss_done_a',
        stage: 'done',
        closedReason: null,
        ownerUserId: 'mem_owner',
        readAt: iso(3),
      },
      {
        id: 'iss_done_b',
        stage: 'done',
        closedReason: null,
        ownerUserId: 'mem_owner',
        readAt: iso(3),
      },
    ])
    const next = await reads.issueArchivePage({
      cutoffReadAt: iso(10),
      limit: 2,
      after: { readAt: iso(3), id: 'iss_done_b' },
    })
    expect(next.map((row) => [row.id, row.closedReason])).toEqual([['iss_closed', 'duplicate']])
  })
})

describe('JanitorReadsRepository: worktree GC [POD-564]', () => {
  it('proposes finished checkouts, sub-issues included, past the window', async () => {
    const { seed, reads } = await open()
    await seed.issue({
      id: 'iss_parent',
      seq: 1,
      closedAt: iso(1),
      worktreePath: '/r/.worktrees/parent',
    })
    await seed.issue({
      id: 'iss_child',
      seq: 2,
      parentId: 'iss_parent',
      closedAt: iso(1),
      worktreePath: '/r/.worktrees/child',
    })
    await seed.issue({
      id: 'iss_reason',
      seq: 3,
      stage: 'in_progress',
      closedReason: 'duplicate',
      closedAt: iso(2),
      worktreePath: '/r/.worktrees/dup',
    })
    await seed.issue({
      id: 'iss_archived',
      seq: 4,
      archived: true,
      closedAt: iso(3),
      worktreePath: '/r/w/arch',
    })
    // Open work, deleted, already freed, closed inside the window.
    await seed.issue({ id: 'iss_open', seq: 5, stage: 'in_progress', worktreePath: '/r/w/open' })
    await seed.issue({
      id: 'iss_deleted',
      seq: 6,
      closedAt: iso(1),
      deletedAt: iso(2),
      worktreePath: '/r/w/del',
    })
    await seed.issue({ id: 'iss_freed', seq: 7, closedAt: iso(1), worktreePath: null })
    await seed.issue({ id: 'iss_young', seq: 8, closedAt: iso(16), worktreePath: '/r/w/young' })

    const rows = await reads.worktreeGcPage({ cutoffClosedAt: iso(15), limit: 10 })
    expect(rows.map((row) => row.id)).toEqual([
      'iss_child',
      'iss_parent',
      'iss_reason',
      'iss_archived',
    ])
    expect(rows[2]).toEqual({
      id: 'iss_reason',
      worktreePath: '/r/.worktrees/dup',
      stage: 'in_progress',
      closedReason: 'duplicate',
      closedAt: iso(2),
    })
    const after = await reads.worktreeGcPage({
      cutoffClosedAt: iso(15),
      limit: 10,
      after: { closedAt: iso(1), id: 'iss_parent' },
    })
    expect(after.map((row) => row.id)).toEqual(['iss_reason', 'iss_archived'])
  })

  it('leaves a directory a live session stands in, by path, whoever the session is', async () => {
    const { seed, reads } = await open()
    await seed.issue({
      id: 'iss_busy',
      seq: 1,
      closedAt: iso(1),
      worktreePath: '/r/.worktrees/busy',
    })
    await seed.issue({
      id: 'iss_root',
      seq: 2,
      closedAt: iso(1),
      worktreePath: '/r/.worktrees/root',
    })
    await seed.issue({
      id: 'iss_idle',
      seq: 3,
      closedAt: iso(1),
      worktreePath: '/r/.worktrees/idle',
    })
    await seed.issue({
      id: 'iss_sibling',
      seq: 4,
      closedAt: iso(1),
      worktreePath: '/r/.worktrees/sib',
    })
    await seed.session({
      id: 'ses_sub',
      ownerUserId: 'mem_x',
      status: 'live',
      cwd: '/r/.worktrees/busy/packages/web',
    })
    await seed.session({
      id: 'ses_root',
      ownerUserId: 'mem_x',
      status: 'starting',
      cwd: '/r/.worktrees/root',
    })
    // An exited session stands in nothing; a prefix that is not a path segment is no match.
    await seed.session({
      id: 'ses_exited',
      ownerUserId: 'mem_x',
      status: 'exited',
      cwd: '/r/.worktrees/idle',
    })
    await seed.session({
      id: 'ses_prefix',
      ownerUserId: 'mem_x',
      status: 'live',
      cwd: '/r/.worktrees/sibling',
    })
    const rows = await reads.worktreeGcPage({ cutoffClosedAt: iso(15), limit: 10 })
    expect(rows.map((row) => row.id)).toEqual(['iss_idle', 'iss_sibling'])
  })
})

describe('JanitorReadsRepository: automations, steward, machines, admin', () => {
  it('reads enabled automations that are due, by (next_run_at, id)', async () => {
    const { seed, reads } = await open()
    await seed.automation({ id: 'aut_b', nextRunAt: iso(2) })
    await seed.automation({ id: 'aut_a', nextRunAt: iso(2), scheduleKind: 'once' })
    await seed.automation({ id: 'aut_off', nextRunAt: iso(1), enabled: false })
    await seed.automation({ id: 'aut_later', nextRunAt: iso(20) })
    await seed.automation({ id: 'aut_never', nextRunAt: null })
    expect(await reads.dueAutomations({ now: iso(10), limit: 10 })).toEqual([
      { id: 'aut_a', scheduleKind: 'once', cron: '0 * * * *', nextRunAt: iso(2) },
      { id: 'aut_b', scheduleKind: 'cron', cron: '0 * * * *', nextRunAt: iso(2) },
    ])
    expect(await reads.dueAutomations({ now: iso(10), limit: 1 })).toHaveLength(1)
  })

  it("reads the steward's cursor and the event head", async () => {
    const { seed, reads } = await open()
    expect(await reads.stewardCursor()).toBeUndefined()
    expect(await reads.maxEventId()).toBe(0)
    await seed.steward({ key: 'cursor', value: '7' })
    await seed.steward({ key: 'other', value: '9' })
    const id = await seed.event(iso(1))
    expect(await reads.stewardCursor()).toBe('7')
    expect(await reads.maxEventId()).toBe(id)
  })

  it('reads every machine but this one, newest handshake first, however old (delay, not lose)', async () => {
    const { seed, reads } = await open()
    await seed.machine({ id: 'local', lastSeenAt: iso(5) })
    await seed.machine({ id: 'mch_old', lastSeenAt: iso(1) })
    await seed.machine({ id: 'mch_new', lastSeenAt: iso(3) })
    expect(await reads.remoteMachines({ localMachineId: 'local', limit: 10 })).toEqual([
      { id: 'mch_new', lastSeenAt: iso(3) },
      { id: 'mch_old', lastSeenAt: iso(1) },
    ])
  })

  it('names the earliest active admin, as the users repository does', async () => {
    // A workspace of its own: the SQLite fixture's `local` holds the install's admin.
    const { seed, reads } = await open('ws_people')
    expect(await reads.earliestAdminId()).toBeUndefined()
    await seed.user({ id: 'mem_member', role: 'member', createdAt: iso(1) })
    await seed.user({ id: 'mem_gone', createdAt: iso(1), disabledAt: iso(2) })
    await seed.user({ id: 'mem_late', createdAt: iso(3) })
    await seed.user({ id: 'mem_first', createdAt: iso(2) })
    expect(await reads.earliestAdminId()).toBe('mem_first')
  })
})

describe("the janitor's database on the store's engine", () => {
  it('lists the workspaces with a feed and scans one in a read session of its own', async () => {
    const { seed } = await open()
    await seed.user({ id: 'mem_admin' })
    await seed.machine({ id: 'mch_remote', lastSeenAt: iso(3) })
    const database = openJanitorDatabase(await (store as JanitorStore).location())
    try {
      const workspaces = await database.workspacesWithFeed()
      expect(workspaces.map((w) => w.id)).toEqual(
        await workspacesWithFeed(fleetDb((store as JanitorStore).base)),
      )
      const local = workspaces.find((w) => w.id === 'local')
      if (!local) throw new Error('the local workspace has a feed')
      const seen = await local.scan(async (reads) => ({
        admin: await reads.earliestAdminId(),
        machines: await reads.remoteMachines({ localMachineId: 'local', limit: 10 }),
      }))
      expect(seen).toEqual({
        admin: 'mem_admin',
        machines: [{ id: 'mch_remote', lastSeenAt: iso(3) }],
      })
    } finally {
      await database.close()
    }
  })
})

/**
 * ONE FULL SCAN, COUNTED [POD-6993]. Every job of a janitor tick reads once, through the
 * package's own readers, over data that takes each down its whole path (a second expiry
 * page, a prune head that is found, so its count is read). The count is the janitor's
 * before it read through the store: the raw readers ran the same statements, one per
 * page or aggregate (expiry 3 pages, event prune 3: cap, head, count; change prune 1;
 * command prune 2: head, count; session and issue archive 1 page each; worktree GC 1;
 * automations 1; steward 2: cursor, head; connect scan 1), so SQLite's traffic did not
 * move, and Postgres runs the same statements.
 */
describe('one full janitor scan', () => {
  // RE-PINNED 16 -> 19 FOR POD-7118: dev/mw's receipt prune reads its head and
  // count, and its queue expiry its page (POD-7035). 18 distinct queries: the event
  // cap's seek starts from the log's head, the read the steward poll makes too.
  it('runs the same 19 statements on either engine', async () => {
    const { seed, reads, slice } = await open()
    for (let i = 0; i < 30; i += 1) {
      await seed.message({
        id: `msg_${String(i).padStart(2, '0')}`,
        lifecycle: 'wait',
        createdAt: iso(1),
      })
    }
    await seed.message({ id: 'msg_due', lifecycle: 'wake', createdAt: iso(1), expiresAt: iso(2) })
    for (const day of [1, 2]) await seed.event(iso(day))
    await seed.feed({ headSeq: 2, floorSeq: 1 })
    await seed.change({ seq: 1, eventTime: 1_000 })
    await seed.change({ seq: 2, eventTime: 1_000 })
    await seed.command({ runKey: 'r', appliedAt: iso(1) })
    await seed.receipt({ mutationId: 'mut_old', appliedAt: Date.parse(iso(1)) })
    await seed.queued({ id: 'q_old', sessionId: 'ses_parked', queuedAt: Date.parse(iso(1)) })
    await seed.session({ id: 'ses_done', ownerUserId: 'mem_owner', stoppedAt: iso(1) })
    await seed.sessionRead({ sessionId: 'ses_done', userId: 'mem_owner', readAt: iso(2) })
    await seed.issue({ id: 'iss_done', seq: 1, closedAt: iso(1), worktreePath: '/r/w/done' })
    await seed.issueRead({ issueId: 'iss_done', userId: 'mem_owner', readAt: iso(2) })
    await seed.automation({ id: 'aut_due', nextRunAt: iso(1) })
    await seed.steward({ key: 'cursor', value: '0' })
    await seed.machine({ id: 'mch_remote', lastSeenAt: iso(1) })

    const source: JanitorReadSource = { scan: async (fn) => await fn(reads) }
    const nowMs = Date.parse(iso(18))
    const now = iso(18)
    const archive = { cutoffReadAt: iso(10), limit: 100 }
    const { result, statements, byQuery } = await countStatements(slice.probeTarget, async () => ({
      expiry: (
        await new MessageExpiryReader(source).read({ now, waitImplicitCutoff: iso(11), limit: 100 })
      ).length,
      events: (
        await new EventLogPrunePlanner(source).plan({
          maxAgeDays: 7,
          maxRows: 50_000,
          batchSize: 1,
          nowMs,
        })
      ).length,
      changes: (
        await new ChangeLogPrunePlanner(source, ws.workspaceId).plan({
          keepRows: 0,
          maxAgeMs: 1,
          batchSize: 1,
          nowMs: 5_000,
        })
      ).length,
      commands: (
        await new MaintenanceCommandsPrunePlanner(source).plan({
          maxAgeMs: 7 * 86_400_000,
          batchSize: 1,
          nowMs,
        })
      ).length,
      receipts: (
        await new AppliedMutationsPrunePlanner(source).plan({
          maxAgeMs: 7 * 86_400_000,
          batchSize: 1,
          nowMs,
        })
      ).length,
      queued: (
        await new QueuedMessagesExpiryReader(source).read({
          maxAgeMs: 7 * 86_400_000,
          nowMs,
          limit: 100,
        })
      ).length,
      sessions: (await new SessionAutoArchiveReader(source).read(archive)).length,
      issues: (await new IssueAutoArchiveReader(source).read(archive)).length,
      worktrees: (
        await new WorktreeGcReader(source).read({
          cutoffClosedAt: iso(10),
          mode: 'propose',
          afterDays: 7,
          limit: 100,
        })
      ).length,
      automations: (await new AutomationDueReader(source).read(now)).length,
      steward: (await new StewardPollReader(source).read()) === null ? 0 : 1,
      machines: (await new ConnectScanReader(source).read(now, 'local')).length,
    }))
    expect(result).toEqual({
      expiry: 31,
      events: 2,
      changes: 2,
      commands: 1,
      receipts: 1,
      queued: 1,
      sessions: 1,
      issues: 1,
      worktrees: 1,
      automations: 1,
      steward: 1,
      machines: 1,
    })
    expect({ statements, queries: byQuery.size }).toEqual({ statements: 19, queries: 18 })
  })
})
