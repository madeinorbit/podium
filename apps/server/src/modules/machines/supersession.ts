import type { MachineId, UserId } from '@podium/model'
import { type EnrollmentHost, type MachineManagementContext, withMachineTransition } from './enrollment'

/** An explicit admin decision; cancelling authority never grants it to a new identity. */
export async function supersedeMachine(
  host: EnrollmentHost,
  id: MachineId,
  replacementId: MachineId,
  actor: UserId,
  context: MachineManagementContext = {},
): Promise<void> {
  if (await host.deps.store.users.roleOf(actor) !== 'admin' ||
      context.manage?.(id) === false || context.manage?.(replacementId) === false) {
    throw new Error('only an admin with manage access to both machines may supersede a machine')
  }
  if (id === replacementId) throw new Error('replacement must be a different machine')
  // Stable ordering prevents opposing A→B/B→A requests from deadlocking.
  const [first, second] = [id, replacementId].sort() as [MachineId, MachineId]
  await withMachineTransition(host, first, () => withMachineTransition(host, second, async () => {
    await host.deps.store.transact(async () => {
      const old = await host.deps.store.machines.getMachine(id)
      const replacement = await host.deps.store.machines.getMachine(replacementId)
      if (!old || !replacement) throw new Error('unknown machine')
      if (replacement.revokedAt || replacement.supersededBy) throw new Error('replacement machine is retired')
      if (old.supersededBy) {
        if (old.supersededBy === replacementId) return
        throw new Error('machine already has a different replacement')
      }
      await host.deps.store.grants.removeAllForResource('machine', id, true)
      await host.deps.store.machines.supersedeMachine(id, replacementId)
      await host.deps.store.settingsAudit.append({
        command: 'machines.supersede', outcome: 'applied',
        ...(context.attribution ?? { actorKind: 'user' as const, actorId: actor, onBehalfOf: actor }),
        detail: { machineId: id, replacementId, grants: 'cancelled', queuedWork: 'cancelled' },
        redactedPaths: [], createdAt: new Date().toISOString(),
      })
    })
    host.retireIncarnation(id)
  }))
  await host.broadcastMachines()
}
