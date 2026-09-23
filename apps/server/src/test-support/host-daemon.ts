/**
 * ATTACHING THE HOST'S FAKE DAEMON AS A MACHINE THAT MAY RUN AGENTS (POD-4631).
 *
 * Since 2b803efb5 ("Refuse implicit server machine placement") the server never
 * invents a target: `MachinesService.defaultMachine` picks only a machine whose
 * row is assigned `agentExecution` AND has a daemon attached, and otherwise
 * refuses with "no assigned and available daemon". A test store has no machine
 * row at all, so a fixture that only calls `gateway.attachDaemon(hostMachineId)`
 * has a socket but no assigned machine, and every `createSession` in it dies in
 * setup. In production the row comes from setup enrollment; this is that row.
 *
 * An existing row is left alone: a test that wrote its own machine row (a name,
 * an inventory, a deliberately unassigned machine) keeps exactly what it wrote.
 *
 * The same commit resolves an issue's repo only through a machine that REPORTED
 * it ("no reporting machine for repo path"), so `repos` are registered on the
 * host the way its daemon's repo scan would register them.
 */

import { firstAdminMemberId } from '@podium/model'
import type { DaemonControlPeer } from '../gateway/daemon-ports'
import type { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'

/** Give the store's host machine the row setup enrollment would: owned, server + agent execution. */
export async function assignHostMachine(store: SessionStore): Promise<void> {
  if (await store.machines.getMachine(store.hostMachineId)) return
  await store.machines.upsertMachine({
    id: store.hostMachineId,
    name: 'Host',
    hostname: 'test',
    tokenHash: 'test',
    ownerUserId: await firstAdminMemberId(store),
    assignment: { server: true, agentExecution: true },
  })
}

/** Attach a fake daemon for the host machine, registering the machine (and any `repos` it reports) first. */
export async function attachHostDaemon(
  registry: SessionRegistry,
  transport: DaemonControlPeer = () => {},
  opts: { repos?: readonly string[] } = {},
): Promise<void> {
  const store = registry.sessionStore
  await assignHostMachine(store)
  for (const path of opts.repos ?? []) await store.repos.addRepo(path, store.hostMachineId)
  await registry.gateway.attachDaemon(store.hostMachineId, transport)
}
