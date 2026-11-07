/**
 * The fleet commands on the PLAIN path (ADR 12 D8, POD-6417; registrations,
 * POD-6593). `discovery.refreshRepos` is the boot's repository and machine
 * snapshot: a read of what the machines' daemons report, whose only write is the
 * origins they reported (the server's own write, `RepoRegistry.scanReposAll`).
 * The daemon fan-out runs outside any unit of work, and nothing is recorded for
 * a replay. Its route stays: the shipped mobile app calls it.
 *
 * The derived fleet gate (`authz.ts`) runs after the parse, in the handler, as
 * it did on the route.
 */

import { FLEET_CONTRACTS } from '@podium/commands'
import type { PlainContractRegistration } from '../plain-command/registry'
import { trpcRequest } from '../plain-command/registry'
import { fleetAuthzDeps, fleetAuthzFailure } from './authz'
import type { FleetHandler, FleetPorts } from './handlers'
import { FLEET_COMMANDS, type FleetCommandName } from './registry'

export const FLEET_PLAIN_COMMANDS = [
  'discovery.refreshRepos',
] as const satisfies readonly FleetCommandName[]

/** A plain fleet handler reaches no composition port; asking for one is a fault. */
const NO_PORTS: FleetPorts = {
  joinCommand: () => {
    throw new Error('fleet: a plain fleet command has no join-command port')
  },
}

export const FLEET_PLAIN_REGISTRATIONS: readonly PlainContractRegistration[] =
  FLEET_PLAIN_COMMANDS.map((name) => {
    const run = FLEET_COMMANDS[name].handler as FleetHandler<unknown, unknown>
    return {
      contract: FLEET_CONTRACTS[name],
      handle: async (ctx, input) => {
        const request = trpcRequest(ctx)
        const refusal = await fleetAuthzFailure(name, input, await fleetAuthzDeps(request))
        if (refusal) throw refusal
        return await run({ ctx: request, input, ports: NO_PORTS })
      },
    }
  })
