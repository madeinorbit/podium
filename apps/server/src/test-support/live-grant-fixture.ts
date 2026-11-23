/**
 * The live grant tests' store (POD-7311): members, machines with custody and
 * shared `use`, registered roots and private sessions, and the grant's read
 * sources over that store as production composes them.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  type GrantVerb,
  type MachineId,
  type SessionId,
  type UserId,
  type UserRole,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { userCommandPrincipal } from '../command-principal'
import type { ClientGrantSources } from '../modules/live-grants/scopes'
import type { SessionStore } from '../store'
import { memberFacts } from '../store/fixtures/test-support'
import { session } from './workspace-seeds/sessions'

/** The machine source as `MachinesService` reads it: the machines table and its edges. */
export function grantMachineSource(store: SessionStore): ClientGrantSources['machines'] {
  return {
    ownershipRows: async () =>
      (await store.machines.listMachines()).map((machine) => ({
        id: machine.id,
        name: machine.name,
        revokedAt: machine.revokedAt,
        daemonAssigned: machine.serviceAssignment.agentExecution,
        daemonAvailable: false,
      })),
    grantsForMachines: async (ids) => await store.grants.listForResources('machine', ids),
  }
}

export function grantSources(store: SessionStore): ClientGrantSources {
  return { sessions: store.sessions, machines: grantMachineSource(store), repos: store.repos }
}

export async function grantEdge(
  store: SessionStore,
  resourceKind: 'machine' | 'session',
  resourceId: string,
  grantee: UserId,
  verb: GrantVerb,
  owner: UserId,
): Promise<void> {
  await store.grants.upsert({
    resourceKind,
    resourceId,
    grantee,
    verb,
    owner,
    visibility: resourceKind === 'machine' ? 'owned-compute' : 'private',
    createdAt: '2026-11-23T00:00:00.000Z',
    actorKind: 'user',
    actorId: owner,
    onBehalfOf: owner,
  })
}

export async function addMember(store: SessionStore, id: UserId, role: UserRole): Promise<void> {
  await memberFacts(store).create(
    { id, displayName: id, role, createdAt: '2026-11-23T00:00:00.000Z', disabledAt: null },
    'not-a-real-hash',
  )
}

/** A machine in `owner`'s custody (custody brings `use` and `manage`). */
export async function addMachine(store: SessionStore, id: MachineId, owner: UserId): Promise<void> {
  await store.machines.upsertMachine({
    id,
    name: id,
    hostname: `${id}.example.com`,
    tokenHash: `hash-${id}`,
    ownerUserId: owner,
  })
}

export const ALICE = asUserId('user:alice')
export const BOB = asUserId('user:bob')
export const CAROL = asUserId('user:carol')
export const ROLE: Readonly<Record<string, UserRole>> = {
  [ALICE]: 'member',
  [BOB]: 'member',
  [CAROL]: 'admin',
}
export const PEOPLE = [ALICE, BOB, CAROL] as const

/** Alice's own machine. */
export const M_ALICE = asMachineId('m-alice')
/** Bob's, shared with Alice for `use`. */
export const M_SHARED = asMachineId('m-shared')
/** Bob's, not shared. */
export const M_PRIVATE = asMachineId('m-private')
export const MACHINES: readonly MachineId[] = [
  M_ALICE,
  M_SHARED,
  M_PRIVATE,
  asMachineId('m-missing'),
]

export const S = {
  aliceOnHers: asSessionId('s-alice-hers'),
  aliceOnPrivate: asSessionId('s-alice-private'),
  bobOnShared: asSessionId('s-bob-shared'),
  aliceClosed: asSessionId('s-alice-closed'),
  missing: asSessionId('s-missing'),
} as const
export const SESSIONS: readonly SessionId[] = Object.values(S)

export const principalOf = (user: UserId) => userCommandPrincipal(user, ROLE[user]!)

/** Alice, Bob (member) and Carol (admin); three machines; five session ids. */
export async function seedGrantWorld(store: SessionStore): Promise<void> {
  for (const id of PEOPLE) await addMember(store, id, ROLE[id]!)
  await addMachine(store, M_ALICE, ALICE)
  await addMachine(store, M_SHARED, BOB)
  await addMachine(store, M_PRIVATE, BOB)
  await grantEdge(store, 'machine', M_SHARED, ALICE, 'use', BOB)
  await store.repos.addRepo('/alice', M_ALICE, undefined, 'ALI')
  await store.repos.addRepo('/shared', M_SHARED, undefined, 'SHA')
  await store.repos.addRepo('/secret', M_PRIVATE, undefined, 'SEC')
  await store.sessions.upsertSessions(fixtureWriteScope(), [
    session('a', 1, { id: S.aliceOnHers, ownerUserId: ALICE, machineId: M_ALICE }),
    session('a', 2, { id: S.aliceOnPrivate, ownerUserId: ALICE, machineId: M_PRIVATE }),
    session('a', 3, { id: S.bobOnShared, ownerUserId: BOB, machineId: M_SHARED }),
    session('a', 4, {
      id: S.aliceClosed,
      ownerUserId: ALICE,
      machineId: M_ALICE,
      deletedAt: '2026-11-22T00:00:00.000Z',
    }),
  ])
  // A legacy read grant on Bob's session: inert, sessions are private (POD-6283).
  await grantEdge(store, 'session', S.bobOnShared, ALICE, 'read', BOB)
}
