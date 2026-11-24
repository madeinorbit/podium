import {
  asMachineId,
  asSessionId,
  asUserId,
  asWorkspaceId,
  type Capability,
  spawnedByParentSessionId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import { capabilityPrincipalResolver } from './capability-principal'
import { resolvePrincipalAsync } from './command-principal'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import type { SessionRow } from './store/types'
import type { UserAccountRow } from './store/users'
import { openPeopleStoreSlice, type PeopleStoreSlice } from './test-support/people-store-slice'
import { expectConstantStatements, type StatementPin } from './test-support/statement-count'

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')
const MALLORY = asUserId('user:mallory')
/**
 * The members of the fixture's workspace, answered without a statement: the
 * pins below count the session reads of the delegation walk, and the member
 * read is the per-operation account read every gate already makes.
 */
const MEMBERS = new Set<string>([ALICE, BOB])
const members = {
  get: async (id: UserId) => (MEMBERS.has(id) ? ({ role: 'member' } as UserAccountRow) : undefined),
}
/** The resolver over a store's sessions, with the fixture's members. */
const resolverOf = (sessions: PeopleStoreSlice['sessions']) =>
  capabilityPrincipalResolver(SELF_HOSTED_WORKSPACE_ID, sessions, members)

const row = (id: string, owner = BOB, spawnedBy: string | null = null): SessionRow => ({
  id: asSessionId(id),
  ownerUserId: owner,
  agentKind: 'claude-code',
  cwd: '/home/u/repo',
  title: id,
  name: null,
  nameSource: null,
  originKind: 'spawn',
  conversationId: null,
  resumeKind: null,
  resumeValue: null,
  status: 'live',
  exitCode: null,
  spawnFailure: null,
  durableLabel: `label-${id}`,
  createdAt: '2026-10-15T00:00:00.000Z',
  lastActiveAt: '2026-10-15T00:00:00.000Z',
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
  spawnedBy,
})

/** `size` unrelated sessions plus a root → child → grandchild spawn chain owned by Alice. */
async function fixture(size: number): Promise<PeopleStoreSlice> {
  const store = await openPeopleStoreSlice()
  for (let i = 0; i < size; i++)
    await store.sessions.upsertSession(fixtureWriteScope(), row(`other-${i}`))
  await store.sessions.upsertSession(fixtureWriteScope(), row('root', ALICE))
  await store.sessions.upsertSession(fixtureWriteScope(), row('child', BOB, 'session:root'))
  await store.sessions.upsertSession(fixtureWriteScope(), row('grandchild', BOB, 'session:child'))
  return store
}

const agent = (id: string): Capability =>
  ({
    workspaceId: SELF_HOSTED_WORKSPACE_ID,
    actorSessionId: asSessionId(id),
    role: 'worker',
    scope: { kind: 'none' },
  }) as unknown as Capability

/**
 * The resolver as relay.ts composed it before POD-6149: two reads of the root row.
 * Over the sessions repository NOT drained: a read captures nothing, and on Postgres
 * the drain's own statements would be counted with the reads.
 */
const legacyResolver = (store: PeopleStoreSlice) => (capability: Capability) =>
  resolvePrincipalAsync(SELF_HOSTED_WORKSPACE_ID, capability, {
    parentSessionOf: async (candidate) =>
      spawnedByParentSessionId(
        (await store.undrained.sessions.getSession(asSessionId(candidate)))?.spawnedBy,
      ),
    onBehalfOfFor: async (candidate) =>
      (await store.undrained.sessions.getSession(asSessionId(candidate)))?.ownerUserId,
    isMember: async (user) => MEMBERS.has(user),
  })

const pin = (
  name: string,
  resolve: (store: PeopleStoreSlice) => (capability: Capability) => Promise<unknown>,
  actor: string,
  expected: object,
): StatementPin<PeopleStoreSlice> => ({
  name,
  setup: fixture,
  target: (store) => store.probeTarget,
  run: async (store) => await resolve(store)(agent(actor)),
  check: (result) => expect(result).toMatchObject(expected),
  teardown: async (store) => await store.close(),
})

describe('capability → principal resolution', () => {
  it('reads a root agent session once, whatever the number of sessions', async () => {
    await expectConstantStatements(
      pin('root agent', (s) => resolverOf(s.undrained.sessions), 'root', {
        kind: 'agent',
        onBehalfOf: ALICE,
        chain: [],
      }),
      1,
    )
  })

  it('control: the resolver it replaces read the same root row twice', async () => {
    await expectConstantStatements(
      pin('legacy root agent', legacyResolver, 'root', { kind: 'agent', onBehalfOf: ALICE }),
      2,
    )
  })

  it('reads each link of a spawn chain once, the root owner from the walk', async () => {
    const expected = { kind: 'agent', onBehalfOf: ALICE, chain: ['child', 'root'] }
    await expectConstantStatements(
      pin('grandchild agent', (s) => resolverOf(s.undrained.sessions), 'grandchild', expected),
      3,
    )
    await expectConstantStatements(
      pin('legacy grandchild agent', legacyResolver, 'grandchild', expected),
      4,
    )
  })

  it('answers exactly what the old resolver answered', async () => {
    const store = await fixture(5)
    try {
      for (const id of ['root', 'child', 'grandchild', 'other-1']) {
        expect(await resolverOf(store.sessions)(agent(id))).toEqual(
          await legacyResolver(store)(agent(id)),
        )
      }
      await expect(resolverOf(store.sessions)(agent('absent'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'not_workspace_member',
      })
    } finally {
      await store.close()
    }
  })

  it('sees a delegation change made earlier in the same operation', async () => {
    const store = await fixture(5)
    try {
      const { withReadScope } = await import('./store/executor/read-scope')
      await withReadScope(async () => {
        const resolve = resolverOf(store.sessions)
        expect(await resolve(agent('root'))).toMatchObject({ onBehalfOf: ALICE, chain: [] })
        // The owner column is immutable on upsert; the parent link is not.
        await store.sessions.upsertSession(
          fixtureWriteScope(),
          row('root', ALICE, 'session:other-1'),
        )
        expect(await resolve(agent('root'))).toMatchObject({ onBehalfOf: BOB, chain: ['other-1'] })
      })
    } finally {
      await store.close()
    }
  })

  it("refuses another workspace's capability, and an agent whose root owner is not a member", async () => {
    const store = await fixture(1)
    try {
      await store.sessions.upsertSession(fixtureWriteScope(), row('foreign-root', MALLORY))
      const resolve = resolverOf(store.sessions)
      const notAMember = { code: 'FORBIDDEN', message: 'not_workspace_member' }
      await expect(
        resolve({ ...agent('root'), workspaceId: asWorkspaceId('ws_other') }),
      ).rejects.toMatchObject(notAMember)
      await expect(resolve(agent('foreign-root'))).rejects.toMatchObject(notAMember)
    } finally {
      await store.close()
    }
  })
})
