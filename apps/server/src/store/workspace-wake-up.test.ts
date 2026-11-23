/**
 * THE WORKSPACE WAKE-UP ON THE RUN'S ENGINE [POD-7292, POD-6954 design 4.2 and 4.13].
 *
 * SQLite on the store lane (the in-process transport), Postgres on `server-store-pg`
 * (LISTEN/NOTIFY). The cases: a change-log append publishes after its commit and never
 * before; a dropped signal is healed by the poll; the poll reads every subscribed
 * workspace's head in one statement; and on Postgres, a second process's listener gets the
 * notification, and a listener whose connection is killed reconnects and loses nothing.
 */

import { asWorkspaceId, type WorkspaceId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { connectPgTest, testStoreEngine } from '../test-support/pg-test-database'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { fleetDb } from './executor/sync-drizzle'
import { feedHeadsOf } from './wake-up-reads'
import { WakeUpHub } from './workspace-wake-up'
import { pgWakeUpTransport, WAKE_UP_LISTENER_APPLICATION } from './workspace-wake-up-pg'

const engine = testStoreEngine()
const opened: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.close()
})

async function storeWith(pollIntervalMs: number): Promise<SessionStore> {
  const store = await openTestStore(undefined, undefined, { wakeUp: { pollIntervalMs } })
  opened.push(store)
  return store
}

/** One change-log append in its own write transaction: what every synced write ends in. */
async function appendOne(store: SessionStore, entityId: string): Promise<void> {
  await store.transact(async () => {
    await store.sync.appendChanges(
      [{ entity: 'agentProfile', entityId, op: 'upsert', payload: '{}' }],
      Date.now(),
    )
  })
}

/** A listener that counts its wake-ups. */
function counter() {
  let count = 0
  return {
    listener: () => {
      count++
    },
    count: () => count,
    reach: async (target: number, timeout = 5_000) =>
      await vi.waitFor(() => expect(count).toBeGreaterThanOrEqual(target), {
        timeout,
        interval: 10,
      }),
  }
}

