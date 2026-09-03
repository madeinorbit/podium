/**
 * THE GUARD IS AT THE ACTION, NOT THE PICKER (POD-2700).
 *
 * The reported failure was a repo screen pinned to the server-only coordinator.
 * Filtering the dropdown fixes the screen; it does not fix the hole, because a
 * stale tab, a CLI, or a raw tRPC call reaches the same RPC with the same
 * machine id and the row lands anyway. So these tests call the actions
 * DIRECTLY, with a machine that structurally cannot do the job, and assert both
 * halves of the evidence standard:
 *
 *   1. it refuses, and
 *   2. it refuses FOR THAT REASON — the message names the machine and says it
 *      runs no daemon, rather than dying of some incidental error that would
 *      also fail on a perfectly capable machine.
 *
 * The second half is the one worth writing down. A test that only asserts
 * `rejects` passes just as happily when the guard is deleted and the call dies
 * of "no daemon answered" 35 seconds later, which is precisely the confusing
 * failure this work replaces.
 */
import { asMachineId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'
import { openTestStore } from './test-support/open-test-store'

/**
 * A fleet with exactly the shape of the sandbox that broke: a coordinator that
 * runs the server and no daemon, and one ordinary machine that runs a daemon.
 */
function fleet() {
  const store = openTestStore(':memory:')
  const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
  // The coordinator row, stamped `server` by boot exactly as production does.
  const coordinator = asMachineId(registry.modules.machines.ensureHostMachine('source'))
  store.machines.upsertMachine({
    id: 'laptop',
    name: 'mango',
    hostname: 'mango.local',
    tokenHash: 'h',
    ownerUserId: asUserId('user:sole'),
  })
  const laptop = asMachineId('laptop')
  // A daemon attaching is what records the durable `daemon` component.
  // Held so a test can drop exactly this socket: `detach` ignores a send that is
  // not the registered one (a superseded socket must not evict a fresh one).
  const laptopSocket = (): void => {}
  registry.gateway.attachDaemon(laptop, laptopSocket)
  registry.modules.machines.invalidateMachineCache()
  const repos = new RepoRegistry(registry, store)
  const superagent = SuperagentService.create(registry.modules, repos, store)
  return {
    registry,
    repos,
    coordinator,
    laptop,
    /** Take the laptop's daemon offline WITHOUT retracting its component. */
    dropLaptopDaemon: (): void => {
      registry.modules.machines.detach(laptop, laptopSocket)
      registry.modules.machines.invalidateMachineCache()
    },
    call: appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability: OPERATOR,
      principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
    }),
  }
}

/** The refusal must name the machine AND the axis — see the header. */
function expectNoDaemonRefusal(error: unknown, name: string): void {
  const message = error instanceof Error ? error.message : String(error)
  expect(message).toContain(name)
  expect(message).toContain('runs no Podium daemon')
}

describe('the component fact', () => {
  it('marks the coordinator server-only and the daemon host repo-capable', async () => {
    const { call, coordinator, laptop } = fleet()
    const machines = await call.machines.list()
    expect(machines.find((m) => m.id === coordinator)?.components).toEqual(['server'])
    expect(machines.find((m) => m.id === laptop)?.components).toEqual(['daemon'])
  })

  it('is additive: a coordinator that also runs a daemon keeps both', () => {
    const { registry, coordinator } = fleet()
    registry.gateway.attachDaemon(coordinator, () => {})
    registry.modules.machines.invalidateMachineCache()
    const machine = registry.modules.machines.listMachines().find((m) => m.id === coordinator)
    expect(machine?.components).toEqual(['server', 'daemon'])
    // And it is then perfectly able to host a repo — the fact is about the box,
    // not about being the coordinator.
    expect(() => registry.modules.machines.requireRepoHostStructure(coordinator)).not.toThrow()
  })
})

describe('repo actions refuse a machine that runs no daemon', () => {
  it('repos.add refuses the coordinator, and says why', async () => {
    const { call, coordinator } = fleet()
    await expect(
      call.repos.add({ path: '/home/mgw/src/thing', machineId: coordinator }),
    ).rejects.toThrow(/runs no Podium daemon/)
    try {
      await call.repos.add({ path: '/home/mgw/src/thing', machineId: coordinator })
      expect.unreachable('repos.add accepted the server-only coordinator')
    } catch (error) {
      expectNoDaemonRefusal(error, 'source')
    }
  })

  it('repos.add still accepts a machine that runs a daemon, ONLINE OR NOT', async () => {
    const { call, laptop, registry, dropLaptopDaemon } = fleet()
    await call.repos.add({ path: '/home/mgw/src/thing', machineId: laptop })
    expect(registry.sessionStore.repos.listRepoPaths(laptop)).toContain('/home/mgw/src/thing')
    // The gate that matters is DURABLE, not live: dropping the socket must not
    // retract a repo host, or "offline" and "incapable" have been collapsed again.
    dropLaptopDaemon()
    expect(registry.modules.machines.hasDaemon(laptop)).toBe(false)
    await call.repos.add({ path: '/home/mgw/src/other', machineId: laptop })
    expect(registry.sessionStore.repos.listRepoPaths(laptop)).toContain('/home/mgw/src/other')
  })

  it('repos.addMany reports the refusal per path rather than swallowing it', async () => {
    const { call, coordinator } = fleet()
    const result = await call.repos.addMany({ paths: ['/a/one', '/a/two'], machineId: coordinator })
    expect(result.failed).toHaveLength(2)
    expectNoDaemonRefusal(new Error(result.failed[0]?.message ?? ''), 'source')
  })

  it('repos.browse refuses the coordinator instead of timing out on a daemon that is not there', async () => {
    const { call, coordinator } = fleet()
    try {
      await call.repos.browse({ machineId: coordinator })
      expect.unreachable('repos.browse walked a machine with no daemon')
    } catch (error) {
      expectNoDaemonRefusal(error, 'source')
    }
  })
})

describe('issue homing refuses a machine that can never hold the worktree', () => {
  it('issues.create refuses to home an issue on the coordinator', async () => {
    const { registry, coordinator, repos } = fleet()
    await repos.add('/home/mgw/src/thing', asMachineId('laptop'))
    expect(() =>
      registry.modules.issues.create({
        title: 'homed wrongly',
        repoPath: '/home/mgw/src/thing',
        machineId: coordinator,
        startNow: false,
      }),
    ).toThrow(/runs no Podium daemon/)
  })
})

describe('offline is not incapable', () => {
  it('an offline daemon host is refused for a LIVE action with different words', () => {
    const { registry, laptop, coordinator, dropLaptopDaemon } = fleet()
    dropLaptopDaemon()
    const machines = registry.modules.machines
    // Same requirement, same call, two machines — and two different sentences.
    let offlineMessage = ''
    let incapableMessage = ''
    try {
      machines.requireRepoHost(laptop)
    } catch (e) {
      offlineMessage = e instanceof Error ? e.message : String(e)
    }
    try {
      machines.requireRepoHost(coordinator)
    } catch (e) {
      incapableMessage = e instanceof Error ? e.message : String(e)
    }
    expect(offlineMessage).toContain('offline')
    expect(offlineMessage).not.toContain('runs no Podium daemon')
    expect(incapableMessage).toContain('runs no Podium daemon')
    expect(incapableMessage).not.toContain('offline')
  })
})
