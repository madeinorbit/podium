import { ACCOUNT_CONTRACTS } from '@podium/commands'
import { asMachineId, asUserId, firstAdminMemberId, type UserRole } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as principals from './command-principal'
import { SessionRegistry } from './relay'
import { attachDaemonWithInventory, fixtureInventory } from './test-support/daemon-inventory'
import { openTestStore } from './test-support/open-test-store'

const OWNER = asUserId('native-login-owner')
const MACHINE = asMachineId('native-login-host')
const ADMIN_REFUSAL = 'native provider login requires an admin account'
const registries: SessionRegistry[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const registry of registries.splice(0)) await registry.dispose()
})

async function fixture(role: UserRole = 'admin') {
  const store = await openTestStore(':memory:')
  await store.users.create({
    id: OWNER,
    displayName: 'Login owner',
    role,
    createdAt: '2026-09-14T00:00:00.000Z',
    disabledAt: null,
  }, 'unused-test-password')
  await store.machines.upsertMachine({
    id: MACHINE,
    name: 'Login host',
    hostname: 'login-host',
    tokenHash: 'unused-test-token',
    ownerUserId: OWNER,
  })
  const inventory = fixtureInventory({
    agents: [
      { kind: 'codex', installed: true, login: { state: 'out' } },
      { kind: 'claude-code', installed: true, login: { state: 'out' } },
    ],
  })
  await store.machines.setMachineInventory(MACHINE, JSON.stringify(inventory))
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  const frames: ControlMessage[] = []
  await attachDaemonWithInventory(registry, MACHINE, (frame) => frames.push(frame), inventory)
  const start = () => registry.modules.nativeLogin.start({
    harness: 'codex', machineId: MACHINE, ownerUserId: OWNER,
  })
  return { store, registry, frames, start }
}

describe('native login policy at relay composition', () => {
  it('uses the shared admin decision for a live admin and starts on their host', async () => {
    const f = await fixture()
    // Call-through observation: the real decision, store and machine policy run.
    // Reintroducing a hand-written role comparison must fail this wiring witness.
    const decision = vi.spyOn(principals, 'adminFloorRefusal')
    expect(ACCOUNT_CONTRACTS.login.policy.roleFloor).toBe('admin')
    const attempt = await f.start()
    expect(attempt).toMatchObject({ machineId: MACHINE, machineName: 'Login host', status: 'running' })
    expect(f.frames.filter((frame) => frame.type === 'spawn')).toHaveLength(1)
    expect(decision).toHaveBeenCalledWith('user', 'admin')
  })

  it('refuses a member who owns the host with the native-login admin message', async () => {
    const f = await fixture('member')
    const decision = vi.spyOn(principals, 'adminFloorRefusal')
    await expect(f.start()).rejects.toThrow(ADMIN_REFUSAL)
    expect(f.frames.filter((frame) => frame.type === 'spawn')).toHaveLength(0)
    expect(decision).toHaveBeenCalledWith('user', 'member')
  })

  it('re-reads admin authority before a fresh login after the account is disabled', async () => {
    const f = await fixture()
    await f.start()
    await f.store.users.disable(OWNER, '2026-09-14T00:01:00.000Z')
    // Another harness avoids the same-owner in-flight reuse path: this witnesses
    // authorizerFor on a fresh login, not reauthorization of an existing attempt.
    await expect(f.registry.modules.nativeLogin.start({
      harness: 'claude-code', machineId: MACHINE, ownerUserId: OWNER,
    })).rejects.toThrow(ADMIN_REFUSAL)
    expect(f.frames.filter((frame) => frame.type === 'spawn')).toHaveLength(1)
  })

  it('refuses a missing account even when it is named as the machine owner', async () => {
    const f = await fixture()
    const missing = asUserId('missing-login-owner')
    await f.store.machines.upsertMachine({
      id: MACHINE, name: 'Login host', hostname: 'login-host', tokenHash: 'unused-test-token',
      ownerUserId: missing,
    })
    await expect(f.registry.modules.nativeLogin.start({
      harness: 'codex', machineId: MACHINE, ownerUserId: missing,
    })).rejects.toThrow(ADMIN_REFUSAL)
    expect(f.frames.filter((frame) => frame.type === 'spawn')).toHaveLength(0)
  })

  it('follows a changed contract floor instead of retaining a second admin floor', async () => {
    const f = await fixture('member')
    const policy = ACCOUNT_CONTRACTS.login.policy
    const descriptor = Object.getOwnPropertyDescriptor(policy, 'roleFloor')!
    expect(policy.roleFloor).toBe('admin')
    try {
      // Deliberate test-only policy variation. The shipped floor stays admin;
      // varying the declaration is what distinguishes it from the old callback.
      Object.defineProperty(policy, 'roleFloor', { ...descriptor, value: 'member' })
      await expect(f.start()).resolves.toMatchObject({ machineId: MACHINE, status: 'running' })
      expect(f.frames.filter((frame) => frame.type === 'spawn')).toHaveLength(1)
    } finally {
      Object.defineProperty(policy, 'roleFloor', descriptor)
    }
  })

  it('refuses another admin without machine use instead of returning the owners attempt', async () => {
    const f = await fixture()
    const attempt = await f.start()
    const other = firstAdminMemberId()
    expect(other).not.toBe(OWNER)
    expect(await f.store.users.roleOf(other)).toBe('admin')
    // Seeing a machine is independent of permission to use it. Retain see so
    // the refusal witnesses the use gate, not the hidden-machine response.
    await f.store.grants.upsert({
      resourceKind: 'machine', resourceId: MACHINE, grantee: other, verb: 'see',
      owner: OWNER, visibility: 'owned-compute', createdAt: '2026-09-14T00:00:00.000Z',
      actorKind: 'user', actorId: OWNER, onBehalfOf: OWNER,
    })
    await expect(f.registry.modules.nativeLogin.start({
      harness: 'codex', machineId: MACHINE, ownerUserId: other,
    })).rejects.toThrow('you do not have access to start login on this machine')
    expect(f.registry.modules.nativeLogin.attempt('codex', OWNER)).toEqual(attempt)
    expect(f.frames.filter((frame) => frame.type === 'spawn')).toHaveLength(1)
  })

  it('does not expose accounts.login to an admins agent through the daemon relay', async () => {
    const f = await fixture()
    const attempt = await f.start()
    expect(ACCOUNT_CONTRACTS.login.exposure).toEqual(['trpc'])
    await f.registry.gateway.routeDaemonFrame(MACHINE, {
      type: 'agentRelayRequest', requestId: 'native-login-agent', sessionId: attempt.sessionId,
      router: 'accounts', proc: 'login', input: { harness: 'claude-code', machineId: MACHINE },
    })
    await expect.poll(() => f.frames.find((frame) =>
      frame.type === 'agentRelayResult' && frame.requestId === 'native-login-agent',
    )).toMatchObject({ ok: false, error: 'accounts.login is not permitted via relay' })
    expect(f.frames.filter((frame) => frame.type === 'spawn')).toHaveLength(1)
  })
})
