import { asMachineId, type UserId, type UserRole, type WorkspaceId } from '@podium/model'
import { userCommandPrincipal } from '../../command-principal'
import { checkMachineVerb, ownershipSnapshotFromMachines } from '../../machine-access'
import type { MachinesService } from '../machines/service'
import { decodeOperationActor } from '../operations/actor'
import { ServerTransferError } from './service'
import { type ServerTransferAuthorization, TRANSFER_FAILURE_CODES } from './types'

export interface ServerMoveAuthorizationDeps {
  /** The workspace the move was authorized in. */
  workspaceId: WorkspaceId
  authorizedBy: string
  targetMachineId: string
  machines: MachinesService
  roleOf(userId: UserId): Promise<UserRole | undefined>
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
      const role = await deps.roleOf(actor.userId)
      if (role !== 'admin') {
        return denied('the recorded administrator is unavailable')
      }
      const principal = userCommandPrincipal(deps.workspaceId, actor.userId, role)
      const refusal = checkMachineVerb(
        principal,
        asMachineId(deps.targetMachineId),
        await ownershipSnapshotFromMachines(deps.machines),
        'manage',
      )
      if (refusal) {
        denied('machine management access was revoked')
      }
    },
  }
}
