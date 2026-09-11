/**
 * MACHINE FACTS, RESOLVED ONCE PER OPERATION (POD-3858).
 *
 * The first production loop profile after the config loader was cached put
 * `resolveUpdateChannel` and the `statSync` behind it at 14% and 11% of the
 * server's main thread. Neither is expensive; both were asked for once per
 * machine per session, by two code paths that only ever needed one answer:
 *
 *  - a session's login condition, resolved by building the WHOLE machine
 *    listing and then discarding every row but one, and
 *  - the listing itself, which resolved each machine's update channel once to
 *    report it and twice more so the update authority could name that
 *    machine's target and say why it had none.
 *
 * These tests pin the shape of the answer rather than its cost: the facts are
 * read from the record cache and the in-memory presence sets, the channel is
 * resolved once per call, and the update authority is asked by CHANNEL —
 * which is what it actually holds — so it never resolves a machine again on
 * the caller's behalf.
 */
import type { Inventory, MachineId, UpdateChannel } from '@podium/model'
import { asMachineId, asUserId } from '@podium/model'
import { describe, expect, test, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { type MachinesDeps, MachinesService } from './service'

const MACHINE = asMachineId('vmi')

/** A harness that is installed and NOT logged in — the one condition a started session reports. */
const LOGGED_OUT: Inventory = {
  os: 'linux',
  arch: 'x64',
  podiumVersion: '9.9.9',
  agents: [{ kind: 'claude-code', installed: true, version: '2.1.0', login: { state: 'out' } }],
  tools: [],
}

/**
 * `size` machines, each with a live daemon (so each is online and durably
 * records its `daemon` component) and the first one inventoried.
 */
async function fleet(
  size: number,
  deps: Partial<MachinesDeps> = {},
): Promise<{ svc: MachinesService; ids: MachineId[] }> {
  const store = await openTestStore(':memory:')
  const ids = [MACHINE, ...Array.from({ length: size - 1 }, (_, i) => asMachineId(`peer-${i}`))]
  for (const id of ids) {
    await store.machines.upsertMachine({
      id,
      name: `name-of-${id}`,
      hostname: `${id}.local`,
      tokenHash: 'x',
      ownerUserId: asUserId('user:sole'),
    })
  }
  const svc = new MachinesService({
    instanceId: 'default',
    store,
    hostMachineId: store.hostMachineId,
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: async () => [],
    ...deps,
  } as MachinesDeps)
  for (const id of ids) await svc.attach(id, () => {})
  await svc.recordInventory(MACHINE, LOGGED_OUT)
  return { svc, ids }
}

describe('machine facts (POD-3858)', () => {
  test('the login condition for one machine does not build the whole machine listing', async () => {
    const { svc } = await fleet(3)
    const listMachines = vi.spyOn(svc, 'listMachines')

    const condition = await svc.agentLoginCondition(MACHINE, 'claude-code')

    expect(condition).toBe('logged-out')
    expect(listMachines).not.toHaveBeenCalled()
  })

  test('a machine listing asks the update authority for a target by channel', async () => {
    // The authority publishes a target PER CHANNEL. Asking it per MACHINE made
    // it resolve the machine's channel again — twice, once for the version and
    // once for the reason there was none — for a fact the listing had already
    // worked out in order to report it.
    const asked: UpdateChannel[] = []
    const { svc } = await fleet(3, {
      fleetUpdateChannel: () => 'stable',
      channelTarget: (channel) => {
        asked.push(channel)
        return { version: `v-${channel}` }
      },
    })

    const listings = await svc.listMachines()

    expect(asked).toEqual(['stable', 'stable', 'stable'])
    expect(listings.map((l) => l.targetVersion)).toEqual(['v-stable', 'v-stable', 'v-stable'])
  })

  test('a machine listing resolves the fleet channel once, whatever the fleet size', async () => {
    const fleetUpdateChannel = vi.fn((): UpdateChannel => 'stable')
    const { svc } = await fleet(4, {
      fleetUpdateChannel,
      channelTarget: () => ({ version: 'v1' }),
    })

    await svc.listMachines()

    expect(fleetUpdateChannel).toHaveBeenCalledTimes(1)
  })

  test('a facts snapshot answers for every machine it was built from', async () => {
    const { svc, ids } = await fleet(3, { fleetUpdateChannel: () => 'stable' })

    const facts = await svc.factsSnapshot()

    expect(facts.loginCondition(MACHINE, 'claude-code')).toBe('logged-out')
    expect(facts.loginCondition(MACHINE, 'shell')).toBeUndefined()
    expect(ids.map((id) => facts.name(id))).toEqual(ids.map((id) => `name-of-${id}`))
    expect(ids.every((id) => facts.online(id))).toBe(true)
    expect(facts.channel(MACHINE)).toBe('stable')
  })

  test('a facts snapshot resolves the fleet channel once, whatever the fleet size', async () => {
    const fleetUpdateChannel = vi.fn((): UpdateChannel => 'stable')
    const { svc } = await fleet(4, { fleetUpdateChannel })

    await svc.factsSnapshot()

    expect(fleetUpdateChannel).toHaveBeenCalledTimes(1)
  })

  test('a facts snapshot says what it does not know, rather than guessing', async () => {
    // A snapshot is taken ONCE and then read per row, so a machine it was not
    // built from is a real case — a session whose machine row was removed. It
    // must not read as an online, named, logged-in machine.
    const { svc } = await fleet(2)
    const stranger = asMachineId('never-registered')

    const facts = await svc.factsSnapshot()

    expect(facts.online(stranger)).toBe(false)
    expect(facts.channel(stranger)).toBeUndefined()
    expect(facts.loginCondition(stranger, 'claude-code')).toBeUndefined()
    expect(facts.name(stranger)).toBe(stranger)
  })
})
