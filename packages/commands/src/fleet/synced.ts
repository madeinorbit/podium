/**
 * THE FLEET WRITES ON THE SYNC WRITE ENTRY POINT (ADR 12 D2, POD-6417).
 *
 * One list for the server, which registers each of these on `sync.submit`
 * (`apps/server/src/modules/fleet/sync-write.ts`), and for the clients, which
 * send them there. The fleet's other writes are effects on a machine (scans,
 * clone, folder and repository creation, apply update, server move: their
 * routes create effect records) or plain commands (`discovery.refreshRepos`,
 * pairing), and keep their routes.
 *
 * Beside the contracts rather than in client-core, so the web, the CLI and any
 * other client take it from one place, without loading the contracts.
 */

import { type SyncSubmitTransport, writesThroughSubmit } from '@podium/protocol'
import type { FleetContractName } from './contracts'

export const SYNCED_FLEET_COMMANDS = [
  'machines.setAssignment',
  'machines.share',
  'machines.unshare',
  'machines.transferOwnership',
  'machines.adopt',
  'machines.supersede',
  'machines.revoke',
  'repos.add',
  'repos.addMany',
  'repos.remove',
  'repos.setPrefix',
  'repos.setDefaultParentBranch',
] as const satisfies readonly FleetContractName[]

export type SyncedFleetCommand = (typeof SYNCED_FLEET_COMMANDS)[number]

export const isSyncedFleetCommand = (name: string): name is SyncedFleetCommand =>
  (SYNCED_FLEET_COMMANDS as readonly string[]).includes(name)

/**
 * A client's `machines` procedures with the listed writes sent on `sync.submit`:
 * `machineWrites(trpc).revoke.mutate(input)` in place of
 * `trpc.machines.revoke.mutate(input)`, same procedures, same types.
 * LEGACY(remove-after: 2027-03): an older server takes each command's own route.
 */
export function machineWrites<C extends { readonly machines: object }>(client: C): C['machines'] {
  return writesThroughSubmit(
    client as unknown as SyncSubmitTransport,
    client.machines,
    'machines',
    (proc) => isSyncedFleetCommand(`machines.${proc}`),
  )
}

/** {@link machineWrites} for the `repos` procedures. */
export function repoWrites<C extends { readonly repos: object }>(client: C): C['repos'] {
  return writesThroughSubmit(
    client as unknown as SyncSubmitTransport,
    client.repos,
    'repos',
    (proc) => isSyncedFleetCommand(`repos.${proc}`),
  )
}
