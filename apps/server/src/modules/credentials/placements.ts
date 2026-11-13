/**
 * WHAT PODIUM LEFT ON MACHINES, REMOVED (credential management §8 "cleanup";
 * epic Task 13).
 *
 * A placement is something Podium created on a machine for a credential: a home
 * it made for a login (`home`, removed by Task 9's transport) or a login file it
 * copied there by propagation (`propagated-file`). Removing one asks the machine
 * to remove it. A machine that is offline, or cannot do it yet, keeps the
 * placement as `removal-pending`, visibly, and is asked again when it
 * reconnects; only the machine's own confirmation makes it `removed`.
 */

import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import type { SessionStore } from '../../store'
import type { CredentialRecord, PlacementKind, PlacementRef } from '../../store/credentials'

const log = createLogger('server:credentials')

/**
 * How a removal reaches a machine. Each remover answers `true` once the machine
 * confirmed the removal; `false` (or a throw) leaves it pending. A kind with no
 * remover stays pending until one is bound.
 */
export interface PlacementTransport {
  isOnline(machineId: MachineId): boolean
  removers: Partial<
    Record<PlacementKind, (machineId: MachineId, credential: CredentialRecord) => Promise<boolean>>
  >
}

export interface PlacementsDeps {
  store: Pick<SessionStore, 'credentials'>
  transport?: PlacementTransport
}

export class Placements {
  transport: PlacementTransport | undefined

  constructor(private readonly deps: PlacementsDeps) {
    this.transport = deps.transport
  }

  /** Remove one placement now, or leave it `removal-pending` until its machine confirms. */
  async removePlacement(placement: PlacementRef): Promise<'removed' | 'pending'> {
    const credentials = this.deps.store.credentials
    if (await this.tryRemove(placement)) {
      await credentials.setPlacementState(placement, 'removed')
      return 'removed'
    }
    await credentials.setPlacementState(placement, 'removal-pending')
    return 'pending'
  }

  /** A machine reconnected: ask it again for everything still pending there. */
  async retryPendingOn(machineId: MachineId): Promise<void> {
    const credentials = this.deps.store.credentials
    for (const placement of await credentials.listPendingPlacementsOn(machineId)) {
      if (await this.tryRemove(placement)) {
        await credentials.setPlacementState(placement, 'removed')
      }
    }
  }

  private async tryRemove(placement: PlacementRef): Promise<boolean> {
    const transport = this.transport
    const remover = transport?.removers[placement.kind]
    if (!transport || !remover || !transport.isOnline(placement.machineId)) return false
    const credential = await this.deps.store.credentials.get(placement.credentialId)
    if (!credential) return false
    try {
      return await remover(placement.machineId, credential)
    } catch (err) {
      log.warn('a machine did not confirm a credential removal; it stays pending', {
        err,
        machineId: placement.machineId,
        kind: placement.kind,
      })
      return false
    }
  }
}
