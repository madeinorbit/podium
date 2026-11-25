/**
 * THE JANITOR READS ONE WORKSPACE [POD-7021, POD-6993].
 *
 * Two workspaces in one database of the run's engine. Every fact the janitor observes
 * is seeded in the first; the second's reads find none of them, the first's find each.
 * A join matches the row's own workspace: a read state row in one workspace never makes
 * another workspace's session or issue a candidate. The one cross-workspace read lists
 * both workspaces.
 */

import { startJanitor } from '@podium/janitor'
import { afterEach, describe, expect, it } from 'vitest'
import { openJanitorDatabase } from '../janitor-database'
import {
  type JanitorSlice,
  type JanitorStore,
  openJanitorStore,
} from '../test-support/janitor-store-slice'
import { fleetDb } from './executor/sync-drizzle'
import { workspacesWithFeed } from './janitor-reads'

let store: JanitorStore | undefined

afterEach(async () => {
  await store?.close()
  store = undefined
})

const iso = (day: number) => new Date(Date.UTC(2026, 6, day)).toISOString()

/** How many rows each read finds in `ws`. */
async function observed(ws: JanitorSlice) {
  const { reads } = ws
  return {
    implicit: (await reads.implicitExpiryPage({ cutoff: iso(11), limit: 10 })).length,
    explicit: (await reads.explicitExpiryPage({ now: iso(18), limit: 10 })).length,
    eventHead: await reads.eventPruneCount({ cutoff: iso(10), capThroughId: 0 }),
    eventCap: (await reads.eventCapThroughId(0)) === undefined ? 0 : 1,
    commands: await reads.commandPruneCount(iso(10)),
    agedSeq: (await reads.changeFeed(5_000))?.agedSeq ?? 0,
    sessions: (await reads.sessionArchivePage({ cutoffReadAt: iso(10), limit: 10 })).length,
    issues: (await reads.issueArchivePage({ cutoffReadAt: iso(10), limit: 10 })).length,
    worktrees: (await reads.worktreeGcPage({ cutoffClosedAt: iso(15), limit: 10 })).length,
    automations: (await reads.dueAutomations({ now: iso(10), limit: 10 })).length,
    steward: (await reads.stewardCursor()) === undefined ? 0 : 1,
    events: (await reads.maxEventId()) > 0 ? 1 : 0,
    machines: (await reads.remoteMachines({ localMachineId: 'local', limit: 10 })).length,
  }
}

describe('the janitor reads one workspace (POD-7021)', () => {
  it("observes none of another workspace's rows, and each of its own", async () => {
    const opened = await openJanitorStore(['ws_a', 'ws_b'])
    store = opened.store
    const [a, b] = opened.slices
    const { seed } = a
    await seed.message({ id: 'msg_wait', lifecycle: 'wait', createdAt: iso(1) })
    await seed.message({ id: 'msg_due', lifecycle: 'wake', createdAt: iso(1), expiresAt: iso(2) })
    await seed.event(iso(1))
    await seed.command({ runKey: 'r', appliedAt: iso(1) })
    await seed.feed({ headSeq: 1, floorSeq: 1 })
    await seed.change({ seq: 1, eventTime: 1_000 })
    await seed.session({ id: 'ses_a', ownerUserId: 'mem_a', stoppedAt: iso(1) })
    await seed.sessionRead({ sessionId: 'ses_a', userId: 'mem_a', readAt: iso(2) })
    await seed.issue({
      id: 'iss_a',
      seq: 1,
      ownerUserId: 'mem_a',
      closedAt: iso(1),
      worktreePath: '/r/w/a',
    })
    await seed.issueRead({ issueId: 'iss_a', userId: 'mem_a', readAt: iso(2) })
    await seed.automation({ id: 'aut_a', nextRunAt: iso(1) })
    await seed.steward({ key: 'cursor', value: '0' })
    await seed.machine({ id: 'mch_a', lastSeenAt: iso(1) })
    await seed.user({ id: 'mem_a' })

    const one = {
      implicit: 1,
      explicit: 1,
      eventHead: 1,
      eventCap: 1,
      commands: 1,
      agedSeq: 1,
      sessions: 1,
      issues: 1,
      worktrees: 1,
      automations: 1,
      steward: 1,
      events: 1,
      machines: 1,
    }
    expect(await observed(a)).toEqual(one)
    expect(await observed(b)).toEqual(
      Object.fromEntries(Object.keys(one).map((key) => [key, 0])) as typeof one,
    )
  })

  it("joins on the row's own workspace", async () => {
    const opened = await openJanitorStore(['ws_a', 'ws_b'])
    store = opened.store
    const [a, b] = opened.slices
    // The session, the issue and a live session in B; their read state and the
    // standing session's twin in A.
    await b.seed.session({ id: 'ses_b', ownerUserId: 'mem_b', stoppedAt: iso(1) })
    await a.seed.sessionRead({ sessionId: 'ses_b', userId: 'mem_b', readAt: iso(2) })
    await b.seed.issue({
      id: 'iss_b',
      seq: 1,
      ownerUserId: 'mem_b',
      closedAt: iso(1),
      worktreePath: '/r/w/b',
    })
    await a.seed.issueRead({ issueId: 'iss_b', userId: 'mem_b', readAt: iso(2) })
    // A live session in A standing in B's checkout does not hold B's checkout.
    await a.seed.session({ id: 'ses_in_b', ownerUserId: 'mem_a', status: 'live', cwd: '/r/w/b' })

    for (const ws of [a, b]) {
      expect(await ws.reads.sessionArchivePage({ cutoffReadAt: iso(10), limit: 10 })).toEqual([])
      expect(await ws.reads.issueArchivePage({ cutoffReadAt: iso(10), limit: 10 })).toEqual([])
    }
    expect(
      (await b.reads.worktreeGcPage({ cutoffClosedAt: iso(15), limit: 10 })).map((row) => row.id),
    ).toEqual(['iss_b'])
  })

  it('lists the workspaces with a feed in one read', async () => {
    const opened = await openJanitorStore(['ws_a', 'ws_b'])
    store = opened.store
    const listed = await workspacesWithFeed(fleetDb(store.base))
    expect(listed).toEqual(expect.arrayContaining(['ws_a', 'ws_b']))
    expect(listed).toEqual([...listed].sort())
  })

  /**
   * The janitor's boot over its database on this engine: a command does not name its
   * workspace yet, so it serves one workspace and refuses a database of several. No
   * server listens at the address: the first tick's handshake fails fast, a delay.
   */
  const offline = { serverUrl: 'http://127.0.0.1:1', token: 't', tickMs: 60_000 }

  it('refuses to serve a database of several workspaces', async () => {
    const opened = await openJanitorStore(['ws_a', 'ws_b'])
    store = opened.store
    for (const ws of opened.slices) await ws.seed.user({ id: `mem_${ws.workspaceId}` })
    const database = openJanitorDatabase(await store.location())
    await expect(startJanitor({ ...offline, database })).rejects.toThrow(
      /^janitor serves a database of one workspace; this one has [23] with a feed$/,
    )
  })

  it('serves a database of one workspace whose only admin is disabled (POD-7597)', async () => {
    const opened = await openJanitorStore(['local'])
    store = opened.store
    await opened.slices[0].seed.user({ id: 'mem_admin', disabledAt: iso(1) })
    const handle = await startJanitor({
      ...offline,
      database: openJanitorDatabase(await store.location()),
    })
    await handle.close()
  })
})
