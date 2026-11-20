import { asMachineId, asThreadId, BUILTIN_HARNESS_KINDS, firstAdminMemberId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { MachineHomeUnavailableError } from '../machines/service'
import { SuperagentService } from './service'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

async function harness(homePath?: string) {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  const machineId = asMachineId('remote-machine')
  await registry.sessionStore.machines.upsertMachine({
    id: machineId,
    name: 'Remote laptop',
    hostname: 'remote-machine',
    tokenHash: 'test',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  const frames: ControlMessage[] = []
  const peer = (frame: ControlMessage) => {
    frames.push(frame)
  }
  await registry.gateway.attachDaemon(machineId, peer)
  const inventory = {
    os: 'win32' as const,
    arch: 'x64' as const,
    ...(homePath ? { homePath } : {}),
    agents: BUILTIN_HARNESS_KINDS.map((kind) => ({
      kind,
      installed: true,
      login: { state: 'in' as const },
    })),
    tools: [],
  }
  await registry.gateway.routeDaemonFrame(machineId, {
    type: 'inventoryReport',
    machineId,
    inventory,
  })
  const service = await SuperagentService.create(
    registry.modules,
    { list: async () => [] },
    registry.sessionStore,
  )
  const start = () =>
    service.ensureSession(registry.modules.superagentBridgeWriter, {
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
    })
  const spawns = () => frames.filter((frame) => frame.type === 'spawn')
  return { registry, machineId, peer, inventory, service, start, spawns }
}

describe('assistant target machine home', () => {
  it.each([
    'C:\\Users\\u',
    '/Users/u',
  ])('stores and spawns a global thread in the remote home: %s', async (homePath) => {
    const h = await harness(homePath)
    expect(h.machineId).not.toBe(h.registry.sessionStore.hostMachineId)
    const { podiumSessionId } = await h.start()
    expect(h.spawns()).toEqual([
      expect.objectContaining({ sessionId: podiumSessionId, cwd: homePath }),
    ])
    expect(await h.registry.sessionStore.sessions.getSession(podiumSessionId)).toMatchObject({
      machineId: h.machineId,
      cwd: homePath,
    })
    expect(
      (await h.registry.sessionStore.machines.getMachine(h.machineId))?.inventory?.homePath,
    ).toBe(homePath)
  })

  it('refuses an older daemon before creating a session or sending a spawn', async () => {
    const h = await harness()
    const started = h.start()
    await expect(started).rejects.toBeInstanceOf(MachineHomeUnavailableError)
    await expect(started).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      reason: 'home-unreported',
      machineId: h.machineId,
      message: "home directory is unknown — update the daemon on 'Remote laptop' and retry",
    })
    expect(h.spawns()).toEqual([])
    expect(
      (await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.podiumSessionId,
    ).toBeFalsy()
  })

  it('rejects an offline destination with a stored home and never queues a new spawn', async () => {
    const h = await harness('/Users/u')
    const { podiumSessionId } = await h.start()
    await h.registry.sessionStore.superagent.updateSuperagentThreadBinding('global', {
      agentKind: 'codex',
      harnessSessionId: 'conversation-1',
    })
    h.registry.gateway.detachDaemon(h.machineId, h.peer)
    const opened = h.service.openInTerminal({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
    })
    await expect(opened).rejects.toBeInstanceOf(MachineHomeUnavailableError)
    await expect(opened).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      reason: 'offline',
      machineId: h.machineId,
      message: "machine 'Remote laptop' is offline — reconnect it and retry",
    })
    // The destination's stored home is still present; its current link is authoritative.
    expect(
      (await h.registry.sessionStore.machines.getMachine(h.machineId))?.inventory?.homePath,
    ).toBe('/Users/u')
    expect(h.spawns()).toHaveLength(1)
    expect(await h.registry.sessionStore.sessions.getSession(podiumSessionId)).toMatchObject({
      machineId: h.machineId,
    })
    await h.registry.gateway.attachDaemon(h.machineId, h.peer)
    expect(h.spawns()).toHaveLength(1)
  })

  it('does not reuse a previous connection home before the new daemon reports', async () => {
    const h = await harness('/Users/u')
    h.registry.gateway.detachDaemon(h.machineId, h.peer)
    await h.registry.gateway.attachDaemon(h.machineId, h.peer)
    await expect(h.start()).rejects.toMatchObject({
      name: 'MachineHomeUnavailableError',
      reason: 'home-unreported',
      machineId: h.machineId,
    })
    expect(h.spawns()).toEqual([])
    await h.registry.gateway.routeDaemonFrame(h.machineId, {
      type: 'inventoryReport',
      machineId: h.machineId,
      inventory: { ...h.inventory, homePath: '/Users/new-user' },
    })
    await h.start()
    expect(h.spawns()).toEqual([expect.objectContaining({ cwd: '/Users/new-user' })])
  })

  it('pins the chosen machine when another machine reports a repo at the same home path', async () => {
    const homePath = '/Users/u'
    const h = await harness(homePath)
    const other = asMachineId('second-machine')
    await h.registry.sessionStore.machines.upsertMachine({
      id: other,
      name: 'Second laptop',
      hostname: 'second-machine',
      tokenHash: 'test',
      ownerUserId: firstAdminMemberId(),
      assignment: { server: false, agentExecution: true },
    })
    await h.registry.gateway.attachDaemon(other, () => {})
    await h.registry.gateway.routeDaemonFrame(other, {
      type: 'inventoryReport',
      machineId: other,
      inventory: { ...h.inventory, homePath },
    })
    await h.registry.sessionStore.repos.addRepo(homePath, other)
    expect(await h.registry.modules.machines.defaultMachine()).toBe(h.machineId)
    expect(await h.registry.modules.machines.resolveMachine(undefined, homePath)).toBe(other)
    const { podiumSessionId } = await h.start()
    expect(await h.registry.sessionStore.sessions.getSession(podiumSessionId)).toMatchObject({
      machineId: h.machineId,
      cwd: homePath,
    })
    expect(h.spawns()).toEqual([
      expect.objectContaining({ sessionId: podiumSessionId, cwd: homePath }),
    ])
  })
})
