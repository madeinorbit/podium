import { asMachineId, type UserId, type UserRole } from '@podium/model'
import { checkMachineVerb, ownershipFromMachines } from '../../machine-access'
import { userCommandPrincipal } from '../../command-principal'
import { decodeOperationActor } from '../operations/actor'
import type { MachinesService } from '../machines/service'
import { TRANSFER_FAILURE_CODES, type ServerTransferAuthorization } from './types'
import { ServerTransferError } from './service'

export interface ServerMoveAuthorizationDeps {
  authorizedBy: string
  targetMachineId: string
  machines: MachinesService
  roleOf(userId: UserId): UserRole | undefined
}

/** Reconstructs current policy from durable identity; it never retains a request context. */
export function serverMoveAuthorization(
  deps: ServerMoveAuthorizationDeps,
): ServerTransferAuthorization {
  const denied = (message: string): never => {
    throw new ServerTransferError(TRANSFER_FAILURE_CODES.REAUTHORIZATION_DENIED, message)
  }
  return {
    reauthorize: async () => {
      const actor = decodeOperationActor(deps.authorizedBy)
      if (!actor) return denied('the recorded actor is invalid')
      if (actor.kind !== 'user') {
        return denied('the recorded actor is not a current administrator')
      }
      const role = deps.roleOf(actor.userId)
      if (role !== 'admin') {
        return denied('the recorded administrator is unavailable')
      }
      const principal = userCommandPrincipal(actor.userId, role)
      const refusal = checkMachineVerb(
        principal,
        asMachineId(deps.targetMachineId),
        ownershipFromMachines(deps.machines),
        'manage',
      )
      if (refusal) {
        denied('machine management access was revoked')
      }
    },
  }
}
