import { asMachineId, asUserId, type Capability, firstAdminMemberId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'
import { PairingManager } from './hub/pairing'

import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'
import { attachDaemonWithInventory, fixtureInventory } from './test-support/daemon-inventory'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { renameMachine } from './test-support/machine-records'

async function machineCaller() {
  const store = await openTestStore(':memory:')
  // Pre-register a machine so listMachines returns it
  await store.machines.upsertMachine({
    id: 'm1',
    name: 'machine-one',
    hostname: 'host-one',
    tokenHash: 'h1',
    ownerUserId: firstAdminMemberId(),
  })
  // Pairing is a hub-role capability, injected the way server assembly does it.
  const registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    pairing: new PairingManager(),
  })
  // The host row setup enrollment writes — owned, and assigned agent execution
  // (34aa06cf2) — BEFORE the rename, which keeps the row's custodian and would
  // otherwise leave the host ownerless (6fd4f7221: boot no longer creates it).
  await attachHostDaemon(registry, () => {})
  await registry.modules.machines.ensureHostMachine('machine-under-test', undefined, {
    server: true,
    agentExecution: true,
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  return {
    registry,
    call: appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability: OPERATOR,
      principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
    }),
  }
}

describe('machines router', () => {
  it('machines.list returns registered machines', async () => {
    const { call } = await machineCaller()
    const machines = await call.machines.list()
    const m1 = machines.find((m) => m.id === 'm1')
    expect(m1).toBeDefined()
    expect(m1?.name).toBe('machine-one')
    expect(m1?.hostname).toBe('host-one')
    // m1 daemon not attached, so online = false
    expect(m1?.online).toBe(false)
  })

  it('records.machine.edit renames it, and machines.list serves the new name', async () => {
    const { call } = await machineCaller()
    await renameMachine(call, 'm1', 'renamed-machine')
    const m1 = (await call.machines.list()).find((m) => m.id === 'm1')
    expect(m1?.name).toBe('renamed-machine')
  })

  it('records.machine.edit refuses an empty or over-long name', async () => {
    const { call } = await machineCaller()
    await expect(renameMachine(call, 'm1', '')).rejects.toThrow()
    await expect(renameMachine(call, 'm1', 'x'.repeat(81))).rejects.toThrow()
  })

  it('machines.revoke removes the machine from the list', async () => {
    const { call } = await machineCaller()
    const before = await call.machines.list()
    expect(before.find((m) => m.id === 'm1')).toBeDefined()
    const after = await call.machines.revoke({ id: 'm1' })
    expect(after.find((m) => m.id === 'm1')).toBeUndefined()
  })

  it('machines.pairingCode returns a non-empty code string', async () => {
    const { call } = await machineCaller()
    const result = await call.machines.pairingCode()
    expect(result).toHaveProperty('code')
    expect(typeof result.code).toBe('string')
    expect(result.code.length).toBeGreaterThan(0)
  })
})

/**
 * `machines.pairingCode` is a plain registration (POD-6593): its contract's
 * action is `write`, so the front door admits a member, and the fleet gate
 * decides who may mint which code. An administrator mints a new enrollment; a
 * retained (revoked) machine's grantee mints only its replacement.
 */
describe('machines.pairingCode as a member', () => {
  const MEMBER = asUserId('user:pairing-member')
  const MEMBER_CAPABILITY: Capability = {
    role: 'worker',
    scope: { kind: 'owned', userId: MEMBER },
    actorUser: MEMBER,
    onBehalfOf: MEMBER,
  }

  async function memberCaller() {
    const store = await openTestStore(':memory:')
    await store.users.create(
      {
        id: MEMBER,
        displayName: 'Member',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      await hashPassword('member-password'),
    )
    for (const [id, owner] of [
      ['mine', MEMBER],
      ['theirs', firstAdminMemberId()],
    ] as const) {
      await store.machines.upsertMachine({
        id,
        name: id,
        hostname: `host-${id}`,
        tokenHash: `h-${id}`,
        ownerUserId: owner,
      })
      await store.machines.revokeMachine(asMachineId(id))
    }
    const registry = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      pairing: new PairingManager(),
    })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(
      registry.modules,
      repos,
      registry.sessionStore,
    )
    return appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability: MEMBER_CAPABILITY,
      principal: resolvePrincipal(MEMBER_CAPABILITY, { parentSessionOf: () => undefined }),
    })
  }

  async function refusalOf(call: Promise<unknown>): Promise<TRPCError> {
    try {
      await call
    } catch (error) {
      if (error instanceof TRPCError) return error
      throw error
    }
    throw new Error('expected a refusal')
  }

  it("mints the replacement code for the member's own retained machine", async () => {
    const call = await memberCaller()
    const result = await call.machines.pairingCode({ replaceMachineId: 'mine' })
    expect(typeof result.code).toBe('string')
    expect(result.code.length).toBeGreaterThan(0)
  })

  it('refuses a member the replacement of a machine they are not the grantee of', async () => {
    const call = await memberCaller()
    const refusal = await refusalOf(call.machines.pairingCode({ replaceMachineId: 'theirs' }))
    expect(refusal.code).toBe('FORBIDDEN')
  })

  it('refuses a member a new enrollment', async () => {
    const call = await memberCaller()
    const refusal = await refusalOf(call.machines.pairingCode())
    expect(refusal.code).toBe('FORBIDDEN')
  })
})

describe('sessions.create with machineId', () => {
  it('sessions.create accepts and forwards machineId', async () => {
    const store = await openTestStore(':memory:')
    await store.machines.upsertMachine({
      id: 'm2',
      name: 'machine-two',
      hostname: 'host-two',
      tokenHash: 'h2',
      ownerUserId: firstAdminMemberId(),
      // A daemon machine that may run agents (34aa06cf2).
      assignment: { server: false, agentExecution: true },
    })
    const inventory = fixtureInventory({
      agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
    })
    await store.machines.setMachineInventory('m2', JSON.stringify(inventory))
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachDaemonWithInventory(registry, 'm2', () => {}, inventory)
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(
      registry.modules,
      repos,
      registry.sessionStore,
    )
    const call = appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability: OPERATOR,
      principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
    })

    const { sessionId } = await call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/home/test',
      machineId: 'm2',
    })

    const list = await call.sessions.list()
    const session = list.find((s) => s.sessionId === sessionId)
    expect(session?.machineId).toBe('m2')
  })

  it('sessions.create works without machineId (falls back to local)', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    // The host row setup enrollment writes — owned, and assigned agent execution
    // (34aa06cf2) — BEFORE the rename, which keeps the row's custodian and would
    // otherwise leave the host ownerless (6fd4f7221: boot no longer creates it).
    await attachHostDaemon(registry, () => {})
    await registry.modules.machines.ensureHostMachine('machine-under-test', undefined, {
      server: true,
      agentExecution: true,
    })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(
      registry.modules,
      repos,
      registry.sessionStore,
    )
    const call = appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability: OPERATOR,
      principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
    })

    const { sessionId } = await call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/home/test',
    })

    const list = await call.sessions.list()
    expect(list.find((s) => s.sessionId === sessionId)).toBeDefined()
  })
})
