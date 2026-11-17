/**
 * ONE DATABASE, ONE STORE PER WORKSPACE [POD-6959 design 2.4, task POD-7010].
 *
 * `StoreDatabase.workspace(id)` gives each workspace its own repositories over
 * the one database, the same object every time; `provisionWorkspace` creates a
 * workspace's feed row once; and every transaction a workspace's store opens is
 * that workspace's, so work of another workspace cannot join it.
 */

import { existsSync } from 'node:fs'
import { asMachineId, asWorkspaceId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { type SessionStore, StoreDatabase } from '../store'
import { PostgresStoreBootError } from '../store-database'
import { openTestStore } from '../test-support/open-test-store'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import {
  CrossWorkspaceTransactionError,
  currentStoreContext,
  WorkspaceTransactionInGlobalFrameError,
} from './executor/context'

const WS_A = asWorkspaceId('ws_a')
const WS_B = asWorkspaceId('ws_b')
const WS_C = asWorkspaceId('ws_c')

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

async function twoWorkspaces(): Promise<readonly [SessionStore, SessionStore]> {
  const stores = await openWorkspaceStores(['ws_a', 'ws_b'])
  opened.push(stores[0])
  return stores
}

describe('StoreDatabase.workspace', () => {
  it('gives two workspaces over one database two stores, each bound to its own workspace', async () => {
    const [a, b] = await twoWorkspaces()
    expect(a).not.toBe(b)
    expect(a.database).toBe(b.database)
    expect([a.workspaceId, b.workspaceId]).toEqual([WS_A, WS_B])
    // The repositories are each workspace's own, not shared.
    expect(a.sessions).not.toBe(b.sessions)
    expect(a.issues).not.toBe(b.issues)
    expect([a.sync.tenantId, b.sync.tenantId]).toEqual([WS_A, WS_B])
    // What there is one of per database is shared.
    expect(a.secrets).toBe(b.secrets)
    expect(a.tableWrites).toBe(b.tableWrites)
    expect(a.hostMachineId).toBe(b.hostMachineId)
  })

  it('is memoised per id, concurrent first calls included', async () => {
    const [a, b] = await twoWorkspaces()
    expect(await a.database.workspace(WS_A)).toBe(a)
    expect(await a.database.workspace(WS_B)).toBe(b)
    await a.database.provisionWorkspace(WS_C)
    const [first, second] = await Promise.all([
      a.database.workspace(WS_C),
      a.database.workspace(WS_C),
    ])
    expect(first).toBe(second)
    expect(await a.database.workspace(WS_C)).toBe(first)
    expect(first.workspaceId).toBe(WS_C)
  })

  it('opens the self-hosted workspace when a test names none', async () => {
    const store = await openTestStore()
    opened.push(store)
    expect(store.workspaceId).toBe(SELF_HOSTED_WORKSPACE_ID)
    expect(await store.database.workspace(SELF_HOSTED_WORKSPACE_ID)).toBe(store)
  })

  it('closes the database once, whichever workspace store closes it', async () => {
    const [a, b] = await openWorkspaceStores(['ws_a', 'ws_b'])
    await a.close()
    await expect(b.close()).resolves.toBeUndefined()
  })
})

describe('StoreDatabase.provisionWorkspace', () => {
  it('creates the workspace feed row once and keeps it on a second call', async () => {
    const [a] = await twoWorkspaces()
    const database = a.database
    await database.provisionWorkspace(WS_C)
    const c = await database.workspace(WS_C)
    const identity = await c.sync.readFeedIdentity()
    expect(identity).not.toBeNull()
    // A fresh feed: nothing appended, the floor one past the head.
    expect(await c.sync.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })

    await database.provisionWorkspace(WS_C)
    expect(await c.sync.readFeedIdentity()).toEqual(identity)
    expect(await c.sync.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
  })

  it('gives each workspace its own feed', async () => {
    const [a, b] = await twoWorkspaces()
    const [identityA, identityB] = [
      await a.sync.readFeedIdentity(),
      await b.sync.readFeedIdentity(),
    ]
    expect(identityA).not.toBeNull()
    expect(identityB).not.toBeNull()
    expect(identityA?.feedId).not.toBe(identityB?.feedId)
  })

  it('provisions from inside a workspace transaction too (global work joins it)', async () => {
    const [a] = await twoWorkspaces()
    await a.transact(async () => await a.database.provisionWorkspace(WS_C))
    const c = await a.database.workspace(WS_C)
    expect(await c.sync.readFeedIdentity()).not.toBeNull()
  })
})

describe('a workspace store opens its own workspace transactions', () => {
  it('SessionStore.transact runs in the store workspace', async () => {
    const [a, b] = await twoWorkspaces()
    expect(await a.transact(() => currentStoreContext())).toEqual({
      kind: 'workspace',
      workspaceId: WS_A,
    })
    expect(await b.transact(() => currentStoreContext())).toEqual({
      kind: 'workspace',
      workspaceId: WS_B,
    })
  })

  it('a repository transaction is its workspace transaction', async () => {
    const [a] = await twoWorkspaces()
    // The identity port's transaction runs on the store's queries.
    const context = await a.identityDatabase().transaction(async () => currentStoreContext())
    expect(context).toEqual({ kind: 'workspace', workspaceId: WS_A })
  })

  it('refuses work of another workspace inside the transaction', async () => {
    const [a, b] = await twoWorkspaces()
    await expect(a.transact(async () => await b.transact(() => 'joined'))).rejects.toBeInstanceOf(
      CrossWorkspaceTransactionError,
    )
    // A repository of the other workspace is refused the same way: its write
    // opens (joins) its own workspace's transaction.
    await expect(
      a.transact(
        async () =>
          await b.sync.appendChanges(
            [{ entity: 'issueProjection', entityId: 'i1', op: 'upsert', payload: '{}' }],
            Date.now(),
          ),
      ),
    ).rejects.toBeInstanceOf(CrossWorkspaceTransactionError)
    // Nothing reached the other workspace's feed.
    expect((await b.sync.readFeedState()).headSeq).toBe(0)
  })

  it('refuses a workspace store inside a global transaction', async () => {
    const [a] = await twoWorkspaces()
    await expect(
      a.database.queries.createOrJoinTransaction(async () => await a.transact(() => 'joined')),
    ).rejects.toBeInstanceOf(WorkspaceTransactionInGlobalFrameError)
  })
})

describe('StoreDatabase.open on a Postgres URL [POD-6979]', () => {
  it('chooses the engine from the location and refuses before it touches the disk', async () => {
    await expect(
      StoreDatabase.open('postgres://podium@127.0.0.1:9/nowhere', asMachineId('m_test'), {
        bootWorkspace: asWorkspaceId('local'),
      }),
    ).rejects.toBeInstanceOf(PostgresStoreBootError)
    // A path would have had its directory made; a URL's "directory" must not exist.
    expect(existsSync('postgres:')).toBe(false)
  })
})
