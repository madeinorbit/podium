/** A revoked credential delegation never returns when manage is granted again. */
import { ALL_MEMBERS_GRANTEE, asCredentialId, asUserId, type UserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { grants } from '../migrations/schema'
import { mayUse } from '../modules/credentials/may-use'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../test-support/statement-count'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import type { CommittedRowChange } from './committed-rows'
import { withReadScope } from './executor/read-scope'
import { memberFacts } from './fixtures/test-support'
import type { GrantRow } from './grants'

const OWNER = asUserId('credential-owner')
const MANAGER = asUserId('credential-manager')
const DELEGATE = asUserId('credential-delegate')
const READER = asUserId('credential-reader')
const INDEPENDENT = asUserId('credential-independent')
const KEY = asCredentialId('cred_grant-revocation')
const credential = { id: KEY, ownerUserId: OWNER }

const edge = (
  owner: string,
  grantee: string,
  verb: 'use' | 'manage',
  resourceId: string = KEY,
): GrantRow => ({
  resourceKind: 'credential',
  resourceId,
  grantee,
  verb,
  owner,
  visibility: 'secret',
  createdAt: '2026-11-25T00:00:00.000Z',
  actorKind: 'user',
  actorId: owner,
  onBehalfOf: owner,
})

async function seed(store: SessionStore): Promise<void> {
  await store.credentials.insert({ ...credential, label: 'Team key', type: 'openai.api-key' })
  for (const id of [OWNER, MANAGER, DELEGATE, READER, INDEPENDENT]) {
    await memberFacts(store).create(
      {
        id,
        displayName: id,
        role: 'member',
        createdAt: '2026-11-25T00:00:00.000Z',
        disabledAt: null,
      },
      'not-a-real-hash',
    )
  }
  await store.grants.upsert(edge(OWNER, MANAGER, 'manage'))
}

describe('credential manage revocation', () => {
  let store: SessionStore

  beforeEach(async () => {
    store = await openTestStore(':memory:')
    await seed(store)
  })
  afterEach(async () => {
    await store.close()
  })

  const revoke = async (store: SessionStore, grantee: UserId = MANAGER) =>
    await store.grants.remove('credential', KEY, grantee, 'manage')

  it('deletes downstream use and manage, including all-members use, before any re-grant', async () => {
    await store.grants.upsert(edge(MANAGER, DELEGATE, 'manage'))
    await store.grants.upsert(edge(DELEGATE, READER, 'use'))
    await store.grants.upsert(edge(MANAGER, ALL_MEMBERS_GRANTEE, 'use'))
    expect(await mayUse(store, DELEGATE, credential)).toBe('manage')
    expect(await mayUse(store, READER, credential)).toBe('use')
    expect(await mayUse(store, INDEPENDENT, credential)).toBe('use')

    expect(await revoke(store)).toBe(true)
    expect(await store.grants.listForResource('credential', KEY)).toEqual([])
    expect(await mayUse(store, READER, credential)).toBeNull()

    await store.grants.upsert(edge(OWNER, MANAGER, 'manage'))
    expect(await mayUse(store, MANAGER, credential)).toBe('manage')
    for (const id of [DELEGATE, READER, INDEPENDENT]) {
      expect(await mayUse(store, id, credential)).toBeNull()
    }
    // Giving a descendant manage afresh must not resurrect their old shares either.
    await store.grants.upsert(edge(OWNER, DELEGATE, 'manage'))
    expect(await mayUse(store, DELEGATE, credential)).toBe('manage')
    expect(await mayUse(store, READER, credential)).toBeNull()
  })

  it('keeps independent grants, retained use, and shares on other resources', async () => {
    await store.grants.upsert(edge(OWNER, MANAGER, 'use'))
    await store.grants.upsert(edge(MANAGER, DELEGATE, 'manage'))
    // A later direct share replaces the incoming manage edge and makes this
    // branch independent of MANAGER, even though MANAGER originally gave it.
    await store.grants.upsert(edge(OWNER, DELEGATE, 'manage'))
    await store.grants.upsert(edge(DELEGATE, READER, 'use'))
    await store.grants.upsert(edge(MANAGER, INDEPENDENT, 'use'))
    const other = edge(MANAGER, INDEPENDENT, 'use', 'another-key')
    const machine = { ...edge(MANAGER, INDEPENDENT, 'manage'), resourceKind: 'machine' }
    await store.grants.upsert(other)
    await store.grants.upsert(machine)

    expect(await revoke(store)).toBe(true)
    expect(await mayUse(store, MANAGER, credential)).toBe('use')
    expect(await mayUse(store, DELEGATE, credential)).toBe('manage')
    expect(await mayUse(store, READER, credential)).toBe('use')
    expect(await mayUse(store, INDEPENDENT, credential)).toBeNull()
    expect(await store.grants.listForResource('credential', 'another-key')).toEqual([other])
    expect(await store.grants.listForResource('machine', KEY)).toEqual([machine])
    await store.grants.upsert(edge(OWNER, MANAGER, 'manage'))
    expect(await mayUse(store, INDEPENDENT, credential)).toBeNull()
  })

  it('revoking use or an absent manage edge leaves a live delegation intact', async () => {
    await store.grants.upsert(edge(OWNER, MANAGER, 'use'))
    await store.grants.upsert(edge(MANAGER, READER, 'use'))
    expect(await store.grants.remove('credential', KEY, MANAGER, 'use')).toBe(true)
    const before = await store.grants.listForResource('credential', KEY)
    const revision = await store.grants.visibilityRevision()
    expect(await revoke(store, INDEPENDENT)).toBe(false)
    expect(await store.grants.visibilityRevision()).toBe(revision)
    expect(await store.grants.listForResource('credential', KEY)).toEqual(before)
    expect(await mayUse(store, READER, credential)).toBe('use')
  })

  it('never follows a malformed delegation back through the credential owner', async () => {
    await store.grants.upsert(edge(MANAGER, OWNER, 'manage'))
    await store.grants.upsert(edge(OWNER, INDEPENDENT, 'manage'))
    await store.grants.upsert(edge(INDEPENDENT, READER, 'use'))
    expect(await revoke(store, OWNER)).toBe(true)
    expect(await mayUse(store, READER, credential)).toBe('use')
    await store.grants.upsert(edge(MANAGER, OWNER, 'manage'))
    expect(await revoke(store)).toBe(true)
    expect(await mayUse(store, OWNER, credential)).toBe('owner')
    expect(await mayUse(store, INDEPENDENT, credential)).toBe('manage')
    expect(await mayUse(store, READER, credential)).toBe('use')
  })

  it('deletes malformed downstream cycles without following them forever', async () => {
    await store.grants.upsert(edge(MANAGER, DELEGATE, 'manage'))
    await store.grants.upsert(edge(DELEGATE, READER, 'manage'))
    await store.grants.upsert(edge(READER, MANAGER, 'manage'))
    await store.grants.upsert(edge(READER, INDEPENDENT, 'use'))
    expect(await revoke(store)).toBe(true)
    expect(await store.grants.listForResource('credential', KEY)).toEqual([])
    await store.grants.upsert(edge(OWNER, MANAGER, 'manage'))
    expect(await mayUse(store, DELEGATE, credential)).toBeNull()
    expect(await mayUse(store, READER, credential)).toBeNull()
  })

  it('invalidates loaded grants and publishes every deletion only after commit; rollback restores them', async () => {
    await store.grants.upsert(edge(MANAGER, DELEGATE, 'manage'))
    await store.grants.upsert(edge(DELEGATE, READER, 'use'))
    const before = await store.grants.listForResource('credential', KEY)
    const heard: CommittedRowChange<typeof grants.$inferSelect>[] = []
    const stop = store.grants.committed.subscribe((change) => heard.push(change))
    try {
      await withReadScope(async () => {
        expect(await store.grants.loadForResource('credential', KEY)).toEqual(before)
        await expect(
          store.transact(async () => {
            expect(await revoke(store)).toBe(true)
            expect(await store.grants.loadForResource('credential', KEY)).toEqual([])
            expect(heard).toEqual([])
            throw new Error('roll back revocation')
          }),
        ).rejects.toThrow('roll back revocation')
        expect(heard).toEqual([])
        expect(await store.grants.loadForResource('credential', KEY)).toEqual(before)
        expect(await mayUse(store, READER, credential)).toBe('use')
        const revision = await store.grants.visibilityRevision()
        expect(await revoke(store)).toBe(true)
        expect(await store.grants.visibilityRevision()).toBe(revision + 1)
        expect(await store.grants.loadForResource('credential', KEY)).toEqual([])
      })
      expect(heard).toHaveLength(1)
      expect(heard[0]?.operation).toBe('delete')
      expect(heard[0]?.rows).toHaveLength(before.length)
      expect(heard[0]?.rows).toEqual(
        expect.arrayContaining(before.map((row) => expect.objectContaining(row))),
      )
    } finally {
      stop()
    }
  })
})

it('cascades only in the target workspace when both hold the same credential and member ids', async () => {
  const [a, b] = await openWorkspaceStores(['ws_grant-revoke-a', 'ws_grant-revoke-b'])
  try {
    for (const store of [a, b]) {
      await seed(store)
      await store.grants.upsert(edge(MANAGER, DELEGATE, 'manage'))
      await store.grants.upsert(edge(DELEGATE, READER, 'use'))
    }
    const otherEdges = await b.grants.listForResource('credential', KEY)
    expect(await a.grants.remove('credential', KEY, MANAGER, 'manage')).toBe(true)
    await a.grants.upsert(edge(OWNER, MANAGER, 'manage'))
    expect(await mayUse(a, READER, credential)).toBeNull()
    expect(await b.grants.listForResource('credential', KEY)).toEqual(otherEdges)
    expect(await mayUse(b, READER, credential)).toBe('use')
  } finally {
    await a.close()
  }
})

describe('credential revocation statement count', () => {
  const pin: StatementPin<SessionStore> = {
    name: 'credential manage cascade',
    setup: async (size) => {
      const store = await openTestStore(':memory:')
      await store.credentials.insert({ ...credential, label: 'Team key', type: 'openai.api-key' })
      // Reverse creation order exercises a deep chain independent of row order.
      for (let i = size - 1; i >= 0; i--) {
        await store.grants.upsert(
          edge(i === 0 ? MANAGER : `delegate-${i - 1}`, `delegate-${i}`, 'manage'),
        )
      }
      await store.grants.upsert(edge(`delegate-${size - 1}`, READER, 'use'))
      await store.grants.upsert(edge(OWNER, MANAGER, 'manage'))
      return store
    },
    target: (store) => store,
    run: async (store) => await store.grants.remove('credential', KEY, MANAGER, 'manage'),
    check: async (removed, store) => {
      expect(removed).toBe(true)
      expect(await store.grants.listForResource('credential', KEY)).toEqual([])
    },
    teardown: async (store) => await store.close(),
  }

  it('uses five statements for either 5 or 200 downstream managers, with an armed count pin', async () => {
    await expectConstantStatements(pin, 5)
    await expectArmed(pin, 5, (store, size) => {
      const list = store.grants.listForResource.bind(store.grants)
      const spy = vi.spyOn(store.grants, 'listForResource').mockImplementation(async (kind, id) => {
        for (let i = 0; i < size; i++) await store.credentials.get(KEY)
        return await list(kind, id)
      })
      return () => spy.mockRestore()
    })
  })

  it('chunks the delete above 500 downstream managers without a statement per manager', async () => {
    await expectConstantStatements({ ...pin, sizes: [501, 600] }, 6)
  })
})