describe(`workspace wake-up (${engine})`, () => {
  it('publishes a change-log append after its commit, never before', async () => {
    const store = await storeWith(0)
    const hub = store.database.wakeUps
    expect(hub.transportKind).toBe(engine === 'pg' ? 'postgres' : 'in-process')
    const publish = vi.spyOn(hub, 'publish')
    const woken = counter()
    hub.subscribe(store.workspaceId, woken.listener)
    // The first (re)connect polls once and wakes the new subscriber; let it pass.
    await woken.reach(1)

    let publishedInside = -1
    await store.transact(async () => {
      await store.sync.appendChanges(
        [{ entity: 'agentProfile', entityId: 'p1', op: 'upsert', payload: '{}' }],
        Date.now(),
      )
      // Give a premature publish every chance to happen while the transaction is open.
      await new Promise((resolve) => setTimeout(resolve, 50))
      publishedInside = publish.mock.calls.length
    })
    expect(publishedInside).toBe(0)
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(store.workspaceId))
    await woken.reach(2)
  })

  it('does not publish an append whose transaction rolled back', async () => {
    const store = await storeWith(0)
    const publish = vi.spyOn(store.database.wakeUps, 'publish')
    await expect(
      store.transact(async () => {
        await store.sync.appendChanges(
          [{ entity: 'agentProfile', entityId: 'p1', op: 'upsert', payload: '{}' }],
          Date.now(),
        )
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(publish).not.toHaveBeenCalled()
  })

  it('heals a dropped signal at the next poll', async () => {
    const store = await storeWith(100)
    const hub = store.database.wakeUps
    const woken = counter()
    hub.subscribe(store.workspaceId, woken.listener)
    await woken.reach(1)
    // Let any wake-up of the first poll and the connect poll settle before counting.
    await hub.poll()
    const before = woken.count()

    let dropped = 0
    hub.receive = () => {
      dropped++
    }
    await appendOne(store, 'p1')
    await hub.settled()
    await woken.reach(before + 1, 3_000)
    expect(dropped).toBeGreaterThan(0)
  })

  it('reads the heads of every subscribed workspace in one read', async () => {
    const [a, b, c] = await openWorkspaceStores(['ws-a', 'ws-b', 'ws-c'])
    opened.push(a)
    await appendOne(b, 'p1')
    await appendOne(b, 'p2')
    const missing = asWorkspaceId('ws-missing')
    const heads = await feedHeadsOf(fleetDb(a.database.queries), [
      a.workspaceId,
      b.workspaceId,
      c.workspaceId,
      missing,
    ])
    const headA = (await a.sync.readFeedState()).headSeq
    const headB = (await b.sync.readFeedState()).headSeq
    expect(Object.fromEntries(heads)).toEqual({
      [a.workspaceId]: headA,
      [b.workspaceId]: headB,
      [c.workspaceId]: (await c.sync.readFeedState()).headSeq,
    })
    expect(headB).toBeGreaterThan(headA)

    // The hub asks for all of them at once.
    const asked: WorkspaceId[][] = []
    const hub = new WakeUpHub({
      transport: { kind: 'in-process', listen() {}, async send() {}, async close() {} },
      readHeads: async (ids) => {
        asked.push([...ids])
        return await feedHeadsOf(fleetDb(a.database.queries), ids)
      },
      pollIntervalMs: 0,
    })
    opened.push(hub)
    for (const store of [a, b, c]) hub.subscribe(store.workspaceId, () => {})
    await hub.poll()
    expect(asked).toEqual([[a.workspaceId, b.workspaceId, c.workspaceId]])
  })

  describe.skipIf(engine !== 'pg')('on Postgres', () => {
    /** A second process's hub on the same database: its own listener, no periodic poll. */
    function secondProcess(store: SessionStore, reconnectMs = 100): WakeUpHub {
      const location = store.database.location
      const hub = new WakeUpHub({
        transport: pgWakeUpTransport({
          listenUrl: location,
          notifyUrl: location,
          reconnectDelayMs: { initial: reconnectMs, max: reconnectMs },
        }),
        readHeads: async (ids) => await feedHeadsOf(fleetDb(store.database.queries), ids),
        pollIntervalMs: 0,
      })
      opened.push(hub)
      return hub
    }

    it("wakes another process's subscriber by notification", async () => {
      const store = await storeWith(0)
      const other = secondProcess(store)
      const woken = counter()
      other.subscribe(store.workspaceId, woken.listener)
      await woken.reach(1)
      // No periodic poll on either side: only the notification can wake it.
      await appendOne(store, 'p1')
      await woken.reach(2)
      await appendOne(store, 'p2')
      await woken.reach(3)
    })

    it('loses nothing across a listener reconnect', async () => {
      const store = await storeWith(0)
      const other = secondProcess(store, 500)
      const woken = counter()
      other.subscribe(store.workspaceId, woken.listener)
      await woken.reach(1)

      const admin = connectPgTest(store.database.location)
      try {
        const killed = await admin.unsafe<{ pid: number }>(
          'SELECT pg_terminate_backend(pid) AS pid FROM pg_stat_activity ' +
            'WHERE application_name = $1 AND datname = current_database()',
          [WAKE_UP_LISTENER_APPLICATION],
        )
        expect(killed).toHaveLength(1)
      } finally {
        await admin.close()
      }
      // Written while nobody listens: its notification is gone, and the reconnect's poll
      // is what must deliver it.
      await appendOne(store, 'gap')
      await store.database.wakeUps.settled()
      expect(woken.count()).toBe(1)
      await woken.reach(2)
      // And the listener listens again.
      await appendOne(store, 'after')
      await woken.reach(3)
    })

    it('carries several workspaces in one notify statement, one notification each', async () => {
      const [a, b] = await openWorkspaceStores(['ws-a', 'ws-b'])
      opened.push(a)
      const other = secondProcess(a)
      const wokenA = counter()
      const wokenB = counter()
      other.subscribe(a.workspaceId, wokenA.listener)
      other.subscribe(b.workspaceId, wokenB.listener)
      await wokenA.reach(1)
      await wokenB.reach(1)
      const send = vi.spyOn(
        (a.database.wakeUps as unknown as { options: { transport: { send: () => unknown } } })
          .options.transport,
        'send',
      )
      // Both in the same turn: one batch.
      a.database.wakeUps.publish(a.workspaceId)
      a.database.wakeUps.publish(b.workspaceId)
      await a.database.wakeUps.settled()
      expect(send.mock.calls).toEqual([[[a.workspaceId, b.workspaceId]]])
      await wokenA.reach(2)
      await wokenB.reach(2)
    })
  })
})
