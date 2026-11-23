/**
 * THE FLEET'S WRITES ON THE SYNC WRITE ENTRY POINT (POD-6417, plan Task 16).
 *
 * The machine and repository writes that are data edits: renames, the service
 * assignment, the update channel, sharing, custody (transfer, adopt,
 * supersede, revoke), and the repository registrations. Each is registered with
 * its contract, a target check and its handler; the entry point does the rest
 * (principal, coarse check, parse, dedup, provenance, one unit of work, the
 * receipt).
 *
 * THE TARGET CHECK is the fleet gate (`authz.ts`, POD-1079) as it was: the
 * contract's role floor against the account's role now, then the machine verb
 * against the machine's owner and grants, and the owner-or-admin rules. Its
 * refusals keep their words and codes (`refuseTarget`): the gate already
 * answers an invisible machine exactly as an absent one. A command declared for
 * the hub role is refused on a server that does not run it, as its route 404ed.
 *
 * WORK OUTSIDE THE DATABASE runs after the commit (ADR 2 D10): the daemon push
 * of an assignment, retiring a revoked or superseded machine's transports, the
 * release-feed refresh of a channel change and the clients' `machinesChanged`
 * (`machines/service.ts`, `machines/enrollment.ts`). The one daemon call that
 * DECIDES the write, whether a repository's base branch exists, is part of the
 * target: it is asked before the unit of work, and a missing branch refuses.
 *
 * Not here: the writes that are effects on a machine (scans, clone, folder and
 * repository creation, apply update, server move) are effect records, and their
 * routes create them through `sync.submit` (`discovery-effects.ts`,
 * `folder-effects.ts`, `update-effect.ts`, `server-move-effect.ts`).
 */

import {
  isSyncedFleetCommand,
  SYNCED_FLEET_COMMANDS,
  type SyncedFleetCommand,
} from '@podium/commands/fleet-synced'
import { describeError } from '@podium/logger'
import type { MachineId, UserId, UserRole } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { RepoRegistry } from '../../repo-registry'
import type { SessionStore } from '../../store'
import { SyncWriteRefused } from '../sync-write/entry'
import { trpcErrorRefusal } from '../sync-write/family'
import {
  NO_TARGET,
  refuseTarget,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from '../sync-write/registry'
import { type FleetAuthzDeps, fleetAuthzDepsFor, fleetAuthzFailure } from './authz'
import type { FleetSyncHandler, FleetWriteEnv } from './handlers'
import { FLEET_COMMANDS } from './registry'

/** Every fleet command on the entry point, by wire name: the clients' list. */
export const FLEET_SYNC_COMMANDS = SYNCED_FLEET_COMMANDS

export type FleetSyncCommandName = SyncedFleetCommand

export const isFleetSyncCommand = isSyncedFleetCommand

export interface FleetSyncDeps {
  /** The composed modules, read per call. */
  modules(): RegistryModules
  roleOf(user: UserId): Promise<UserRole | undefined>
  /** The repository registry over the store (stateless). */
  repos(): RepoRegistry
  store(): SessionStore
  /** Whether this server runs the hub role (`roles.ts`). */
  servesHub(): boolean
}

/** The refusal a node gives a hub-only command: the one its route gave. */
const NOT_ON_THIS_SERVER = 'not available: this server does not run the hub role'

async function authzFor(deps: FleetSyncDeps, principal: CommandPrincipal): Promise<FleetAuthzDeps> {
  const user = onBehalfOfUser(principal)
  const role = user === null ? undefined : await deps.roleOf(user)
  return await fleetAuthzDepsFor(deps.modules().machines, principal, role)
}

/** A gate refusal (a `TRPCError`) as the target's answer, in its own words. */
const refusedAs = (error: TRPCError): SyncWriteTarget =>
  refuseTarget(trpcErrorRefusal(error) ?? { kind: 'unauthorized' })

export async function fleetTarget(
  deps: FleetSyncDeps,
  name: FleetSyncCommandName,
  input: unknown,
  principal: CommandPrincipal,
): Promise<SyncWriteTarget> {
  const { contract } = FLEET_COMMANDS[name]
  if (contract.serverRole === 'hub' && !deps.servesHub()) {
    return refusedAs(new TRPCError({ code: 'NOT_FOUND', message: NOT_ON_THIS_SERVER }))
  }
  const refusal = await fleetAuthzFailure(name, input, await authzFor(deps, principal))
  if (refusal !== undefined) return refusedAs(refusal)
  if (name === 'repos.setDefaultParentBranch') {
    // The branch is part of what the write names: asked of the machine that
    // holds the checkout, before the unit of work (POD-6417).
    const { path, branch, machineId } = input as {
      path: string
      branch: string | null
      machineId?: MachineId
    }
    try {
      await deps.repos().verifyDefaultParentBranch(path, branch, machineId)
    } catch (error) {
      return refusedAs(new TRPCError({ code: 'BAD_REQUEST', message: describeError(error) }))
    }
  }
  return NO_TARGET
}

export function registerFleetCommands(registry: SyncWriteRegistry, deps: FleetSyncDeps): void {
  for (const name of FLEET_SYNC_COMMANDS) {
    const { contract, handler } = FLEET_COMMANDS[name]
    const run = handler as FleetSyncHandler<unknown, unknown>
    registry.register({
      contract,
      target: async (input, { principal }) => await fleetTarget(deps, name, input, principal),
      handle: async (ctx, input) => {
        const env: FleetWriteEnv = {
          modules: deps.modules(),
          principal: ctx.principal,
          authz: await authzFor(deps, ctx.principal),
          repos: deps.repos(),
          store: deps.store(),
          writer: ctx.ledger,
        }
        try {
          return await run({ env, input })
        } catch (error) {
          // The handler's own 4xx (a refused transfer, an invalid prefix) is a
          // definitive refusal with its message; anything else is a failure.
          const refusal = trpcErrorRefusal(error)
          if (refusal === undefined) throw error
          throw new SyncWriteRefused(refusal, { cause: error })
        }
      },
    })
  }
}
