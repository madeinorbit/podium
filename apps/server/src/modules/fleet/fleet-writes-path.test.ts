/**
 * THE FLEET'S WRITES ON THE ONE WRITE PATH (POD-6417, plan Task 16).
 *
 * Driven through the REAL composed server (`makeOracle`):
 *
 *  - the machine and repository writes are registered on the sync write entry
 *    point; `sync.submit` and the old routes (thin adapters) both reach them
 *    there, with provenance and a receipt, and a replay runs nothing;
 *  - the target check is the fleet gate, in its own words, before the handler
 *    and before the dedup (a revoked grant refuses a replay);
 *  - the work outside the database (the clients' broadcast, the bus, a daemon's
 *    retirement, the release feed) runs once after a commit and never after a
 *    rollback; the base-branch check asks the machine before the unit of work;
 *  - the folder picker's writes and apply-update are effect records;
 *  - the routes no shipped client calls are gone;
 *  - cloud and the repository refresh are plain commands, not synced writes.
 */

import {
  asMachineId,
  asMutationId,
  asUserId,
  firstAdminMemberId,
  type MachineId,
  type UserId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { appRouter } from '../../router'
import { spanOpen } from '../../store/executor/executor'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { envelope, expectAppliedOnPath, rowsOf, submit } from '../sync-write/outbox-test-support'
import { isTargetRefused } from '../sync-write/registry'
import { FOLDER_CREATE_KIND, FOLDER_RENAME_KIND, REPO_CREATE_KIND } from './folder-effects'
import { FLEET_SYNC_COMMANDS, type FleetSyncDeps, fleetTarget } from './sync-write'
import { FLEET_SUBMIT_ONLY } from './trpc'
import { MACHINE_UPDATE_KIND } from './update-effect'

afterEach(() => disposeOracles())

const OFFLINE = asMachineId('m-offline-6417')

const routerRecord = (name: string): Record<string, unknown> =>
  (appRouter as unknown as { _def: { record: Record<string, Record<string, unknown>> } })._def
    .record[name] ?? {}

/** Lets fire-and-forget after-commit steps run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/** The fixture, once its own attach-time work (inventory, broadcasts) has settled. */
const oracle = async () => {
  const o = await makeOracle({ offlineMachines: [{ id: OFFLINE, name: 'offline-6417' }] })
  await settle()
  return o
}

/** A member account that exists, so its role is read live. */
async function member(o: Oracle, id = 'usr_member_6417'): Promise<UserId> {
  const user = asUserId(id)
  await o.store.users.createUnclaimed({
    id: user,
    displayName: 'Member',
    email: null,
    role: 'member',
    createdAt: new Date().toISOString(),
    disabledAt: null,
  })
  return user
}

/** `manage` on a machine for `grantee`, as the owner's share writes it. */
async function grantManage(o: Oracle, machineId: MachineId, grantee: UserId) {
  await o.store.grants.upsert({
    resourceKind: 'machine',
    resourceId: machineId,
    grantee,
    verb: 'manage',
    owner: firstAdminMemberId(),
    visibility: 'owned-compute',
    createdAt: new Date().toISOString(),
    actorKind: 'user',
    actorId: firstAdminMemberId(),
    onBehalfOf: firstAdminMemberId(),
  })
}

const submitAs = async (o: Oracle, user: UserId, env: ReturnType<typeof envelope>) =>
  await o.reg.modules.syncWrite.submitDetailed(env, userCommandPrincipal(user, 'member'), 'trpc')

/** Make the handler's last read throw once its write has run: the unit rolls back. */
function failAfter(o: Oracle, method: 'renameMachine' | 'revokeMachine' | 'setUpdateChannel') {
  const machines = o.reg.modules.machines
  let wrote = false
  const original = machines[method].bind(machines) as (...args: unknown[]) => Promise<void>
  vi.spyOn(machines, method).mockImplementation((async (...args: unknown[]) => {
    await original(...args)
    wrote = true
  }) as never)
  const list = machines.listMachines.bind(machines)
  vi.spyOn(machines, 'listMachines').mockImplementation((async (
    ...args: Parameters<typeof list>
  ) => {
    if (wrote) throw new Error('forced rollback after the write')
    return await list(...args)
  }) as never)
}

describe('the fleet writes are on the sync write entry point', () => {
  it('registers every listed command', async () => {
    const o = await oracle()
    const names = o.reg.modules.syncWrite.registry.names()
    for (const name of FLEET_SYNC_COMMANDS) expect(names, name).toContain(name)
    // The effects and the plain commands are not synced writes of their own.
    for (const name of [
      'machines.applyUpdate',
      'machines.moveServer',
      'repos.cloneGithub',
      'repos.createFolder',
      'repos.createRepo',
      'repos.renameFolder',
      'discovery.refreshRepos',
      'discovery.scanMachine',
      'cloud.createMachine',
      'cloud.moveSession',
      'cloud.stop',
      'cloud.wake',
    ]) {
      expect(names, name).not.toContain(name)
    }
  })

  it('machines.rename arrives through sync.submit with provenance and a receipt; a replay runs nothing', async () => {
    const o = await oracle()
    const rename = vi.spyOn(o.reg.modules.machines, 'renameMachine')
    const { result } = await expectAppliedOnPath(
      o,
      envelope('machines.rename', { id: OFFLINE, name: 'renamed-6417' }, 'm-fleet-rename-1'),
      // The machine's feed projection is written in the unit, with provenance.
      { writes: true },
    )
    expect((result as { id: string; name: string }[]).find((m) => m.id === OFFLINE)?.name).toBe(
      'renamed-6417',
    )
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('repos.add and repos.setPrefix apply once, with a receipt covering the repo entity', async () => {
    const o = await oracle()
    const host = o.store.hostMachineId
    // The repo entity is the projection's reconcile, which carries no
    // provenance by design (POD-6272); the dedup record is the write's.
    const before = await o.reg.changeLedger.cursor()
    const { rows } = await expectAppliedOnPath(
      o,
      envelope('repos.add', { path: '/abs/repo-6417', machineId: host }, 'm-fleet-add-1'),
      { writes: false },
    )
    expect(rows).toEqual([])
    const repoRows = (await o.store.sync.changesSince(before)).filter((r) => r.entity === 'repo')
    expect(repoRows.length).toBeGreaterThan(0)
    expect(await o.store.sync.getAppliedMutation(asMutationId('m-fleet-add-1'))).toBeDefined()
    await expectAppliedOnPath(
      o,
      envelope(
        'repos.setPrefix',
        { path: '/abs/repo-6417', prefix: 'FLT', machineId: host },
        'm-fleet-prefix-1',
      ),
      { writes: false },
    )
    const row = (await o.store.repos.listRepos(host)).find((r) => r.path === '/abs/repo-6417')
    expect(row?.prefix).toBe('FLT')
  })

  it('repos.addMany registers the good paths and returns the refused ones, in one write', async () => {
    const o = await oracle()
    const host = o.store.hostMachineId
    const reply = await submit(
      o,
      envelope(
        'repos.addMany',
        { paths: ['relative/path', '/abs/many-6417'], machineId: host },
        'm-fleet-many-1',
      ),
    )
    expect(reply.outcome).toBe('applied')
    const result = (reply as { result: { failed: { path: string }[] } }).result
    expect(result.failed.map((f) => f.path)).toEqual(['relative/path'])
    expect(await o.store.repos.listRepoPaths(host)).toContain('/abs/many-6417')
  })

  it('the kept routes are adapters onto submit, as the tRPC transport', async () => {
    const o = await oracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const rows = await o.call.machines.rename({ id: OFFLINE, name: 'via-route' })
    expect(rows.find((m) => m.id === OFFLINE)?.name).toBe('via-route')
    expect(entry).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'machines.rename', version: 1 }),
      expect.anything(),
      'trpc',
    )
    const mutationId = entry.mock.calls[0]![0].mutationId
    expect((await rowsOf(o, mutationId)).length).toBeGreaterThan(0)
  })

  it('the routes no shipped client calls are deleted; the rest are still served', () => {
    const machines = routerRecord('machines')
    for (const name of FLEET_SUBMIT_ONLY) {
      expect(machines[name.split('.')[1]!], name).toBeUndefined()
    }
    for (const key of [
      'rename',
      'setUpdateChannel',
      'transferOwnership',
      'adopt',
      'supersede',
      'revoke',
    ]) {
      expect(machines[key], key).toBeDefined()
    }
    const repos = routerRecord('repos')
    for (const key of ['add', 'addMany', 'remove', 'setPrefix', 'setDefaultParentBranch']) {
      expect(repos[key], key).toBeDefined()
    }
  })
})

