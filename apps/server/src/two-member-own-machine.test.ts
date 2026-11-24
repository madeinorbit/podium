/**
 * A MEMBER BRINGS THEIR OWN MACHINE (POD-6883; design §2.4).
 *
 * On the two-member fixture (POD-6282): Alice is the admin, Bob a member.
 *
 * - Bob mints an enrollment code for a new machine. The machine that redeems it
 *   is in Bob's custody (`manage` + custody) with Bob's `use`, exactly as an
 *   admin-enrolled machine is for its admin.
 * - Alice sees and manages it by her role, and may revoke it, but has no `use`.
 * - The code carries its minter: nothing in the request can name someone else.
 * - An agent principal never mints a new-machine code, even an admin's agent.
 * - A code minted before Bob is disabled is refused at redeem, and stays refused
 *   after he is enabled again.
 *
 * Redemption goes through `machines.authenticateDaemon`, the function the
 * `/daemon` socket's pair handshake calls. A member may mint five codes a minute
 * (`PAIR_MINTS_PER_MINUTE`), so the file mints four.
 */

import { asMachineId, type MachineId, type UserId } from '@podium/model'
import { mintSigningKeyPair, publicKeyWire } from '@podium/runtime/signing'
import { createTRPCClient, httpLink } from '@trpc/client'
import { TRPCError } from '@trpc/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SuperagentService } from './modules/superagent'
import { RepoRegistry } from './repo-registry'
import { type AppRouter, appRouter } from './router'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import { permissiveFixturePrincipal } from './test-support/capabilities'
import {
  MEMBERS,
  type MemberName,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

const store = () => f.handle.registry.sessionStore
const machines = () => f.handle.registry.modules.machines
// biome-ignore lint/suspicious/noExplicitAny: tRPC procedures addressed by one loose shape
const trpc = async (who: MemberName): Promise<any> => (await f.as(who)).trpc

const mint = async (who: MemberName, input: Record<string, unknown> = {}): Promise<string> =>
  (
    (await (
      await trpc(who)
    ).machines.pairingCode.mutate({
      copyAgentCredentials: false,
      ...input,
    })) as { code: string }
  ).code

/** Redeem `code` as a fresh daemon proposing `name` as its id. */
const redeem = async (code: string, name: string) =>
  await machines().authenticateDaemon({
    type: 'pair',
    code,
    machineId: asMachineId(name),
    publicKey: publicKeyWire(mintSigningKeyPair()),
    hostname: name,
  })

const grantsOn = async (id: MachineId) =>
  (await store().grants.listForResource('machine', id))
    .map((grant) => ({ grantee: grant.grantee, verb: grant.verb, custody: grant.custody === true }))
    .sort((a, b) => `${a.grantee}${a.verb}`.localeCompare(`${b.grantee}${b.verb}`))

const listed = async (who: MemberName, id: MachineId) =>
  ((await (await trpc(who)).machines.list.query()) as Array<{ id: string; use?: string }>).find(
    (machine) => machine.id === id,
  )

describe('a member adds a machine of their own', () => {
  const laptop = asMachineId('bob-laptop')

  it('Bob mints a code, and the machine it enrolls is in his custody with his use', async () => {
    // The request has no owner field: one smuggled in is not read, so the code
    // can only ever enroll into Bob's own custody.
    const code = await mint('bob', { ownerUserId: MEMBERS.alice.id })
    expect(await redeem(code, laptop)).toMatchObject({ ok: true, machineId: laptop })
    expect(await store().machines.custodian(laptop)).toBe(MEMBERS.bob.id)
    expect(await grantsOn(laptop)).toEqual([
      { grantee: MEMBERS.bob.id, verb: 'manage', custody: true },
      { grantee: MEMBERS.bob.id, verb: 'use', custody: false },
    ])
    expect(await listed('bob', laptop)).toMatchObject({ id: laptop, use: 'granted' })
    // Single use: the same code enrolls nothing further.
    expect(await redeem(code, 'bob-laptop-again')).toEqual({
      ok: false,
      reason: 'invalid or expired code',
    })
    expect(await store().machines.getMachine('bob-laptop-again')).toBeUndefined()
  })

  it('Alice sees and manages it by role, with no use', async () => {
    expect(await listed('alice', laptop)).toMatchObject({ id: laptop, use: 'denied' })
    // Reading what runs there needs `use`, which her role never gives.
    await expect(
      (await trpc('alice')).discovery.lastMachineScan.query({ machineId: laptop }),
    ).rejects.toThrow()
    expect(
      await (await trpc('bob')).discovery.lastMachineScan.query({ machineId: laptop }),
    ).toBeNull()
  })

  it('Bob still may not register a client identity, which is an administrator’s', async () => {
    await expect(
      mint('bob', {
        clientRegistration: {
          machineId: 'bob-client',
          publicKey: publicKeyWire(mintSigningKeyPair()),
        },
      }),
    ).rejects.toThrow(/requires an admin account/)
  })

  it('Alice may revoke Bob’s machine', async () => {
    await (await trpc('alice')).machines.revoke.mutate({ id: laptop })
    expect((await store().machines.getMachine(laptop))?.revokedAt).toBeTruthy()
  })
})

describe('an agent may not mint an enrollment code', () => {
  async function agentCaller(onBehalfOf: UserId, role: 'admin' | 'worker') {
    const registry = f.handle.registry
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(
      registry.modules,
      repos,
      registry.sessionStore,
    )
    const capability = {
      workspaceId: SELF_HOSTED_WORKSPACE_ID,
      role,
      scope: { kind: 'owned' as const, userId: onBehalfOf },
      actorSessionId: f.sessions.bob,
      onBehalfOf,
    }
    return appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability,
      principal: permissiveFixturePrincipal(SELF_HOSTED_WORKSPACE_ID, capability, {
        parentSessionOf: () => undefined,
        onBehalfOfFor: () => onBehalfOf,
      }),
    })
  }

  it.each([
    ['Bob’s agent', 'bob', 'worker'],
    ['an admin’s agent', 'alice', 'admin'],
  ] as const)('%s is refused', async (_label, who, role) => {
    const call = await agentCaller(MEMBERS[who].id, role)
    const refusal = await call.machines.pairingCode().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(TRPCError)
    expect(refusal).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('a disabled member’s unused code', () => {
  const memberships = () => f.handle.identity.memberships
  const disable = async () =>
    await memberships().disable({ actor: { memberId: MEMBERS.alice.id }, memberId: MEMBERS.bob.id })
  const enable = async () =>
    await memberships().enable({ actor: { memberId: MEMBERS.alice.id }, memberId: MEMBERS.bob.id })

  it('is refused at redeem, and stays refused after the member is enabled again', async () => {
    // Two codes minted while Bob is active.
    const whileDisabled = await mint('bob')
    const afterReenable = await mint('bob')
    await disable()
    try {
      expect(await redeem(whileDisabled, 'bob-while-disabled')).toEqual({
        ok: false,
        reason: 'invalid or expired code',
      })
      expect(await store().machines.getMachine('bob-while-disabled')).toBeUndefined()
    } finally {
      await enable()
    }
    // Enabled again, Bob's code from before is still not his to use: it is bound
    // to the authority it was minted under.
    expect(await redeem(afterReenable, 'bob-after-reenable')).toEqual({
      ok: false,
      reason: 'invalid or expired code',
    })
    expect(await store().machines.getMachine('bob-after-reenable')).toBeUndefined()
    // Disabling ended Bob's sign-ins; signed in again, a code he mints now works,
    // so the refusals were about the stale codes, not about Bob.
    const cookie = await f.signInDevice('bob')
    const bob = createTRPCClient<AppRouter>({
      links: [httpLink({ url: `${f.origin}/trpc`, headers: () => ({ cookie }) })],
    })
    const { code } = await bob.machines.pairingCode.mutate({ copyAgentCredentials: false })
    expect(await redeem(code, 'bob-fresh')).toMatchObject({ ok: true })
    expect(await store().machines.custodian('bob-fresh')).toBe(MEMBERS.bob.id)
  })
})
