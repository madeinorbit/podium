/**
 * THE JOIN — the ten fleet contracts (L1, `@podium/commands`) paired with the
 * handlers beside them (L3), per ADR 3 D1 and POD-311's three-way split.
 *
 * A transport does not reach a handler; it reaches a CONTRACT by name, the
 * contract's schema validates the input, the contract's `serverRole` decides
 * whether this process serves the surface at all, and only then does the joined
 * handler run. An eleventh fleet command added to this table gets its role gate
 * and its validation because it declared them, not because whoever added it
 * remembered to attach a middleware.
 */

import {
  type AnyCommandContract,
  FLEET_CONTRACTS,
  type FleetContractName,
  type FleetServerRole,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import {
  discoveryRefreshReposHandler,
  discoveryScanFolderHandler,
  discoveryScanMachineHandler,
  type FleetHandler,
  machinePairingCodeHandler,
  machineRenameHandler,
  machineRevokeHandler,
  repoAddHandler,
  repoAddManyHandler,
  repoRemoveHandler,
  repoSetPrefixHandler,
} from './handlers'

/** One contract joined to the handler that implements it. */
export interface FleetCommand {
  readonly contract: AnyCommandContract & { readonly serverRole: FleetServerRole }
  // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by
  // construction; each entry's input type is pinned by its own contract and
  // checked at the handler declaration, and `never` here would make the table
  // untypeable rather than safer.
  readonly handler: FleetHandler<any, unknown>
}

/**
 * The joined table, keyed by the DOTTED WIRE NAME — unlike the workflow table,
 * which keys on a bare proc name because its eleven all live on one router.
 * These ten span three routers (`machines`, `repos`, `discovery`) and two of
 * them have a `scan`-ish sibling that is NOT in this family, so the router
 * prefix is part of the identity and dropping it would invite exactly the
 * collision that made `discovery.scan` (a CONVERSATION scan) look like a
 * member of this table.
 */
export const FLEET_COMMANDS = {
  'machines.rename': { contract: FLEET_CONTRACTS['machines.rename'], handler: machineRenameHandler },
  'machines.revoke': { contract: FLEET_CONTRACTS['machines.revoke'], handler: machineRevokeHandler },
  'machines.pairingCode': {
    contract: FLEET_CONTRACTS['machines.pairingCode'],
    handler: machinePairingCodeHandler,
  },
  'repos.add': { contract: FLEET_CONTRACTS['repos.add'], handler: repoAddHandler },
  'repos.addMany': { contract: FLEET_CONTRACTS['repos.addMany'], handler: repoAddManyHandler },
  'repos.remove': { contract: FLEET_CONTRACTS['repos.remove'], handler: repoRemoveHandler },
  'repos.setPrefix': { contract: FLEET_CONTRACTS['repos.setPrefix'], handler: repoSetPrefixHandler },
  'discovery.refreshRepos': {
    contract: FLEET_CONTRACTS['discovery.refreshRepos'],
    handler: discoveryRefreshReposHandler,
  },
  'discovery.scanFolder': {
    contract: FLEET_CONTRACTS['discovery.scanFolder'],
    handler: discoveryScanFolderHandler,
  },
  'discovery.scanMachine': {
    contract: FLEET_CONTRACTS['discovery.scanMachine'],
    handler: discoveryScanMachineHandler,
  },
} as const satisfies Record<FleetContractName, FleetCommand>

export type FleetCommandName = keyof typeof FLEET_COMMANDS

export const isFleetCommand = (name: string): name is FleetCommandName =>
  Object.hasOwn(FLEET_COMMANDS, name)

/**
 * ADR 3 D3, enforced rather than documented. Default-closed: an unknown name is
 * `false`, not "probably fine", so a typo at a call site removes a surface
 * loudly instead of opening one silently.
 */
export function isFleetCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isFleetCommand(name)) return false
  return FLEET_COMMANDS[name].contract.exposure.includes(transport)
}

/** The classification lint over the joined table — the same function the L1 test
 *  runs, so the gate cannot pass at L1 and be absent where the handlers live. */
export const fleetRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(FLEET_COMMANDS).map((c) => c.contract))

/** The dotted names this family serves on `transport`, in table order. */
export const fleetCommandsOn = (transport: TransportTag): FleetCommandName[] =>
  (Object.keys(FLEET_COMMANDS) as FleetCommandName[]).filter((n) =>
    isFleetCommandExposedOn(n, transport),
  )

/** The parsed-input type of one command, for the transport that builds it. */
export type FleetCommandInput<N extends FleetCommandName> = z.infer<
  (typeof FLEET_COMMANDS)[N]['contract']['input']
>
