/**
 * A MACHINE'S SPEC AS A GENERIC RECORD (ADR 12 D3, POD-6644).
 *
 * The `machine` record's two spec fields are its name and its update-channel
 * pin, each a field-LWW group written by its owner or an admin (`manage`, the
 * fleet gate's own check, as `machines.rename` and `machines.setUpdateChannel`
 * did). The machines service writes the row and its records on the command's
 * own writer, so the change carries the command's provenance and the device
 * that queued it confirms by receipt. A channel change also asks the release
 * feed for the channel's target, after the commit (POD-6417).
 */

import { MACHINE_RECORD } from '@podium/commands'
import { asMachineId, resolveMachineChannel, type UpdateChannel } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { SessionStore } from '../../store'
import { fleetAuthzDepsFor, machineRefusal, roleSatisfiesFloor } from '../fleet/authz'
import { SyncWriteRefused } from '../sync-write/entry'
import { trpcErrorRefusal } from '../sync-write/family'
import { NO_TARGET, refuseTarget, type SyncWriteRegistry } from '../sync-write/registry'
import { registerRecordKind } from './generic'

export interface MachineRecordDeps {
  modules(): RegistryModules
  store(): Pick<SessionStore, 'users'>
}

/** A service refusal (an unknown or revoked machine) as the entry point's. */
async function refusing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const refusal =
      error instanceof TRPCError
        ? trpcErrorRefusal(error)
        : error instanceof Error && /unknown or revoked machine/.test(error.message)
          ? ({ kind: 'target-not-found' } as const)
          : undefined
    if (refusal === undefined) throw error
    throw new SyncWriteRefused(refusal, { cause: error })
  }
}

export function registerMachineRecord(registry: SyncWriteRegistry, deps: MachineRecordDeps): void {
  registerRecordKind(registry, MACHINE_RECORD, {
    // The fleet gate: a member floor, then `manage` on this machine. An
    // invisible machine is refused exactly as an unknown one.
    target: async (_op, id, { principal }) => {
      if (principal.kind === 'system') return undefined
      const user = onBehalfOfUser(principal)
      const role = user === null ? undefined : await deps.store().users.roleOf(user)
      if (!roleSatisfiesFloor(role, 'member')) return undefined
      const authz = await fleetAuthzDepsFor(deps.modules().machines, principal, role)
      const refusal = await machineRefusal(asMachineId(id), 'manage', authz)
      // The gate decided; there is nothing left for the entry point to scope.
      if (refusal === undefined) return NO_TARGET
      return refuseTarget(trpcErrorRefusal(refusal) ?? { kind: 'unauthorized' })
    },
    edit: async (ctx, id, patch) => {
      const machines = deps.modules().machines
      const machineId = asMachineId(id)
      if (typeof patch.name === 'string') {
        await refusing(async () => await machines.renameMachine(machineId, patch.name as string, ctx.ledger))
      }
      if (patch.updateChannelOverride !== undefined) {
        const pin = patch.updateChannelOverride as UpdateChannel | null
        await refusing(async () => await machines.setUpdateChannel(machineId, pin, ctx.ledger))
        // The channel the machine ACTUALLY lands on, which after a clear is the
        // fleet default (POD-1882), asked of the release feed once committed.
        const updates = deps.modules().updates
        const channel = resolveMachineChannel(pin, updates.fleetDefaultChannel())
        ctx.afterCommit(async () => {
          await updates.refreshTarget(channel)
          await machines.publishMachines([machineId])
        }, 'machines:channel:refresh-target')
      }
      return { ok: true }
    },
  })
}
