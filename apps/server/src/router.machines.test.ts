import { describe, expect, it } from 'vitest'
import { PairingManager } from './hub/pairing'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SessionStore } from './store'
import { SuperagentService } from './modules/superagent'

function machineCaller() {
  const store = new SessionStore(':memory:')
  // Pre-register a machine so listMachines returns it
  store.machines.upsertMachine({ id: 'm1', name: 'machine-one', hostname: 'host-one', tokenHash: 'h1' })
  // Pairing is a hub-role capability, injected the way server assembly does it.
  const registry = new SessionRegistry(store, undefined, { pairing: new PairingManager() })
  registry.ensureLocalMachine()
  registry.attachDaemon('local', () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
  return {
    registry,
    call: appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR }),
  }
}

describe('machines router', () => {
  it('machines.list returns registered machines', async () => {
    const { call } = machineCaller()
    const machines = await call.machines.list()
    const m1 = machines.find((m) => m.id === 'm1')
    expect(m1).toBeDefined()
    expect(m1?.name).toBe('machine-one')
    expect(m1?.hostname).toBe('host-one')
    // m1 daemon not attached, so online = false
    expect(m1?.online).toBe(false)
  })

  it('machines.rename changes the name and returns the updated list', async () => {
    const { call } = machineCaller()
    const result = await call.machines.rename({ id: 'm1', name: 'renamed-machine' })
    const m1 = result.find((m) => m.id === 'm1')
    expect(m1?.name).toBe('renamed-machine')
  })

  it('machines.rename enforces min=1 max=80 on name', async () => {
    const { call } = machineCaller()
    await expect(call.machines.rename({ id: 'm1', name: '' })).rejects.toThrow()
    await expect(call.machines.rename({ id: 'm1', name: 'x'.repeat(81) })).rejects.toThrow()
  })

  it('machines.revoke removes the machine from the list', async () => {
    const { call } = machineCaller()
    const before = await call.machines.list()
    expect(before.find((m) => m.id === 'm1')).toBeDefined()
    const after = await call.machines.revoke({ id: 'm1' })
    expect(after.find((m) => m.id === 'm1')).toBeUndefined()
  })

  it('machines.pairingCode returns a non-empty code string', async () => {
    const { call } = machineCaller()
    const result = await call.machines.pairingCode()
    expect(result).toHaveProperty('code')
    expect(typeof result.code).toBe('string')
    expect(result.code.length).toBeGreaterThan(0)
  })
})

describe('sessions.create with machineId', () => {
  it('sessions.create accepts and forwards machineId', async () => {
    const store = new SessionStore(':memory:')
    store.machines.upsertMachine({ id: 'm2', name: 'machine-two', hostname: 'host-two', tokenHash: 'h2' })
    const registry = new SessionRegistry(store)
    registry.attachDaemon('m2', () => {})
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
    const call = appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR })

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
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store)
    registry.ensureLocalMachine()
    registry.attachDaemon('local', () => {})
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
    const call = appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR })

    const { sessionId } = await call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/home/test',
    })

    const list = await call.sessions.list()
    expect(list.find((s) => s.sessionId === sessionId)).toBeDefined()
  })
})
