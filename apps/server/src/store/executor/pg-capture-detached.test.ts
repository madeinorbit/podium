/**
 * A Postgres store's change capture before it is attached [POD-6994].
 *
 * Runs on the `server-store-pg` lane against a clone of the run's template (the whole
 * store schema, the capture guard included). The statements are counted at the
 * Postgres driver's own sessions, below the capture switch, so the count is what the
 * switch adds to the wire: one statement per write unit before the attach, none after.
 */

import { asWorkspaceId } from '@podium/model'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  clonePgTestDatabase,
  connectPgTest,
  type PgTestClient,
  testStoreEngine,
} from '../../test-support/pg-test-database'
import type { DriverSession, QueryClient, StoreDriver } from './driver'
import { createStoreExecutor, type RootStoreExecutor, workspaceContext } from './executor'
import { barrier } from './harness'
import { captureDetachedDriver, DROP_OWN_CAPTURE } from './pg-capture-detached'
import { createPgStoreDriver } from './pg-driver'

const WS_A = workspaceContext(asWorkspaceId('ws_a'))
const WS_B = workspaceContext(asWorkspaceId('ws_b'))

const CAPTURE =
  "INSERT INTO sync_capture (kind, source, op, new_key) VALUES ('issue', 0, 'i', '[1]')"

/** `driver` with every statement its sessions send recorded, in order. */
function recorded(driver: StoreDriver<QueryClient>, sent: string[]): StoreDriver<QueryClient> {
  const record = (session: DriverSession): DriverSession => ({
    ...session,
    execute: async (statement) => {
      sent.push(statement.sql)
      return await session.execute(statement)
    },
    executeBatch: async (statements) => {
      for (const statement of statements) sent.push(statement.sql)
      return await session.executeBatch(statements)
    },
    begin: async (lane) => await session.begin(lane),
    commit: async () => await session.commit(),
    rollback: async () => await session.rollback(),
    enterSavepoint: async (name) => await session.enterSavepoint(name),
    releaseSavepoint: async (name) => await session.releaseSavepoint(name),
    rollbackToSavepoint: async (name) => await session.rollbackToSavepoint(name),
    close: async () => await session.close(),
  })
  return {
    ...driver,
    open: async (lane) => record(await driver.open(lane)),
  }
}

describe.runIf(testStoreEngine() === 'pg')('Postgres capture before the attach', () => {
  let url: string
  let admin: PgTestClient
  const opened: { close(): Promise<void> }[] = []

  beforeAll(async () => {
    url = (await clonePgTestDatabase('file')).url
    admin = connectPgTest(url, 1)
    // The two workspaces' lock rows (contract C4).
    for (const workspace of ['ws_a', 'ws_b']) {
      await admin.unsafe(
        'INSERT INTO sync_feed (workspace_id, feed_id, epoch, minted_at, head_seq, floor_seq) ' +
          "VALUES ($1, $1, 'e', 0, 0, 0)",
        [workspace],
      )
    }
  })

  afterEach(async () => {
    for (const store of opened.splice(0).reverse()) await store.close()
    await admin.unsafe('DELETE FROM sync_capture')
  })

  afterAll(async () => {
    await admin?.close({ timeout: 5 })
  })

  function openStore(sent: string[] = []): {
    executor: RootStoreExecutor<QueryClient>
    attach(): void
  } {
    const capture = captureDetachedDriver(
      recorded(createPgStoreDriver({ url, poolSize: 4, strictTimestamps: true }), sent),
    )
    const executor = createStoreExecutor<QueryClient>({ driver: capture.driver, startOpen: true })
    opened.push(executor)
    return { executor, attach: () => capture.attach() }
  }

  async function committedCapture(): Promise<number> {
    const [row] = await admin.unsafe<{ n: string }>('SELECT count(*) AS n FROM sync_capture')
    return Number(row?.n)
  }

  it('commits a transaction that captured, dropping its capture with one more statement', async () => {
    const sent: string[] = []
    const { executor } = openStore(sent)
    await executor.transact(async (tx) => {
      await tx.drizzle.run(CAPTURE)
      await tx.drizzle.run(CAPTURE)
    }, WS_A)
    expect(sent).toEqual([CAPTURE, CAPTURE, DROP_OWN_CAPTURE.sql])
    expect(await committedCapture()).toBe(0)
  })

  it('drops a root write’s capture inside the same unit', async () => {
    const sent: string[] = []
    const { executor } = openStore(sent)
    await executor.drizzle.run(CAPTURE)
    // One unit: the driver pipelines BEGIN; statement; DELETE; COMMIT.
    expect(sent).toEqual([CAPTURE, DROP_OWN_CAPTURE.sql])
    expect(await committedCapture()).toBe(0)
  })

  it('adds nothing to a read or to a transaction that ran no statement', async () => {
    const sent: string[] = []
    const { executor } = openStore(sent)
    await executor.read(async (tx) => {
      await tx.drizzle.all('SELECT 1')
    })
    await executor.transact(async () => undefined, WS_A)
    expect(sent).toEqual(['SELECT 1'])
  })

  it('drops only its own transaction’s rows, never a concurrent writer’s', async () => {
    const { executor } = openStore()
    const entered = barrier()
    const held = barrier()
    let ownRowsAfterTheOtherCommitted = -1
    const first = executor.transact(async (tx) => {
      await tx.drizzle.run(CAPTURE)
      entered.release()
      await held.wait()
      const rows = (await tx.drizzle.all('SELECT count(*) AS n FROM sync_capture')) as unknown as {
        n: number
      }[]
      ownRowsAfterTheOtherCommitted = Number(rows[0]?.n)
    }, WS_A)
    await entered.wait()
    await executor.transact(async (tx) => {
      await tx.drizzle.run(CAPTURE)
      await tx.drizzle.run(CAPTURE)
    }, WS_B)
    held.release()
    await first
    expect(ownRowsAfterTheOtherCommitted).toBe(1)
    expect(await committedCapture()).toBe(0)
  })

  it('after the attach, refuses an undrained commit and adds no statement', async () => {
    const sent: string[] = []
    const { executor, attach } = openStore(sent)
    attach()
    await expect(
      executor.transact(async (tx) => {
        await tx.drizzle.run(CAPTURE)
      }, WS_A),
    ).rejects.toThrow(/sync_capture_undrained|foreign key/i)
    await expect(executor.drizzle.run(CAPTURE)).rejects.toThrow(
      /sync_capture_undrained|foreign key/i,
    )
    expect(sent).toEqual([CAPTURE, CAPTURE])
    expect(await committedCapture()).toBe(0)
  })

  it('after the attach, commits a transaction that drained what it captured', async () => {
    const sent: string[] = []
    const { executor, attach } = openStore(sent)
    attach()
    await executor.transact(async (tx) => {
      await tx.drizzle.run(CAPTURE)
      await tx.drizzle.run('DELETE FROM sync_capture')
    }, WS_A)
    expect(sent).toEqual([CAPTURE, 'DELETE FROM sync_capture'])
    expect(await committedCapture()).toBe(0)
  })
})