describe('the target check is the fleet gate, before the handler', () => {
  it('a member who cannot see the machine is refused as if it were absent, and nothing runs', async () => {
    const o = await oracle()
    const user = await member(o)
    const rename = vi.spyOn(o.reg.modules.machines, 'renameMachine')
    const { reply } = await submitAs(
      o,
      user,
      envelope('machines.rename', { id: OFFLINE, name: 'nope' }, 'm-fleet-refused-1'),
    )
    // The gate's own words, the ones a never-paired id gets (no existence oracle).
    expect(reply).toMatchObject({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found', message: expect.any(String) },
    })
    const absent = await submitAs(
      o,
      user,
      envelope('machines.rename', { id: 'm-never-paired', name: 'nope' }, 'm-fleet-refused-2'),
    )
    expect(absent.reply).toMatchObject({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found' },
    })
    expect(rename).not.toHaveBeenCalled()
  })

  it('a member holding `manage` may rename; once the grant is revoked a replay is refused', async () => {
    const o = await oracle()
    const user = await member(o)
    await grantManage(o, OFFLINE, user)
    const rename = vi.spyOn(o.reg.modules.machines, 'renameMachine')
    const env = envelope('machines.rename', { id: OFFLINE, name: 'by-member' }, 'm-fleet-grant-1')

    // `action: write` with the `member` floor: the coarse check admits the
    // member, and the machine verb decides the row.
    expect((await submitAs(o, user, env)).reply).toMatchObject({ outcome: 'applied' })
    await o.store.grants.remove('machine', OFFLINE, user, 'manage')
    const replay = await submitAs(o, user, env)
    expect(replay.reply.outcome).toBe('rejected')
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('a hub-only command is refused on a server that does not run the hub role', async () => {
    const o = await oracle()
    const deps: FleetSyncDeps = {
      modules: () => o.reg.modules,
      roleOf: async (user) => await o.store.users.roleOf(user),
      repos: () => {
        throw new Error('not asked')
      },
      store: () => o.store,
      servesHub: () => false,
    }
    const operator = userCommandPrincipal(firstAdminMemberId(), 'admin')
    const target = await fleetTarget(deps, 'machines.rename', { id: OFFLINE, name: 'x' }, operator)
    expect(isTargetRefused(target) && target.syncWriteRefused.kind).toBe('target-not-found')
    // A core command is still served there.
    const core = await fleetTarget(
      deps,
      'repos.remove',
      { path: '/abs/none', machineId: o.store.hostMachineId },
      operator,
    )
    expect(isTargetRefused(core)).toBe(false)
  })
})

describe('work outside the database runs once after the commit, never after a rollback', () => {
  it('rename: the bus and the clients hear it once after the commit, not after a rollback', async () => {
    const o = await oracle()
    const broadcast = vi.spyOn(o.reg.modules.machines, 'broadcastMachines')
    const heard: unknown[] = []
    o.reg.bus.on('machine.metadataChanged', (e) => heard.push(e))

    failAfter(o, 'renameMachine')
    await expect(
      submit(o, envelope('machines.rename', { id: OFFLINE, name: 'rolled-back' }, 'm-fleet-rb-1')),
    ).rejects.toThrow('forced rollback')
    await settle()
    expect(broadcast).not.toHaveBeenCalled()
    expect(heard).toEqual([])
    expect((await o.store.machines.getMachine(OFFLINE))?.name).not.toBe('rolled-back')

    vi.restoreAllMocks()
    const broadcastAgain = vi.spyOn(o.reg.modules.machines, 'broadcastMachines')
    await submit(o, envelope('machines.rename', { id: OFFLINE, name: 'committed' }, 'm-fleet-rb-2'))
    await settle()
    expect(broadcastAgain).toHaveBeenCalledTimes(1)
    expect(heard).toHaveLength(1)
  })

  it('revoke: the machine is retired once after the commit, not after a rollback', async () => {
    const o = await oracle()
    const retire = vi.spyOn(o.reg.modules.machines, 'retireIncarnation')

    failAfter(o, 'revokeMachine')
    await expect(
      submit(o, envelope('machines.revoke', { id: OFFLINE }, 'm-fleet-rv-1')),
    ).rejects.toThrow('forced rollback')
    await settle()
    expect(retire).not.toHaveBeenCalled()
    expect((await o.store.machines.getMachine(OFFLINE))?.revokedAt).toBeNull()

    vi.restoreAllMocks()
    const retireAgain = vi.spyOn(o.reg.modules.machines, 'retireIncarnation')
    await submit(o, envelope('machines.revoke', { id: OFFLINE }, 'm-fleet-rv-2'))
    await settle()
    expect(retireAgain).toHaveBeenCalledTimes(1)
    expect(retireAgain).toHaveBeenCalledWith(OFFLINE)
    expect((await o.store.machines.getMachine(OFFLINE))?.revokedAt).toEqual(expect.any(String))
  })

  it('setUpdateChannel: the release feed is asked once after the commit, not after a rollback', async () => {
    const o = await oracle()
    const refresh = vi.spyOn(o.reg.modules.updates, 'refreshTarget').mockResolvedValue(true)

    failAfter(o, 'setUpdateChannel')
    await expect(
      submit(
        o,
        envelope('machines.setUpdateChannel', { id: OFFLINE, channel: 'edge' }, 'm-fleet-ch-1'),
      ),
    ).rejects.toThrow('forced rollback')
    await settle()
    expect(refresh).not.toHaveBeenCalled()

    vi.restoreAllMocks()
    const refreshAgain = vi.spyOn(o.reg.modules.updates, 'refreshTarget').mockResolvedValue(true)
    await submit(
      o,
      envelope('machines.setUpdateChannel', { id: OFFLINE, channel: 'edge' }, 'm-fleet-ch-2'),
    )
    await settle()
    expect(refreshAgain).toHaveBeenCalledTimes(1)
  })

  it('setDefaultParentBranch asks the machine before the unit of work; a missing branch refuses', async () => {
    const o = await oracle()
    const host = o.store.hostMachineId
    await o.store.repos.addRepo('/abs/branches-6417', host)
    const store = vi.spyOn(o.store.repos, 'setRepoDefaultParentBranch')
    const asked: boolean[] = []
    vi.spyOn(o.reg.modules.rpc, 'repoOp').mockImplementation((async (
      _op: string,
      _path: string,
      input: { ref?: string },
    ) => {
      asked.push(spanOpen())
      return { ok: input.ref !== 'refs/heads/missing', output: '' }
    }) as never)

    const refused = await submit(
      o,
      envelope(
        'repos.setDefaultParentBranch',
        { path: '/abs/branches-6417', branch: 'missing', machineId: host },
        'm-fleet-br-1',
      ),
    )
    expect(refused).toMatchObject({ outcome: 'rejected', refusal: { kind: 'invalid' } })
    expect(store).not.toHaveBeenCalled()

    await expectAppliedOnPath(
      o,
      envelope(
        'repos.setDefaultParentBranch',
        { path: '/abs/branches-6417', branch: 'main', machineId: host },
        'm-fleet-br-2',
      ),
      { writes: false },
    )
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((open) => !open)).toBe(true)
    expect(store).toHaveBeenCalledTimes(1)
  })
})

describe('the folder picker and apply-update are effect records', () => {
  it('createFolder, createRepo and renameFolder create their records and answer their old shapes', async () => {
    const o = await oracle()
    const host = o.store.hostMachineId
    const created: string[] = []
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const inSpan: boolean[] = []
    vi.spyOn(o.reg.modules.rpc, 'dirOp').mockImplementation((async (
      op: string,
      _machine: MachineId,
      input: { parentPath: string; name: string },
    ) => {
      inSpan.push(spanOpen())
      created.push(op)
      return { path: `${input.parentPath}/${input.name}` }
    }) as never)

    expect(
      await o.call.repos.createFolder({ machineId: host, parentPath: '/abs/f', name: 'new' }),
    ).toEqual({ path: '/abs/f/new' })
    expect(
      (await o.call.repos.createRepo({ machineId: host, parentPath: '/abs/f', name: 'repo' })).path,
    ).toBe('/abs/f/repo')
    expect(
      await o.call.repos.renameFolder({
        machineId: host,
        parentPath: '/abs/f',
        currentName: 'new',
        name: 'renamed',
      }),
    ).toEqual({ path: '/abs/f/renamed' })

    expect(created).toEqual(['createFolder', 'createRepo', 'renameFolder'])
    expect(inSpan.every((open) => !open)).toBe(true)
    const kinds = entry.mock.calls
      .filter(([env]) => env.command === 'effects.create')
      .map(([env]) => (env.input as { kind: string }).kind)
    expect(kinds).toEqual([FOLDER_CREATE_KIND, REPO_CREATE_KIND, FOLDER_RENAME_KIND])
    // The new repository was registered by its record.
    expect(await o.store.repos.listRepoPaths(host)).toContain('/abs/f/repo')
  })

  it('a rename of a registered folder fails from its record with the old precondition', async () => {
    const o = await oracle()
    const host = o.store.hostMachineId
    await o.store.repos.addRepo('/abs/g/kept', host)
    const dirOp = vi.spyOn(o.reg.modules.rpc, 'dirOp')
    const error = await o.call.repos
      .renameFolder({ machineId: host, parentPath: '/abs/g', currentName: 'kept', name: 'moved' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TRPCError)
    expect((error as TRPCError).code).toBe('PRECONDITION_FAILED')
    expect((error as TRPCError).message).toContain('is registered in Podium')
    expect(dirOp).not.toHaveBeenCalled()
  })

  it('applyUpdate is a machine.update record: the feed and the grant run from it, outside the unit', async () => {
    const o = await oracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const inSpan: boolean[] = []
    vi.spyOn(o.reg.modules.updates, 'refreshTarget').mockImplementation(async () => {
      inSpan.push(spanOpen())
      return true
    })
    const grant = vi
      .spyOn(o.reg.modules.updates, 'authorizeMachine')
      .mockImplementation((async () => {
        inSpan.push(spanOpen())
        return { result: 'offline' }
      }) as never)

    const answer = await o.call.machines.applyUpdate({ id: OFFLINE })
    expect(answer.outcome).toEqual({ result: 'offline' })
    expect(grant).toHaveBeenCalledTimes(1)
    expect(inSpan).toEqual([false, false])
    expect(
      entry.mock.calls
        .filter(([env]) => env.command === 'effects.create')
        .map(([env]) => (env.input as { kind: string }).kind),
    ).toEqual([MACHINE_UPDATE_KIND])
  })
})

describe('cloud and the repository refresh are plain commands', () => {
  it('a cloud write is refused below its floor and answers the disabled provider honestly', async () => {
    const o = await oracle()
    const error = await o.call.cloud.stop({ id: 'rt-1' }).catch((e: unknown) => e)
    // No cloud provider on this deployment: a precondition, not a 500.
    expect((error as TRPCError).code).toBe('PRECONDITION_FAILED')
  })

  it('refreshRepos answers its snapshot through the plain entry', async () => {
    const o = await oracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const snapshot = await o.call.discovery.refreshRepos()
    expect(snapshot.machines.length).toBeGreaterThan(0)
    expect(entry).not.toHaveBeenCalled()
  })
})
